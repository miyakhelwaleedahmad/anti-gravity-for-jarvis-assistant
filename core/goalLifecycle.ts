/**
 * core/goalLifecycle.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The goal and goal-task types, and the one place that says which status
 * changes are allowed (docs/GOAL_RUNTIME.md §Lifecycle).
 *
 * Kinds:
 *   request    a typed or spoken command, recorded while the orchestrator runs
 *              it. The Goal Runtime never runs these. Goals saved before kinds
 *              existed are requests.
 *   temporary  a finite objective with success criteria; ends completed,
 *              failed, cancelled or expired.
 *   permanent  a continuing objective worked through milestones; a finished
 *              milestone does not finish the goal.
 *   recurring  a schedule that creates one temporary instance per due time.
 *
 * A goal-task is one step of a goal's plan, run by one specialist agent.
 */

import type { ResourceUsage } from './agents/types.js';

// ─── Goal ─────────────────────────────────────────────────────────────────────

export type GoalStatus =
  | 'pending'       // created, not yet planned
  | 'planning'      // its plan is being made
  | 'ready'         // planned; waits for a free worker
  | 'executing'     // tasks are running
  | 'in_progress'   // the orchestrator's name for executing (request goals)
  | 'waiting'       // waits for a time, an approval, a review, a budget or a service
  | 'retry'         // failed in a way worth trying again; waits for its retry time
  | 'paused'        // stopped by the user; resumes only when asked
  | 'blocked'       // cannot continue without a person (reason recorded)
  | 'completed'     // success criteria met (terminal)
  | 'failed'        // gave up (terminal)
  | 'cancelled'     // stopped for good by the user (terminal)
  | 'expired';      // its deadline passed (terminal)

export type GoalKind = 'request' | 'temporary' | 'permanent' | 'recurring';

export const GOAL_KINDS: readonly GoalKind[] = ['request', 'temporary', 'permanent', 'recurring'];
export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set(['completed', 'failed', 'cancelled', 'expired']);

const ACTIVE: GoalStatus[] = ['planning', 'ready', 'executing', 'in_progress', 'waiting', 'retry'];
const STOPS: GoalStatus[] = ['paused', 'blocked', 'cancelled', 'expired', 'failed'];

/**
 * Allowed changes. A change to the same status is always allowed (it updates
 * fields, not the status). Anything not listed is refused.
 */
const GOAL_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  // completed from pending/ready: every task had already ended (after a restart) and the criteria are met.
  pending:     [...ACTIVE, 'completed', ...STOPS],
  planning:    ['pending', 'ready', 'executing', 'in_progress', 'waiting', 'retry', 'completed', ...STOPS],
  ready:       ['pending', 'planning', 'executing', 'in_progress', 'waiting', 'retry', 'completed', ...STOPS],
  executing:   ['pending', 'planning', 'ready', 'in_progress', 'waiting', 'retry', 'completed', ...STOPS],
  in_progress: ['pending', 'planning', 'ready', 'executing', 'waiting', 'retry', 'completed', ...STOPS],
  waiting:     ['pending', 'planning', 'ready', 'executing', 'in_progress', 'retry', 'completed', ...STOPS],
  // A request that was interrupted and then finished anyway is completed.
  retry:       ['pending', 'planning', 'ready', 'executing', 'in_progress', 'waiting', 'completed', ...STOPS],
  paused:      ['pending', 'ready', 'waiting', 'cancelled', 'expired'],
  blocked:     ['pending', 'planning', 'ready', 'waiting', 'paused', 'cancelled', 'expired', 'failed'],
  // A failed goal can be resumed while it has attempts left (resumeGoal checks that).
  failed:      ['pending'],
  completed:   [],
  cancelled:   [],
  expired:     [],
};

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return TERMINAL_GOAL_STATUSES.has(status);
}

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  if (from === to) return true;
  return (GOAL_TRANSITIONS[from] ?? []).includes(to);
}

/** Why `from → to` is refused, or undefined when it is allowed. */
export function goalTransitionProblem(from: GoalStatus, to: GoalStatus): string | undefined {
  if (!(from in GOAL_TRANSITIONS)) return `unknown status "${from}"`;
  if (!(to in GOAL_TRANSITIONS)) return `unknown status "${to}"`;
  if (canTransitionGoal(from, to)) return undefined;
  if (isTerminalGoalStatus(from)) return `the goal has already ended (${from})`;
  return `${from} → ${to} is not an allowed change`;
}

