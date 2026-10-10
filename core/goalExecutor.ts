/**
 * core/goalExecutor.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs one goal-task through the existing agent system (core/agents): a root
 * task for the task's specialist, started over the in-process A2A server like
 * delegate_task, which may create workers within the agent
 * limits, message them over the in-process A2A layer and run them in
 * parallel. Every tool call still passes the registry, the risk engine and
 * the approval gate; the root task carries the goal and task ids, so an
 * approval request says which goal asks (core/agents/agentScope.ts).
 *
 * The outcome is judged here, not taken on trust:
 *   - an approval this root task asked for that was denied, or not answered,
 *     makes the task fail as `approval` (denied → blocked; unanswered →
 *     waiting), whatever the agent's summary says;
 *   - research, data and engineering results get the Verification agent's
 *     check (jarvisAgents.verifyRootResult); "issues" is an evidence failure;
 *   - a cancelled root task is reported as interrupted.
 *
 * After a restart, inspectPrevious() reads the agent archive
 * (data/agents/<root>.json) so the runtime can take a result that finished
 * before the restart instead of running the task again.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskResult } from './goalLifecycle.js';
import { dataRoot, getWorkspaceRoot } from './workspaceRoot.js';
import type { ExecOutcome, ExecRequest, GoalTaskExecutor, PreviousRun } from './goalRuntime.js';
import type { AgentManager, RootResult } from './agents/agentManager.js';
import { A2AServer, InProcessA2AClient, userMessage } from './agents/a2a.js';
import type { A2ATask, ResourceUsage } from './agents/types.js';

const ZERO: ResourceUsage = { llmCalls: 0, toolCalls: 0, tokens: 0 };

/** The root task's result once it has ended (its end event comes after the result is set). */
function waitForRoot(manager: AgentManager, rootTaskId: string): Promise<RootResult> {
  const done = manager.rootResult(rootTaskId);
  if (done) return Promise.resolve(done);
  return new Promise((resolve) => {
    const off = manager.events.subscribe({ rootTaskId, types: ['TASK_COMPLETED', 'TASK_FAILED', 'TASK_CANCELLED', 'TASK_TIMED_OUT'] }, () => {
      setImmediate(() => {
        const r = manager.rootResult(rootTaskId);
        if (r) { off(); resolve(r); }
      });
    });
    // It may have ended between the first look and the subscription.
    const late = manager.rootResult(rootTaskId);
    if (late) { off(); resolve(late); }
  });
}

export interface AgentGoalExecutorOptions {
  manager?: AgentManager;
  /** Run the Verification agent on research, data and engineering results (default on; JARVIS_AGENT_VERIFY=0 turns it off). */
  verify?: boolean;
  /** How long one task may run (default: the agent root lifetime). */
  timeoutMs?: number;
}

/** A root result as a goal-task result. */
export function taskResultFrom(r: Pick<RootResult, 'status' | 'answer' | 'confidence' | 'findings' | 'sources' | 'conflicts'> & { specialist?: { role: string; usage?: ResourceUsage } }, agents: string[] = [], origin: TaskResult['origin'] = 'run'): TaskResult {
  return {
    status: r.status,
    summary: (r.answer ?? '').trim(),
    confidence: Number.isFinite(r.confidence) ? r.confidence : 0,
    findings: (r.findings ?? []).slice(0, 10).map((f) => f.text.slice(0, 300)),
    sources: (r.sources ?? []).slice(0, 10).map((s) => ({ title: s.title, ...(s.url ? { url: s.url } : {}) })),
    agent: r.specialist?.role ?? 'unknown',
    ...(agents.length ? { agents } : {}),
    conflicts: (r.conflicts ?? []).length,
    ...(r.specialist?.usage ? { usage: r.specialist.usage } : {}),
    finishedAt: Date.now(),
    origin,
  };
}

export class AgentGoalExecutor implements GoalTaskExecutor {
  private own?: { manager: AgentManager; client: InProcessA2AClient };

  constructor(private readonly opts: AgentGoalExecutorOptions = {}) {}

  /** The agent manager and an in-process A2A client to it (JARVIS's own, or the one given). */
  private async system(): Promise<{ manager: AgentManager; client: InProcessA2AClient }> {
    if (this.opts.manager) {
      if (!this.own) {
        const { registerAgentRoles } = await import('./agents/specialists.js');
        registerAgentRoles(this.opts.manager);
        this.own = { manager: this.opts.manager, client: new InProcessA2AClient(new A2AServer(this.opts.manager)) };
      }
      return this.own;
    }
    const { ensureAgentSystem, a2a } = await import('./agents/jarvisAgents.js');
    await ensureAgentSystem();
    const { agentManager } = await import('./agents/agentManager.js');
    return { manager: agentManager, client: a2a().client };
  }

