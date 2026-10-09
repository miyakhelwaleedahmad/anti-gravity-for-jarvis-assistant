/**
 * core/agents/agentManager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The Agent Manager / Factory. It is the only place agents are created, and
 * the only place a task's work runs. For every child request it checks, in
 * order: parent alive, role known, role allowed for the parent, depth limit
 * (leaf rule), task depth, children per agent, active agents, capabilities,
 * task type, permissions (no escalation), whole-task delegation, retries,
 * deadline and budget. A request that fails a check is rejected with the
 * reasons and no agent exists; a request that passes gets an agent record
 * and a task record and runs through the lifecycle:
 *
 *   CREATED → VALIDATING → STARTING (waits for dependencies and a work slot)
 *     → RUNNING ⇄ WAITING (for children) → COMPLETED | FAILED | CANCELLED | TIMED_OUT
 *
 * Results always come back to the parent as a ChildResult, never as a thrown
 * error, so a failed child does not crash its parent. When a task ends, its
 * unfinished children are cancelled (no orphans). Temporary agents are removed
 * from the registry when their root task ends; their records are kept in the
 * root's archive (data/agents/<rootTaskId>.json).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { toolRegistryV2, type ToolResult } from '../toolRegistryV2.js';
import { modelRouter } from '../../bridge/modelRouter.js';
import type { ILLMRequest, ILLMResponse } from '../../bridge/llmTypes.js';
import { securityAuditLogger } from '../../security/securityAuditLogger.js';
import { dataRoot, getWorkspaceRoot } from '../workspaceRoot.js';
import { loadAgentLimits, type AgentLimits } from './config.js';
import { agentEvents, matches, type AgentEventFilter, type AgentEventHub } from './events.js';
import { AgentRegistry, UnknownRoleError, type AgentRoleDefinition } from './registry.js';
import { AgentTaskManager, DependencyFailedError } from './taskManager.js';
import { SharedWorkspace } from './workspace.js';
import { PrioritySemaphore } from './semaphore.js';
import { checkCall, deriveChildScope, isSubsetScope, rootScope, type ToolInfoSource } from './permissions.js';
import { decideSpawn, type SpawnDecision, type SpawnDecisionInput } from './spawnPolicy.js';
import { similarity } from './similarity.js';
import { runAsAgent } from './agentScope.js';
import {
  BudgetExceededError, SpawnRejectedError,
  type AgentContext, type ChildHandle, type SpawnRequest,
} from './agentContextApi.js';
import type {
  AgentEvent, AgentEventType, AgentMessage, AgentOutcome, AgentRecord, AgentTaskRecord, ChildResult,
  ChildTaskSpec, Claim, Conflict, CreateChildAgentRequest, Finding, LifecycleState, MessageOptions, PermissionScope,
  ResourceBudget, ResourceUsage, Source, WorkspaceArtifact,
} from './types.js';
import { isTerminal } from './types.js';

export const JARVIS_AGENT_ID = 'jarvis';

/** A tool source the manager can call: toolRegistryV2, or a stand-in in tests. */
export interface ToolExecutor extends ToolInfoSource {
  execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

export interface RootTaskInput {
  /** The user's words. */
  request: string;
  source?: 'voice' | 'cli';
  /** The permanent specialist that gets the task. */
  specialistRole: string;
  task?: ChildTaskSpec;
  priority?: number;
  timeoutMs?: number;
  budget?: Partial<ResourceBudget>;
}

/** What JARVIS receives when a root task ends. */
export interface RootResult {
  rootTaskId: string;
  status: LifecycleState;
  answer: string;
  findings: Finding[];
  sources: Source[];
  confidence: number;
  conflicts: Conflict[];
  limitations: string[];
  artifacts: WorkspaceArtifact[];
  recommendedNextActions: string[];
  specialist: ChildResult;
  durationMs: number;
}

export interface RootHandle {
  rootTaskId: string;
  /** The specialist's task. */
  taskId: string;
  agentId: string;
  result: Promise<RootResult>;
}

interface RootRun {
  rootTaskId: string;
  request: string;
  source: 'voice' | 'cli';
  workspace: SharedWorkspace;
  startedAt: number;
  endedAt?: number;
  status: LifecycleState;
  result?: RootResult;
  agents: Map<string, AgentRecord>;
  /** Snapshot of the task records once the root has ended. */
  tasks?: AgentTaskRecord[];
  archivePath?: string;
}

interface Budget {
  limit: ResourceBudget;
  used: ResourceUsage;
}

const FINISHED_RUNS_KEPT = 10;
const ZERO_USAGE: ResourceUsage = { llmCalls: 0, toolCalls: 0, tokens: 0 };
/** A child is never handed (nearly) its parent's own task, except by JARVIS. */
const WHOLE_TASK = 0.9;

function eventTypeFor(status: LifecycleState): AgentEventType {
  switch (status) {
    case 'COMPLETED': return 'TASK_COMPLETED';
    case 'CANCELLED': return 'TASK_CANCELLED';
    case 'TIMED_OUT': return 'TASK_TIMED_OUT';
    default: return 'TASK_FAILED';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Rejects as soon as `signal` aborts, whatever `work` does. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Aborted'), { name: 'AbortError' }));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

export class AgentManager {
  readonly registry = new AgentRegistry();
  readonly tasks: AgentTaskManager;
  limits: AgentLimits;
  private slots: PrioritySemaphore;
  private llmSlots: PrioritySemaphore;
  private runs = new Map<string, RootRun>();
  private budgets = new Map<string, Budget>();
  private heldSlots = new Map<string, () => void>();
  private settled = new Map<string, Promise<ChildResult>>();
  private childHandles = new Map<string, ChildHandle[]>();
  private requests = new Map<string, CreateChildAgentRequest>();
  private inboxes = new Map<string, AgentMessage[]>();
  /** Ids of delivered messages (most recent 5,000): a message is handled once. */
  private deliveredIds = new Set<string>();
  private agentCounter = 0;
  private tools: ToolExecutor = toolRegistryV2;
  private archiveEnabled = process.env['JARVIS_AGENT_ARCHIVE'] !== '0';
  readonly counters = { created: 0, completed: 0, failed: 0, cancelled: 0, timedOut: 0, rejected: 0 };

  constructor(readonly events: AgentEventHub = agentEvents, limits: AgentLimits = loadAgentLimits()) {
    this.limits = limits;
    this.tasks = new AgentTaskManager(events);
    this.tasks.setIdleTimeout(limits.idleTimeoutMs);
    this.tasks.onTimeout = (task, by) => {
      this.events.emit('PROGRESS_UPDATE', task.rootTaskId, { taskId: task.taskId, agentId: task.agentId },
        { note: by === 'idle' ? 'stopped: no progress' : 'stopped: deadline passed' });
    };
    this.slots = new PrioritySemaphore(limits.maxConcurrentAgents);
    this.llmSlots = new PrioritySemaphore(limits.maxConcurrentLlmCalls);
    this.registry.add(this.jarvisRecord());
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  /** Changes limits at run time (tests, settings). */
  configure(changes: Partial<AgentLimits>): void {
    this.limits = { ...this.limits, ...changes };
    this.slots.setCapacity(this.limits.maxConcurrentAgents);
    this.llmSlots.setCapacity(this.limits.maxConcurrentLlmCalls);
    this.tasks.setIdleTimeout(this.limits.idleTimeoutMs);
  }

  /** Tests pass a stand-in tool source; JARVIS uses toolRegistryV2. */
  useToolExecutor(tools: ToolExecutor): void {
    this.tools = tools;
  }

  setArchiveEnabled(on: boolean): void {
    this.archiveEnabled = on;
  }

  private jarvisRecord(): AgentRecord {
    return {
      agentId: JARVIS_AGENT_ID, role: 'jarvis', name: 'JARVIS', description: 'Main supervisor',
      capabilities: ['supervision'], tools: [], status: 'READY', version: '1.0.0',
      endpoint: `inproc://agents/${JARVIS_AGENT_ID}`,
      permissions: { tools: [], maxRisk: 3, canSpawn: true },
      supportedTaskTypes: [], depth: 0, permanent: true, taskIds: [], createdAt: Date.now(),
      budget: { ...this.limits.rootBudget }, usage: { ...ZERO_USAGE },
    };
  }

  /** JARVIS's scope: every tool an agent may have. Computed when used, since tools register late. */
  private jarvisScope(): PermissionScope {
    return rootScope(this.tools);
  }

  /** Defines a role; a permanent role (a specialist) gets its agent record now. */
  defineRole(def: AgentRoleDefinition): void {
    this.registry.defineRole(def);
    if (def.permanent && !this.registry.get(def.role)) {
      const scope = this.permanentScope(def.role);
      this.registry.add({
        agentId: def.role, role: def.role, name: def.name, description: def.description,
        capabilities: [...def.capabilities], tools: scope.tools, status: 'READY', version: def.version,
        endpoint: `inproc://agents/${def.role}`, permissions: scope, parentAgentId: JARVIS_AGENT_ID,
        supportedTaskTypes: [...def.supportedTaskTypes], depth: 1, permanent: true, taskIds: [],
        createdAt: Date.now(), budget: { ...this.limits.rootBudget }, usage: { ...ZERO_USAGE },
      });
    }
  }

  private permanentScope(role: string): PermissionScope {
    return deriveChildScope({
      parent: this.jarvisScope(), role: this.registry.roleScope(role),
      depthAllowsSpawn: 1 < this.limits.maxDepth, registry: this.tools,
    }).scope;
  }

  // ── Root tasks ─────────────────────────────────────────────────────────────

  /** JARVIS hands a request to a specialist. Returns at once; the result arrives later. */
  async startRootTask(input: RootTaskInput): Promise<RootHandle> {
    const activeRoots = [...this.runs.values()].filter((r) => !r.endedAt).length;
    if (activeRoots >= this.limits.maxRootTasks) {
      throw new SpawnRejectedError('ROOT_LIMIT', [`${activeRoots} delegated tasks are already running (JARVIS_AGENT_MAX_ROOT_TASKS=${this.limits.maxRootTasks})`]);
    }
    const def = this.registry.role(input.specialistRole);
    if (!def.permanent) {
      throw new SpawnRejectedError('NOT_A_SPECIALIST', [`"${input.specialistRole}" is not one of JARVIS's specialists`]);
    }
    const now = Date.now();
    const lifetime = Math.min(input.timeoutMs ?? this.limits.maxRootLifetimeMs, this.limits.maxRootLifetimeMs);
    const root = this.tasks.create({
      agentId: JARVIS_AGENT_ID, role: 'jarvis', description: input.request,
      priority: input.priority, deadline: now + lifetime, reason: 'user request',
    });
    const rootTaskId = root.taskId;
    const workspace = new SharedWorkspace(rootTaskId, input.request, (type, ids, data) => {
      this.events.emit(type, rootTaskId, ids, data);
    });
    this.events.setRecorder(rootTaskId, (e) => workspace.record(e));
    const run: RootRun = {
      rootTaskId, request: input.request, source: input.source ?? 'cli', workspace,
      startedAt: now, status: 'RUNNING', agents: new Map([[JARVIS_AGENT_ID, this.registry.get(JARVIS_AGENT_ID)!]]),
    };
    this.runs.set(rootTaskId, run);
    const rb = this.limits.rootBudget;
    this.budgets.set(rootTaskId, {
      limit: {
        llmCalls: Math.min(input.budget?.llmCalls ?? rb.llmCalls, rb.llmCalls),
        toolCalls: Math.min(input.budget?.toolCalls ?? rb.toolCalls, rb.toolCalls),
        tokens: Math.min(input.budget?.tokens ?? rb.tokens, rb.tokens),
      },
      used: { ...ZERO_USAGE },
    });
    this.registry.get(JARVIS_AGENT_ID)!.taskIds.push(rootTaskId);
    this.emitTask('TASK_CREATED', root, { description: root.description, role: 'jarvis' });
    this.tasks.transition(rootTaskId, 'STARTING');
    this.tasks.transition(rootTaskId, 'RUNNING');
    this.emitTask('TASK_STARTED', root, {});
    this.writeArchive(run);

    let handle: ChildHandle;
    try {
      handle = this.spawnChild(JARVIS_AGENT_ID, rootTaskId, {
        childRole: input.specialistRole,
        childTask: input.task ?? { description: input.request },
        priority: input.priority,
        reason: `JARVIS delegated the request to the ${def.name}`,
      });
    } catch (err) {
      this.tasks.setResult(rootTaskId, this.failedResult(root, 'FAILED', 'DELEGATION_REJECTED', errorMessage(err)));
      this.tasks.transition(rootTaskId, 'FAILED');
      this.emitTask('TASK_FAILED', root, { error: errorMessage(err) });
      run.status = 'FAILED';
      run.endedAt = Date.now();
      this.closeRun(run);
      throw err;
    }
    this.tasks.transition(rootTaskId, 'WAITING');
    const result = handle.result.then((r) => this.finishRoot(run, r));
    return { rootTaskId, taskId: handle.taskId, agentId: handle.agentId, result };
  }

  /** Stops a root task and everything below it. */
  cancelRoot(rootTaskId: string, reason = 'stopped by the user'): boolean {
    const root = this.tasks.get(rootTaskId);
    if (!root || isTerminal(root.status)) return false;
    this.tasks.cancel(rootTaskId, reason, 'user');
    return true;
  }

  /** Stops one task (and its subtree). */
  cancelTask(taskId: string, reason = 'stopped by the user'): boolean {
    const t = this.tasks.get(taskId);
    if (!t || isTerminal(t.status)) return false;
    this.tasks.cancel(taskId, reason, 'user');
    return true;
  }

  /** Stops every running root task (JARVIS shutting down). */
  cancelAll(reason = 'JARVIS is shutting down'): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.endedAt) continue;
      this.tasks.cancel(run.rootTaskId, reason, 'shutdown');
      n++;
    }
    return n;
  }

  private async finishRoot(run: RootRun, specialist: ChildResult): Promise<RootResult> {
    const root = this.tasks.get(run.rootTaskId)!;
    // Anything still running below the root is stopped and waited for.
    for (const t of this.tasks.all(run.rootTaskId)) {
      if (t.taskId !== root.taskId && !isTerminal(t.status)) this.tasks.cancel(t.taskId, 'root task finished', 'parent');
    }
    await this.settleAll(run.rootTaskId, 5_000);

    let status: LifecycleState;
    if (root.cancellation.requested) {
      status = root.cancellation.by === 'timeout' || root.cancellation.by === 'idle' ? 'TIMED_OUT' : 'CANCELLED';
    } else {
      status = specialist.status;
    }
    const ws = run.workspace;
    const conflicts = ws.conflicts();
    const limitations = [...specialist.limitations];
    if (root.cancellation.requested) limitations.push(`Stopped: ${root.cancellation.reason}`);
    for (const c of conflicts.filter((x) => x.status !== 'resolved')) {
      limitations.push(`Unresolved: sources disagree on ${c.subject} ${c.attribute}.`);
    }
    const nextActions = Array.isArray(specialist.data?.['recommendedNextActions'])
      ? (specialist.data!['recommendedNextActions'] as unknown[]).map(String) : [];
    const findings = specialist.findings.length ? specialist.findings : ws.findings();
    const sourceIds = new Set(findings.flatMap((f) => f.sourceIds));
    const result: RootResult = {
      rootTaskId: run.rootTaskId,
      status,
      answer: ws.finalSynthesis?.summary || specialist.summary,
      findings,
      sources: specialist.sources.length ? specialist.sources : ws.sources().filter((s) => sourceIds.has(s.id)),
      confidence: status === 'COMPLETED' ? specialist.confidence : Math.min(specialist.confidence, 0.4),
      conflicts,
      limitations,
      artifacts: specialist.artifacts.length ? specialist.artifacts : ws.artifacts(),
      recommendedNextActions: nextActions,
      specialist,
      durationMs: Date.now() - run.startedAt,
    };
    const rootResult: ChildResult = {
      ...specialist, taskId: root.taskId, agentId: JARVIS_AGENT_ID, role: 'jarvis', status,
      summary: result.answer, usage: this.usageOf(root.taskId), durationMs: result.durationMs,
    };
    this.tasks.setResult(root.taskId, rootResult);
    this.tasks.transition(root.taskId, status);
    this.count(status);
    this.emitTask(eventTypeFor(status), root, { summary: result.answer.slice(0, 300), confidence: result.confidence });
    run.status = status;
    run.result = result;
    run.endedAt = Date.now();
    this.closeRun(run);
    return result;
  }

  /** Archives the run and removes its temporary agents and task records from the live tables. */
  private closeRun(run: RootRun): void {
    for (const a of this.registry.all()) {
      if (a.rootTaskId === run.rootTaskId) run.agents.set(a.agentId, a);
    }
    run.tasks = this.tasks.forgetRoot(run.rootTaskId);
    this.writeArchive(run);
    for (const [id, a] of run.agents) {
      if (!a.permanent) this.registry.remove(id);
      this.inboxes.delete(id);
    }
    for (const t of run.tasks) {
      this.budgets.delete(t.taskId);
      this.settled.delete(t.taskId);
      this.childHandles.delete(t.taskId);
      this.requests.delete(t.taskId);
      this.heldSlots.get(t.taskId)?.();
      this.heldSlots.delete(t.taskId);
    }
    this.refreshPermanentStatuses();
    this.events.setRecorder(run.rootTaskId, undefined);
    const finished = [...this.runs.values()].filter((r) => r.endedAt).sort((a, b) => a.endedAt! - b.endedAt!);
    while (finished.length > FINISHED_RUNS_KEPT) this.runs.delete(finished.shift()!.rootTaskId);
  }

  private async settleAll(rootTaskId: string, maxMs: number): Promise<void> {
    const pending = this.tasks.all(rootTaskId)
      .filter((t) => t.agentId !== JARVIS_AGENT_ID)
      .map((t) => this.settled.get(t.taskId))
      .filter((p): p is Promise<ChildResult> => !!p);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((r) => { timer = setTimeout(r, maxMs); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  // ── The factory ────────────────────────────────────────────────────────────

  /**
   * CREATE_CHILD_AGENT. Checks the request; on success creates the agent and
   * its task and starts it. Throws SpawnRejectedError with every failed check.
   */
  spawnChild(parentAgentId: string, parentTaskId: string, req: SpawnRequest): ChildHandle {
    const parentTask = this.tasks.get(parentTaskId);
    const parentAgent = this.registry.get(parentAgentId);
    if (!parentTask || !parentAgent || parentTask.agentId !== parentAgentId) {
      throw this.reject(parentTask?.rootTaskId, parentAgentId, parentTaskId, req, 'INVALID_PARENT', ['the parent agent or task does not exist']);
    }
    const rootTaskId = parentTask.rootTaskId;
    const full: CreateChildAgentRequest = { ...req, parentAgentId, parentTaskId, rootTaskId };
    if (isTerminal(parentTask.status) || parentTask.cancellation.requested) {
      throw this.reject(rootTaskId, parentAgentId, parentTaskId, req, 'PARENT_STOPPED', [`the parent task is ${parentTask.cancellation.requested ? 'being cancelled' : parentTask.status}`]);
    }
    let def: AgentRoleDefinition;
    try {
      def = this.registry.role(req.childRole);
    } catch (err) {
      const valid = err instanceof UnknownRoleError ? err.validRoles : [];
      throw this.reject(rootTaskId, parentAgentId, parentTaskId, req, 'UNKNOWN_ROLE', [errorMessage(err)], { validRoles: valid });
    }

    const reasons: string[] = [];
    let code = 'INVALID_REQUEST';
    const fail = (c: string, r: string) => { if (!reasons.length) code = c; reasons.push(r); };

    const isJarvis = parentAgentId === JARVIS_AGENT_ID;
    const childDepth = parentAgent.depth + 1;
    // Roles: JARVIS delegates only to specialists; specialists only at depth 1.
    if (isJarvis && !def.permanent) fail('ROLE_NOT_ALLOWED', `JARVIS delegates only to specialists, not "${def.role}"`);
    if (!isJarvis && def.permanent) fail('ROLE_NOT_ALLOWED', `"${def.role}" is a specialist; only JARVIS delegates to it`);
    if (!isJarvis) {
      const parentDef = this.registry.hasRole(parentAgent.role) ? this.registry.role(parentAgent.role) : undefined;
      if (!parentDef?.allowedChildRoles.includes(def.role)) {
        fail('ROLE_NOT_ALLOWED', `${parentAgent.name} may not create "${def.role}" (allowed: ${parentDef?.allowedChildRoles.join(', ') || 'none'})`);
      }
    }
    // Depth (leaf rule) and task depth.
    if (!parentAgent.permissions.canSpawn || childDepth > this.limits.maxDepth) {
      fail('DEPTH_LIMIT', `${parentAgent.name} is at depth ${parentAgent.depth}; the limit is ${this.limits.maxDepth} (JARVIS_AGENT_MAX_DEPTH), so it must do the work itself`);
    }
    if (parentTask.depth + 1 > this.limits.maxTaskDepth) {
      fail('TASK_DEPTH_LIMIT', `task depth ${parentTask.depth + 1} is above ${this.limits.maxTaskDepth} (JARVIS_AGENT_MAX_TASK_DEPTH)`);
    }
    // Counts.
    const activeChildren = this.activeChildren(parentAgentId).length;
    if (activeChildren >= this.limits.maxChildrenPerAgent) {
      fail('CHILD_LIMIT', `${parentAgent.name} already has ${activeChildren} active children (JARVIS_AGENT_MAX_CHILDREN=${this.limits.maxChildrenPerAgent})`);
    }
    if (!def.permanent) {
      const active = this.activeTemporaryAgents().length;
      if (active >= this.limits.maxActiveAgents) {
        fail('ACTIVE_LIMIT', `${active} agents are active (JARVIS_AGENT_MAX_ACTIVE=${this.limits.maxActiveAgents})`);
      }
    }
    // Capabilities and task type.
    const missing = (req.requiredCapabilities ?? []).filter((c) => !def.capabilities.includes(c));
    if (missing.length) fail('CAPABILITY_MISSING', `role "${def.role}" lacks ${missing.join(', ')}`);
    if (req.childTask.taskType && def.supportedTaskTypes.length && !def.supportedTaskTypes.includes(req.childTask.taskType)) {
      fail('TASK_TYPE', `role "${def.role}" does not take "${req.childTask.taskType}" tasks`);
    }
    // Permissions: parent ∩ role ∩ request, with no escalation.
    const scoped = deriveChildScope({
      parent: isJarvis ? this.jarvisScope() : parentAgent.permissions,
      role: this.registry.roleScope(def.role),
      allowedTools: req.allowedTools,
      requested: req.permissionScope,
      depthAllowsSpawn: childDepth < this.limits.maxDepth,
      registry: this.tools,
    });
    for (const e of scoped.escalations) fail('PERMISSION_ESCALATION', e);
    // A child must not be handed its parent's whole task.
    if (!isJarvis && similarity(req.childTask.description, parentTask.description) >= WHOLE_TASK) {
      fail('DELEGATES_WHOLE_TASK', 'the child task is the parent\'s whole task; the parent must split it or do it');
    }
    // Retries.
    if (req.retryOf) {
      let attempts = 1;
      let cur = this.tasks.get(req.retryOf);
      while (cur) { attempts++; cur = cur.retryOf ? this.tasks.get(cur.retryOf) : undefined; }
      if (attempts - 1 > this.limits.maxRetries) {
        fail('RETRY_LIMIT', `this would be attempt ${attempts}; JARVIS_AGENT_MAX_RETRIES=${this.limits.maxRetries}`);
      }
    }
    // Deadline and budget.
    const now = Date.now();
    const deadline = Math.min(req.deadline ?? now + this.limits.defaultTaskTimeoutMs, parentTask.deadline);
    if (deadline <= now) fail('DEADLINE_PASSED', 'the deadline has already passed');
    const parentLeft = this.remainingBudget(parentTaskId);
    if (parentLeft.llmCalls <= 0 && parentLeft.toolCalls <= 0) fail('BUDGET_EXHAUSTED', 'the parent has no model or tool calls left');
    // Dependencies.
    for (const d of req.dependencies ?? []) {
      const dep = this.tasks.get(d);
      if (!dep || dep.rootTaskId !== rootTaskId) fail('BAD_DEPENDENCY', `dependency ${d} is not a task of this root`);
    }
    if (reasons.length) {
      throw this.reject(rootTaskId, parentAgentId, parentTaskId, req, code, reasons);
    }

    // ── Accepted: create the agent and its task. ─────────────────────────────
    let agent: AgentRecord;
    if (def.permanent) {
      agent = this.registry.get(def.role)!;
      agent.permissions = scoped.scope;
      agent.tools = scoped.scope.tools;
    } else {
      const agentId = `${def.role}-${++this.agentCounter}`;
      agent = {
        agentId, role: def.role, name: req.name ?? def.name, description: def.description,
        capabilities: [...def.capabilities], tools: scoped.scope.tools, status: 'CREATED', version: def.version,
        endpoint: `inproc://agents/${agentId}`, permissions: scoped.scope, parentAgentId,
        supportedTaskTypes: [...def.supportedTaskTypes], depth: childDepth, permanent: false, rootTaskId,
        taskIds: [], createdAt: now, budget: { ...ZERO_USAGE }, usage: { ...ZERO_USAGE },
      };
      this.registry.add(agent);
    }
    this.runs.get(rootTaskId)?.agents.set(agent.agentId, agent);

    const task = this.tasks.create({
      parentTaskId, agentId: agent.agentId, parentAgentId, role: def.role,
      description: req.childTask.description, input: req.childTask.input, priority: req.priority,
      dependencies: req.dependencies, deadline, reason: req.reason, retryOf: req.retryOf,
      attempt: req.retryOf ? (this.tasks.get(req.retryOf)?.attempt ?? 1) + 1 : 1,
    });
    agent.taskIds.push(task.taskId);
    const limit: ResourceBudget = {
      llmCalls: Math.min(req.resourceBudget?.llmCalls ?? parentLeft.llmCalls, parentLeft.llmCalls),
      toolCalls: Math.min(req.resourceBudget?.toolCalls ?? parentLeft.toolCalls, parentLeft.toolCalls),
      tokens: Math.min(req.resourceBudget?.tokens ?? parentLeft.tokens, parentLeft.tokens),
    };
    this.budgets.set(task.taskId, { limit, used: { ...ZERO_USAGE } });
    if (!agent.permanent) agent.budget = { ...limit };
    this.requests.set(task.taskId, full);
    this.counters.created++;

    if (!agent.permanent) {
      this.events.emit('AGENT_CREATED', rootTaskId, { taskId: task.taskId, agentId: agent.agentId, parentAgentId }, {
        role: def.role, name: agent.name, depth: agent.depth, reason: req.reason ?? '', tools: agent.tools,
        maxRisk: agent.permissions.maxRisk, canSpawn: agent.permissions.canSpawn,
      });
    }
    this.emitTask('TASK_CREATED', task, {
      description: task.description, role: def.role, dependencies: task.dependencies, reason: req.reason ?? '',
      priority: task.priority, deadline: task.deadline,
    });
    this.setStatus(task, 'VALIDATING');
    this.emitTask('TASK_ASSIGNED', task, { role: def.role, agentName: agent.name });
    this.deliver({
      id: randomUUID(), from: parentAgentId, to: agent.agentId, rootTaskId, taskId: task.taskId, parentTaskId,
      kind: 'assignment', text: task.description.slice(0, 500), data: { role: def.role, reason: req.reason ?? '' }, at: Date.now(),
    });
    this.runs.get(rootTaskId)?.workspace.addDecision({
      at: now, agentId: parentAgentId, taskId: parentTaskId, decision: 'SPAWN',
      reasons: [req.reason ?? 'delegated'], childRole: def.role, childAgentId: agent.agentId, childTaskId: task.taskId,
    });

    const resultPromise = this.execute(task, agent, def);
    this.settled.set(task.taskId, resultPromise);
    const handle: ChildHandle = { agentId: agent.agentId, taskId: task.taskId, role: def.role, name: agent.name, result: resultPromise };
    const siblings = this.childHandles.get(parentTaskId) ?? [];
    siblings.push(handle);
    this.childHandles.set(parentTaskId, siblings);
    return handle;
  }

  /** The user's createAgent({ role, parentAgent, taskId, capabilities }) form. */
  createAgent(input: {
    role: string; parentAgent: string; taskId: string; task: string;
    capabilities?: string[]; allowedTools?: string[]; reason?: string; name?: string;
  }): ChildHandle {
    return this.spawnChild(input.parentAgent, input.taskId, {
      childRole: input.role, childTask: { description: input.task }, requiredCapabilities: input.capabilities,
      allowedTools: input.allowedTools, reason: input.reason, name: input.name,
    });
  }

  private reject(
    rootTaskId: string | undefined, parentAgentId: string, parentTaskId: string, req: SpawnRequest,
    code: string, reasons: string[], extra: Record<string, unknown> = {},
  ): SpawnRejectedError {
    this.counters.rejected++;
    if (rootTaskId) {
      this.events.emit('SPAWN_REJECTED', rootTaskId, { taskId: parentTaskId, agentId: parentAgentId }, {
        code, reasons, childRole: req.childRole, childTask: req.childTask.description, ...extra,
      });
      this.runs.get(rootTaskId)?.workspace.addDecision({
        at: Date.now(), agentId: parentAgentId, taskId: parentTaskId, decision: `REJECTED:${code}`, reasons, childRole: req.childRole,
      });
    }
    return new SpawnRejectedError(code, reasons);
  }

  // ── Running a task ─────────────────────────────────────────────────────────

  private async execute(task: AgentTaskRecord, agent: AgentRecord, def: AgentRoleDefinition): Promise<ChildResult> {
    const signal = this.tasks.signal(task.taskId);
    const run = this.runs.get(task.rootTaskId)!;
    let outcome: AgentOutcome | undefined;
    let status: LifecycleState = 'FAILED';
    let error: { code: string; message: string } | undefined;
    let truncated = false;
    try {
      await Promise.resolve(); // let the caller receive its handle first
      this.setStatus(task, 'STARTING');
      let dependencyResults: Record<string, ChildResult> = {};
      if (task.dependencies.length) {
        const pending = this.tasks.pendingDependencies(task.taskId);
        if (pending.length) this.emitTask('TASK_BLOCKED', task, { waitingFor: pending });
        dependencyResults = await this.tasks.whenReady(task.taskId, signal);
      }
      const release = await this.slots.acquire(task.priority, signal);
      this.heldSlots.set(task.taskId, release);
      this.setStatus(task, 'RUNNING');
      this.emitTask('TASK_STARTED', task, { role: def.role, name: agent.name });
      if (task.parentAgentId) {
        this.deliver({
          id: randomUUID(), from: agent.agentId, to: task.parentAgentId, rootTaskId: task.rootTaskId, taskId: task.taskId,
          ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}), kind: 'acceptance', text: `${agent.name} started`, status: 'ok', at: Date.now(),
        });
      }
      const behavior = this.registry.behaviorFor(def.role);
      const ctx = new TaskContext(this, task, agent, run, dependencyResults);
      const work = runAsAgent({
        rootTaskId: task.rootTaskId, taskId: task.taskId, agentId: agent.agentId,
        agentPath: this.registry.path(agent.agentId), request: run.request, source: run.source,
      }, () => behavior.run(ctx));
      outcome = await raceAbort(work, signal);
      status = 'COMPLETED';
    } catch (err) {
      if (signal.aborted || isAbort(err)) {
        const by = task.cancellation.by;
        status = by === 'timeout' || by === 'idle' ? 'TIMED_OUT' : 'CANCELLED';
        error = { code: status === 'TIMED_OUT' ? (by === 'idle' ? 'STALLED' : 'TIMEOUT') : 'CANCELLED', message: task.cancellation.reason ?? errorMessage(err) };
        truncated = true;
      } else if (err instanceof DependencyFailedError) {
        status = 'FAILED';
        error = { code: err.code, message: err.message };
      } else if (err instanceof BudgetExceededError) {
        status = 'FAILED';
        error = { code: err.code, message: err.message };
        truncated = true;
      } else {
        status = 'FAILED';
        error = { code: 'AGENT_ERROR', message: errorMessage(err) };
      }
    } finally {
      this.heldSlots.get(task.taskId)?.();
      this.heldSlots.delete(task.taskId);
    }

    // No orphans: children still running are stopped.
    for (const child of this.tasks.children(task.taskId)) {
      if (!isTerminal(child.status)) {
        this.tasks.cancel(child.taskId, `parent ${status === 'COMPLETED' ? 'finished' : status.toLowerCase()}`,
          status === 'FAILED' ? 'parent_failed' : 'parent');
      }
    }

    const result = this.buildResult(task, agent, status, outcome, error, truncated);
    this.tasks.setResult(task.taskId, result);
    this.setStatus(task, status);
    this.count(status);
    run.workspace.recordResult(result);
    this.emitTask(eventTypeFor(status), task, {
      summary: result.summary.slice(0, 300), confidence: result.confidence,
      ...(error ? { error } : {}), findings: result.findings.length,
    });
    if (!agent.permanent) {
      agent.endedAt = Date.now();
      this.events.emit('AGENT_STOPPED', task.rootTaskId, { taskId: task.taskId, agentId: agent.agentId, parentAgentId: agent.parentAgentId }, {
        status, role: agent.role, name: agent.name, usage: agent.usage,
      });
    }
    if (task.parentAgentId) {
      this.deliver({
        id: randomUUID(), from: agent.agentId, to: task.parentAgentId, rootTaskId: task.rootTaskId, taskId: task.taskId,
        ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
        kind: status === 'COMPLETED' ? 'completion' : status === 'CANCELLED' ? 'cancellation' : 'failure',
        text: result.summary.slice(0, 500), data: { status },
        status: status === 'COMPLETED' ? 'ok' : 'failed', ...(error ? { error } : {}), at: Date.now(),
      });
    }
    return result;
  }

  private buildResult(
    task: AgentTaskRecord, agent: AgentRecord, status: LifecycleState,
    outcome: AgentOutcome | undefined, error: { code: string; message: string } | undefined, truncated: boolean,
  ): ChildResult {
    const ws = this.runs.get(task.rootTaskId)?.workspace;
    // Without an explicit list, a task's findings are its own and its descendants'.
    const subtree = new Set([task.taskId, ...this.tasks.descendants(task.taskId).map((t) => t.taskId)]);
    const findings = outcome?.findings ?? (ws ? ws.findings().filter((f) => subtree.has(f.taskId)) : []);
    const sourceIds = new Set(findings.flatMap((f) => f.sourceIds));
    const sources = outcome?.sources ?? (ws ? ws.sources().filter((s) => sourceIds.has(s.id)) : []);
    const artifacts = outcome?.artifacts ?? (ws ? ws.artifacts().filter((a) => subtree.has(a.taskId)) : []);
    const limitations = [...(outcome?.limitations ?? [])];
    if (truncated && error) limitations.push(`Stopped early (${error.code}): ${error.message}. Findings so far are included.`);
    const partialConfidence = findings.length ? findings.reduce((s, f) => s + f.confidence, 0) / findings.length * 0.5 : 0;
    return {
      taskId: task.taskId,
      agentId: agent.agentId,
      role: task.role,
      status,
      summary: outcome?.summary
        ?? (error ? `${agent.name} ${status.toLowerCase().replace('_', ' ')}: ${error.message}${findings.length ? ` (${findings.length} finding(s) so far)` : ''}` : ''),
      findings,
      sources,
      artifacts,
      confidence: outcome ? Math.max(0, Math.min(1, outcome.confidence)) : partialConfidence,
      limitations,
      data: { ...(outcome?.data ?? {}), taskDescription: task.description },
      ...(truncated ? { truncated } : {}),
      ...(error ? { error } : {}),
      usage: this.usageOf(task.taskId),
      durationMs: Date.now() - task.createdAt,
    };
  }

  private failedResult(task: AgentTaskRecord, status: LifecycleState, code: string, message: string): ChildResult {
    return {
      taskId: task.taskId, agentId: task.agentId, role: task.role, status, summary: message,
      findings: [], sources: [], artifacts: [], confidence: 0, limitations: [message],
      error: { code, message }, usage: this.usageOf(task.taskId), durationMs: Date.now() - task.createdAt,
    };
  }

  private setStatus(task: AgentTaskRecord, to: LifecycleState): void {
    this.tasks.transition(task.taskId, to);
    const agent = this.registry.get(task.agentId) ?? this.runs.get(task.rootTaskId)?.agents.get(task.agentId);
    if (!agent) return;
    if (agent.permanent) this.refreshPermanentStatuses();
    else agent.status = to;
  }

  /** A specialist is READY with no task, else RUNNING or WAITING. */
  private refreshPermanentStatuses(): void {
    for (const a of this.registry.all()) {
      if (!a.permanent || a.agentId === JARVIS_AGENT_ID) continue;
      const live = a.taskIds.map((id) => this.tasks.get(id)).filter((t): t is AgentTaskRecord => !!t && !isTerminal(t.status));
      a.status = live.some((t) => t.status === 'RUNNING') ? 'RUNNING' : live.length ? 'WAITING' : 'READY';
    }
  }

  private count(status: LifecycleState): void {
    if (status === 'COMPLETED') this.counters.completed++;
    else if (status === 'CANCELLED') this.counters.cancelled++;
    else if (status === 'TIMED_OUT') this.counters.timedOut++;
    else this.counters.failed++;
  }

  emitTask(type: AgentEventType, task: AgentTaskRecord, data: Record<string, unknown>): AgentEvent {
    return this.events.emit(type, task.rootTaskId, { taskId: task.taskId, agentId: task.agentId, parentAgentId: task.parentAgentId }, data);
  }

  // ── Work slots, budgets, messages (used by TaskContext) ────────────────────

  /** Gives up the task's work slot while `work` runs (waiting for children). */
  async withoutSlot<T>(task: AgentTaskRecord, work: Promise<T>): Promise<T> {
    const signal = this.tasks.signal(task.taskId);
    const held = this.heldSlots.get(task.taskId);
    if (held) { held(); this.heldSlots.delete(task.taskId); }
    if (task.status === 'RUNNING') this.setStatus(task, 'WAITING');
    try {
      return await raceAbort(work, signal);
    } finally {
      if (!signal.aborted && !isTerminal(task.status)) {
        const release = await this.slots.acquire(task.priority, signal);
        this.heldSlots.set(task.taskId, release);
        if (task.status === 'WAITING') this.setStatus(task, 'RUNNING');
      }
    }
  }

  async withLlmSlot<T>(task: AgentTaskRecord, fn: () => Promise<T>): Promise<T> {
    const release = await this.llmSlots.acquire(task.priority, this.tasks.signal(task.taskId));
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Charges a task and all its ancestors; refuses when any of them is out of budget. */
  charge(taskId: string, kind: keyof ResourceUsage, n: number, enforce = true): void {
    const chain: Budget[] = [];
    let cur = this.tasks.get(taskId);
    while (cur) {
      const b = this.budgets.get(cur.taskId);
      if (b) {
        if (enforce && b.used[kind] + n > b.limit[kind]) throw new BudgetExceededError(kind, cur.taskId);
        chain.push(b);
      }
      cur = cur.parentTaskId ? this.tasks.get(cur.parentTaskId) : undefined;
    }
    for (const b of chain) b.used[kind] += n;
    const agent = this.registry.get(this.tasks.get(taskId)?.agentId ?? '');
    if (agent) agent.usage[kind] += n;
  }

  remainingBudget(taskId: string): ResourceBudget {
    const left: ResourceBudget = { llmCalls: Infinity, toolCalls: Infinity, tokens: Infinity };
    let cur = this.tasks.get(taskId);
    while (cur) {
      const b = this.budgets.get(cur.taskId);
      if (b) {
        for (const k of ['llmCalls', 'toolCalls', 'tokens'] as const) left[k] = Math.min(left[k], b.limit[k] - b.used[k]);
      }
      cur = cur.parentTaskId ? this.tasks.get(cur.parentTaskId) : undefined;
    }
    for (const k of ['llmCalls', 'toolCalls', 'tokens'] as const) if (!Number.isFinite(left[k])) left[k] = 0;
    return left;
  }

  usageOf(taskId: string): ResourceUsage {
    return { ...(this.budgets.get(taskId)?.used ?? ZERO_USAGE) };
  }

  /** Who `from` may message: its parent, its children, its siblings. */
  messageTargets(task: AgentTaskRecord): Set<string> {
    const out = new Set<string>();
    if (task.parentAgentId) out.add(task.parentAgentId);
    for (const c of this.tasks.children(task.taskId)) out.add(c.agentId);
    if (task.parentTaskId) {
      for (const s of this.tasks.children(task.parentTaskId)) if (s.taskId !== task.taskId) out.add(s.agentId);
    }
    return out;
  }

  /** True when `agentId` is a temporary agent whose task has ended: messages to it would be stale. */
  hasEnded(rootTaskId: string, agentId: string): boolean {
    const a = this.agentOf(rootTaskId, agentId);
    return !!a && !a.permanent && a.endedAt !== undefined;
  }

  /**
   * Puts a message in the recipient's inbox. False (and nothing happens) for a
   * message id already delivered, or a recipient whose task has ended.
   */
  deliver(message: AgentMessage): boolean {
    if (this.deliveredIds.has(message.id)) return false;
    if (this.hasEnded(message.rootTaskId, message.to)) return false;
    this.deliveredIds.add(message.id);
    if (this.deliveredIds.size > 5_000) this.deliveredIds.delete(this.deliveredIds.values().next().value as string);
    const box = this.inboxes.get(message.to) ?? [];
    box.push(message);
    if (box.length > 200) box.splice(0, box.length - 200);
    this.inboxes.set(message.to, box);
    this.runs.get(message.rootTaskId)?.workspace.addMessage(message);
    this.events.emit('AGENT_MESSAGE', message.rootTaskId, { taskId: message.taskId, agentId: message.from }, {
      messageId: message.id, from: message.from, to: message.to, kind: message.kind, text: message.text.slice(0, 300),
      ...(message.correlationId ? { correlationId: message.correlationId } : {}),
    });
    return true;
  }

  inbox(agentId: string): AgentMessage[] {
    return [...(this.inboxes.get(agentId) ?? [])];
  }

  toolSource(): ToolExecutor {
    return this.tools;
  }

  childHandlesOf(taskId: string): ChildHandle[] {
    return [...(this.childHandles.get(taskId) ?? [])];
  }

  originalRequest(taskId: string): CreateChildAgentRequest | undefined {
    return this.requests.get(taskId);
  }

  workspace(rootTaskId: string): SharedWorkspace | undefined {
    return this.runs.get(rootTaskId)?.workspace;
  }

  private activeChildren(agentId: string): AgentTaskRecord[] {
    return this.tasks.all().filter((t) => t.parentAgentId === agentId && !isTerminal(t.status));
  }

  private activeTemporaryAgents(): AgentRecord[] {
    return this.registry.all().filter((a) => !a.permanent && !isTerminal(a.status as LifecycleState));
  }

  // ── Observability ──────────────────────────────────────────────────────────

  /** All task records of a root (live, or the snapshot of an ended root). */
  tasksOfRoot(rootTaskId: string): AgentTaskRecord[] {
    const live = this.tasks.all(rootTaskId);
    return live.length ? live : (this.runs.get(rootTaskId)?.tasks ?? []);
  }

  rootRuns(): { rootTaskId: string; request: string; status: LifecycleState; startedAt: number; endedAt?: number; archivePath?: string }[] {
    return [...this.runs.values()].map((r) => ({
      rootTaskId: r.rootTaskId, request: r.request, status: r.endedAt ? r.status : (this.tasks.get(r.rootTaskId)?.status ?? r.status),
      startedAt: r.startedAt, ...(r.endedAt ? { endedAt: r.endedAt } : {}), ...(r.archivePath ? { archivePath: r.archivePath } : {}),
    }));
  }

  rootResult(rootTaskId: string): RootResult | undefined {
    return this.runs.get(rootTaskId)?.result;
  }

  agentOf(rootTaskId: string, agentId: string): AgentRecord | undefined {
    return this.registry.get(agentId) ?? this.runs.get(rootTaskId)?.agents.get(agentId);
  }

  /** Counts and lists for "what are your agents doing / how many are running". */
  status(): {
    activeAgents: number; running: number; waiting: number; startingOrQueued: number;
    slots: { inUse: number; limit: number; queued: number };
    llmSlots: { inUse: number; limit: number; queued: number };
    counters: AgentManager['counters'];
    roots: ReturnType<AgentManager['rootRuns']>;
    agents: { agentId: string; name: string; role: string; status: string; depth: number; task?: string; progress?: string; parent?: string }[];
  } {
    const live = this.tasks.all().filter((t) => !isTerminal(t.status) && t.agentId !== JARVIS_AGENT_ID);
    return {
      activeAgents: live.length,
      running: live.filter((t) => t.status === 'RUNNING').length,
      waiting: live.filter((t) => t.status === 'WAITING').length,
      startingOrQueued: live.filter((t) => t.status === 'STARTING' || t.status === 'VALIDATING' || t.status === 'CREATED').length,
      slots: { inUse: this.slots.active, limit: this.slots.limit, queued: this.slots.waiting },
      llmSlots: { inUse: this.llmSlots.active, limit: this.llmSlots.limit, queued: this.llmSlots.waiting },
      counters: { ...this.counters },
      roots: this.rootRuns(),
      agents: live.map((t) => {
        const a = this.agentOf(t.rootTaskId, t.agentId);
        return {
          agentId: t.agentId, name: a?.name ?? t.agentId, role: t.role, status: t.status, depth: a?.depth ?? 0,
          task: t.description, ...(t.progress ? { progress: t.progress.note } : {}),
          ...(t.parentAgentId ? { parent: t.parentAgentId } : {}),
        };
      }),
    };
  }

  /** The task tree of a root as nested nodes. */
  taskTree(rootTaskId: string): TaskTreeNode | undefined {
    const tasks = this.tasksOfRoot(rootTaskId);
    const byParent = new Map<string, AgentTaskRecord[]>();
    let root: AgentTaskRecord | undefined;
    for (const t of tasks) {
      if (!t.parentTaskId) root = t;
      else byParent.set(t.parentTaskId, [...(byParent.get(t.parentTaskId) ?? []), t]);
    }
    if (!root) return undefined;
    const build = (t: AgentTaskRecord): TaskTreeNode => {
      const a = this.agentOf(rootTaskId, t.agentId);
      return {
        taskId: t.taskId, agentId: t.agentId, agentName: a?.name ?? t.agentId, role: t.role, status: t.status,
        description: t.description, depth: a?.depth ?? 0, dependencies: t.dependencies,
        ...(t.reason ? { reason: t.reason } : {}), ...(t.progress ? { progress: t.progress.note } : {}),
        findings: this.runs.get(rootTaskId)?.workspace.findings({ taskId: t.taskId }).length ?? 0,
        ...(t.result?.error ? { error: `${t.result.error.code}: ${t.result.error.message}` } : {}),
        children: (byParent.get(t.taskId) ?? []).sort((x, y) => x.createdAt - y.createdAt).map(build),
      };
    };
    return build(root);
  }

  /** The tree as indented text lines. */
  renderTaskTree(rootTaskId: string): string {
    const tree = this.taskTree(rootTaskId);
    if (!tree) return 'No such task.';
    const lines: string[] = [];
    const walk = (n: TaskTreeNode, prefix: string, last: boolean, top: boolean) => {
      const branch = top ? '' : last ? '└─ ' : '├─ ';
      const deps = n.dependencies.length ? ` [after ${n.dependencies.length} task(s)]` : '';
      const extra = n.error ? ` — ${n.error}` : n.progress ? ` — ${n.progress}` : '';
      lines.push(`${prefix}${branch}${n.agentName} (${n.status.toLowerCase()}, ${n.findings} finding(s))${deps}${extra}`);
      const next = top ? '' : prefix + (last ? '   ' : '│  ');
      n.children.forEach((c, i) => walk(c, next, i === n.children.length - 1, false));
    };
    walk(tree, '', true, true);
    return lines.join('\n');
  }

  /** Children an agent created in a root, with the reason given for each. */
  spawnedBy(rootTaskId: string, agentId: string): { agentId: string; name: string; role: string; status: LifecycleState; reason: string }[] {
    return this.tasksOfRoot(rootTaskId).filter((t) => t.parentAgentId === agentId).map((t) => ({
      agentId: t.agentId, name: this.agentOf(rootTaskId, t.agentId)?.name ?? t.agentId, role: t.role,
      status: t.status, reason: t.reason ?? '',
    }));
  }

  /** Findings per agent in a root. */
  findingsByAgent(rootTaskId: string): Record<string, Finding[]> {
    const ws = this.runs.get(rootTaskId)?.workspace;
    const out: Record<string, Finding[]> = {};
    for (const f of ws?.findings() ?? []) (out[f.addedBy] ??= []).push(f);
    return out;
  }

  /** How much of a root is left: counts by status and a rough percentage. */
  remainingWork(rootTaskId: string): { total: number; finished: number; running: number; waiting: number; notStarted: number; percent: number } {
    const tasks = this.tasksOfRoot(rootTaskId).filter((t) => t.parentTaskId);
    const finished = tasks.filter((t) => isTerminal(t.status)).length;
    return {
      total: tasks.length,
      finished,
      running: tasks.filter((t) => t.status === 'RUNNING').length,
      waiting: tasks.filter((t) => t.status === 'WAITING').length,
      notStarted: tasks.filter((t) => ['CREATED', 'VALIDATING', 'STARTING'].includes(t.status)).length,
      percent: tasks.length ? Math.round((finished / tasks.length) * 100) : 0,
    };
  }

  // ── Archive ────────────────────────────────────────────────────────────────

  archiveDir(): string {
    return path.join(dataRoot(getWorkspaceRoot()), 'data', 'agents');
  }

  private writeArchive(run: RootRun): void {
    if (!this.archiveEnabled) return;
    try {
      const dir = this.archiveDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${run.rootTaskId}.json`);
      const body = {
        rootTaskId: run.rootTaskId,
        request: run.request,
        source: run.source,
        status: run.endedAt ? run.status : 'RUNNING',
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        tasks: run.tasks ?? this.tasks.all(run.rootTaskId),
        agents: [...run.agents.values()],
        workspace: run.workspace.toJSON(),
        events: run.workspace.events.slice(-500),
        result: run.result ? { ...run.result, specialist: undefined } : undefined,
      };
      fs.writeFileSync(file, JSON.stringify(body, null, 2));
      run.archivePath = file;
    } catch (err) {
      console.warn(`[Agents] Could not write the archive of ${run.rootTaskId}: ${errorMessage(err)}`);
    }
  }

  /**
   * At startup: root tasks whose archive still says RUNNING were cut off by a
   * restart. They are marked INTERRUPTED, not run again (research §4.2).
   */
  markInterruptedArchives(): string[] {
    const marked: string[] = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.archiveDir()).filter((f) => f.endsWith('.json'));
    } catch {
      return marked;
    }
    for (const f of files) {
      const file = path.join(this.archiveDir(), f);
      try {
        const body = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (body.status !== 'RUNNING' || this.runs.has(body.rootTaskId)) continue;
        body.status = 'INTERRUPTED';
        body.interruptedNote = 'JARVIS stopped while this task was running. It was not restarted; check partial work.';
        fs.writeFileSync(file, JSON.stringify(body, null, 2));
        marked.push(body.rootTaskId);
      } catch {
        // A damaged archive is left as it is.
      }
    }
    return marked;
  }
}

export interface TaskTreeNode {
  taskId: string;
  agentId: string;
  agentName: string;
  role: string;
  status: LifecycleState;
  description: string;
  depth: number;
  dependencies: string[];
  reason?: string;
  progress?: string;
  findings: number;
  error?: string;
  children: TaskTreeNode[];
}

// ─── The context an agent behaviour works through ────────────────────────────

class TaskContext implements AgentContext {
  readonly memory = new Map<string, unknown>();
  readonly input: Record<string, unknown>;

  constructor(
    private readonly manager: AgentManager,
    readonly task: AgentTaskRecord,
    readonly agent: AgentRecord,
    private readonly run: { workspace: SharedWorkspace; request: string },
    readonly dependencyResults: Record<string, ChildResult>,
  ) {
    this.input = { ...(task.input ?? {}) };
  }

  get workspace(): SharedWorkspace { return this.run.workspace; }
  get signal(): AbortSignal { return this.manager.tasks.signal(this.task.taskId); }
  get limits(): AgentLimits { return this.manager.limits; }
  get rootRequest(): string { return this.run.request; }

  private by() {
    return { agentId: this.agent.agentId, taskId: this.task.taskId };
  }

  checkpoint(): void {
    if (this.signal.aborted) {
      throw this.signal.reason instanceof Error ? this.signal.reason : Object.assign(new Error('Aborted'), { name: 'AbortError' });
    }
  }

  // ── Delegation ─────────────────────────────────────────────────────────────

  decideSpawn(input: SpawnDecisionInput): SpawnDecision {
    const m = this.manager;
    const def = m.registry.hasRole(this.agent.role) ? m.registry.role(this.agent.role) : undefined;
    const tasks = m.tasks.all(this.task.rootTaskId);
    const activeChildren = tasks.filter((t) => t.parentAgentId === this.agent.agentId && !isTerminal(t.status)).length;
    const activeTemp = m.registry.all().filter((a) => !a.permanent && !isTerminal(a.status as LifecycleState)).length;
    const left = m.remainingBudget(this.task.taskId);
    const decision = decideSpawn(input, {
      ownTask: this.task.description,
      ownCapabilities: this.agent.capabilities,
      canSpawn: this.agent.permissions.canSpawn && this.agent.depth < m.limits.maxDepth,
      childSlotsLeft: m.limits.maxChildrenPerAgent - activeChildren,
      globalSlotsLeft: m.limits.maxActiveAgents - activeTemp,
      concurrency: m.limits.maxConcurrentAgents,
      llmCallsLeft: left.llmCalls,
      toolCallsLeft: left.toolCalls,
      allowedChildRoles: def?.allowedChildRoles ?? [],
      knownRoles: m.registry.roleList().map((r) => r.role),
      activeTasks: tasks.filter((t) => !isTerminal(t.status) && t.taskId !== this.task.taskId)
        .map((t) => ({ taskId: t.taskId, role: t.role, description: t.description })),
      finishedResults: this.workspace.results(),
    });
    this.workspace.addDecision({
      at: Date.now(), agentId: this.agent.agentId, taskId: this.task.taskId, decision: decision.decision, reasons: decision.reasons,
    });
    m.emitTask('SPAWN_DECISION', this.task, {
      decision: decision.decision, reasons: decision.reasons,
      plan: decision.plan.map((p) => ({ ...p, description: input.subtasks[p.index]?.description, role: input.subtasks[p.index]?.role })),
      questions: decision.questions,
    });
    return decision;
  }

  async spawn(request: SpawnRequest): Promise<ChildHandle> {
    this.checkpoint();
    this.manager.tasks.touch(this.task.taskId);
    return this.manager.spawnChild(this.agent.agentId, this.task.taskId, request);
  }

  wait(handles: ChildHandle[], mode: 'all' | 'any' = 'all'): Promise<ChildResult[]> {
    const work = mode === 'all'
      ? Promise.all(handles.map((h) => h.result))
      : Promise.race(handles.map((h) => h.result)).then((r) => [r]);
    return this.manager.withoutSlot(this.task, work).finally(() => this.manager.tasks.touch(this.task.taskId));
  }

  idleWait<T>(promise: Promise<T>): Promise<T> {
    return this.manager.withoutSlot(this.task, promise).finally(() => this.manager.tasks.touch(this.task.taskId));
  }

  async retry(handle: ChildHandle, changes: Partial<SpawnRequest> = {}): Promise<ChildHandle> {
    const original = this.manager.originalRequest(handle.taskId);
    if (!original) throw new SpawnRejectedError('UNKNOWN_CHILD', [`no request recorded for ${handle.taskId}`]);
    const { parentAgentId: _p, parentTaskId: _t, rootTaskId: _r, ...rest } = original;
    return this.spawn({ ...rest, ...changes, retryOf: handle.taskId });
  }

  cancelChild(handle: ChildHandle, reason: string): void {
    const t = this.manager.tasks.get(handle.taskId);
    if (t?.parentTaskId === this.task.taskId) this.manager.tasks.cancel(handle.taskId, reason, 'parent');
  }

  children(): ChildHandle[] {
    return this.manager.childHandlesOf(this.task.taskId);
  }

  // ── Work ───────────────────────────────────────────────────────────────────

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.checkpoint();
    const tools = this.manager.toolSource();
    const check = checkCall(this.agent.permissions, name, args, tools);
    if (!check.allowed) {
      const reason = check.reason ?? 'not allowed';
      this.manager.emitTask('PERMISSION_DENIED', this.task, { tool: name, action: args['action'] ?? null, code: check.code, reason });
      securityAuditLogger.denied(name, `LEVEL_${check.risk}`, `Agent ${this.agent.agentId}: ${reason}`, name);
      return { success: false, output: `Refused: ${reason}.`, error: check.code, tool: name, durationMs: 0 };
    }
    this.manager.charge(this.task.taskId, 'toolCalls', 1);
    this.manager.tasks.touch(this.task.taskId);
    try {
      return await tools.execute(name, args, this.signal);
    } finally {
      this.manager.tasks.touch(this.task.taskId);
    }
  }

  async llm(request: Omit<ILLMRequest, 'signal'>): Promise<ILLMResponse> {
    this.checkpoint();
    const left = this.manager.remainingBudget(this.task.taskId);
    if (left.tokens <= 0) throw new BudgetExceededError('tokens', this.task.taskId);
    this.manager.charge(this.task.taskId, 'llmCalls', 1);
    this.manager.tasks.touch(this.task.taskId);
    const response = await this.manager.withLlmSlot(this.task, () => modelRouter.chat({ ...request, signal: this.signal }));
    this.manager.charge(this.task.taskId, 'tokens', response.usage?.totalTokens ?? 0, false);
    this.manager.tasks.touch(this.task.taskId);
    return response;
  }

  // ── Sharing ────────────────────────────────────────────────────────────────

  addSource(input: Omit<Source, 'id' | 'retrievedAt' | 'addedBy'>): Source {
    this.manager.tasks.touch(this.task.taskId);
    return this.workspace.addSource(input, this.agent.agentId).source;
  }

  addFinding(input: { text: string; sourceIds?: string[]; confidence: number; tags?: string[]; data?: Record<string, unknown> }): Finding {
    this.manager.tasks.touch(this.task.taskId);
    return this.workspace.addFinding(input, this.by()).finding;
  }

  addClaim(input: { subject: string; attribute: string; value: string; sourceIds?: string[]; confidence: number }): { claim: Claim; conflict?: Conflict } {
    this.manager.tasks.touch(this.task.taskId);
    return this.workspace.addClaim(input, this.by());
  }

  addArtifact(input: { name: string; description?: string; parts: WorkspaceArtifact['parts'] }): WorkspaceArtifact {
    this.manager.tasks.touch(this.task.taskId);
    return this.workspace.addArtifact({ ...input, producedBy: this.agent.agentId, taskId: this.task.taskId });
  }

  progress(note: string, percent?: number): void {
    this.manager.tasks.setProgress(this.task.taskId, note, percent);
    this.workspace.setProgress({ taskId: this.task.taskId, agentId: this.agent.agentId, note, at: Date.now(), ...(percent !== undefined ? { percent } : {}) });
    this.manager.emitTask('PROGRESS_UPDATE', this.task, { note, ...(percent !== undefined ? { percent } : {}) });
  }

  sendMessage(to: string, kind: AgentMessage['kind'], text: string, data?: Record<string, unknown>, opts: MessageOptions = {}): AgentMessage {
    const allowed = this.manager.messageTargets(this.task);
    if (!allowed.has(to)) {
      const reason = `${this.agent.agentId} may message only its parent, children and siblings, not ${to}`;
      this.manager.emitTask('PERMISSION_DENIED', this.task, { code: 'MESSAGE_NOT_ALLOWED', reason, to });
      throw new Error(reason);
    }
    if (this.manager.hasEnded(this.task.rootTaskId, to)) {
      throw new Error(`${to} has finished its task; a message to it would never be read`);
    }
    const message: AgentMessage = {
      id: randomUUID(), from: this.agent.agentId, to, rootTaskId: this.task.rootTaskId, taskId: this.task.taskId,
      ...(this.task.parentTaskId ? { parentTaskId: this.task.parentTaskId } : {}),
      kind, text, ...(data ? { data } : {}),
      ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.error ? { error: opts.error } : {}),
      at: Date.now(),
    };
    this.manager.deliver(message);
    this.manager.tasks.touch(this.task.taskId);
    return message;
  }

  requestDelegation(childRole: string, description: string, reason: string): AgentMessage {
    if (!this.task.parentAgentId) throw new Error('JARVIS has no parent to ask');
    return this.sendMessage(this.task.parentAgentId, 'delegation_request', description, { childRole, reason });
  }

  inbox(): AgentMessage[] {
    return this.manager.inbox(this.agent.agentId).filter((m) => m.rootTaskId === this.task.rootTaskId);
  }

  onMessage(handler: (m: AgentMessage) => void): () => void {
    return this.manager.events.subscribe({ rootTaskId: this.task.rootTaskId, types: ['AGENT_MESSAGE'] }, (e) => {
      if (e.data['to'] !== this.agent.agentId) return;
      const m = this.manager.inbox(this.agent.agentId).find((x) => x.id === e.data['messageId']);
      if (m) handler(m);
    });
  }

  onEvent(filter: Omit<AgentEventFilter, 'rootTaskId'>, handler: (e: AgentEvent) => void, opts: { replay?: boolean } = {}): () => void {
    const full = { ...filter, rootTaskId: this.task.rootTaskId };
    // Replay and subscribe in one synchronous step: no event can fall between them.
    if (opts.replay) {
      for (const e of [...this.workspace.events]) {
        if (!matches(e, full)) continue;
        try { handler(e); } catch (err) { console.warn(`[Agents] Replay handler failed on ${e.type}: ${errorMessage(err)}`); }
      }
    }
    return this.manager.events.subscribe(full, handler);
  }
}

/** Exposed for tests of the scope rules. */
export { isSubsetScope };

export const agentManager = new AgentManager();
