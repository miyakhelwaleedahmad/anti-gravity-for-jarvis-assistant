/**
 * tests/goalRuntimeTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Goal Runtime phases 2 and 3 (docs/GOAL_RUNTIME_PLAN.md), with a scripted
 * executor and planner so every outcome is deterministic:
 *
 *   - a pending goal runs and completes with no user message
 *   - independent tasks run in parallel within the limit; dependencies wait
 *   - transient failures are retried by the worker; permission and denied
 *     approvals block; an unanswered approval waits (not failed)
 *   - pause stops work and resume continues it; cancel stops it for good
 *   - success criteria decide completion; unmet criteria re-plan, then fail
 *   - recurring goals: one instance per due time, no overlap, one catch-up
 *   - permanent goals: milestones over a restart; a milestone is not the goal
 *   - restart: read-only tasks run again, acting tasks wait for review, a
 *     result already in the agent archive is taken; stale results ignored
 *   - deadlines expire goals; budgets stop them
 *
 * The real agent system is exercised in goalAgentIntegrationTest.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-goal-runtime-'));
process.env['JARVIS_DATA_ROOT'] = tmp;
process.env['JARVIS_WORKSPACE_ROOT'] = tmp;

const { GoalManager } = await import('../core/goalManager.js');
const { GoalRuntime } = await import('../core/goalRuntime.js');
type Goal = import('../core/goalManager.js').Goal;
type ExecRequest = import('../core/goalRuntime.js').ExecRequest;
type ExecOutcome = import('../core/goalRuntime.js').ExecOutcome;
type GoalPlanner = import('../core/goalPlanner.js').GoalPlanner;
type PlannedTask = import('../core/goalPlanner.js').PlannedTask;

let clock = Date.now();
const now = () => clock;

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(10); }
  return cond();
}

function result(summary: string, confidence = 0.8): ExecOutcome {
  return {
    ok: true,
    usage: { llmCalls: 1, toolCalls: 1, tokens: 100 },
    result: { status: 'COMPLETED', summary, confidence, findings: [summary], sources: [{ title: 'src', url: `https://example.com/${encodeURIComponent(summary.slice(0, 10))}` }], agent: 'research_agent', finishedAt: Date.now() },
  };
}

/** Scripted executor: `script` decides per task title; records calls and concurrency. */
class ScriptExecutor {
  calls: { title: string; attempt: number; context: string; goalId: string }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  script: (req: ExecRequest, n: number) => Promise<ExecOutcome> = async (req) => result(`did ${req.task.title}`);
  previous = new Map<string, { status: string; result?: ExecOutcome['result']; findings?: string[] }>();
  async run(req: ExecRequest): Promise<ExecOutcome> {
    const n = this.calls.filter((c) => c.title === req.task.title && c.goalId === req.goal.id).length + 1;
    this.calls.push({ title: req.task.title, attempt: req.task.attempts, context: req.context, goalId: req.goal.id });
    req.onStarted(`root-${req.task.id}-${n}`);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await this.script(req, n);
    } finally {
      this.inFlight--;
    }
  }
  inspectPrevious(rootTaskId: string) { return this.previous.get(rootTaskId); }
}

/** Waits for the signal to abort, then reports a cancelled run (as the agent system does). */
function untilAborted(req: ExecRequest): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    req.signal.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'CANCELLED', message: 'cancelled' }, usage: { llmCalls: 0, toolCalls: 0, tokens: 0 } }), { once: true });
  });
}

class ScriptPlanner implements GoalPlanner {
  plans: PlannedTask[][] = [];
  calls = 0;
  advice: string[][] = [];
  proposals: ({ title: string; successCriteria: string[] } | undefined)[] = [];
  async plan(input: Parameters<GoalPlanner['plan']>[0]) {
    this.calls++;
    this.advice.push(input.advice);
    const tasks = this.plans.shift() ?? [{ title: `do ${input.milestone?.title ?? input.goal.description}`, description: 'x', specialist: 'research_agent', dependsOn: [], sideEffects: 'none' as const }];
    return { tasks, via: 'model' as const };
  }
  async proposeMilestone() { return this.proposals.shift(); }
}

