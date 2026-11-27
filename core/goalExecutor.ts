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
      // A used-up tool budget is its own condition, not a model failure (owner, 2026-11-16).
      const goalCode = (c: { code: string; budget?: string }) => (c.code === 'BUDGET_EXCEEDED' && c.budget === 'toolCalls' ? 'TOOL_BUDGET_EXHAUSTED' : c.code);
      const code = err ? goalCode(err) : undefined;
      // Every distinct cause is passed on (review LR-2).
      const causes = [...new Set((err?.causes ?? []).map(goalCode))];
      return { ok: false, result, usage, failure: { message: err?.message ?? (r.answer || 'the agent could not finish'), ...(code ? { code } : {}), ...(causes.length > 1 ? { causes } : {}) } };
    }
    if (!result.summary) return { ok: false, result, usage, failure: { class: 'evidence', message: 'the agent finished without a result' } };
    // A step that tried to keep a fact did not keep it, whatever its text says (owner, 2026-11-17, L-3):
    // save_relation stores nothing inside a goal.
    const notStored = memoryNotStored(r.limitations, task.specialist, task.description);
    if (notStored) return { ok: false, result, usage, failure: { class: 'inconclusive', code: 'MEMORY_NOT_STORED', message: notStored } };

    if (this.opts.verify !== false) {
      const { shouldVerify, verifyRootResult } = await import('./agents/jarvisAgents.js');
      if (shouldVerify(r)) {
        const v = await verifyRootResult(r, goal.objective ?? goal.description, manager);
        result.verification = v ? { verdict: v.verdict, note: v.checks.filter((c) => !c.ok).map((c) => c.note).join('; ').slice(0, 300) } : { verdict: 'not verified', note: 'the check did not finish' };
        if (v?.verdict === 'issues') {
          return { ok: false, result, usage, failure: { class: 'evidence', message: `the Verification agent found issues: ${result.verification.note}` } };
        }
        // A check that did not happen, or a verification that did not finish: the owner reviews it (D-1).
        if (!v || v.verdict === 'inconclusive') {
          return { ok: false, result, usage, failure: { code: 'VERIFICATION_INCONCLUSIVE', message: `the Verification agent could not check everything: ${result.verification.note || 'the check did not finish'}` } };
        }
      }
    }
    return { ok: true, result, usage };
  }

  inspectPrevious(rootTaskId: string): PreviousRun | undefined {
    try {
      const dir = this.opts.manager?.archiveDir() ?? path.join(dataRoot(getWorkspaceRoot()), 'data', 'agents');
      const body = JSON.parse(fs.readFileSync(path.join(dir, `${rootTaskId}.json`), 'utf8')) as {
        status: string; result?: RootResult; workspace?: { findings?: { text: string }[] }; request?: string; agents?: { role?: string }[];
      };
      const findings = (body.result?.findings ?? body.workspace?.findings ?? []).map((f) => f.text).slice(0, 5);
      // A step that did not keep its fact is not taken back as done (review L-2); it runs again and says so.
      const memoryStep = (body.agents ?? []).some((a) => a.role === 'memory_agent');
      const notStored = memoryNotStored(body.result?.limitations ?? [], memoryStep ? 'memory_agent' : '', body.request ?? '');
      return {
        status: body.status,
        ...(body.status === 'COMPLETED' && body.result && !notStored ? { result: taskResultFrom({ ...body.result, specialist: { role: 'archived' } }, [], 'archive') } : {}),
        findings,
      };
    } catch {
      return undefined;
    }
  }
}

/**
 * The start of a step: an optional "First,", "Then", "Next,", "Finally,",
 * "Also" or "And", then an optional "please" (LL-2). Only the start of the
 * step is read; a request later in its text is not (owner decision D-2).
 */
const STEP_START = String.raw`^\s*(?:(?:first|then|next|finally|also|and)\b\s*,?\s*)?(?:please\s+)?`;
/** "Remember what …", "note which …": reading what is remembered, not keeping something (final review L-7). */
const RECALL_STEP = new RegExp(STEP_START + String.raw`(?:remember|note|recall)\s+(?:what|which|whether|how|if|when|where|who|why)\b`, 'i');
/**
 * A value after a colon makes it a keep step: "Remember who the manager is: Sara" (LL-2, owner decision D-3).
 * The colon in a time ("at 10:30") or a web address ("https://") is not one (review, PR #2).
 */
const GIVES_VALUE = /(?<!\d):(?!\/\/)\s*\S|\d:(?![\d/])\s*\S/;
/**
 * A step that starts by asking to keep something (LL-2). "Remember to …" and
 * "don't forget to …" are instructions, "keep in mind" is not keeping; "add",
 * "record", "store" and "save" ask to keep only with "that", the user's or
 * owner's, my/our/this/these/it/fact, or "the/a … : value" ("save time",
 * "store hours: …", "record the answer" are not). "Note that …" stays a keep
 * step (owner decision D-1).
 */
const KEEP_STEP = new RegExp(STEP_START + String.raw`(?:remember\b(?!\s+to\b)|(?:don'?t|do not) forget\b(?!\s+to\b)|note\b|memori[sz]e\b|make a note\b|make sure to remember\b|log that\b|write down\b|learn that\b|persist\b|keep track of\b|(?:record|store|save|add)\s+(?:that\b|(?:the\s+)?(?:user|owner)'?s?\b|(?:my|our|this|these|it|facts?)\b|(?:the|a|an)\s+[^:.?!]*:\s*\S))`, 'i');
/** A step that starts with "keep, store, save, add, record or put … in memory" (not "list what you store in memory"). */
const IN_MEMORY_STEP = new RegExp(STEP_START + String.raw`(?:keep|store|save|add|record|put)\b[^.?!]*\b(?:in|to|into)\s+(?:long-term\s+)?memory\b`, 'i');
/** "Update / set / change the (user's) profile, preference(s) or memory" (not "update the user on …"). */
const PROFILE_STEP = new RegExp(STEP_START + String.raw`(?:update|set|change)\s+(?:the\s+)?(?:(?:user|owner)'?s?\s+|my\s+)?(?:profile|preferences?|(?:long-term\s+)?memory)\b`, 'i');

/** A goal step asked to keep a fact (English phrasing only, read from its start; final review L-7, LL-2). */
function isRememberStep(description: string): boolean {
  if (RECALL_STEP.test(description) && !GIVES_VALUE.test(description)) return false;
  return KEEP_STEP.test(description) || IN_MEMORY_STEP.test(description) || PROFILE_STEP.test(description);
}

/**
 * Why a goal step did not keep a fact (owner, 2026-11-17, L-3; review L-1, L-2):
 * save_relation's own failure (only its entry, not any text that mentions it),
 * or a Memory-agent step asked to keep one, since nothing is stored inside a goal.
 */
function memoryNotStored(limitations: readonly string[], specialist: string, description: string): string | undefined {
  const failed = limitations.find((l) => /^Tool refused or failed: save_relation:/.test(l));
  if (failed) return `the fact was not stored in long-term memory: ${failed.replace(/^Tool refused or failed:\s*/, '').slice(0, 200)}`;
  if (specialist === 'memory_agent' && isRememberStep(description)) {
    return 'the fact was not stored in long-term memory: inside a goal nothing is stored there; tell me the fact yourself to keep it';
  }
  return undefined;
}
