/**
 * core/agents/taskManager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Task records of the multi-agent system: lineage (task, parent task, root
 * task, agent, parent agent), status, dependencies, results, deadlines and
 * cancellation.
 *
 *  - Dependencies: a task starts only when every task it depends on has
 *    COMPLETED; it then receives their results. A dependency that ends in
 *    any other way fails the dependent task (DEPENDENCY_FAILED). A dependency
 *    that would close a cycle is refused when it is added (swarms-rs's check,
 *    RECURSIVE_AGENT_RESEARCH.md §4.13), not discovered while running.
 *  - Cancellation: every task has an AbortController. Cancelling a task
 *    cancels every unfinished task below it, so nothing is orphaned.
 *  - Deadlines: each task has one (never later than its parent's). When it
 *    passes, the task is stopped as TIMED_OUT.
 *  - Idle watchdog: a RUNNING task with no activity for idleTimeoutMs is
 *    stopped as stalled (Hermes's progress-based check, research §4.3).
 *
 * The task manager records and signals; agentManager.ts runs the work and
 * sets the final status when the work has stopped.
 */

import { randomUUID } from 'node:crypto';
import type { AgentTaskRecord, CancellationState, ChildResult, LifecycleState } from './types.js';
import { isTerminal } from './types.js';
import type { AgentEventHub } from './events.js';

