/**
 * core/goalRuntime.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The Goal Runtime: turns stored goals into work, in the background, without
 * waiting for the user to say anything (docs/GOAL_RUNTIME.md).
 *
 *   goalManager (store, lifecycle) ─► GoalRuntime ─► planner (tasks)
 *                                        │
 *                                        ├─► executor ─► agentManager root task
 *                                        │                (specialist, workers, A2A,
 *                                        │                 tools, risk engine, approvals)
 *                                        └─► verifier (success criteria)
 *
 * How it runs:
 *   - It wakes when a goal is created, resumed or signalled, when a task
 *     finishes, and on one timer set for the next due time (capped, unref'd so
 *     it never keeps the process alive). There is no polling loop.
 *   - Each wake runs one step: pick eligible work (priority, then deadline,
 *     then age), claim it (a lease written to disk before the work starts),
 *     and start at most `maxConcurrent` jobs. A job is: plan a goal, run one
 *     task, or evaluate a goal whose tasks have all ended.
 *   - Results are written to disk before the next step uses them. A result
 *     for an attempt that is no longer the task's current one is ignored.
 *   - stop() aborts running jobs (their agents are cancelled), waits briefly,
 *     records what was interrupted, and releases the claims.
 *
 * Goal kinds:
 *   temporary  plan → run tasks (in parallel where independent) → verify the
 *              success criteria → completed, or re-plan with what was learnt,
 *              or failed when attempts run out.
 *   permanent  one milestone at a time; a verified milestone updates progress
 *              and the goal waits for its next cycle (maxCyclesPerDay,
 *              reviewIntervalMs). When milestones run out the planner may
 *              propose the next one. Failed cycles in a row block it.
 *   recurring  at each due time, one temporary instance goal (instance key =
 *              template id @ due time, so a time is never run twice); none
 *              while the previous instance is still active; after downtime,
 *              at most one catch-up run (policy.catchUp).
 *
 * The runtime never calls orchestrator.process(): that path serves the user's
 * own request (and aborts the previous one). Background work goes through the
 * agent system, which runs beside the foreground request.
 */

import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import {
  isTerminalGoalStatus, TERMINAL_TASK_STATUSES,
  type FailureClass, type GoalCriterion, type GoalLesson, type GoalTask, type Milestone, type TaskResult,
} from './goalLifecycle.js';
import { goalKind, goalManager as defaultManager, isManaged, MAX_TASK_ATTEMPTS, newId, type Goal, type GoalManager } from './goalManager.js';
import { classifyFailure, decideRecovery, DEFAULT_RETRY, type FailureInfo, type RetrySettings } from './goalRecovery.js';
import { dueTimesBetween, nextRunAfter } from './goalSchedule.js';
import type { GoalPlanner } from './goalPlanner.js';
import { verifyCriteria, type Judge } from './goalVerifier.js';
import type { ResourceUsage } from './agents/types.js';

// ─── The executor seam ───────────────────────────────────────────────────────

export interface ExecRequest {
  goal: Goal;
  task: GoalTask;
  attemptId: string;
  signal: AbortSignal;
  /** What is left of the goal's budget for this attempt. */
  budget: { llmCalls?: number; toolCalls?: number; tokens?: number };
  /** Goal, constraints, results of the tasks it depends on, earlier partial findings, advice, lessons. */
  context: string;
  /** Called as soon as the agent root task exists, so its id is on disk before the work goes on. */
  onStarted: (rootTaskId: string) => void;
}

export interface ExecOutcome {
  ok: boolean;
  result?: TaskResult;
  failure?: FailureInfo;
  usage?: ResourceUsage;
}

/** What an earlier attempt left behind (core/agents archive), read after a restart. */
export interface PreviousRun {
  status: string;
  result?: TaskResult;
  findings?: string[];
}

export interface GoalTaskExecutor {
  run(req: ExecRequest): Promise<ExecOutcome>;
  inspectPrevious?(rootTaskId: string): PreviousRun | undefined;
}

export interface LearningHooks {
  relevant(goal: Goal, milestone?: Milestone): GoalLesson[];
  onTaskFinished?(goal: Goal, task: GoalTask, cls?: FailureClass): void;
  onGoalFinished?(goal: Goal, outcome: 'completed' | 'failed' | 'milestone' | 'blocked' | 'expired' | 'cancelled'): void;
}

export interface GoalRuntimeEvent {
  type:
    | 'goal_completed' | 'goal_failed' | 'goal_blocked' | 'goal_waiting' | 'goal_expired'
    | 'milestone_completed' | 'milestone_proposed' | 'task_started' | 'task_finished' | 'task_failed'
    | 'instance_created' | 'instance_skipped' | 'planned' | 'recovered';
  goalId: string;
  taskId?: string;
  text: string;
  at: number;
}

export interface GoalRuntimeOptions {
  manager?: GoalManager;
  executor: GoalTaskExecutor;
  planner: GoalPlanner;
  judge?: Judge;
  learning?: LearningHooks;
  /** Jobs at once, across all goals (JARVIS_GOAL_MAX_CONCURRENT, default 2). */
  maxConcurrent?: number;
  /** How long a claim lasts without being renewed (renewed every third of it while the task runs). */
  leaseMs?: number;
  retry?: RetrySettings;
  /** The timer never sleeps longer than this (clock changes, missed wakes). */
  maxSleepMs?: number;
  /** Housekeeping (archive, budget periods, the maintenance hook) this often. */
  maintenanceMs?: number;
  maintenance?: () => Promise<void>;
  /** Waits this long for running jobs at stop() before recording them as interrupted. */
  stopWaitMs?: number;
  now?: () => number;
  ownerId?: string;
}

interface Job {
  kind: 'plan' | 'task' | 'eval' | 'instance';
  goalId: string;
  taskId?: string;
  title: string;
  specialist?: string;
  since: number;
  ac: AbortController;
  done: Promise<void>;
}

const DAY_MS = 86_400_000;
const PERMANENT_REVIEW_MS = DAY_MS;
const PERMANENT_MAX_CYCLES = 4;
const PERMANENT_MAX_FAILURES = 3;
const MAX_TASKS_KEPT = 40;
const EVENTS_KEPT = 100;

function envInt(name: string, fallback: number, min = 1): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

function dayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** A task a newer plan replaced: kept for the record, no longer part of the goal's outcome. */
function isReplaced(t: GoalTask): boolean {
  return t.status === 'cancelled' && t.failures.some((f) => f.action.startsWith('replaced'));
}

/** Loop guard: more jobs than this for one goal within a minute pauses it. */
const LOOP_GUARD_JOBS = 60;

export class GoalRuntime extends EventEmitter {
  readonly owner: string;
  private readonly manager: GoalManager;
  private readonly opts: Required<Pick<GoalRuntimeOptions, 'maxConcurrent' | 'leaseMs' | 'maxSleepMs' | 'maintenanceMs' | 'stopWaitMs'>> & GoalRuntimeOptions;
  private readonly retry: RetrySettings;
  private readonly jobs = new Map<string, Job>();
  private timer: NodeJS.Timeout | undefined;
  private maintTimer: NodeJS.Timeout | undefined;
  private nextWakeAt: number | undefined;
  private started = false;
  private stopping = false;
  private ticking = false;
  private tickAgain = false;
  private wakePending = false;
  private readonly events: GoalRuntimeEvent[] = [];
  private readonly managerListeners: [string, (...a: any[]) => void][] = [];
  /** Jobs whose goal was paused, cancelled or expired while they ran. */
  private readonly abortedFor = new Map<string, string>();

