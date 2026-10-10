/**
 * core/goalLearning.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Learning from goal outcomes, kept separate from changing code.
 *
 *   observe   the Goal Runtime reports each finished task and goal
 *   compare   the outcome against the goal's verified criteria
 *   extract   a lesson only when there is evidence behind it:
 *               - a task that failed and then worked: what changed
 *               - a goal that failed: why, so the next plan avoids it
 *               - the user's correction (goal_control feedback)
 *             A plain success teaches nothing new and stores nothing; tool
 *             output and agents' claims are never stored as lessons.
 *   store     in the goal store (data/runtime/goals.json, with counters) and,
 *             for user feedback and repeated patterns, in long-term memory
 *   retrieve  lessons similar to a new goal go into its plan (goalPlanner)
 *   evaluate  each lesson counts the goals that used it and how they ended;
 *             one that keeps being followed by failures is no longer offered
 *
 * Repeated failures of one kind (same specialist, same failure class, three
 * or more in a week) produce an improvement proposal for the user — a
 * sentence, never a change to code, prompts, security or approvals.
 */

import type { FailureClass, GoalLesson, GoalTask, Milestone } from './goalLifecycle.js';
import { goalManager as defaultManager, newId, type Goal, type GoalManager } from './goalManager.js';
import type { LearningHooks } from './goalRuntime.js';
import { similarity } from './agents/similarity.js';

export interface MemorySink {
  rememberFact(fact: string, source?: string, importance?: number, confidence?: number): Promise<void>;
}

const WEEK_MS = 7 * 86_400_000;
const PATTERN_MIN = 3;

/** What a repeated failure suggests; the user decides. */
const PROPOSALS: Partial<Record<FailureClass, string>> = {
  transient: 'check the network, the model provider and the search key (SERPER_API_KEY), or lower how many goals run at once',
  permission: 'give the goal the permission it needs (full control mode or allow_desktop), or change the goal so it does not need it',
  approval: 'answer approvals when they appear, or change the goal so it needs fewer approvals',
  evidence: 'add better sources or narrower success criteria to these goals',
  invalid_plan: 'describe the objective more concretely, or name the specialist to use',
  budget: 'raise the goal budget or narrow the goal',
  dependency: 'check the service the tasks depend on',
  unrecoverable: 'look at the failure messages; the task may be outside what JARVIS can do',
};

export class GoalLearning {
  constructor(private readonly manager: GoalManager = defaultManager, private memory?: MemorySink) {}

  private async sink(): Promise<MemorySink | undefined> {
    if (this.memory) return this.memory;
    try {
      const { memoryManager } = await import('../memory/memoryManager.js');
      await memoryManager.init?.();
      return memoryManager;
    } catch {
      return undefined; // memory is optional; lessons stay in the goal store
    }
  }

  hooks(): LearningHooks {
    return {
      relevant: (g, ms) => this.relevant(g, ms),
      onTaskFinished: (g, t, cls) => this.onTaskFinished(g, t, cls),
      onGoalFinished: (g, outcome) => this.onGoalFinished(g, outcome),
    };
  }

  /** Lessons that fit this goal, best first; ones that did not help are left out. */
  relevant(goal: Goal, milestone?: Milestone, limit = 5): GoalLesson[] {
    let lessons: GoalLesson[];
    try { lessons = this.manager.getLessons(); } catch { return []; }
    const subject = `${milestone?.title ?? ''} ${goal.objective ?? goal.description}`;
    return lessons
      .filter((l) => l.goalId !== goal.id || l.source === 'user_feedback')
      .filter((l) => l.failuresAfter <= l.successesAfter + 2)
      .map((l) => ({ l, score: similarity(subject, l.text) + (l.source === 'user_feedback' ? 0.2 : 0) + Math.min(0.1, l.successesAfter * 0.02) }))
      .filter((x) => x.score >= 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.l);
  }

  private add(lesson: Omit<GoalLesson, 'id' | 'createdAt' | 'applied' | 'successesAfter' | 'failuresAfter'>): GoalLesson | undefined {
    const existing = this.manager.getLessons().find((l) => similarity(l.text, lesson.text) >= 0.8);
    if (existing) return undefined; // the same lesson is not stored twice
    const full: GoalLesson = { ...lesson, id: newId('lesson'), createdAt: this.manager.now(), applied: 0, successesAfter: 0, failuresAfter: 0 };
    this.manager.addLesson(full);
    return full;
  }

  onTaskFinished(goal: Goal, task: GoalTask, cls?: FailureClass): void {
    if (cls) return; // a failure alone is not a lesson yet; the goal's end or a later success decides
    const earlier = task.failures.filter((f) => f.class !== 'interrupted');
    if (task.status !== 'completed' || !earlier.length) return;
    const last = earlier[earlier.length - 1]!;
    this.add({
      text: `For "${(goal.objective ?? goal.description).slice(0, 100)}", step "${task.title}" (${task.specialist}): the first attempt failed (${last.class}: ${last.message.slice(0, 100)}); `
        + `it worked after ${last.advice ? `this change: ${last.advice.slice(0, 160)}` : 'a retry'}.`,
      source: 'retry', goalId: goal.id, taskId: task.id, specialist: task.specialist, failureClass: last.class,
      evidence: `completed on attempt ${task.attempts}${task.result?.verification ? `, verification ${task.result.verification.verdict}` : ''}`,
    });
  }