const T = (title: string, dependsOn: string[] = [], specialist = 'research_agent', sideEffects: 'none' | 'possible' = 'none'): PlannedTask =>
  ({ title, description: `${title} (desc)`, specialist, dependsOn, sideEffects });


function makeRuntime(manager: InstanceType<typeof GoalManager>, executor: ScriptExecutor, planner: ScriptPlanner, extra: Record<string, unknown> = {}) {
  return new GoalRuntime({
    manager, executor, planner, now, maxConcurrent: 3, leaseMs: 60_000, stopWaitMs: 300,
    retry: { baseMs: 1_000, factor: 2, maxMs: 10_000 },
    ...extra,
  });
}

console.log('\n=== Goal Runtime (phases 2–3) ===\n');

const gm = new GoalManager({ now });
await gm.init();
const exec = new ScriptExecutor();
const planner = new ScriptPlanner();
const rt = makeRuntime(gm, exec, planner);
await rt.start();

console.log('--- A pending goal runs with no user message ---');
{
  planner.plans.push([T('research A')]);
  const { goal } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Research A', successCriteria: [{ description: 'confident', kind: 'min_confidence', value: 0.5 }] });
  await rt.idle();
  ok('the goal completed without another request', goal.status === 'completed', goal.status);
  ok('its outcome is the result', /did research A/.test(goal.outcome ?? ''), goal.outcome);
  ok('the criterion was checked from evidence', goal.successCriteria![0]!.met === true && /average confidence/.test(goal.successCriteria![0]!.evidence ?? ''));
  const events = (goal.history ?? []).map((h) => h.event);
  ok('history shows planning, the task and completion', ['planned', 'task_started', 'task_completed'].every((e) => events.includes(e)), events.join(','));
  ok('usage is counted', (goal.usage?.llmCalls ?? 0) === 1 && (goal.usage?.tasks ?? 0) === 1);
}

console.log('\n--- Parallel tasks within the limit; dependencies wait ---');
{
  exec.maxInFlight = 0;
  exec.script = async (req) => { await sleep(80); return result(`did ${req.task.title}`); };
  planner.plans.push([T('p1'), T('p2'), T('p3'), T('p4'), T('join', ['p1', 'p2', 'p3', 'p4'])]);
  const { goal } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Parallel work', policy: { maxParallelTasks: 3 } });
  await rt.idle();
  ok('independent tasks ran at the same time', exec.maxInFlight > 1, `max ${exec.maxInFlight}`);
  ok('never more than the limit (3)', exec.maxInFlight <= 3, `max ${exec.maxInFlight}`);
  const join = exec.calls.find((c) => c.title === 'join' && c.goalId === goal.id)!;
  ok('the dependent task got the results it builds on', ['p1', 'p2', 'p3', 'p4'].every((p) => join.context.includes(`did ${p}`)));
  const order = exec.calls.filter((c) => c.goalId === goal.id).map((c) => c.title);
  ok('the dependent task ran last', order.at(-1) === 'join', order.join(','));
  ok('the goal completed', goal.status === 'completed');
  exec.script = async (req) => result(`did ${req.task.title}`);
}

console.log('\n--- Transient failure: retried by the worker ---');
{
  exec.script = async (req, n) => (n === 1 ? { ok: false, failure: { message: 'fetch failed: ECONNRESET' }, usage: { llmCalls: 1, toolCalls: 1, tokens: 0 } } : result('second time'));
  planner.plans.push([T('flaky')]);
  const { goal } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Flaky work' });
  await rt.idle(2_000);
  const task = goal.tasks![0]!;
  ok('the task waits to retry, with a time', task.status === 'retry' && !!task.nextAttemptAt, `${task.status}`);
  ok('the goal shows that it waits to retry', goal.status === 'retry', goal.status);
  ok('the failure is classified and recorded', task.failures[0]?.class === 'transient' && /retry at/.test(task.failures[0]!.action));
  clock += 1_500;
  await rt.idle();
  ok('the worker retried it on its own and it completed', task.status === 'completed' && task.attempts === 2 && goal.status === 'completed', `${task.status}, attempts ${task.attempts}`);
}