// ─── Goal content ─────────────────────────────────────────────────────────────

/**
 * A success criterion. The verifier decides `met` from evidence:
 *   tasks_completed  every task of the plan (or milestone) completed
 *   min_confidence   the results' confidence is at least `value` (0–1)
 *   verified         the Verification agent found no issues
 *   sources          at least `value` distinct sources were cited
 *   judge            a statement checked against the results by the model
 *                    (or by the user when no model is available)
 */
export interface GoalCriterion {
  id: string;
  description: string;
  kind: 'tasks_completed' | 'min_confidence' | 'verified' | 'sources' | 'judge';
  value?: number;
  met?: boolean;
  evidence?: string;
  checkedAt?: number;
}

export type GoalTaskStatus =
  | 'pending'       // waits for its dependencies
  | 'ready'         // may run now
  | 'running'       // claimed by a worker
  | 'waiting'       // waits for an approval, a service or a review
  | 'retry'         // failed; runs again at nextAttemptAt
  | 'completed'
  | 'failed'
  | 'blocked'       // a person must look at it (reason in failures)
  | 'cancelled'
  | 'needs_review'; // stopped mid-action by a restart; repeating it might act twice

export const TERMINAL_TASK_STATUSES: ReadonlySet<GoalTaskStatus> = new Set(['completed', 'failed', 'cancelled']);

const TASK_TRANSITIONS: Record<GoalTaskStatus, readonly GoalTaskStatus[]> = {
  pending:      ['ready', 'waiting', 'blocked', 'cancelled', 'failed'],
  ready:        ['running', 'pending', 'waiting', 'blocked', 'cancelled', 'failed'],
  running:      ['completed', 'failed', 'retry', 'waiting', 'blocked', 'cancelled', 'ready', 'needs_review'],
  waiting:      ['ready', 'running', 'retry', 'blocked', 'cancelled', 'failed', 'pending'],
  retry:        ['ready', 'running', 'blocked', 'cancelled', 'failed', 'waiting'],
  blocked:      ['ready', 'cancelled', 'failed', 'pending'],
  needs_review: ['ready', 'completed', 'cancelled', 'failed', 'blocked'],
  completed:    [],
  failed:       ['ready'], // only when a person resumes the goal
  cancelled:    [],
};

