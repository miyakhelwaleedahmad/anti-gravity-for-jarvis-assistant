/**
 * core/goalService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The Goal Runtime inside JARVIS: one runtime with the real agent executor,
 * the model planner and judge, and the learning hooks; started after the
 * agent system at startup and stopped at shutdown (jarvis.ts).
 *
 * What the user hears: a goal finishing, failing, being blocked, or waiting
 * for an approval or a review is said once JARVIS is idle (never over its own
 * speech); everything else is a console line.
 *
 * JARVIS_GOAL_RUNTIME=0 keeps the runtime off (goals are still recorded; they
 * run at the next start with it on).
 */

import { GoalRuntime, type GoalRuntimeEvent } from './goalRuntime.js';
import { AgentGoalExecutor } from './goalExecutor.js';
import { ModelGoalPlanner } from './goalPlanner.js';
import { modelJudge } from './goalVerifier.js';
import { goalManager } from './goalManager.js';
import { goalControlHooks } from './goalTools.js';
import { goalLearning } from './goalLearning.js';

let runtime: GoalRuntime | undefined;

export function goalRuntime(): GoalRuntime {
  runtime ??= new GoalRuntime({
    executor: new AgentGoalExecutor(),
    planner: new ModelGoalPlanner(),
    judge: modelJudge(),
    learning: goalLearning.hooks(),
    maintenance: async () => {
      // Facts not used for a while lose importance (memoryManager.decayMemory is idempotent).
      const { memoryManager } = await import('../memory/memoryManager.js');
      await memoryManager.decayMemory().catch(() => undefined);
    },
  });
  return runtime;
}

const SPOKEN: Partial<Record<GoalRuntimeEvent['type'], (text: string) => string>> = {
  goal_completed: (t) => `Sir, a background goal is done. ${t}`,
  goal_failed: (t) => `Sir, a background goal could not be finished. ${t}`,
  goal_blocked: (t) => `Sir, a background goal needs you. ${t}`,
  milestone_completed: (t) => `Sir, a milestone is done. ${t}`,
};

async function say(text: string): Promise<void> {
  try {
    const [{ nodeBridge }, { conversationBus }] = await Promise.all([import('../bridge/nodeBridge.js'), import('./conversationBus.js')]);
    const speak = () => nodeBridge.speakToClients(text);
    if (conversationBus.isIdle) speak();
    else conversationBus.onceIdle(speak);
  } catch {
    // Voice is optional.
  }
}

function clip(text: string, max = 220): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Starts the runtime. Returns what it found from the last run. */
export async function startGoalRuntime(): Promise<{ started: boolean; reason?: string }> {
  if (process.env['JARVIS_GOAL_RUNTIME'] === '0') {
    console.log('[GoalRuntime] Off (JARVIS_GOAL_RUNTIME=0). Goals are recorded and will run at a start with it on.');
    return { started: false, reason: 'disabled' };
  }
  const rt = goalRuntime();
  goalControlHooks.confirm = (id) => rt.confirmGoal(id);
  goalControlHooks.feedback = (goal, text) => goalLearning.feedback(goal, text);
  rt.on('event', (e: GoalRuntimeEvent) => {
    console.log(`[GoalRuntime] ${e.type}: ${e.text}`);
    const speech = SPOKEN[e.type];
    if (speech) void say(clip(speech(e.text.split(': ').slice(1).join(': ') || e.text)));
    if (e.type === 'goal_waiting' && /approval|review/.test(e.text)) void say(clip(`Sir, a background goal is waiting for you: ${e.text}`));
  });
  const report = await rt.start();
  try {
    const { runtimeDashboard } = await import('../monitoring/runtimeDashboard.js');
    runtimeDashboard.setGoalSummary(() => goalSummaryLine(rt));
  } catch { /* the dashboard is optional */ }
  const st = rt.status();
  const live = st.goals.filter((g) => !['completed', 'failed', 'cancelled', 'expired'].includes(g.status));
  console.log(`[GoalRuntime] ✅ Running: ${live.length} goal(s) (${st.scheduled.length} scheduled, ${st.blocked.length} blocked, ${st.waitingApproval.length} waiting for approval); at most ${st.maxConcurrent} task(s) at once.`
    + (report.recovered || report.needsReview || report.resumedFromArchive ? ` Restart: ${report.recovered} to re-run, ${report.resumedFromArchive} recovered, ${report.needsReview} need review.` : ''));
  return { started: true };
}

/** One line for the dashboard: active goals, work running, what waits for the user, the next run. */
export function goalSummaryLine(rt: GoalRuntime): string {
  const st = rt.status();
  if (!st.running) return 'Goal Runtime stopped';
  const live = st.goals.filter((g) => !['completed', 'failed', 'cancelled', 'expired'].includes(g.status));
  const parts = [
    `${live.length} active`,
    st.jobs.length ? `${st.jobs.filter((j) => j.kind === 'task').length} task(s) running` : '',
    st.waitingApproval.length ? `${st.waitingApproval.length} need approval` : '',
    live.some((g) => g.waitingFor === 'review') ? `${live.filter((g) => g.waitingFor === 'review').length} need review` : '',
    st.blocked.length ? `${st.blocked.length} blocked` : '',
    st.retries.length ? `${st.retries.length} retrying` : '',
    st.scheduled[0] ? `next ${new Date(st.scheduled[0].at).toLocaleTimeString()}` : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

export async function stopGoalRuntime(): Promise<void> {
  if (!runtime?.isRunning) return;
  try { (await import('../monitoring/runtimeDashboard.js')).runtimeDashboard.setGoalSummary(undefined); } catch { /* optional */ }
  await runtime.stop('JARVIS is shutting down');
  await goalManager.flush().catch(() => {});
}