console.log('\n--- Permission and denied approval block; an unanswered approval waits ---');
{
  exec.script = async () => ({ ok: false, failure: { code: 'PERMISSION_DENIED', message: 'Tool "files" requires permission level 2' }, usage: { llmCalls: 1, toolCalls: 0, tokens: 0 } });
  planner.plans.push([T('needs permission')]);
  const { goal: g1 } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Needs permission' });
  await rt.idle();
  ok('a permission error blocks the goal with the reason', g1.status === 'blocked' && /permission level/.test(g1.blockedReason ?? ''), `${g1.status}: ${g1.blockedReason}`);
  ok('the attempt did not count against the task', g1.tasks![0]!.attempts === 0);

  exec.script = async () => ({ ok: false, failure: { code: 'APPROVAL_DENIED', message: 'not approved', approval: 'denied' } });
  planner.plans.push([T('denied')]);
  const { goal: g2 } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Denied approval' });
  await rt.idle();
  ok('a denied approval blocks (it is not retried)', g2.status === 'blocked' && exec.calls.filter((c) => c.goalId === g2.id).length === 1);

  let approved = false;
  exec.script = async () => (approved ? result('done after approval') : { ok: false, failure: { code: 'APPROVAL_DENIED', message: 'no answer', approval: 'timeout' } });
  planner.plans.push([T('needs approval')]);
  const { goal: g3 } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Unanswered approval' });
  await rt.idle();
  ok('an unanswered approval leaves the goal waiting, not failed', g3.status === 'waiting' && g3.waitingFor === 'approval', `${g3.status}/${g3.waitingFor}`);
  clock += 3_600_000;
  await rt.idle();
  ok('… and it does not run again by itself', exec.calls.filter((c) => c.goalId === g3.id).length === 1);
  approved = true;
  await gm.resumeGoal(g3.id);
  await rt.idle();
  ok('resumed by the user, it asks again and completes', g3.status === 'completed', g3.status);
  exec.script = async (req) => result(`did ${req.task.title}`);
}

console.log('\n--- Pause stops work; resume continues; cancel ends it ---');
{
  let release = false;
  exec.script = async (req) => (release ? result('finished after resume') : untilAborted(req));
  planner.plans.push([T('long task')]);
  const { goal } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Long job' });
  await until(() => goal.tasks?.[0]?.status === 'running');
  await gm.pauseGoal(goal.id);
  await until(() => goal.tasks![0]!.status !== 'running');
  ok('pausing aborted the running task, which is ready to run again', goal.status === 'paused' && goal.tasks![0]!.status === 'ready', `${goal.status}/${goal.tasks![0]!.status}`);
  const before = exec.calls.filter((c) => c.goalId === goal.id).length;
  clock += 60_000;
  await rt.idle();
  ok('nothing runs while paused', exec.calls.filter((c) => c.goalId === goal.id).length === before);
  release = true;
  await gm.resumeGoal(goal.id);
  await rt.idle();
  ok('resume continues it to completion', goal.status === 'completed', goal.status);

  release = false;
  planner.plans.push([T('to cancel')]);
  const { goal: c } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Cancel me' });
  await until(() => c.tasks?.[0]?.status === 'running');
  await gm.cancelGoal(c.id, 'not needed');
  await until(() => c.tasks![0]!.status !== 'running');
  await rt.idle();
  ok('cancel stops it for good', c.status === 'cancelled' && c.tasks![0]!.status === 'cancelled', `${c.status}/${c.tasks![0]!.status}`);
  exec.script = async (req) => result(`did ${req.task.title}`);
}

