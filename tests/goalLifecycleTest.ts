/**
 * tests/goalLifecycleTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Goal Runtime phase 1 (docs/GOAL_RUNTIME_PLAN.md): goal kinds, the lifecycle
 * policy, validation, retention and archiving, and schedule arithmetic.
 *
 * Offline, in a temporary data folder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-goal-lifecycle-'));
process.env['JARVIS_DATA_ROOT'] = tmp;
process.env['JARVIS_WORKSPACE_ROOT'] = tmp;

const { GoalManager, isManaged, goalKind } = await import('../core/goalManager.js');
const { canTransitionGoal, goalTransitionProblem, canTransitionTask } = await import('../core/goalLifecycle.js');
const { nextRunAfter, dueTimesBetween, scheduleProblem, zonedTime } = await import('../core/goalSchedule.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
async function rejects(fn: () => Promise<unknown>): Promise<string | undefined> {
  try { await fn(); return undefined; } catch (e) { return (e as Error).message; }
}

const goalsFile = path.join(tmp, 'data', 'runtime', 'goals.json');

console.log('\n=== Goal lifecycle (phase 1) ===\n');

console.log('--- The policy ---');
ok('pending → planning → ready → executing → completed is allowed',
  canTransitionGoal('pending', 'planning') && canTransitionGoal('planning', 'ready') && canTransitionGoal('ready', 'executing') && canTransitionGoal('executing', 'completed'));
ok('a finished goal cannot start again', !canTransitionGoal('completed', 'executing') && !canTransitionGoal('cancelled', 'pending') && !canTransitionGoal('expired', 'ready'));
ok('a paused goal does not jump to executing', !canTransitionGoal('paused', 'executing'), goalTransitionProblem('paused', 'executing'));
ok('a failed goal can only be resumed (→ pending)', canTransitionGoal('failed', 'pending') && !canTransitionGoal('failed', 'executing'));
ok('unknown statuses are refused', !!goalTransitionProblem('pending', 'nonsense' as never));
ok('tasks: running → needs_review allowed; completed is final', canTransitionTask('running', 'needs_review') && !canTransitionTask('completed', 'ready'));

console.log('\n--- Old files load; request goals keep working ---');
fs.mkdirSync(path.dirname(goalsFile), { recursive: true });
fs.writeFileSync(goalsFile, JSON.stringify({
  goals: [{ id: 'old_1', description: 'open notepad', status: 'completed', source: 'cli', retries: 0, maxRetries: 3, createdAt: 1, updatedAt: 1, metadata: {}, priority: 5 }],
  activeGoalId: null,
}));
const gm = new GoalManager();
await gm.init();
const old = gm.getGoal('old_1')!;
ok('a goal saved before kinds existed is a request', goalKind(old) === 'request' && !isManaged(old));
const req = await gm.createGoal('what time is it', 'cli');
ok('a new request goal is a request', req.kind === 'request');
ok('refused change is not applied', !gm.transition(old, 'executing', 'test') && old.status === 'completed');
gm.transition(req, 'in_progress', 'request started');
gm.transition(req, 'planning', 'planning');
gm.transition(req, 'completed', 'done');
ok('each change is recorded with its reason', (req.history ?? []).map((h) => h.reason).join('|') === 'request started|planning|done', (req.history ?? []).map((h) => `${h.from}→${h.to}`).join(' '));

console.log('\n--- Validation ---');
ok('an empty objective is refused', /objective/.test(await rejects(() => gm.createManagedGoal({ kind: 'temporary', objective: '  ' })) ?? ''));
ok('a recurring goal needs a schedule', /schedule/.test(await rejects(() => gm.createManagedGoal({ kind: 'recurring', objective: 'x' })) ?? ''));
ok('a bad time of day is refused', /time of day/.test(await rejects(() => gm.createManagedGoal({ kind: 'recurring', objective: 'x', schedule: { type: 'daily', time: '25:00' } })) ?? ''));
ok('a bad time zone is refused', /time zone/.test(await rejects(() => gm.createManagedGoal({ kind: 'recurring', objective: 'x', schedule: { type: 'daily', time: '09:00', timezone: 'Mars/Base' } })) ?? ''));
ok('a task depending on an unknown task is refused', /unknown task/.test(await rejects(() => gm.createManagedGoal({
  kind: 'temporary', objective: 'x', tasks: [{ title: 'a', specialist: 'research_agent', dependsOn: ['b'] }],
})) ?? ''));
ok('a negative budget is refused', /budget/.test(await rejects(() => gm.createManagedGoal({ kind: 'temporary', objective: 'x', budget: { llmCalls: -1 } })) ?? ''));

console.log('\n--- Creating managed goals ---');
const { goal: temp } = await gm.createManagedGoal({
  kind: 'temporary', objective: 'Compare two web frameworks', successCriteria: ['names a recommendation'],
  tasks: [{ title: 'find', specialist: 'research_agent' }, { title: 'compare', specialist: 'data_agent', dependsOn: ['find'] }],
});
ok('a temporary goal starts pending with its plan', temp.status === 'pending' && temp.tasks?.length === 2);
ok('dependencies are stored by task id', temp.tasks![1]!.dependsOn[0] === temp.tasks![0]!.id);
ok('a sentence criterion becomes a judge criterion', temp.successCriteria?.[0]?.kind === 'judge');
const onDisk = JSON.parse(fs.readFileSync(goalsFile, 'utf8')) as { goals: { id: string }[] };
ok('a managed goal is on disk at once (no debounce)', onDisk.goals.some((g) => g.id === temp.id));

const { goal: rec } = await gm.createManagedGoal({ kind: 'recurring', objective: 'daily check', schedule: { type: 'interval', everyMs: 3_600_000 } });
ok('a recurring goal waits for its schedule', rec.status === 'waiting' && rec.waitingFor === 'schedule' && (rec.nextRunAt ?? 0) > Date.now());
const later = Date.now() + 3_600_000;
const { goal: once } = await gm.createManagedGoal({ kind: 'temporary', objective: 'later', schedule: { type: 'once', at: later } });
ok('a goal for later waits until then', once.status === 'waiting' && once.nextRunAt === later);

const a = await gm.createManagedGoal({ kind: 'temporary', objective: 'instance', instanceKey: 'rec@1' });
const b = await gm.createManagedGoal({ kind: 'temporary', objective: 'instance', instanceKey: 'rec@1' });
ok('the same instance key is created once', a.created && !b.created && a.goal.id === b.goal.id);

console.log('\n--- Retention: requests do not push out managed goals ---');
const { goal: perm } = await gm.createManagedGoal({ kind: 'permanent', objective: 'Keep improving JARVIS', milestones: ['fix flaky tests', 'faster startup'] });
for (let i = 0; i < 150; i++) await gm.createGoal(`request ${i}`, 'cli');
ok('the permanent goal is still there after 150 requests', !!gm.getGoal(perm.id));
ok('only the newest 100 request goals are kept', gm.listGoals({ kinds: ['request'] }).length === 100, `${gm.listGoals({ kinds: ['request'] }).length}`);
ok('milestones are stored', perm.milestones?.length === 2 && perm.milestones[0]!.status === 'pending');

console.log('\n--- Archive, not delete ---');
gm.transition(temp, 'planning', 'test');
gm.transition(temp, 'completed', 'criteria met');
temp.outcome = 'recommended B';
const archived = await gm.archiveFinished(Date.now() + 8 * 86_400_000);
ok('a finished goal past retention is archived', archived.includes(temp.id) && !gm.getGoal(temp.id));
ok('the archived record is complete and readable', gm.readArchivedGoal(temp.id)?.outcome === 'recommended B' && gm.readArchivedGoal(temp.id)?.tasks?.length === 2);
ok('the archive is listed', gm.archivedGoals().some((r) => r.id === temp.id && r.status === 'completed'));
ok('a recurring template is never archived', !archived.includes(rec.id));
ok('unfinished goals are not archived', !archived.includes(perm.id) && !archived.includes(once.id));
const again = await gm.createManagedGoal({ kind: 'temporary', objective: 'instance', instanceKey: 'rec@1' });
gm.transition(again.goal, 'cancelled', 'test');
await gm.archiveFinished(Date.now() + 8 * 86_400_000);
const third = await gm.createManagedGoal({ kind: 'temporary', objective: 'instance', instanceKey: 'rec@1' });
ok('an archived instance key is not created again', !third.created);

console.log('\n--- Pause, resume, cancel ---');
const { goal: g2 } = await gm.createManagedGoal({ kind: 'temporary', objective: 'x', tasks: [{ title: 't', specialist: 'research_agent' }] });
g2.tasks![0]!.status = 'blocked';
g2.tasks![0]!.attempts = 3;
gm.transition(g2, 'blocked', 'needs a person');
ok('blocked → paused', await gm.pauseGoal(g2.id));
ok('a paused goal resumes', await gm.resumeGoal(g2.id) && g2.status === 'pending');
ok('its blocked task is ready again with one more attempt', (g2.tasks![0]!.status as string) === 'ready' && g2.tasks![0]!.maxAttempts === 4);
ok('cancelling cancels its unfinished tasks', await gm.cancelGoal(g2.id) && (g2.tasks![0]!.status as string) === 'cancelled');
ok('a cancelled goal cannot be resumed', !(await gm.resumeGoal(g2.id)));
await gm.pauseGoal(rec.id);
ok('a resumed recurring goal waits for its schedule again', await gm.resumeGoal(rec.id) && rec.status === 'waiting' && rec.waitingFor === 'schedule');
ok('the priority queue can be limited to managed goals', gm.getPriorityQueue(['permanent', 'temporary']).every(isManaged));

console.log('\n--- Schedules ---');
ok('scheduleProblem accepts a weekly schedule', scheduleProblem({ type: 'daily', time: '09:00', weekdays: [1, 3] }) === undefined);
// Asia/Karachi is UTC+5 all year.
const kar = nextRunAfter({ type: 'daily', time: '09:00', timezone: 'Asia/Karachi' }, Date.UTC(2026, 9, 10, 3, 0), 0)!;
ok('09:00 in Karachi is 04:00 UTC the same day', kar === Date.UTC(2026, 9, 10, 4, 0), new Date(kar).toISOString());
const karNext = nextRunAfter({ type: 'daily', time: '09:00', timezone: 'Asia/Karachi' }, kar, 0)!;
ok('… and the next one is a day later', karNext - kar === 86_400_000);
// New York: 2026-03-08 the clocks go from 02:00 to 03:00.
const ny = zonedTime(2026, 3, 8, 2, 30, 'America/New_York');
ok('a local time skipped by DST moves forward (03:30 EDT)', new Date(ny).toISOString() === '2026-03-08T07:30:00.000Z', new Date(ny).toISOString());
const nySummer = nextRunAfter({ type: 'daily', time: '09:00', timezone: 'America/New_York' }, Date.UTC(2026, 6, 1, 0, 0), 0)!;
ok('09:00 New York in July is 13:00 UTC', new Date(nySummer).toISOString() === '2026-07-01T13:00:00.000Z', new Date(nySummer).toISOString());
// 2026-10-10 is a Saturday; next Monday/Wednesday 09:00 UTC.
const wk = nextRunAfter({ type: 'daily', time: '09:00', timezone: 'UTC', weekdays: [1, 3] }, Date.UTC(2026, 9, 10, 12, 0), 0)!;
ok('weekdays: the next run is Monday', new Date(wk).toISOString() === '2026-10-12T09:00:00.000Z', new Date(wk).toISOString());
const iv = nextRunAfter({ type: 'interval', everyMs: 3_600_000 }, 10 * 3_600_000 + 5, 0)!;
ok('interval: the next whole step after the anchor', iv === 11 * 3_600_000);
const missed = dueTimesBetween({ type: 'interval', everyMs: 3_600_000 }, 0, 5 * 3_600_000 + 1, 0);
ok('five hours down = five missed hourly runs', missed.length === 5);
ok('a one-time schedule in the past is never due again', nextRunAfter({ type: 'once', at: 100 }, 200, 0) === undefined);

await gm.flush();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
