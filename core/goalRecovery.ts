/**
 * core/goalRecovery.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What the Goal Runtime does when a goal-task fails: classify the failure,
 * then retry later, wait, re-plan, block for a person, or give up.
 *
 * Three recovery layers, three jobs (docs/GOAL_RUNTIME.md §Recovery):
 *   core/recoveryPlanner.ts + core/reflectionEngine.ts  one request's failed
 *       steps, inside the orchestrator, within seconds;
 *   this file   a goal-task that an agent could not finish, across minutes,
 *       hours and restarts, with bounded attempts and backoff;
 *   self_healing/recoveryPlanner.ts   JARVIS's own services (TTS, STT, …).
 * A goal-task never re-runs the orchestrator's step repairs; it keeps its own
 * attempt history and passes what was learnt to the next attempt as advice.
 *
 * A task that may change something outside JARVIS (desktop, browser, files)
 * is repeated automatically only when the failed attempt made no tool call;
 * otherwise a person decides, because repeating it might act twice.
 */

import type { FailureClass, GoalTask, GoalTaskStatus } from './goalLifecycle.js';

export interface FailureInfo {
  /** Set when the caller already knows the class. */
  class?: FailureClass;
  /** A machine code: APPROVAL_DENIED, RATE_LIMITED, TIMED_OUT, … */
  code?: string;
  message: string;
  /** How an approval this attempt asked for ended. */
  approval?: 'denied' | 'timeout' | 'unavailable';
}

const PATTERNS: [RegExp, FailureClass][] = [
  [/\b(BUDGET|budget (?:is )?(?:used|exceeded|exhausted)|BudgetExceeded)/i, 'budget'],
  [/\bDEPENDENCY_FAILED\b|depends on .* ended/i, 'dependency'],
  [/\b(PERMISSION_DENIED|RISK_REFUSED|NOT_ALLOWED|permission level|full control|refused by safety policy|outside (?:its|the) scope)\b/i, 'permission'],
  [/\b(RATE_LIMITED|rate[- ]limit|429|503|502|504|overloaded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|timed? ?out|TIMED_OUT|STALLED|ROOT_LIMIT|temporarily unavailable|service unavailable)\b/i, 'transient'],
  [/\b(conflict|contradict|disagree|insufficient evidence|low confidence|no sources?|not verified|verification found)\b/i, 'evidence'],
  [/\b(NOT_A_SPECIALIST|SPAWN_REJECTED|unknown tool|not registered|invalid argument|not supported|cannot do that|no such specialist)\b/i, 'invalid_plan'],
  [/\b(INTERRUPTED|shutting down|restart(?:ed)?|paused by)\b/i, 'interrupted'],
];

/** The class of a failure, from what is known about it. */
export function classifyFailure(f: FailureInfo): FailureClass {
  if (f.class) return f.class;
  if (f.approval || f.code === 'APPROVAL_DENIED') return 'approval';
  const text = `${f.code ?? ''} ${f.message}`;
  for (const [re, cls] of PATTERNS) if (re.test(text)) return cls;
  return 'unrecoverable';
}

export interface RetrySettings {
  /** First retry after this long; each later one waits `factor` times longer, up to maxMs. */
  baseMs: number;
  factor: number;
  maxMs: number;
}

export const DEFAULT_RETRY: RetrySettings = {
  baseMs: Number(process.env['JARVIS_GOAL_RETRY_BASE_MS'] ?? 30_000),
  factor: 4,
  maxMs: Number(process.env['JARVIS_GOAL_RETRY_MAX_MS'] ?? 30 * 60_000),
};

export function backoffMs(attempt: number, s: RetrySettings = DEFAULT_RETRY): number {
  return Math.min(s.maxMs, Math.round(s.baseMs * s.factor ** Math.max(0, attempt - 1)));
}

/** What happens to the task and its goal. */
export interface RecoveryDecision {
  taskStatus: GoalTaskStatus;
  nextAttemptAt?: number;
  waitingFor?: GoalTask['waitingFor'];
  /** continue: the goal carries on (other tasks, or evaluation decides); wait / block: the goal stops for that. */
  goal: 'continue' | 'replan' | 'wait' | 'block';
  goalWaitingFor?: 'approval' | 'budget' | 'service' | 'review';
  /** What the runtime did, in words, for the history and status. */
  action: string;
  /** What should change on the next attempt. */
  advice?: string;
  /** Whether this attempt counts against the task's attempts. */
  countsAsAttempt: boolean;
}