console.log('\n--- Success criteria decide; unmet criteria re-plan, then fail ---');
{
  const verdicts = [false, true];
  const judge = async () => { const met = verdicts.shift(); return met === undefined ? undefined : { met, reason: met ? 'the report names a winner' : 'no recommendation in the results' }; };
  const rt2 = makeRuntime(gm, exec, planner, { judge });
  await rt.stop();
  await rt2.start();
  planner.plans.push([T('compare')], [T('compare again')]);
  const { goal } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Pick a framework', successCriteria: ['names a recommendation'] });
  await rt2.idle();
  ok('unmet criteria made it re-plan once, then it completed', goal.status === 'completed' && goal.retries === 1, `${goal.status}, retries ${goal.retries}`);
  ok('the second plan was told why the first fell short', planner.advice.at(-1)!.some((a) => /no recommendation/.test(a)), JSON.stringify(planner.advice.at(-1)));

  const alwaysNo = async () => ({ met: false, reason: 'still missing' });
  const rt3 = makeRuntime(gm, exec, planner, { judge: alwaysNo });
  await rt2.stop();
  await rt3.start();
  const { goal: g2 } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Never good enough', successCriteria: ['impossible'], maxRetries: 2 });
  await rt3.idle();
  ok('when re-plans run out the goal fails with the reason', g2.status === 'failed' && /criteria not met/.test(g2.outcome ?? ''), `${g2.status}: ${g2.outcome}`);

  const rt4 = makeRuntime(gm, exec, planner); // no judge
  await rt3.stop();
  await rt4.start();
  const { goal: g3 } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Needs a judge', successCriteria: ['the user likes it'] });
  await rt4.idle();
  ok('without a model the goal waits for review instead of completing', g3.status === 'waiting' && g3.waitingFor === 'review', `${g3.status}/${g3.waitingFor}`);
  ok('a person can confirm it', await rt4.confirmGoal(g3.id) && g3.status === 'completed');
  await rt4.stop();
  await rt.start();
}

console.log('\n--- Recurring: one instance per due time, no overlap, one catch-up ---');
{
  const { goal: tpl } = await gm.createManagedGoal({ kind: 'recurring', objective: 'Hourly check', schedule: { type: 'interval', everyMs: 3_600_000 } });
  await rt.idle();
  const instances = () => gm.listGoals().filter((g) => g.parentGoalId === tpl.id);
  ok('nothing runs before the first due time', instances().length === 0);
  clock += 3_600_000;
  await rt.idle();
  ok('at the due time one instance runs and completes', instances().length === 1 && instances()[0]!.status === 'completed', instances().map((g) => g.status).join(','));
  await rt.tick();
  await rt.idle();
  ok('the same due time does not run twice', instances().length === 1);

  // Overlap: the next run hangs; the one after must be skipped.
  exec.script = async (req) => untilAborted(req);
  clock += 3_600_000;
  await rt.idle(500);
  ok('the second run started', instances().length === 2 && instances()[1]!.status === 'executing', instances().map((g) => g.status).join(','));
  clock += 3_600_000;
  await rt.tick();
  await sleep(50);
  ok('while it is still running, the next run is skipped', instances().length === 2 && (tpl.history ?? []).some((h) => h.event === 'instance_skipped'));
  await gm.cancelGoal(instances()[1]!.id);
  await rt.idle();
  exec.script = async (req) => result(`did ${req.task.title}`);

  // Downtime: five slots missed → one catch-up run.
  await rt.stop();
  clock += 5 * 3_600_000;
  await rt.start();
  await rt.idle();
  ok('after downtime, one catch-up run (not five)', instances().length === 3, `${instances().length}`);
  ok('the missed runs are recorded', (tpl.history ?? []).some((h) => /missed run/.test(h.reason)));
  ok('instance keys are unique', new Set(instances().map((g) => g.instanceKey)).size === instances().length);
  ok('the template keeps waiting for its schedule', tpl.status === 'waiting' && (tpl.nextRunAt ?? 0) > clock);

  tpl.policy = { ...(tpl.policy ?? {}), catchUp: 'none' };
  await rt.stop();
  clock += 3 * 3_600_000 + 30 * 60_000; // the latest missed run is half an hour old
  await rt.start();
  await rt.idle();
  ok('with catch-up off, missed runs are skipped', instances().length === 3 && (tpl.history ?? []).some((h) => /catch-up is off/.test(h.reason)));
  await gm.pauseGoal(tpl.id);
}