  constructor(opts: GoalRuntimeOptions) {
    super();
    this.manager = opts.manager ?? defaultManager;
    this.opts = {
      maxConcurrent: envInt('JARVIS_GOAL_MAX_CONCURRENT', 2),
      leaseMs: 10 * 60_000,
      maxSleepMs: 5 * 60_000,
      maintenanceMs: 60 * 60_000,
      stopWaitMs: 5_000,
      ...opts,
    };
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.owner = opts.ownerId ?? `${os.hostname()}:${process.pid}:${Date.now().toString(36)}`;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : this.manager.now();
  }

  get isRunning(): boolean {
    return this.started && !this.stopping;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Reconciles what a previous run left, then starts working. */
  async start(): Promise<{ recovered: number; needsReview: number; resumedFromArchive: number }> {
    if (this.started) return { recovered: 0, needsReview: 0, resumedFromArchive: 0 };
    await this.manager.init();
    const report = await this.reconcile();
    const on = (ev: string, fn: (...a: any[]) => void) => { this.manager.on(ev, fn); this.managerListeners.push([ev, fn]); };
    on('goal_created', () => this.wake('goal created'));
    on('goal_resumed', () => this.wake('goal resumed'));
    on('goal_changed', (goal: Goal, _from: string, to: string) => {
      if (!isManaged(goal)) return;
      if (to === 'paused' || to === 'cancelled' || to === 'expired') this.abortGoal(goal.id, to);
      this.wake('goal changed');
    });
    this.started = true;
    this.stopping = false;
    this.maintTimer = setInterval(() => { void this.maintain(); }, this.opts.maintenanceMs);
    this.maintTimer.unref?.();
    this.wake('start');
    return report;
  }

  /** Stops new work, aborts running jobs, records what was interrupted, releases claims. */
  async stop(reason = 'JARVIS is shutting down'): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.maintTimer) clearInterval(this.maintTimer);
    this.timer = undefined;
    this.maintTimer = undefined;
    for (const [ev, fn] of this.managerListeners) this.manager.off(ev, fn);
    this.managerListeners.length = 0;
    const running = [...this.jobs.values()];
    for (const j of running) j.ac.abort(new Error(`INTERRUPTED: ${reason}`));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(running.map((j) => j.done)),
      // A ref'd timer: shutdown must end even if a job never settles.
      new Promise<void>((r) => { timer = setTimeout(r, this.opts.stopWaitMs); }),
    ]);
    if (timer) clearTimeout(timer);
    // Jobs that did not settle in time: recorded as interrupted now.
    for (const j of this.jobs.values()) {
      if (j.kind !== 'task' || !j.taskId) continue;
      const goal = this.manager.getGoal(j.goalId);
      const task = goal?.tasks?.find((t) => t.id === j.taskId);
      if (goal && task && task.status === 'running') this.interruptTask(goal, task, reason);
    }
    this.jobs.clear();
    await this.manager.persistImmediate().catch(() => {});
    this.started = false;
    this.stopping = false;
    this.nextWakeAt = undefined;
  }

  /** Asks for a step soon. Several calls in a row make one step. */
  wake(_reason = ''): void {
    if (!this.started || this.stopping || this.wakePending) return;
    this.wakePending = true;
    setImmediate(() => {
      this.wakePending = false;
      void this.tick();
    });
  }

  /**
   * An authorised event ("monitor and respond"): goals whose triggers include
   * `name` become due now. Called by JARVIS code, never by page or model text.
   */
  signal(name: string, detail = ''): number {
    let n = 0;
    for (const g of this.manager.listGoals({ kinds: ['permanent', 'temporary', 'recurring'] })) {
      if (isTerminalGoalStatus(g.status) || g.status === 'paused' || g.status === 'blocked') continue;
      if (!g.triggers?.includes(name)) continue;
      g.nextRunAt = this.now();
      this.manager.note(g, { event: 'trigger', reason: `${name}${detail ? `: ${detail.slice(0, 120)}` : ''}` });
      this.manager.touch(g);
      n++;
    }
    if (n) this.wake(`signal ${name}`);
    return n;
  }

  /** Runs one step now and waits for it (tests and the status tool). */
  async tick(): Promise<void> {
    if (!this.started || this.stopping) return;
    if (this.ticking) { this.tickAgain = true; return; }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        await this.step();
      } while (this.tickAgain && !this.stopping);
    } catch (err) {
      console.error('[GoalRuntime] Step failed:', err);
    } finally {
      this.ticking = false;
      this.schedule();
    }
  }

  /** Resolves when no job is running and nothing is runnable now (tests). */
  async idle(timeoutMs = 10_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await this.tick();
      if (!this.jobs.size && !this.ticking && !this.hasRunnableWork()) return true;
      await Promise.race([...[...this.jobs.values()].map((j) => j.done), new Promise((r) => setTimeout(r, 20))]);
    }
    return false;
  }

  // ── The step ───────────────────────────────────────────────────────────────

  private managedGoals(): Goal[] {
    return this.manager.listGoals({ kinds: ['temporary', 'permanent', 'recurring'] }).filter((g) => !isTerminalGoalStatus(g.status));
  }

  private jobFor(goalId: string, kind?: Job['kind']): Job | undefined {
    for (const j of this.jobs.values()) if (j.goalId === goalId && (!kind || j.kind === kind)) return j;
    return undefined;
  }

  private goalJobs(goalId: string): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.goalId === goalId) n++;
    return n;
  }

  /** Whether something could start right now (for idle()). */
  private hasRunnableWork(): boolean {
    const now = this.now();
    return this.managedGoals().some((g) => {
      if (g.status === 'paused' || g.status === 'blocked') return false;
      if (g.status === 'waiting' && (g.waitingFor === 'approval' || g.waitingFor === 'review')) return false;
      if ((g.nextRunAt ?? 0) > now && ['waiting', 'retry'].includes(g.status)) return false;
      if (goalKind(g) === 'recurring') return (g.nextRunAt ?? Infinity) <= now;
      if (this.needsPlanning(g)) return true;
      const scope = this.scopeTasks(g);
      return scope.some((t) => this.runnable(g, t, now)) || (scope.length > 0 && this.allEnded(scope) && !this.jobFor(g.id));
    });
  }

  private async step(): Promise<void> {
    const now = this.now();
    type Candidate = { kind: Job['kind']; goal: Goal; task?: GoalTask };
    const candidates: Candidate[] = [];

    for (const g of this.managedGoals()) {
      if (g.policy?.deadline && now > g.policy.deadline && goalKind(g) !== 'recurring') {
        this.expire(g, 'its deadline passed');
        continue;
      }
      if (g.status === 'paused' || g.status === 'blocked') continue;
      this.renewBudgetPeriod(g, now);

      if (goalKind(g) === 'recurring') {
        if ((g.nextRunAt ?? Infinity) <= now && !this.jobFor(g.id)) candidates.push({ kind: 'instance', goal: g });
        continue;
      }
      if (g.status === 'waiting') {
        if (g.waitingFor === 'approval' || g.waitingFor === 'review') continue; // a person answers these
        if ((g.nextRunAt ?? 0) > now) continue;
        this.manager.transition(g, this.needsPlanning(g) ? 'pending' : 'ready', g.waitingFor ? `${g.waitingFor} wait is over` : 'due', { quiet: true });
      }
      if (g.status === 'retry') {
        if ((g.nextRunAt ?? 0) > now) continue;
        this.manager.transition(g, this.needsPlanning(g) ? 'pending' : 'ready', 'retry time reached', { quiet: true });
      }
      if (this.jobFor(g.id, 'plan') || this.jobFor(g.id, 'eval')) continue;

      if (this.needsPlanning(g)) {
        candidates.push({ kind: 'plan', goal: g });
        continue;
      }
      const scope = this.scopeTasks(g);
      this.failBrokenDependencies(g, scope);
      const runnable = scope.filter((t) => this.runnable(g, t, now));
      for (const t of runnable) candidates.push({ kind: 'task', goal: g, task: t });
      const anyRunning = scope.some((t) => t.status === 'running');
      if (!runnable.length && !anyRunning && !this.goalJobs(g.id)) {
        if (this.allEnded(scope)) {
          candidates.push({ kind: 'eval', goal: g });
        } else {
          // Only retries later: the goal shows that it waits to retry.
          const next = Math.min(...scope.filter((t) => t.status === 'retry' && t.nextAttemptAt).map((t) => t.nextAttemptAt!));
          if (Number.isFinite(next) && next > now && g.status !== 'retry') {
            g.nextRunAt = next;
            this.manager.transition(g, 'retry', `waiting to retry until ${new Date(next).toISOString()}`);
          }
        }
      }
    }

    candidates.sort((a, b) =>
      (b.goal.priority - a.goal.priority)
      || ((a.goal.policy?.deadline ?? Infinity) - (b.goal.policy?.deadline ?? Infinity))
      || (a.goal.createdAt - b.goal.createdAt)
      || ((a.task?.createdAt ?? 0) - (b.task?.createdAt ?? 0)));

    for (const c of candidates) {
      if (this.jobs.size >= this.opts.maxConcurrent || this.stopping) break;
      const g = c.goal;
      if (c.kind !== 'task') {
        if (this.jobFor(g.id, c.kind)) continue;
        if (c.kind === 'plan' && this.goalJobs(g.id)) continue;
        this.startJob(c.kind, g, undefined);
        continue;
      }
      const t = c.task!;
      if (this.jobs.has(t.id) || t.status === 'running') continue;
      if (this.goalJobs(g.id) >= (g.policy?.maxParallelTasks ?? 2)) continue;
      const budget = this.budgetProblem(g);
      if (budget) {
        this.onBudgetExhausted(g, budget);
        continue;
      }
      this.startJob('task', g, t);
    }
  }

  private readonly jobStarts = new Map<string, number[]>();

  private startJob(kind: Job['kind'], goal: Goal, task: GoalTask | undefined): void {
    // A goal that keeps starting jobs without progress is paused, not spun on.
    const now = this.now();
    const recent = (this.jobStarts.get(goal.id) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.jobStarts.set(goal.id, recent);
    if (recent.length > LOOP_GUARD_JOBS) {
      console.error(`[GoalRuntime] Goal ${goal.id} started ${recent.length} jobs in a minute; pausing it.`);
      this.jobStarts.delete(goal.id);
      void this.manager.pauseGoal(goal.id, 'paused by the runtime: it kept starting work without progress');
      return;
    }
    const ac = new AbortController();
    const key = task ? task.id : `${kind}:${goal.id}`;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const job: Job = {
      kind, goalId: goal.id, ...(task ? { taskId: task.id, specialist: task.specialist } : {}),
      title: task?.title ?? `${kind} ${goal.description.slice(0, 60)}`, since: this.now(), ac, done,
    };
    this.jobs.set(key, job);
    const work = kind === 'plan' ? this.planGoal(goal)
      : kind === 'eval' ? this.evaluate(goal)
        : kind === 'instance' ? this.spawnInstance(goal)
          : this.runTask(goal, task!, ac);
    work.catch((err) => console.error(`[GoalRuntime] ${kind} for ${goal.id} failed:`, err))
      .finally(() => {
        this.jobs.delete(key);
        this.abortedFor.delete(key);
        resolveDone();
        this.wake(`${kind} finished`);
      });
  }

  // ── Scope helpers ──────────────────────────────────────────────────────────

  private activeMilestone(g: Goal): Milestone | undefined {
    return g.milestones?.find((m) => m.status === 'active');
  }

  /** The tasks that decide the goal's (or the active milestone's) outcome now. */
  private scopeTasks(g: Goal): GoalTask[] {
    const tasks = (g.tasks ?? []).filter((t) => !isReplaced(t));
    if (goalKind(g) === 'permanent') {
      const ms = this.activeMilestone(g);
      return ms ? tasks.filter((t) => t.milestoneId === ms.id) : [];
    }
    return tasks;
  }

  private needsPlanning(g: Goal): boolean {
    if (goalKind(g) === 'recurring') return false;
    if (g.metadata?.['replan']) return true;
    if (goalKind(g) === 'permanent' && !this.activeMilestone(g)) return true;
    return this.scopeTasks(g).length === 0;
  }

  /** Marks tasks as replaced by a new plan (kept, out of scope). */
  private retire(tasks: GoalTask[], why: string): void {
    const now = this.now();
    for (const t of tasks) {
      if (t.status === 'completed' || t.status === 'running' || isReplaced(t)) continue;
      t.status = 'cancelled';
      t.failures.push({ at: now, attemptId: 'none', class: 'invalid_plan', message: why, action: 'replaced by a new plan' });
    }
  }

  private runnable(g: Goal, t: GoalTask, now: number): boolean {
    if (this.jobs.has(t.id)) return false;
    const depsDone = t.dependsOn.every((d) => g.tasks?.find((x) => x.id === d)?.status === 'completed');
    if (!depsDone) return false;
    if (t.status === 'pending' || t.status === 'ready') return true;
    if (t.status === 'retry') return (t.nextAttemptAt ?? 0) <= now;
    return false;
  }

  private allEnded(scope: GoalTask[]): boolean {
    return scope.length > 0 && scope.every((t) => TERMINAL_TASK_STATUSES.has(t.status) || ['blocked', 'needs_review', 'waiting'].includes(t.status));
  }

  /** A task whose dependency failed or was cancelled cannot run: it fails as a dependency failure. */
  private failBrokenDependencies(g: Goal, scope: GoalTask[]): void {
    for (const t of scope) {
      if (t.status !== 'pending' && t.status !== 'ready') continue;
      const broken = t.dependsOn.map((d) => g.tasks?.find((x) => x.id === d)).find((d) => d && (d.status === 'failed' || d.status === 'cancelled'));
      if (!broken) continue;
      t.status = 'failed';
      t.failures.push({ at: this.now(), attemptId: 'none', class: 'dependency', message: `"${broken.title}" ${broken.status}`, action: 'not run: a task it needs did not finish' });
      this.manager.note(g, { event: 'task_failed', reason: `"${t.title}" not run: "${broken.title}" ${broken.status}`, taskId: t.id });
      this.manager.touch(g);
    }
  }

  // ── Budget ─────────────────────────────────────────────────────────────────

  private renewBudgetPeriod(g: Goal, now: number): void {
    if (g.budget?.period !== 'day' || !g.usage) return;
    if (now - g.usage.periodStart >= DAY_MS) {
      g.usage = { llmCalls: 0, toolCalls: 0, tokens: 0, tasks: 0, periodStart: now };
      this.manager.note(g, { event: 'budget', reason: 'daily budget renewed' });
      this.manager.touch(g);
    }
  }

  private budgetProblem(g: Goal): string | undefined {
    const b = g.budget;
    const u = g.usage;
    if (!b || !u) return undefined;
    if (b.maxTasks !== undefined && u.tasks >= b.maxTasks) return `${u.tasks} of ${b.maxTasks} task runs used`;
    if (b.llmCalls !== undefined && u.llmCalls >= b.llmCalls) return `${u.llmCalls} of ${b.llmCalls} model calls used`;
    if (b.toolCalls !== undefined && u.toolCalls >= b.toolCalls) return `${u.toolCalls} of ${b.toolCalls} tool calls used`;
    if (b.tokens !== undefined && u.tokens >= b.tokens) return `${u.tokens} of ${b.tokens} tokens used`;
    return undefined;
  }

  private remainingBudget(g: Goal): ExecRequest['budget'] {
    const b = g.budget;
    const u = g.usage;
    if (!b || !u) return {};
    return {
      ...(b.llmCalls !== undefined ? { llmCalls: Math.max(0, b.llmCalls - u.llmCalls) } : {}),
      ...(b.toolCalls !== undefined ? { toolCalls: Math.max(0, b.toolCalls - u.toolCalls) } : {}),
      ...(b.tokens !== undefined ? { tokens: Math.max(0, b.tokens - u.tokens) } : {}),
    };
  }

  private onBudgetExhausted(g: Goal, why: string): void {
    if (g.budget?.period === 'day' && g.usage) {
      g.nextRunAt = g.usage.periodStart + DAY_MS;
      if (this.manager.transition(g, 'waiting', `budget used up (${why}); continues when the daily budget renews`, { event: 'budget' })) {
        g.waitingFor = 'budget';
        this.record('goal_waiting', g, `waits for its daily budget (${why})`);
      }
    } else if (this.manager.transition(g, 'blocked', `budget used up (${why})`, { event: 'budget' })) {
      g.blockedReason = `its budget is used up (${why}); raise the budget or say "resume goal"`;
      this.record('goal_blocked', g, g.blockedReason);
    }
    void this.manager.persistImmediate();
  }

  // ── Jobs ───────────────────────────────────────────────────────────────────

  /** Plans a goal, or the next milestone of a permanent goal. */
  private async planGoal(g: Goal): Promise<void> {
    if (!this.manager.transition(g, 'planning', 'planning', { quiet: true })) return;
    let milestone: Milestone | undefined;
    if (goalKind(g) === 'permanent') {
      milestone = this.activeMilestone(g) ?? g.milestones?.find((m) => m.status === 'pending');
      if (!milestone) {
        const proposal = this.opts.planner.proposeMilestone
          ? await this.opts.planner.proposeMilestone(g, this.opts.learning?.relevant(g) ?? []).catch(() => undefined)
          : undefined;
        if (!proposal) {
          g.nextRunAt = this.now() + (g.policy?.reviewIntervalMs ?? PERMANENT_REVIEW_MS);
          this.manager.transition(g, 'waiting', 'no milestone left: add one, or the next review will try to propose one');
          g.waitingFor = 'schedule';
          this.record('goal_waiting', g, 'has no milestone to work on; add one, or it will try to propose one at the next review');
          await this.manager.persistImmediate();
          return;
        }
        milestone = {
          id: newId('ms'), title: proposal.title, status: 'pending', proposed: true,
          successCriteria: proposal.successCriteria.map((d) => ({ id: newId('crit'), description: d, kind: 'judge' as const })),
        };
        (g.milestones ??= []).push(milestone);
        this.record('milestone_proposed', g, `proposed the next milestone: "${milestone.title}"`);
      }
      milestone.status = 'active';
      milestone.startedAt ??= this.now();
    }

    const completed = (g.tasks ?? []).filter((t) => t.status === 'completed' && t.result && (!milestone || t.milestoneId === milestone.id));
    const advice = [...new Set((g.tasks ?? []).flatMap((t) => t.failures.map((f) => f.advice)).filter((a): a is string => !!a))];
    const lessons = this.opts.learning?.relevant(g, milestone) ?? [];
    const out = await this.opts.planner.plan({
      goal: g, ...(milestone ? { milestone } : {}), lessons, advice,
      done: completed.map((t) => ({ title: t.title, summary: t.result!.summary })),
    });
    if (g.status !== 'planning') return; // paused or cancelled meanwhile

    // A new plan replaces the old one's unfinished and failed tasks; completed ones stay as evidence.
    const now = this.now();
    this.retire((g.tasks ?? []).filter((t) => !milestone || t.milestoneId === milestone.id), 're-planned');
    const ids = new Map(out.tasks.map((t) => [t.title, newId('task')]));
    const fresh: GoalTask[] = out.tasks.map((t) => ({
      id: ids.get(t.title)!, title: t.title, description: t.description, specialist: t.specialist,
      dependsOn: t.dependsOn.map((d) => ids.get(d)!).filter(Boolean), status: 'pending', sideEffects: t.sideEffects,
      attempts: 0, maxAttempts: MAX_TASK_ATTEMPTS, failures: [], createdAt: now, ...(milestone ? { milestoneId: milestone.id } : {}),
    }));
    g.tasks = [...(g.tasks ?? []), ...fresh];
    if (g.tasks.length > MAX_TASKS_KEPT) {
      const drop = g.tasks.filter((t) => t.status === 'cancelled').slice(0, g.tasks.length - MAX_TASKS_KEPT).map((t) => t.id);
      g.tasks = g.tasks.filter((t) => !drop.includes(t.id));
    }
    g.planSummary = fresh.map((t) => `${t.title} → ${t.specialist}`).join('; ');
    g.lessonsUsed = lessons.map((l) => l.id);
    if (g.metadata) delete g.metadata['replan'];
    this.manager.transition(g, 'ready', `planned ${fresh.length} task(s) (${out.via}${out.note ? `: ${out.note}` : ''})`, { event: 'planned' });
    this.record('planned', g, `planned ${fresh.length} task(s) via ${out.via}: ${g.planSummary}`);
    await this.manager.persistImmediate();
  }

  /** The context an agent gets for a task. */
  private contextFor(g: Goal, t: GoalTask): string {
    const deps = t.dependsOn.map((d) => g.tasks?.find((x) => x.id === d)).filter((d): d is GoalTask => !!d?.result);
    const advice = t.failures.map((f) => f.advice).filter(Boolean).slice(-3);
    const lessons = (this.opts.learning?.relevant(g) ?? []).slice(0, 3);
    return [
      `Goal: ${g.objective ?? g.description}`,
      g.constraints?.length ? `Constraints: ${g.constraints.join('; ')}` : '',
      deps.length ? `Results it builds on:\n${deps.map((d) => `- ${d.title}: ${d.result!.summary.slice(0, 400)}`).join('\n')}` : '',
      t.checkpoint?.partial?.length ? `An earlier attempt found (not verified; check before relying on it):\n${t.checkpoint.partial.slice(0, 5).map((p) => `- ${p}`).join('\n')}` : '',
      advice.length ? `Change from the last attempt: ${advice.join('; ')}` : '',
      lessons.length ? `Lessons from earlier goals: ${lessons.map((l) => l.text).join('; ')}` : '',
    ].filter(Boolean).join('\n\n');
  }

  private async runTask(g: Goal, t: GoalTask, ac: AbortController): Promise<void> {
    const now = this.now();
    const attemptId = newId('att');
    t.status = 'running';
    t.attempts++;
    t.attemptId = attemptId;
    t.lease = { owner: this.owner, claimedAt: now, expiresAt: now + this.opts.leaseMs };
    t.startedAt = now;
    t.waitingFor = undefined;
    t.nextAttemptAt = undefined;
    g.usage ??= { llmCalls: 0, toolCalls: 0, tokens: 0, tasks: 0, periodStart: now };
    g.usage.tasks++;
    if (g.status !== 'executing') this.manager.transition(g, 'executing', `running "${t.title}"`, { quiet: true });
    this.manager.note(g, { event: 'task_started', reason: `"${t.title}" → ${t.specialist} (attempt ${t.attempts}/${t.maxAttempts})`, taskId: t.id });
    // The claim is on disk before any work starts.
    await this.manager.persistImmediate();
    this.record('task_started', g, `started "${t.title}" with ${t.specialist} (attempt ${t.attempts})`, t.id);

    const heartbeat = setInterval(() => {
      if (t.lease && t.attemptId === attemptId) {
        t.lease.expiresAt = this.now() + this.opts.leaseMs;
        this.manager.touch(g);
      }
    }, Math.max(1_000, Math.floor(this.opts.leaseMs / 3)));
    heartbeat.unref?.();

    let outcome: ExecOutcome;
    try {
      outcome = await this.opts.executor.run({
        goal: g, task: t, attemptId, signal: ac.signal, budget: this.remainingBudget(g), context: this.contextFor(g, t),
        onStarted: (rootTaskId) => {
          if (t.attemptId !== attemptId) return;
          t.rootTaskId = rootTaskId;
          void this.manager.persistImmediate();
        },
      });
    } catch (err) {
      outcome = { ok: false, failure: { message: err instanceof Error ? err.message : String(err) } };
    } finally {
      clearInterval(heartbeat);
    }
    if (ac.signal.aborted && !outcome.ok) {
      const why = this.abortedFor.get(t.id) ?? String((ac.signal.reason as Error)?.message ?? 'stopped');
      outcome = { ...outcome, failure: { class: 'interrupted', message: why } };
    }
    await this.finishTask(g, t, attemptId, outcome);
  }

  private async finishTask(g: Goal, t: GoalTask, attemptId: string, outcome: ExecOutcome): Promise<void> {
    if (t.attemptId !== attemptId) {
      console.warn(`[GoalRuntime] Ignored a result for an old attempt of "${t.title}".`);
      return;
    }
    const now = this.now();
    t.lease = undefined;
    if (outcome.usage && g.usage) {
      g.usage.llmCalls += outcome.usage.llmCalls;
      g.usage.toolCalls += outcome.usage.toolCalls;
      g.usage.tokens += outcome.usage.tokens;
    }
    if (g.status === 'cancelled' || g.status === 'expired') {
      if (outcome.ok && outcome.result) { t.result = outcome.result; t.status = 'completed'; } else t.status = 'cancelled';
      t.finishedAt = now;
      await this.manager.persistImmediate();
      return;
    }

    if (outcome.ok && outcome.result) {
      t.status = 'completed';
      t.result = { ...outcome.result, origin: outcome.result.origin ?? 'run' };
      t.finishedAt = now;
      t.checkpoint = { at: now, note: 'completed', partial: outcome.result.findings.slice(0, 5) };
      this.manager.note(g, { event: 'task_completed', reason: `"${t.title}" completed by ${outcome.result.agent} (confidence ${outcome.result.confidence.toFixed(2)})`, taskId: t.id });
      this.record('task_finished', g, `"${t.title}" completed`, t.id);
      this.opts.learning?.onTaskFinished?.(g, t);
      if (g.status === 'paused') this.manager.note(g, { event: 'task_completed', reason: 'finished while the goal was paused; kept', taskId: t.id });
      await this.manager.persistImmediate();
      return;
    }

    const failure = outcome.failure ?? { message: outcome.ok ? 'the result was empty' : 'failed' };
    const cls = outcome.ok && !outcome.result ? 'evidence' : classifyFailure(failure);
    if (cls === 'interrupted' && g.status === 'paused') failure.message = `paused: ${failure.message}`;
    const decision = decideRecovery({ task: t, failure, cls, ...(outcome.usage ? { toolCalls: outcome.usage.toolCalls } : {}), now, retry: this.retry });
    if (!decision.countsAsAttempt) t.attempts = Math.max(0, t.attempts - 1);
    t.status = decision.taskStatus;
    t.nextAttemptAt = decision.nextAttemptAt;
    t.waitingFor = decision.waitingFor;
    if (outcome.result?.findings?.length) t.checkpoint = { at: now, note: `partial findings of attempt ${attemptId}`, partial: outcome.result.findings.slice(0, 5) };
    t.failures.push({ at: now, attemptId, class: cls, message: failure.message.slice(0, 300), action: decision.action, ...(decision.advice ? { advice: decision.advice } : {}) });
    if (t.failures.length > 20) t.failures.splice(0, t.failures.length - 20);
    if (TERMINAL_TASK_STATUSES.has(t.status)) t.finishedAt = now;
    this.manager.note(g, { event: 'task_failed', reason: `"${t.title}" ${cls}: ${decision.action}`, taskId: t.id });
    this.record('task_failed', g, `"${t.title}" ${cls}: ${decision.action}`, t.id);
    this.opts.learning?.onTaskFinished?.(g, t, cls);

    if (g.status !== 'paused') {
      if (decision.goal === 'wait' && decision.goalWaitingFor === 'budget') {
        this.onBudgetExhausted(g, failure.message.slice(0, 120));
      } else if (decision.goal === 'wait') {
        if (this.manager.transition(g, 'waiting', decision.action, { taskId: t.id })) {
          g.waitingFor = decision.goalWaitingFor;
          this.record('goal_waiting', g, decision.action, t.id);
        }
      } else if (decision.goal === 'block') {
        if (this.manager.transition(g, 'blocked', `"${t.title}": ${decision.action}`, { taskId: t.id })) {
          g.blockedReason = `"${t.title}": ${decision.action}`;
          this.record('goal_blocked', g, g.blockedReason, t.id);
          this.opts.learning?.onGoalFinished?.(g, 'blocked');
        }
      } else if (decision.goal === 'replan') {
        g.metadata = { ...(g.metadata ?? {}), replan: true };
      }
    }
    await this.manager.persistImmediate();
  }

  /** All tasks in scope have ended: check the criteria and decide the goal's (or milestone's) outcome. */
  private async evaluate(g: Goal): Promise<void> {
    const scope = this.scopeTasks(g);
    if (!this.allEnded(scope) || scope.some((t) => this.jobs.has(t.id))) return;
    const blocked = scope.filter((t) => t.status === 'blocked' || t.status === 'needs_review');
    const waiting = scope.filter((t) => t.status === 'waiting');
    const failed = scope.filter((t) => t.status === 'failed');
    if (blocked.length) {
      const reason = `"${blocked[0]!.title}": ${blocked[0]!.failures.at(-1)?.action ?? blocked[0]!.status}`;
      if (this.manager.transition(g, 'blocked', reason)) {
        g.blockedReason = reason;
        this.record('goal_blocked', g, reason);
      }
      await this.manager.persistImmediate();
      return;
    }
    if (waiting.length) {
      if (this.manager.transition(g, 'waiting', `"${waiting[0]!.title}" waits for ${waiting[0]!.waitingFor ?? 'something'}`)) {
        g.waitingFor = waiting[0]!.waitingFor === 'approval' ? 'approval' : 'review';
      }
      await this.manager.persistImmediate();
      return;
    }
    const ms = goalKind(g) === 'permanent' ? this.activeMilestone(g) : undefined;
    if (failed.length) {
      await this.roundFailed(g, ms, `${failed.length} task(s) failed: ${failed.map((t) => `"${t.title}" (${t.failures.at(-1)?.message ?? 'failed'})`).join('; ')}`);
      return;
    }
    const criteria: GoalCriterion[] = ms ? ms.successCriteria : (g.successCriteria ?? []);
    const verdict = await verifyCriteria({ objective: ms ? `${ms.title} (for: ${g.objective})` : (g.objective ?? g.description), tasks: scope, criteria, ...(this.opts.judge ? { judge: this.opts.judge } : {}) });
    if (isTerminalGoalStatus(g.status) || g.status === 'paused') return;
    for (const check of verdict.checks) {
      const c = criteria.find((x) => x.id === check.id);
      if (c) { c.met = check.met; c.evidence = check.evidence; c.checkedAt = this.now(); }
    }
    if (verdict.status === 'needs_review') {
      if (this.manager.transition(g, 'waiting', `success criteria need your review: ${verdict.checks.filter((c) => c.met === undefined).map((c) => c.description).join('; ')}`)) {
        g.waitingFor = 'review';
        g.outcome = verdict.summary.slice(0, 300);
        this.record('goal_waiting', g, 'finished its work; the success criteria need your review (say "confirm goal" or "resume goal")');
      }
      await this.manager.persistImmediate();
      return;
    }
    if (verdict.status === 'unmet') {
      const unmet = verdict.checks.filter((c) => c.met === false).map((c) => `${c.description}: ${c.evidence}`).join('; ');
      for (const t of scope) t.failures.push({ at: this.now(), attemptId: t.attemptId ?? 'none', class: 'evidence', message: unmet.slice(0, 300), action: 'criteria not met', advice: `the success criteria were not met (${unmet.slice(0, 200)}); address them directly` });
      await this.roundFailed(g, ms, `success criteria not met: ${unmet}`);
      return;
    }
    await this.succeed(g, ms, verdict.summary, verdict.checks.map((c) => `${c.description}: ${c.evidence}`).join('; '));
  }

  /** A plan round ended badly: re-plan while attempts last, then fail (temporary) or record a failed cycle (permanent). */
  private async roundFailed(g: Goal, ms: Milestone | undefined, reason: string): Promise<void> {
    if (g.retries < g.maxRetries - 1) {
      g.retries++;
      g.metadata = { ...(g.metadata ?? {}), replan: true };
      this.manager.transition(g, 'pending', `re-planning (round ${g.retries + 1} of ${g.maxRetries}): ${reason}`, { event: 'replan' });
      await this.manager.persistImmediate();
      return;
    }
    if (goalKind(g) === 'permanent' && ms) {
      ms.status = 'failed';
      ms.evidence = reason.slice(0, 300);
      g.consecutiveFailures = (g.consecutiveFailures ?? 0) + 1;
      g.retries = 0;
      const max = g.policy?.maxConsecutiveFailures ?? PERMANENT_MAX_FAILURES;
      // The next cycle plans this milestone afresh; what failed stays on record.
      this.retire((g.tasks ?? []).filter((t) => t.milestoneId === ms.id), 'milestone failed');
      if (g.consecutiveFailures >= max) {
        if (this.manager.transition(g, 'blocked', `${g.consecutiveFailures} cycles in a row failed; last: ${reason}`)) {
          g.blockedReason = `${g.consecutiveFailures} cycles in a row failed. Last: ${reason.slice(0, 200)}`;
          this.record('goal_blocked', g, g.blockedReason);
          this.opts.learning?.onGoalFinished?.(g, 'blocked');
        }
      } else {
        ms.status = 'pending'; // tried again at the next review, with what was learnt
        g.nextRunAt = this.now() + (g.policy?.reviewIntervalMs ?? PERMANENT_REVIEW_MS);
        if (this.manager.transition(g, 'waiting', `milestone "${ms.title}" failed (${reason.slice(0, 160)}); next try at the next review`)) g.waitingFor = 'schedule';
        this.record('goal_waiting', g, `milestone "${ms.title}" failed; it will be tried again at the next review`);
      }
      await this.manager.persistImmediate();
      return;
    }
    g.outcome = `failed: ${reason.slice(0, 280)}`;
    if (this.manager.transition(g, 'failed', reason)) {
      this.record('goal_failed', g, g.outcome);
      this.opts.learning?.onGoalFinished?.(g, 'failed');
      this.finishInstance(g);
    }
    await this.manager.persistImmediate();
  }

  private async succeed(g: Goal, ms: Milestone | undefined, summary: string, evidence: string): Promise<void> {
    const now = this.now();
    if (goalKind(g) === 'permanent' && ms) {
      ms.status = 'completed';
      ms.completedAt = now;
      ms.evidence = `${summary.slice(0, 200)} [${evidence.slice(0, 200)}]`;
      g.cycles = (g.cycles ?? 0) + 1;
      g.consecutiveFailures = 0;
      g.retries = 0;
      const all = g.milestones ?? [];
      const done = all.filter((m) => m.status === 'completed').length;
      g.progress = { percent: all.length ? Math.round((done / all.length) * 100) : 0, note: `${done} of ${all.length} milestone(s) done; latest: ${ms.title}`, updatedAt: now };
      const day = dayKey(now);
      const cyc = (g.metadata?.['cycleDay'] as { day: string; count: number } | undefined);
      const count = cyc?.day === day ? cyc.count + 1 : 1;
      g.metadata = { ...(g.metadata ?? {}), cycleDay: { day, count } };
      const more = all.some((m) => m.status === 'pending');
      const maxCycles = g.policy?.maxCyclesPerDay ?? PERMANENT_MAX_CYCLES;
      g.nextRunAt = more && count < maxCycles ? now : now + (more ? Math.max(1, Date.parse(`${day}T00:00:00.000Z`) + DAY_MS - now) : (g.policy?.reviewIntervalMs ?? PERMANENT_REVIEW_MS));
      this.manager.transition(g, 'waiting', `milestone "${ms.title}" verified; next cycle ${g.nextRunAt <= now ? 'now' : `at ${new Date(g.nextRunAt).toISOString()}`}`, { event: 'milestone' });
      g.waitingFor = 'schedule';
      g.outcome = `milestone "${ms.title}" done`;
      this.record('milestone_completed', g, `milestone "${ms.title}" done (${g.progress.note})`);
      this.opts.learning?.onGoalFinished?.(g, 'milestone');
      await this.manager.persistImmediate();
      return;
    }
    g.outcome = summary.slice(0, 600) || 'completed';
    if (this.manager.transition(g, 'completed', `success criteria met: ${evidence.slice(0, 200)}`)) {
      this.record('goal_completed', g, g.outcome);
      this.opts.learning?.onGoalFinished?.(g, 'completed');
      this.finishInstance(g);
    }
    await this.manager.persistImmediate();
  }

  /** A recurring instance ended: its template remembers the outcome. */
  private finishInstance(g: Goal): void {
    if (!g.parentGoalId) return;
    const tpl = this.manager.getGoal(g.parentGoalId);
    if (!tpl) return;
    tpl.outcome = `${g.status}: ${(g.outcome ?? '').slice(0, 200)}`;
    tpl.progress = { percent: 0, note: `last run ${g.instanceKey?.split('@')[1] ?? ''} ${g.status}`, updatedAt: this.now() };
    this.manager.note(tpl, { event: 'instance_finished', reason: `${g.id} ${g.status}` });
    this.manager.touch(tpl);
  }

  /** A person confirmed a goal waiting for review of its criteria. */
  async confirmGoal(id: string, by = 'the user'): Promise<boolean> {
    const g = this.manager.getGoal(id);
    if (!g || g.status !== 'waiting' || g.waitingFor !== 'review') return false;
    const ms = goalKind(g) === 'permanent' ? this.activeMilestone(g) : undefined;
    const criteria = ms ? ms.successCriteria : (g.successCriteria ?? []);
    for (const c of criteria) if (c.met === undefined) { c.met = true; c.evidence = `confirmed by ${by}`; c.checkedAt = this.now(); }
    await this.succeed(g, ms, g.outcome ?? '', `confirmed by ${by}`);
    return true;
  }

  // ── Recurring ──────────────────────────────────────────────────────────────

  private async spawnInstance(tpl: Goal): Promise<void> {
    const now = this.now();
    const sched = tpl.schedule;
    if (!sched) return;
    const slots = dueTimesBetween(sched, tpl.lastRunAt ?? tpl.createdAt, now, tpl.createdAt, 10_000);
    if (!slots.length && tpl.nextRunAt && tpl.nextRunAt <= now) slots.push(tpl.nextRunAt);
    if (!slots.length) { tpl.nextRunAt = nextRunAfter(sched, now, tpl.createdAt); this.manager.touch(tpl); return; }
    const latest = slots[slots.length - 1]!;
    const missed = slots.length - 1;
    tpl.lastRunAt = latest;
    tpl.nextRunAt = nextRunAfter(sched, now, tpl.createdAt);
    const grace = Math.max(5 * 60_000, 2 * this.opts.maxSleepMs);
    const late = now - latest > grace;
    if (late && (tpl.policy?.catchUp ?? 'one') === 'none') {
      this.manager.note(tpl, { event: 'instance_skipped', reason: `run for ${new Date(latest).toISOString()} skipped: JARVIS was not running then (catch-up is off)` });
      this.record('instance_skipped', tpl, `skipped the missed run for ${new Date(latest).toISOString()} (catch-up is off)`);
      await this.manager.persistImmediate();
      return;
    }
    const active = this.manager.listGoals().find((g) => g.parentGoalId === tpl.id && !isTerminalGoalStatus(g.status));
    if (active) {
      this.manager.note(tpl, { event: 'instance_skipped', reason: `run for ${new Date(latest).toISOString()} skipped: the previous run (${active.id}) is still ${active.status}` });
      this.record('instance_skipped', tpl, `skipped a run: the previous one is still ${active.status}`);
      await this.manager.persistImmediate();
      return;
    }
    const period = sched.type === 'interval' ? sched.everyMs : DAY_MS;
    const key = `${tpl.id}@${new Date(latest).toISOString()}`;
    const planned = tpl.metadata?.['instanceTasks'] as { title: string; description?: string; specialist: string; dependsOn?: string[]; sideEffects?: 'none' | 'possible' }[] | undefined;
    const { goal, created } = await this.manager.createManagedGoal({
      kind: 'temporary',
      objective: tpl.objective ?? tpl.description,
      title: `${tpl.description} (${new Date(latest).toISOString().slice(0, 16).replace('T', ' ')})`,
      source: tpl.source,
      priority: tpl.priority,
      successCriteria: (tpl.successCriteria ?? []).map((c) => ({ description: c.description, kind: c.kind, ...(c.value !== undefined ? { value: c.value } : {}) })),
      ...(tpl.constraints?.length ? { constraints: tpl.constraints } : {}),
      policy: { ...(tpl.policy ?? {}), deadline: latest + period },
      ...(tpl.budget ? { budget: { ...tpl.budget, period: 'goal' as const } } : {}),
      ...(planned?.length ? { tasks: planned } : {}),
      parentGoalId: tpl.id,
      instanceKey: key,
    });
    tpl.cycles = (tpl.cycles ?? 0) + (created ? 1 : 0);
    this.manager.note(tpl, { event: 'instance', reason: `${created ? 'created' : 'already had'} run ${goal.id} for ${new Date(latest).toISOString()}${missed ? `; ${missed} earlier missed run(s) not repeated` : ''}` });
    if (created) this.record('instance_created', tpl, `started the run for ${new Date(latest).toISOString()}${missed ? ` (${missed} missed run(s) not repeated)` : ''}`);
    await this.manager.persistImmediate();
  }

  // ── Stopping work ──────────────────────────────────────────────────────────

  private abortGoal(goalId: string, why: string): void {
    for (const [key, j] of this.jobs) {
      if (j.goalId !== goalId) continue;
      this.abortedFor.set(key, `${why} by the user`);
      j.ac.abort(new Error(`INTERRUPTED: goal ${why}`));
    }
  }

  private expire(g: Goal, why: string): void {
    this.abortGoal(g.id, 'expired');
    for (const t of g.tasks ?? []) if (!TERMINAL_TASK_STATUSES.has(t.status) && t.status !== 'running') t.status = 'cancelled';
    g.outcome = `expired: ${why}`;
    if (this.manager.transition(g, 'expired', why)) {
      this.record('goal_expired', g, `expired: ${why}`);
      this.opts.learning?.onGoalFinished?.(g, 'expired');
      this.finishInstance(g);
    }
    void this.manager.persistImmediate();
  }

  /** A running task that will not report back (stop, restart): safe to run again, or a person checks it. */
  private interruptTask(g: Goal, t: GoalTask, reason: string, previous?: PreviousRun): void {
    const now = this.now();
    t.lease = undefined;
    if (previous?.findings?.length) t.checkpoint = { at: now, note: `partial findings before: ${reason}`, partial: previous.findings.slice(0, 5) };
    const decision = decideRecovery({ task: t, failure: { class: 'interrupted', message: reason }, cls: 'interrupted', now, retry: this.retry });
    t.attempts = Math.max(0, t.attempts - 1);
    t.status = decision.taskStatus;
    t.failures.push({ at: now, attemptId: t.attemptId ?? 'none', class: 'interrupted', message: reason, action: decision.action });
    // A result that still arrives for this attempt is ignored: the task was settled here.
    t.attemptId = undefined;
    this.manager.note(g, { event: 'task_interrupted', reason: `"${t.title}": ${decision.action}`, taskId: t.id });
    if (decision.goal === 'block' && g.status !== 'paused' && g.status !== 'cancelled') {
      if (this.manager.transition(g, 'blocked', `"${t.title}" ${decision.action}`)) g.blockedReason = `"${t.title}": ${decision.action}`;
    }
  }

  /**
   * At start: tasks a previous run left `running`. A result the agent archive
   * shows as finished is taken (and still verified with the goal); otherwise a
   * read-only task runs again and a task that may have acted waits for review.
   */
  private async reconcile(): Promise<{ recovered: number; needsReview: number; resumedFromArchive: number }> {
    let recovered = 0;
    let needsReview = 0;
    let resumedFromArchive = 0;
    const now = this.now();
    for (const g of this.managedGoals()) {
      let touched = false;
      for (const t of g.tasks ?? []) {
        if (t.status !== 'running') continue;
        const [host, pidText] = (t.lease?.owner ?? '').split(':');
        const pid = Number(pidText);
        if (t.lease && t.lease.owner !== this.owner && host === os.hostname() && pid && pid !== process.pid && pidAlive(pid) && t.lease.expiresAt > now) {
          console.warn(`[GoalRuntime] "${t.title}" is claimed by another JARVIS process (${t.lease.owner}); leaving it.`);
          continue;
        }
        touched = true;
        const prev = t.rootTaskId ? this.opts.executor.inspectPrevious?.(t.rootTaskId) : undefined;
        if (prev?.status === 'COMPLETED' && prev.result) {
          t.status = 'completed';
          t.result = { ...prev.result, origin: 'archive' };
          t.finishedAt = now;
          t.lease = undefined;
          this.manager.note(g, { event: 'recovered', reason: `"${t.title}" finished before the restart; its result was read from the agent archive`, taskId: t.id });
          resumedFromArchive++;
          continue;
        }
        this.interruptTask(g, t, 'JARVIS stopped while this task was running', prev);
        if ((t.status as string) === 'needs_review') needsReview++; else recovered++;
      }
      if (['executing', 'planning', 'in_progress'].includes(g.status)) {
        touched = true;
        this.manager.transition(g, (g.tasks ?? []).length ? 'ready' : 'pending', 'JARVIS restarted', { quiet: true });
      }
      if (touched) this.record('recovered', g, 'continued after a restart');
    }
    await this.manager.persistImmediate();
    if (recovered || needsReview || resumedFromArchive) {
      console.log(`[GoalRuntime] Restart: ${recovered} task(s) will run again, ${resumedFromArchive} result(s) recovered from agent archives, ${needsReview} need your review.`);
    }
    return { recovered, needsReview, resumedFromArchive };
  }

  // ── Timers and housekeeping ────────────────────────────────────────────────

  private schedule(): void {
    if (!this.started || this.stopping) return;
    if (this.timer) clearTimeout(this.timer);
    const now = this.now();
    let next = now + this.opts.maxSleepMs;
    for (const g of this.managedGoals()) {
      if (g.status === 'paused' || g.status === 'blocked') continue;
      if (g.nextRunAt && (g.status === 'waiting' || g.status === 'retry' || goalKind(g) === 'recurring') && !(g.waitingFor === 'approval' || g.waitingFor === 'review')) next = Math.min(next, g.nextRunAt);
      if (g.policy?.deadline) next = Math.min(next, g.policy.deadline + 1);
      for (const t of g.tasks ?? []) if (t.status === 'retry' && t.nextAttemptAt) next = Math.min(next, t.nextAttemptAt);
    }
    const delay = Math.max(50, next - now);
    this.nextWakeAt = now + delay;
    this.timer = setTimeout(() => { this.timer = undefined; this.wake('timer'); }, delay);
    this.timer.unref?.();
  }

  private async maintain(): Promise<void> {
    try {
      await this.manager.archiveFinished();
      await this.opts.maintenance?.();
    } catch (err) {
      console.warn('[GoalRuntime] Housekeeping failed:', (err as Error).message);
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  private record(type: GoalRuntimeEvent['type'], g: Goal, text: string, taskId?: string): void {
    const e: GoalRuntimeEvent = { type, goalId: g.id, ...(taskId ? { taskId } : {}), text: `${g.description.slice(0, 80)}: ${text}`, at: this.now() };
    this.events.push(e);
    if (this.events.length > EVENTS_KEPT) this.events.shift();
    this.emit('event', e);
  }

  recentEvents(limit = 20): GoalRuntimeEvent[] {
    return this.events.slice(-limit);
  }

  status(): {
    running: boolean;
    owner: string;
    maxConcurrent: number;
    nextWakeAt?: number;
    jobs: { kind: string; goalId: string; taskId?: string; title: string; specialist?: string; since: number }[];
    goals: { id: string; kind: string; status: string; title: string; priority: number; waitingFor?: string; blockedReason?: string; nextRunAt?: number; progress?: string; tasks: { total: number; done: number; running: number; retry: number; failed: number }; outcome?: string }[];
    waitingApproval: string[];
    blocked: string[];
    retries: { goalId: string; taskId: string; title: string; at?: number }[];
    scheduled: { goalId: string; title: string; at: number }[];
  } {
    const goals = this.manager.listGoals({ kinds: ['temporary', 'permanent', 'recurring'] });
    const live = goals.filter((g) => !isTerminalGoalStatus(g.status));
    return {
      running: this.isRunning,
      owner: this.owner,
      maxConcurrent: this.opts.maxConcurrent,
      ...(this.nextWakeAt ? { nextWakeAt: this.nextWakeAt } : {}),
      jobs: [...this.jobs.values()].map((j) => ({ kind: j.kind, goalId: j.goalId, ...(j.taskId ? { taskId: j.taskId } : {}), title: j.title, ...(j.specialist ? { specialist: j.specialist } : {}), since: j.since })),
      goals: goals.map((g) => {
        const ts = g.tasks ?? [];
        return {
          id: g.id, kind: goalKind(g), status: g.status, title: g.description, priority: g.priority,
          ...(g.waitingFor ? { waitingFor: g.waitingFor } : {}), ...(g.blockedReason ? { blockedReason: g.blockedReason } : {}),
          ...(g.nextRunAt ? { nextRunAt: g.nextRunAt } : {}), ...(g.progress ? { progress: g.progress.note } : {}),
          ...(g.outcome ? { outcome: g.outcome } : {}),
          tasks: {
            total: ts.filter((t) => t.status !== 'cancelled').length, done: ts.filter((t) => t.status === 'completed').length,
            running: ts.filter((t) => t.status === 'running').length, retry: ts.filter((t) => t.status === 'retry').length,
            failed: ts.filter((t) => t.status === 'failed').length,
          },
        };
      }),
      waitingApproval: live.filter((g) => g.status === 'waiting' && g.waitingFor === 'approval').map((g) => g.id),
      blocked: live.filter((g) => g.status === 'blocked').map((g) => g.id),
      retries: live.flatMap((g) => (g.tasks ?? []).filter((t) => t.status === 'retry').map((t) => ({ goalId: g.id, taskId: t.id, title: t.title, ...(t.nextAttemptAt ? { at: t.nextAttemptAt } : {}) }))),
      scheduled: live.filter((g) => g.nextRunAt && g.nextRunAt > this.now()).map((g) => ({ goalId: g.id, title: g.description, at: g.nextRunAt! })).sort((a, b) => a.at - b.at),
    };
  }
}