/** Allowed status changes. Anything else is a bug and is refused. */
const TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  CREATED: ['VALIDATING', 'STARTING', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  VALIDATING: ['STARTING', 'CREATED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  STARTING: ['RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  RUNNING: ['WAITING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  WAITING: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};

export class DependencyFailedError extends Error {
  readonly code = 'DEPENDENCY_FAILED';
  constructor(readonly dependencyTaskId: string, readonly dependencyStatus: LifecycleState) {
    super(`Task ${dependencyTaskId} it depends on ended ${dependencyStatus}.`);
    this.name = 'DependencyFailedError';
  }
}

export interface NewTaskInput {
  parentTaskId?: string;
  rootTaskId?: string;
  agentId: string;
  parentAgentId?: string;
  role: string;
  description: string;
  input?: Record<string, unknown>;
  priority?: number;
  dependencies?: string[];
  deadline: number;
  attempt?: number;
  retryOf?: string;
  reason?: string;
}

export class AgentTaskManager {
  private tasks = new Map<string, AgentTaskRecord>();
  private controllers = new Map<string, AbortController>();
  private deadlineTimers = new Map<string, NodeJS.Timeout>();
  private watchdog: NodeJS.Timeout | undefined;
  private idleTimeoutMs = 120_000;
  /** Called when a deadline or the idle watchdog stops a task. */
  onTimeout: (task: AgentTaskRecord, by: 'timeout' | 'idle') => void = () => {};

  constructor(private readonly events: AgentEventHub) {}

  setIdleTimeout(ms: number): void {
    this.idleTimeoutMs = ms;
  }

  // ── Creation and lookup ────────────────────────────────────────────────────

  /** Validates lineage and dependencies, then records the task as CREATED. */
  create(input: NewTaskInput): AgentTaskRecord {
    const parent = input.parentTaskId ? this.tasks.get(input.parentTaskId) : undefined;
    if (input.parentTaskId && !parent) throw new Error(`Parent task ${input.parentTaskId} does not exist.`);
    if (parent && isTerminal(parent.status)) throw new Error(`Parent task ${parent.taskId} has already ended (${parent.status}).`);
    const taskId = `task-${randomUUID()}`;
    const rootTaskId = parent ? parent.rootTaskId : (input.rootTaskId ?? taskId);
    const deps = [...new Set(input.dependencies ?? [])];
    for (const d of deps) {
      const dep = this.tasks.get(d);
      if (!dep) throw new Error(`Dependency ${d} does not exist.`);
      if (dep.rootTaskId !== rootTaskId) throw new Error(`Dependency ${d} belongs to another root task.`);
    }
    const now = Date.now();
    const deadline = parent ? Math.min(input.deadline, parent.deadline) : input.deadline;
    const record: AgentTaskRecord = {
      taskId,
      ...(parent ? { parentTaskId: parent.taskId } : {}),
      rootTaskId,
      agentId: input.agentId,
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
      role: input.role,
      description: input.description,
      ...(input.input ? { input: input.input } : {}),
      status: 'CREATED',
      createdAt: now,
      priority: Math.max(1, Math.min(10, Math.round(input.priority ?? 5))),
      dependencies: deps,
      errors: [],
      cancellation: { requested: false },
      deadline,
      depth: parent ? parent.depth + 1 : 0,
      attempt: input.attempt ?? 1,
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      lastActivityAt: now,
    };
    this.tasks.set(taskId, record);

    // The controller follows the parent's: cancelling a parent stops the child.
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    const parentSignal = parent ? this.controllers.get(parent.taskId)?.signal : undefined;
    if (parentSignal) {
      const follow = () => this.cancel(taskId, 'parent task stopped', 'parent');
      if (parentSignal.aborted) queueMicrotask(follow);
      else parentSignal.addEventListener('abort', follow, { once: true });
    }

    const delay = Math.max(0, deadline - now);
    const timer = setTimeout(() => this.expire(taskId, 'timeout'), delay);
    timer.unref?.();
    this.deadlineTimers.set(taskId, timer);
    this.ensureWatchdog();
    return record;
  }

  get(taskId: string): AgentTaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  signal(taskId: string): AbortSignal {
    const c = this.controllers.get(taskId);
    if (!c) throw new Error(`Task ${taskId} has no controller.`);
    return c.signal;
  }

  all(rootTaskId?: string): AgentTaskRecord[] {
    const list = [...this.tasks.values()];
    return rootTaskId ? list.filter((t) => t.rootTaskId === rootTaskId) : list;
  }

  children(taskId: string): AgentTaskRecord[] {
    return [...this.tasks.values()].filter((t) => t.parentTaskId === taskId);
  }

  /** Every task below `taskId`, depth first. */
  descendants(taskId: string): AgentTaskRecord[] {
    const out: AgentTaskRecord[] = [];
    const walk = (id: string) => {
      for (const c of this.children(id)) { out.push(c); walk(c.taskId); }
    };
    walk(taskId);
    return out;
  }

  // ── Dependencies ───────────────────────────────────────────────────────────

  /** Whether `taskId` (transitively) depends on `onTaskId`. */
  dependsOn(taskId: string, onTaskId: string): boolean {
    const seen = new Set<string>();
    const stack = [taskId];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === onTaskId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(this.tasks.get(id)?.dependencies ?? []));
    }
    return false;
  }

  /** Adds a dependency after creation; refused if it would create a cycle. */
  addDependency(taskId: string, dependencyId: string): void {
    const task = this.tasks.get(taskId);
    const dep = this.tasks.get(dependencyId);
    if (!task || !dep) throw new Error('Unknown task in dependency.');
    if (task.status !== 'CREATED') throw new Error(`Task ${taskId} has already started.`);
    if (taskId === dependencyId || this.dependsOn(dependencyId, taskId)) {
      throw new Error(`Dependency ${taskId} → ${dependencyId} would create a cycle.`);
    }
    if (!task.dependencies.includes(dependencyId)) task.dependencies.push(dependencyId);
  }

  /** Dependencies not finished yet. */
  pendingDependencies(taskId: string): string[] {
    const task = this.tasks.get(taskId);
    return (task?.dependencies ?? []).filter((d) => this.tasks.get(d)?.status !== 'COMPLETED');
  }

  /**
   * Resolves with the dependencies' results once all have COMPLETED; rejects
   * with DependencyFailedError when one ends otherwise, or when `signal` aborts.
   */
  whenReady(taskId: string, signal: AbortSignal): Promise<Record<string, ChildResult>> {
    const task = this.tasks.get(taskId);
    if (!task) return Promise.reject(new Error(`Unknown task ${taskId}`));
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (err?: Error) => {
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
        if (err) { reject(err); return; }
        const results: Record<string, ChildResult> = {};
        for (const d of task.dependencies) {
          const r = this.tasks.get(d)?.result;
          if (r) results[d] = r;
        }
        resolve(results);
      };
      const check = (): boolean => {
        for (const d of task.dependencies) {
          const dep = this.tasks.get(d);
          if (!dep) { finish(new Error(`Dependency ${d} disappeared.`)); return true; }
          if (isTerminal(dep.status) && dep.status !== 'COMPLETED') {
            finish(new DependencyFailedError(d, dep.status));
            return true;
          }
        }
        if (this.pendingDependencies(taskId).length === 0) { finish(); return true; }
        return false;
      };
      const onAbort = () => finish(Object.assign(new Error('Cancelled while waiting for dependencies'), { name: 'AbortError' }));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      if (check()) return;
      unsubscribe = this.events.subscribe(
        { rootTaskId: task.rootTaskId, taskIds: task.dependencies, types: ['TASK_COMPLETED', 'TASK_FAILED', 'TASK_CANCELLED', 'TASK_TIMED_OUT'] },
        () => { check(); },
      );
    });
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  /** Changes the status; refuses changes the lifecycle does not allow. */
  transition(taskId: string, to: LifecycleState): AgentTaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    const from = task.status;
    if (from === to) return task;
    if (!TRANSITIONS[from].includes(to)) throw new Error(`Task ${taskId}: ${from} → ${to} is not allowed.`);
    task.status = to;
    const now = Date.now();
    task.lastActivityAt = now;
    if (to === 'RUNNING' && !task.startedAt) task.startedAt = now;
    if (isTerminal(to)) {
      task.completedAt = now;
      this.clearTimer(taskId);
    }
    this.events.emit('AGENT_STATE_CHANGED', task.rootTaskId,
      { taskId, agentId: task.agentId, parentAgentId: task.parentAgentId }, { from, to });
    return task;
  }

  touch(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.lastActivityAt = Date.now();
  }

  setProgress(taskId: string, note: string, percent?: number): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.progress = { note, at: Date.now(), ...(percent !== undefined ? { percent: Math.max(0, Math.min(100, percent)) } : {}) };
    task.lastActivityAt = Date.now();
  }

  setResult(taskId: string, result: ChildResult): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.result = result;
    task.confidence = result.confidence;
    if (result.error) task.errors.push(`${result.error.code}: ${result.error.message}`);
  }

  // ── Cancellation and time limits ───────────────────────────────────────────

  /**
   * Requests cancellation of a task and every unfinished task below it. The
   * work stops at its next await; agentManager sets the final status.
   */
  cancel(taskId: string, reason: string, by: NonNullable<CancellationState['by']>): void {
    const task = this.tasks.get(taskId);
    if (!task || isTerminal(task.status)) return;
    if (!task.cancellation.requested) {
      task.cancellation = { requested: true, reason, by, at: Date.now() };
    }
    // Children first are marked by their own listeners on this signal.
    this.controllers.get(taskId)?.abort(Object.assign(new Error(reason), { name: 'AbortError', by }));
  }

  private expire(taskId: string, by: 'timeout' | 'idle'): void {
    const task = this.tasks.get(taskId);
    if (!task || isTerminal(task.status)) return;
    const reason = by === 'timeout'
      ? `deadline passed after ${Math.round((Date.now() - task.createdAt) / 1000)} s`
      : `no activity for ${Math.round(this.idleTimeoutMs / 1000)} s`;
    task.cancellation = { requested: true, reason, by, at: Date.now() };
    this.onTimeout(task, by);
    this.controllers.get(taskId)?.abort(Object.assign(new Error(reason), { name: 'AbortError', by }));
  }

  private ensureWatchdog(): void {
    if (this.watchdog) return;
    const period = Math.max(50, Math.min(1_000, Math.floor(this.idleTimeoutMs / 4)));
    this.watchdog = setInterval(() => this.checkIdle(), period);
    this.watchdog.unref?.();
  }

  /** RUNNING tasks without activity for idleTimeoutMs stop as stalled. WAITING tasks are not idle. */
  checkIdle(now = Date.now()): void {
    let live = 0;
    for (const t of this.tasks.values()) {
      if (isTerminal(t.status)) continue;
      live++;
      if (t.status === 'RUNNING' && now - t.lastActivityAt >= this.idleTimeoutMs) this.expire(t.taskId, 'idle');
    }
    if (!live && this.watchdog) { clearInterval(this.watchdog); this.watchdog = undefined; }
  }

  private clearTimer(taskId: string): void {
    const timer = this.deadlineTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.deadlineTimers.delete(taskId);
  }

  /** Forgets a finished root task's records (they stay in the archive). */
  forgetRoot(rootTaskId: string): AgentTaskRecord[] {
    const removed: AgentTaskRecord[] = [];
    for (const t of [...this.tasks.values()]) {
      if (t.rootTaskId !== rootTaskId) continue;
      this.clearTimer(t.taskId);
      this.tasks.delete(t.taskId);
      this.controllers.delete(t.taskId);
      removed.push(t);
    }
    return removed;
  }
}