console.log('\n--- Permanent goal: milestones across a restart ---');
let permId = '';
{
  planner.plans.push([T('fix flaky test')]);
  const { goal } = await gm.createManagedGoal({
    kind: 'permanent', objective: 'Keep JARVIS reliable', milestones: ['fix flaky tests', 'speed up startup'],
    policy: { maxCyclesPerDay: 1, reviewIntervalMs: 6 * 3_600_000 },
  });
  permId = goal.id;
  await rt.idle();
  ok('the first milestone completed', goal.milestones![0]!.status === 'completed');
  ok('a milestone does not complete the goal', goal.status === 'waiting' && goal.waitingFor === 'schedule', `${goal.status}/${goal.waitingFor}`);
  ok('progress is recorded', goal.progress?.percent === 50, goal.progress?.note);
  ok('the daily cycle limit holds the next one until tomorrow', (goal.nextRunAt ?? 0) > clock && goal.milestones![1]!.status === 'pending');
  await rt.stop();
}
{
  // A new process: new manager, new runtime, same data folder.
  await gm.flush();
  const gm2 = new GoalManager({ now });
  await gm2.init();
  const exec2 = new ScriptExecutor();
  const planner2 = new ScriptPlanner();
  planner2.plans.push([T('profile startup'), T('cache config', ['profile startup'])]);
  planner2.proposals.push(undefined);
  const rt5 = makeRuntime(gm2, exec2, planner2);
  await rt5.start();
  const goal = gm2.getGoal(permId)!;
  ok('the permanent goal survived the restart', !!goal && goal.status === 'waiting');
  clock += 2 * 86_400_000;
  await rt5.idle();
  ok('the next milestone ran after the restart', goal.milestones![1]!.status === 'completed', goal.milestones!.map((m) => m.status).join(','));
  ok('progress reached 100 %', goal.progress?.percent === 100);
  clock += 7 * 3_600_000;
  await rt5.idle();
  ok('with no milestone left and none proposed, it waits (still a goal)', goal.status === 'waiting' && (goal.history ?? []).some((h) => /no milestone left/.test(h.reason)), goal.status);
  await rt5.stop();
}

console.log('\n--- Restart while tasks were running ---');
{
  const gm3 = new GoalManager({ now });
  await gm3.init();
  const exec3 = new ScriptExecutor();
  exec3.script = async (req) => untilAborted(req);
  const planner3 = new ScriptPlanner();
  const rt6 = makeRuntime(gm3, exec3, planner3, { maxConcurrent: 3 });
  await rt6.start();
  const { goal: readOnly } = await gm3.createManagedGoal({ kind: 'temporary', objective: 'read only', tasks: [{ title: 'read', specialist: 'research_agent' }] });
  const { goal: acting } = await gm3.createManagedGoal({ kind: 'temporary', objective: 'acting', policy: { allowDesktop: true }, tasks: [{ title: 'click', specialist: 'pc_agent', sideEffects: 'possible' }] });
  const { goal: finished } = await gm3.createManagedGoal({ kind: 'temporary', objective: 'finished before crash', tasks: [{ title: 'done', specialist: 'research_agent' }] });
  await until(() => [readOnly, acting, finished].every((g) => g.tasks![0]!.status === 'running'));
  ok('the claims are on disk before the work', fs.readFileSync(path.join(tmp, 'data', 'runtime', 'goals.json'), 'utf8').includes('"lease"'));
  // "Crash": no stop(). The archive says one of them had finished.
  const doneRoot = finished.tasks![0]!.rootTaskId!;
  await gm3.flush();

  const gm4 = new GoalManager({ now });
  await gm4.init();
  const exec4 = new ScriptExecutor();
  exec4.previous.set(doneRoot, { status: 'COMPLETED', result: result('finished before the crash').result! });
  const rt7 = makeRuntime(gm4, exec4, new ScriptPlanner());
  const report = await rt7.start();
  await rt7.idle();
  const ro = gm4.getGoal(readOnly.id)!;
  const ac = gm4.getGoal(acting.id)!;
  const fin = gm4.getGoal(finished.id)!;
  ok('a read-only task ran again and completed', ro.status === 'completed' && exec4.calls.some((c) => c.goalId === ro.id), ro.status);
  ok('a task that may have acted is not repeated: it waits for review', ac.tasks![0]!.status === 'needs_review' && ac.status === 'blocked' && !exec4.calls.some((c) => c.goalId === ac.id), `${ac.tasks![0]!.status}/${ac.status}`);
  ok('a result already in the agent archive is taken, not re-run', fin.tasks![0]!.result?.origin === 'archive' && !exec4.calls.some((c) => c.goalId === fin.id) && fin.status === 'completed', fin.status);
  ok('the restart report counts them', report.recovered === 1 && report.needsReview === 1 && report.resumedFromArchive === 1, JSON.stringify(report));
  await gm4.resumeGoal(ac.id);
  await rt7.idle();
  ok('after review, resuming runs the acting task', ac.status === 'completed' && exec4.calls.some((c) => c.goalId === ac.id), ac.status);
  await rt7.stop();
  await rt6.stop();
}

