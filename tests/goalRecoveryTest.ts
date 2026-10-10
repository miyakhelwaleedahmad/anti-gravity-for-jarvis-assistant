/**
 * tests/goalRecoveryTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Goal Runtime phase 3: failure classes and recovery decisions
 * (core/goalRecovery.ts), and the schedule/goal phrases of goal_create.
 */

const { classifyFailure, decideRecovery, backoffMs } = await import('../core/goalRecovery.js');
const { parseSchedule, parseWhen } = await import('../core/goalTools.js');
type GoalTask = import('../core/goalLifecycle.js').GoalTask;

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const task = (over: Partial<GoalTask> = {}): GoalTask => ({
  id: 't', title: 'step', description: 'step', specialist: 'research_agent', dependsOn: [], status: 'running',
  sideEffects: 'none', attempts: 1, maxAttempts: 3, failures: [], createdAt: 0, ...over,
});
const retry = { baseMs: 1_000, factor: 4, maxMs: 60_000 };

console.log('\n=== Goal recovery (phase 3) ===\n');

console.log('--- Classes ---');
const cases: [Parameters<typeof classifyFailure>[0], string][] = [
  [{ message: 'fetch failed: ECONNRESET' }, 'transient'],
  [{ message: 'Groq 429 rate limit' }, 'transient'],
  [{ code: 'TIMED_OUT', message: 'the agents ran out of time' }, 'transient'],
  [{ code: 'ROOT_LIMIT', message: '3 delegated tasks are already running' }, 'transient'],
  [{ code: 'PERMISSION_DENIED', message: 'requires permission level 2' }, 'permission'],
  [{ code: 'RISK_REFUSED', message: 'Refused by safety policy' }, 'permission'],
  [{ code: 'APPROVAL_DENIED', message: 'not approved' }, 'approval'],
  [{ code: 'BUDGET_EXCEEDED', message: 'budget exceeded' }, 'budget'],
  [{ code: 'DEPENDENCY_FAILED', message: 'Task x it depends on ended FAILED' }, 'dependency'],
  [{ code: 'NOT_A_SPECIALIST', message: 'not one of the specialists' }, 'invalid_plan'],
  [{ message: 'sources disagree; conflict on the version' }, 'evidence'],
  [{ message: 'JARVIS is shutting down (INTERRUPTED)' }, 'interrupted'],
  [{ message: 'TypeError: x is not a function' }, 'unrecoverable'],
];
for (const [f, want] of cases) ok(`${f.code ?? f.message.slice(0, 30)} → ${want}`, classifyFailure(f) === want, classifyFailure(f));

console.log('\n--- Decisions ---');
let d = decideRecovery({ task: task(), failure: { message: 'ECONNRESET' }, cls: 'transient', now: 0, retry });
ok('transient, attempts left → retry with backoff', d.taskStatus === 'retry' && d.nextAttemptAt === 1_000 && d.countsAsAttempt);
d = decideRecovery({ task: task({ attempts: 2 }), failure: { message: 'ECONNRESET' }, cls: 'transient', now: 0, retry });
ok('the second retry waits longer', d.nextAttemptAt === 4_000);
d = decideRecovery({ task: task({ attempts: 3 }), failure: { message: 'ECONNRESET' }, cls: 'transient', now: 0, retry });
ok('no attempts left → failed', d.taskStatus === 'failed' && d.goal === 'continue');
ok('backoff is capped', backoffMs(10, retry) === 60_000);
d = decideRecovery({ task: task(), failure: { message: 'no answer', approval: 'timeout' }, cls: 'approval', now: 0, retry });
ok('unanswered approval → waiting, not counted', d.taskStatus === 'waiting' && d.goal === 'wait' && d.goalWaitingFor === 'approval' && !d.countsAsAttempt);
d = decideRecovery({ task: task(), failure: { message: 'no', approval: 'denied' }, cls: 'approval', now: 0, retry });
ok('denied approval → blocked', d.taskStatus === 'blocked' && d.goal === 'block');
d = decideRecovery({ task: task(), failure: { message: 'level 2' }, cls: 'permission', now: 0, retry });
ok('permission → blocked for a person', d.taskStatus === 'blocked' && d.goal === 'block');
d = decideRecovery({ task: task(), failure: { message: 'cannot' }, cls: 'invalid_plan', now: 0, retry });
ok('invalid plan → re-plan, with advice', d.goal === 'replan' && !!d.advice);
d = decideRecovery({ task: task(), failure: { message: 'weak sources' }, cls: 'evidence', now: 0, retry });
ok('weak evidence → retry with advice to use other sources', d.taskStatus === 'retry' && /different/.test(d.advice ?? ''));
d = decideRecovery({ task: task({ sideEffects: 'possible' }), failure: { message: 'ECONNRESET' }, cls: 'transient', toolCalls: 2, now: 0, retry });
ok('an acting task that made tool calls is not repeated automatically', d.taskStatus === 'blocked' && d.goal === 'block');
d = decideRecovery({ task: task({ sideEffects: 'possible' }), failure: { message: 'ECONNRESET' }, cls: 'transient', toolCalls: 0, now: 0, retry });
ok('… but one that made no tool call is', d.taskStatus === 'retry');
d = decideRecovery({ task: task({ sideEffects: 'possible' }), failure: { message: 'restart' }, cls: 'interrupted', now: 0, retry });
ok('an acting task interrupted mid-way needs review', d.taskStatus === 'needs_review' && d.goal === 'block');
d = decideRecovery({ task: task(), failure: { message: 'restart' }, cls: 'interrupted', now: 0, retry });
ok('a read-only task interrupted runs again, not counted', d.taskStatus === 'ready' && !d.countsAsAttempt);
d = decideRecovery({ task: task(), failure: { message: 'budget' }, cls: 'budget', now: 0, retry });
ok('budget → the goal waits for budget', d.goal === 'wait' && d.goalWaitingFor === 'budget');

console.log('\n--- Schedules in words ---');
const s = (t: string) => parseSchedule(t, 'Asia/Karachi');
ok('"every 2 hours"', JSON.stringify(s('every 2 hours')) === JSON.stringify({ type: 'interval', everyMs: 7_200_000 }));
ok('"hourly"', (s('hourly') as { everyMs: number }).everyMs === 3_600_000);
ok('"daily at 9"', JSON.stringify(s('daily at 9')) === JSON.stringify({ type: 'daily', time: '09:00', timezone: 'Asia/Karachi' }));
ok('"every day at 9:30 pm"', (s('every day at 9:30 pm') as { time: string }).time === '21:30');
ok('"weekdays at 8am"', JSON.stringify((s('weekdays at 8am') as { weekdays: number[] }).weekdays) === '[1,2,3,4,5]');
ok('"every monday and thursday at 18:00"', JSON.stringify((s('every monday and thursday at 18:00') as { weekdays: number[] }).weekdays) === '[1,4]');
ok('"in 30 minutes" is a one-time schedule', (s('in 30 minutes') as { type: string }).type === 'once');
ok('an ISO time is a one-time schedule', (s('2026-10-11T09:00Z') as { type: string; at: number }).at === Date.UTC(2026, 9, 11, 9, 0));
ok('nonsense is explained, not guessed', typeof s('whenever you like') === 'string');
ok('"13 pm" is refused', typeof s('daily at 13 pm') === 'string');
ok('parseWhen "in 3 hours"', parseWhen('in 3 hours', 0) === 3 * 3_600_000);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