export interface DecideInput {
  task: GoalTask;
  failure: FailureInfo;
  cls: FailureClass;
  /** Tool calls the failed attempt made (undefined: unknown). */
  toolCalls?: number;
  now: number;
  retry?: RetrySettings;
}

/** Bounded, explicit recovery for one failed attempt. */
export function decideRecovery({ task, failure, cls, toolCalls, now, retry = DEFAULT_RETRY }: DecideInput): RecoveryDecision {
  const attemptsLeft = task.attempts < task.maxAttempts;
  const actedOutside = task.sideEffects === 'possible' && toolCalls !== 0;
  const msg = failure.message.slice(0, 200);
  const retryAt = (attempt: number, mult = 1) => now + backoffMs(attempt, retry) * mult;

  switch (cls) {
    case 'approval':
      // Nobody answered: not a refusal and not a failure; it waits for the user.
      if (failure.approval === 'timeout' || failure.approval === 'unavailable') {
        return {
          taskStatus: 'waiting', waitingFor: 'approval', goal: 'wait', goalWaitingFor: 'approval', countsAsAttempt: false,
          action: 'waiting: nobody answered the approval request; say "resume goal" when you are there to answer it',
        };
      }
      return {
        taskStatus: 'blocked', goal: 'block', countsAsAttempt: false,
        action: 'blocked: the action was not approved; the goal waits for you to change it or resume it',
        advice: 'the user declined an action; find a way that does not need it, or ask first',
      };
    case 'permission':
      return {
        taskStatus: 'blocked', goal: 'block', countsAsAttempt: false,
        action: `blocked: ${msg}`,
        advice: 'the step needs a permission the goal does not have',
      };
    case 'budget':
      return {
        taskStatus: 'ready', goal: 'wait', goalWaitingFor: 'budget', countsAsAttempt: false,
        action: 'waiting: the goal\'s budget is used up',
      };
    case 'interrupted':
      if (actedOutside) {
        return {
          taskStatus: 'needs_review', goal: 'block', countsAsAttempt: false,
          action: 'needs review: stopped while it could have been acting on the desktop, browser or files; check before it runs again',
        };
      }
      return { taskStatus: 'ready', goal: 'continue', countsAsAttempt: false, action: 'will run again (it was interrupted and changes nothing outside JARVIS)' };
    case 'invalid_plan':
      return {
        taskStatus: 'failed', goal: 'replan', countsAsAttempt: true,
        action: 're-planning: this step cannot work as planned',
        advice: `a step failed because it could not work as planned (${msg}); plan it differently`,
      };
    default:
      break;
  }

  // transient, dependency, evidence, unrecoverable
  if (actedOutside) {
    return {
      taskStatus: 'blocked', goal: 'block', countsAsAttempt: true,
      action: `blocked: it failed after acting on the desktop, browser or files (${msg}); repeating it might act twice`,
    };
  }
  if (cls === 'unrecoverable' || !attemptsLeft) {
    return {
      taskStatus: 'failed', goal: 'continue', countsAsAttempt: true,
      action: attemptsLeft ? `failed: ${msg}` : `failed after ${task.attempts} attempt(s): ${msg}`,
      advice: `"${task.title}" failed: ${msg}`,
    };
  }
  if (cls === 'dependency') {
    const at = retryAt(task.attempts, 2);
    return {
      taskStatus: 'retry', nextAttemptAt: at, waitingFor: 'service', goal: 'continue', countsAsAttempt: true,
      action: `retry at ${new Date(at).toISOString()}: something it needs is unavailable (${msg})`,
    };
  }
  const at = retryAt(task.attempts);
  if (cls === 'evidence') {
    return {
      taskStatus: 'retry', nextAttemptAt: at, goal: 'continue', countsAsAttempt: true,
      action: `retry at ${new Date(at).toISOString()} with other sources: ${msg}`,
      advice: `the previous attempt's evidence was weak or contradictory (${msg}); use different, more reliable sources and cite them`,
    };
  }
  return {
    taskStatus: 'retry', nextAttemptAt: at, goal: 'continue', countsAsAttempt: true,
    action: `retry at ${new Date(at).toISOString()}: ${msg}`,
  };
}