console.log('\n--- Stale results, deadlines, budgets ---');
{
  // A fresh data folder: the goals above must not take this section's workers.
  process.env['JARVIS_DATA_ROOT'] = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-goal-runtime-b-'));
  const gm5 = new GoalManager({ now });
  await gm5.init();
  const exec5 = new ScriptExecutor();
  const rt8 = makeRuntime(gm5, exec5, new ScriptPlanner());
  await rt8.start();

  let resolveOld!: (o: ExecOutcome) => void;
  exec5.script = async (_req, n) => (n === 1 ? new Promise<ExecOutcome>((r) => { resolveOld = r; }) : result('second attempt'));
  const { goal: stale } = await gm5.createManagedGoal({ kind: 'temporary', objective: 'stale', tasks: [{ title: 'slow', specialist: 'research_agent' }] });
  await until(() => stale.tasks![0]!.status === 'running');
  const t = stale.tasks![0]!;
  t.attemptId = 'someone-else'; // a newer attempt took the task
  resolveOld(result('old attempt'));
  await sleep(50);
  ok('a result for an old attempt is ignored', t.result === undefined);
  await gm5.cancelGoal(stale.id);

  exec5.script = async (req) => result(`did ${req.task.title}`);
  const { goal: late } = await gm5.createManagedGoal({ kind: 'temporary', objective: 'too late', policy: { deadline: clock - 1 }, tasks: [{ title: 'x', specialist: 'research_agent' }] });
  await rt8.idle();
  ok('a goal past its deadline expires without running', late.status === 'expired' && !exec5.calls.some((c) => c.goalId === late.id), late.status);

  const { goal: cheap } = await gm5.createManagedGoal({
    kind: 'temporary', objective: 'tight budget', budget: { maxTasks: 1 },
    tasks: [{ title: 'one', specialist: 'research_agent' }, { title: 'two', specialist: 'research_agent', dependsOn: ['one'] }],
  });
  await rt8.idle();
  ok('a used-up budget blocks the goal with the reason', cheap.status === 'blocked' && /budget/.test(cheap.blockedReason ?? ''), `${cheap.status}: ${cheap.blockedReason}`);
  ok('… after the one task it allowed', exec5.calls.filter((c) => c.goalId === cheap.id).length === 1);

  const { goal: daily } = await gm5.createManagedGoal({
    kind: 'temporary', objective: 'daily budget', budget: { maxTasks: 1, period: 'day' },
    tasks: [{ title: 'one', specialist: 'research_agent' }, { title: 'two', specialist: 'research_agent', dependsOn: ['one'] }],
  });
  await rt8.idle();
  ok('a daily budget waits for the next day instead', daily.status === 'waiting' && daily.waitingFor === 'budget', `${daily.status}/${daily.waitingFor}`);
  clock += 86_400_000 + 1;
  await rt8.idle();
  ok('… and continues when it renews', daily.status === 'completed', daily.status);

  const st = rt8.status();
  ok('status reports goals, blocked goals and the schedule', st.goals.length >= 3 && st.blocked.includes(cheap.id) && st.running);
  await rt8.stop();
}

await rt.stop();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