  async run(req: ExecRequest): Promise<ExecOutcome> {
    const { goal, task, signal } = req;
    const { manager, client } = await this.system();
    if (signal.aborted) return { ok: false, failure: { class: 'interrupted', message: 'stopped before it started' }, usage: ZERO };

    // A root task for the specialist, through the in-process A2A server (as
    // delegate_task does). The task's own words are the request: research
    // reads them as its question, approvals show them as WHY with the goal
    // named under them. Goal context goes as structured data, not into the
    // text: the Data agent parses the text; the tool loop shows data as context.
    let rootTaskId: string;
    try {
      const res = await client.sendMessage(task.specialist, {
        message: userMessage(task.description, { question: task.description, ...(req.context ? { goalContext: req.context } : {}) }, {
          jarvis: {
            source: goal.source,
            priority: goal.priority,
            ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
            goal: { goalId: goal.id, goalTaskId: task.id, title: goal.description.slice(0, 100) },
            budget: req.budget,
          },
        }),
        configuration: { returnImmediately: true },
      });
      rootTaskId = (res as { task: A2ATask }).task.contextId;
    } catch (err) {
      const e = err as Error & { data?: { code?: string } };
      return { ok: false, failure: { message: e.message, ...(e.data?.code ? { code: e.data.code } : {}) }, usage: ZERO };
    }
    req.onStarted(rootTaskId);

    // Who worked on it: the specialist and every worker it created.
    const agents: string[] = [task.specialist];
    const off = manager.events.subscribe({ rootTaskId, types: ['AGENT_CREATED'] }, (e) => {
      const name = String(e.data['name'] ?? e.agentId ?? '');
      if (name && !agents.includes(name)) agents.push(name);
    });
    const onAbort = () => manager.cancelRoot(rootTaskId, String((signal.reason as Error)?.message ?? 'goal stopped'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    let r: RootResult;
    try {
      r = await waitForRoot(manager, rootTaskId);
    } finally {
      signal.removeEventListener('abort', onAbort);
      off();
    }
    // Workers created before the subscription above are read from the run's records.
    const queue = [task.specialist];
    while (queue.length) {
      const id = queue.shift()!;
      for (const k of manager.spawnedBy(rootTaskId, id)) {
        if (!agents.includes(k.name)) { agents.push(k.name); queue.push(k.agentId); }
      }
    }
    const usage = r.specialist?.usage ?? ZERO;
    const result = taskResultFrom(r, agents);

    // Approvals this root task asked for decide before anything else.
    const { approvalGate } = await import('../security/approvalGate.js');
    const refused = approvalGate.recentDecisions(50).filter((d) => d.rootTaskId === rootTaskId && !d.approved);
    if (refused.length) {
      const unanswered = refused.every((d) => d.by === 'timeout' || d.by === 'unavailable');
      const d = refused[refused.length - 1]!;
      return {
        ok: false, result, usage,
        failure: {
          class: 'approval', code: 'APPROVAL_DENIED',
          approval: unanswered ? (d.by === 'unavailable' ? 'unavailable' : 'timeout') : 'denied',
          message: `${d.action} on ${d.target} was ${unanswered ? 'not answered' : 'not approved'}`,
        },
      };
    }

    if (r.status === 'CANCELLED') {
      return { ok: false, result, usage, failure: { class: 'interrupted', code: 'CANCELLED', message: r.limitations.find((l) => l.startsWith('Stopped')) ?? 'the agent work was stopped' } };
    }
    if (r.status === 'TIMED_OUT') return { ok: false, result, usage, failure: { code: 'TIMED_OUT', message: 'the agents ran out of time' } };
    if (r.status !== 'COMPLETED') {
      const err = r.specialist?.error;
      return { ok: false, result, usage, failure: { message: err?.message ?? (r.answer || 'the agent could not finish'), ...(err?.code ? { code: err.code } : {}) } };
    }
    if (!result.summary) return { ok: false, result, usage, failure: { class: 'evidence', message: 'the agent finished without a result' } };

    if (this.opts.verify !== false) {
      const { shouldVerify, verifyRootResult } = await import('./agents/jarvisAgents.js');
      if (shouldVerify(r)) {
        const v = await verifyRootResult(r, goal.objective ?? goal.description, manager);
        result.verification = v ? { verdict: v.verdict, note: v.checks.filter((c) => !c.ok).map((c) => c.note).join('; ').slice(0, 300) } : { verdict: 'not verified', note: 'the check did not finish' };
        if (v?.verdict === 'issues') {
          return { ok: false, result, usage, failure: { class: 'evidence', message: `the Verification agent found issues: ${result.verification.note}` } };
        }
      }
    }
    return { ok: true, result, usage };
  }

  inspectPrevious(rootTaskId: string): PreviousRun | undefined {
    try {
      const dir = this.opts.manager?.archiveDir() ?? path.join(dataRoot(getWorkspaceRoot()), 'data', 'agents');
      const body = JSON.parse(fs.readFileSync(path.join(dir, `${rootTaskId}.json`), 'utf8')) as {
        status: string; result?: RootResult; workspace?: { findings?: { text: string }[] };
      };
      const findings = (body.result?.findings ?? body.workspace?.findings ?? []).map((f) => f.text).slice(0, 5);
      return {
        status: body.status,
        ...(body.status === 'COMPLETED' && body.result ? { result: taskResultFrom({ ...body.result, specialist: { role: 'archived' } }, [], 'archive') } : {}),
        findings,
      };
    } catch {
      return undefined;
    }
  }
}