export function canTransitionTask(from: GoalTaskStatus, to: GoalTaskStatus): boolean {
  if (from === to) return true;
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Why a task failed, which decides what happens next (core/goalRecovery.ts):
 *   transient       network, rate limit, model or service briefly down → retry with backoff
 *   invalid_plan    the step cannot work as planned → plan again
 *   dependency      a task it needs failed, or a service is unavailable → wait / retry later
 *   permission      refused by policy or needs full control mode → blocked, ask the user
 *   approval        an approval was not given (denied → blocked; timed out → waiting)
 *   evidence        contradictory or too little evidence → retry with what was learnt, then review
 *   budget          the goal's budget is used up → waiting (permanent) or blocked
 *   interrupted     JARVIS stopped during the task
 *   unrecoverable   anything a retry would not fix → failed
 */
export type FailureClass =
  | 'transient' | 'invalid_plan' | 'dependency' | 'permission' | 'approval'
  | 'evidence' | 'budget' | 'interrupted' | 'unrecoverable';

export interface TaskFailure {
  at: number;
  attemptId: string;
  class: FailureClass;
  message: string;
  /** What the runtime did about it (retry at …, blocked, re-planned, …). */
  action: string;
  /** What should change on the next attempt. */
  advice?: string;
}

export interface TaskResult {
  status: string;
  summary: string;
  confidence: number;
  findings: string[];
  sources: { title: string; url?: string }[];
  /** The specialist that did the work, and the sub-agents it created. */
  agent: string;
  agents?: string[];
  verification?: { verdict: string; note?: string };
  conflicts?: number;
  usage?: ResourceUsage;
  finishedAt: number;
  /** Where the result came from: this run, or an agent archive read after a restart. */
  origin?: 'run' | 'archive';
}

export interface GoalTask {
  id: string;
  title: string;
  description: string;
  /** The specialist agent that runs it (core/agents/specialists.ts). */
  specialist: string;
  dependsOn: string[];
  status: GoalTaskStatus;
  /** Whether the task can change anything outside JARVIS (desktop, browser, files, git). */
  sideEffects: 'none' | 'possible';
  attempts: number;
  maxAttempts: number;
  /** The current attempt; a result for another attempt is ignored. */
  attemptId?: string;
  nextAttemptAt?: number;
  lease?: { owner: string; claimedAt: number; expiresAt: number };
  /** The agent root task of the current attempt. */
  rootTaskId?: string;
  result?: TaskResult;
  failures: TaskFailure[];
  checkpoint?: { at: number; note: string; partial?: string[] };
  waitingFor?: 'approval' | 'service' | 'review' | 'budget';
  milestoneId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface Milestone {
  id: string;
  title: string;
  successCriteria: GoalCriterion[];
  status: 'pending' | 'active' | 'completed' | 'failed' | 'skipped';
  startedAt?: number;
  completedAt?: number;
  evidence?: string;
  /** Proposed by the planner rather than given by the user. */
  proposed?: boolean;
}

/**
 * When a goal runs. Times are epoch milliseconds; `time` is a local "HH:MM"
 * in `timezone` (an IANA name, default the PC's zone). `weekdays`: 0 = Sunday.
 */
export type GoalSchedule =
  | { type: 'once'; at: number }
  | { type: 'interval'; everyMs: number; startAt?: number }
  | { type: 'daily'; time: string; timezone?: string; weekdays?: number[] };

export interface GoalPolicy {
  /** Background goals use read-only specialists unless this is set. */
  allowDesktop?: boolean;
  /** Tasks of this goal that may run at once. */
  maxParallelTasks?: number;
  /** Permanent goals: time between work cycles when nothing else is due. */
  reviewIntervalMs?: number;
  /** Permanent goals: at most this many cycles per day. */
  maxCyclesPerDay?: number;
  /** Recurring goals: after downtime, run the latest missed time once, or skip it. */
  catchUp?: 'one' | 'none';
  /** Permanent goals: this many failed cycles in a row block the goal for a person to look at. */
  maxConsecutiveFailures?: number;
  /** Start no work before this time. */
  startAfter?: number;
  /** The goal expires at this time if not finished. */
  deadline?: number;
  /** Plan with the model (default) or as one task for the chosen specialist. */
  planner?: 'model' | 'single';
}

export interface GoalBudget {
  llmCalls?: number;
  toolCalls?: number;
  tokens?: number;
  /** Tasks (attempts included) the goal may start. */
  maxTasks?: number;
  /** For permanent and recurring goals: the budget renews every day. */
  period?: 'goal' | 'day';
}

export interface GoalUsage {
  llmCalls: number;
  toolCalls: number;
  tokens: number;
  tasks: number;
  periodStart: number;
}

export interface GoalHistoryEntry {
  at: number;
  event: string;
  reason: string;
  from?: GoalStatus;
  to?: GoalStatus;
  taskId?: string;
}

export interface GoalLesson {
  id: string;
  text: string;
  /** What it was learnt from. */
  source: 'success' | 'failure' | 'user_feedback' | 'retry';
  goalId: string;
  taskId?: string;
  specialist?: string;
  failureClass?: FailureClass;
  evidence?: string;
  createdAt: number;
  /** Times a later plan used it, and how those goals ended. */
  applied: number;
  successesAfter: number;
  failuresAfter: number;
}

/** Fields only managed (non-request) goals have. All optional: old files load unchanged. */
export interface ManagedGoalFields {
  kind?: GoalKind;
  objective?: string;
  successCriteria?: GoalCriterion[];
  constraints?: string[];
  tasks?: GoalTask[];
  milestones?: Milestone[];
  schedule?: GoalSchedule;
  nextRunAt?: number;
  lastRunAt?: number;
  policy?: GoalPolicy;
  budget?: GoalBudget;
  usage?: GoalUsage;
  history?: GoalHistoryEntry[];
  /** Recurring instances: the template, and the due time the instance is for. */
  parentGoalId?: string;
  instanceKey?: string;
  /** Event names that make the goal due ("monitor and respond"). */
  triggers?: string[];
  progress?: { percent: number; note: string; updatedAt: number };
  waitingFor?: 'schedule' | 'approval' | 'review' | 'budget' | 'service' | 'trigger';
  blockedReason?: string;
  cycles?: number;
  consecutiveFailures?: number;
  /** Ids of lessons used when this goal was planned. */
  lessonsUsed?: string[];
  /** One-line outcome for status reports. */
  outcome?: string;
  archivedAt?: number;
}

export const MAX_GOAL_HISTORY = 200;