  onGoalFinished(goal: Goal, outcome: 'completed' | 'failed' | 'milestone' | 'blocked' | 'expired' | 'cancelled'): void {
    // Did the lessons this goal used help?
    const good = outcome === 'completed' || outcome === 'milestone';
    const bad = outcome === 'failed' || outcome === 'blocked' || outcome === 'expired';
    if (good || bad) {
      for (const id of goal.lessonsUsed ?? []) {
        const l = this.manager.getLessons().find((x) => x.id === id);
        if (!l) continue;
        l.applied++;
        if (good) l.successesAfter++;
        else l.failuresAfter++;
      }
    }
    if (outcome === 'failed') {
      const failed = (goal.tasks ?? []).filter((t) => t.status === 'failed' || t.status === 'blocked');
      const why = failed.map((t) => `${t.title} (${t.specialist}): ${t.failures.at(-1)?.class ?? 'failed'}`).slice(0, 3).join('; ');
      const lesson = this.add({
        text: `Goal "${(goal.objective ?? goal.description).slice(0, 100)}" failed${why ? `: ${why}` : ''}. ${goal.outcome?.slice(0, 160) ?? ''}`.trim(),
        source: 'failure', goalId: goal.id, evidence: goal.outcome?.slice(0, 200) ?? 'failed',
        ...(failed[0]?.failures.at(-1)?.class ? { failureClass: failed[0]!.failures.at(-1)!.class } : {}),
        ...(failed[0] ? { specialist: failed[0].specialist } : {}),
      });
      if (lesson) void this.toMemory(`Lesson from a failed goal: ${lesson.text}`, 5, 0.7);
    }
    if (outcome === 'completed' && goal.retries > 0) {
      const tasks = (goal.tasks ?? []).filter((t) => t.status === 'completed');
      this.add({
        text: `Goal "${(goal.objective ?? goal.description).slice(0, 100)}" succeeded after ${goal.retries} re-plan(s) with ${[...new Set(tasks.map((t) => t.specialist))].join(', ')}.`,
        source: 'success', goalId: goal.id, evidence: (goal.successCriteria ?? []).map((c) => `${c.description}: ${c.evidence ?? ''}`).join('; ').slice(0, 200),
      });
    }
    this.manager.touch(goal);
    for (const p of this.newPatterns()) void this.toMemory(`Repeated problem: ${p.text}`, 6, 0.8);
  }

  /** The user's correction: kept as a lesson (and in long-term memory) and noted on the goal. */
  async feedback(goal: Goal, text: string): Promise<string> {
    const lesson = this.add({
      text: `The user said about "${(goal.objective ?? goal.description).slice(0, 80)}": ${text.slice(0, 300)}`,
      source: 'user_feedback', goalId: goal.id, evidence: 'stated by the user',
    });
    this.manager.note(goal, { event: 'feedback', reason: text.slice(0, 200) });
    this.manager.touch(goal);
    if (lesson) await this.toMemory(lesson.text, 8, 1.0);
    return lesson ? 'Noted, sir. I will use that when I plan similar goals.' : 'I already have that lesson, sir.';
  }

  private async toMemory(fact: string, importance: number, confidence: number): Promise<void> {
    try { await (await this.sink())?.rememberFact(fact, 'lesson', importance, confidence); } catch { /* optional */ }
  }

  /** Repeated failures of one kind across goals in the last week. */
  failurePatterns(now = this.manager.now()): { specialist: string; cls: FailureClass; count: number; text: string }[] {
    const counts = new Map<string, { specialist: string; cls: FailureClass; count: number }>();
    for (const g of this.manager.listGoals({ kinds: ['temporary', 'permanent'] })) {
      for (const t of g.tasks ?? []) {
        for (const f of t.failures) {
          if (now - f.at > WEEK_MS || f.class === 'interrupted' || f.attemptId === 'none') continue;
          const key = `${t.specialist}|${f.class}`;
          const c = counts.get(key) ?? { specialist: t.specialist, cls: f.class, count: 0 };
          c.count++;
          counts.set(key, c);
        }
      }
    }
    return [...counts.values()].filter((c) => c.count >= PATTERN_MIN).sort((a, b) => b.count - a.count).map((c) => ({
      ...c, text: `${c.specialist} failed ${c.count} times this week with "${c.cls}" problems; suggestion: ${PROPOSALS[c.cls] ?? 'look at the failures'}.`,
    }));
  }

  private readonly announced = new Set<string>();

  /** Patterns not reported before in this run. */
  private newPatterns(): { text: string }[] {
    const fresh = this.failurePatterns().filter((p) => !this.announced.has(`${p.specialist}|${p.cls}`));
    for (const p of fresh) this.announced.add(`${p.specialist}|${p.cls}`);
    return fresh;
  }

  /** Improvement proposals for the status report. Proposals only: nothing is changed. */
  proposals(): string[] {
    return this.failurePatterns().map((p) => p.text);
  }
}

export const goalLearning = new GoalLearning();
