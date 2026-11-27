/**
 * tests/goalLearningTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Goal Runtime phase 5: learning from verified outcomes and feedback
 * (core/goalLearning.ts), memory decay on a schedule, and status reporting.
 *
 *   - a plain success stores nothing; a task that failed and then worked,
 *     a failed goal, and the user's correction each store one lesson
 *   - similar later goals get those lessons in their plan, and the lesson
 *     records how those goals ended; one that keeps failing is dropped
 *   - repeated failures of one kind become a proposal (nothing is changed)
 *   - memory decay counts each day once, however often it runs
 *   - goal status reports what the runtime is doing
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-goal-learning-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
process.env['JARVIS_DATA_ROOT'] = tmp;
process.env['JARVIS_WORKSPACE_ROOT'] = tmp;
process.chdir(tmp);

const { GoalManager, goalManager } = await import('../core/goalManager.js');
const { GoalRuntime } = await import('../core/goalRuntime.js');
const { GoalLearning } = await import('../core/goalLearning.js');
const { goalStatusText, goalDetail } = await import('../core/goalTools.js');
type ExecRequest = import('../core/goalRuntime.js').ExecRequest;
type ExecOutcome = import('../core/goalRuntime.js').ExecOutcome;
type GoalLesson = import('../core/goalLifecycle.js').GoalLesson;

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

let clock = Date.now();
const now = () => clock;
const done = (summary: string): ExecOutcome => ({ ok: true, usage: { llmCalls: 1, toolCalls: 1, tokens: 10 }, result: { status: 'COMPLETED', summary, confidence: 0.8, findings: [summary], sources: [], agent: 'research_agent', finishedAt: clock } });
const broken = (message: string): ExecOutcome => ({ ok: false, usage: { llmCalls: 1, toolCalls: 1, tokens: 0 }, failure: { message } });

const facts: { fact: string; importance?: number }[] = [];
const sink = { rememberFact: async (fact: string, _s?: string, importance?: number) => { facts.push({ fact, ...(importance !== undefined ? { importance } : {}) }); } };

const gm = new GoalManager({ now });
await gm.init();
const learning = new GoalLearning(gm, sink);
let script: (req: ExecRequest, n: number) => ExecOutcome = () => done('ok');
const counts = new Map<string, number>();
const executor = { run: async (req: ExecRequest) => { const k = `${req.goal.id}:${req.task.id}`; counts.set(k, (counts.get(k) ?? 0) + 1); req.onStarted('root'); return script(req, counts.get(k)!); } };
const plannedWith: GoalLesson[][] = [];
const planner = { plan: async (input: { goal: { objective?: string }; lessons: GoalLesson[] }) => { plannedWith.push(input.lessons); return { tasks: [{ title: 'do it', description: input.goal.objective ?? '', specialist: 'research_agent', dependsOn: [], sideEffects: 'none' as const }], via: 'model' as const }; } };
const rt = new GoalRuntime({ manager: gm, executor, planner, learning: learning.hooks(), now, retry: { baseMs: 1_000, factor: 2, maxMs: 5_000 } });
await rt.start();

console.log('\n=== Goal learning and status (phase 5) ===\n');

console.log('--- What is learnt, and what is not ---');
await gm.createManagedGoal({ kind: 'temporary', objective: 'Summarise the release notes of the TypeScript compiler' });
await rt.idle();
ok('a plain success stores no lesson', gm.getLessons().length === 0);

script = (_req, n) => (n === 1 ? broken('fetch failed: ECONNRESET') : done('worked on retry'));
const { goal: flaky } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Compare vector databases for local embedding search' });
await rt.idle();
clock += 2_000;
await rt.idle();
const retryLesson = gm.getLessons().find((l) => l.source === 'retry');
ok('a task that failed and then worked leaves a lesson', flaky.status === 'completed' && !!retryLesson && /transient/.test(retryLesson.text), retryLesson?.text);

script = () => broken('TypeError: the page layout changed');
const { goal: bad } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Compare vector databases for production use', maxRetries: 1 });
await rt.idle();
clock += 60_000;
await rt.idle();
const failLesson = gm.getLessons().find((l) => l.source === 'failure');
ok('a failed goal leaves a lesson with why', bad.status === 'failed' && !!failLesson && /failed/.test(failLesson.text), failLesson?.text);
ok('… and it goes to long-term memory', facts.some((f) => /Lesson from a failed goal/.test(f.fact)));

console.log('\n--- Lessons reach later plans, and are judged by results ---');
script = () => done('a careful comparison');
const before = plannedWith.length;
const { goal: similar } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Compare vector databases for a small local project' });
await rt.idle();
const used = plannedWith[before] ?? [];
ok('a similar goal is planned with the earlier lessons', used.some((l) => l.id === failLesson?.id) && used.some((l) => l.id === retryLesson?.id), used.map((l) => l.source).join(','));
ok('the goal records which lessons it used', (similar.lessonsUsed ?? []).includes(failLesson!.id));
ok('the lesson counts the goal that used it and its result', failLesson!.applied === 1 && failLesson!.successesAfter === 1);
const unrelated = learning.relevant({ ...similar, id: 'x', objective: 'Book a dentist appointment', description: 'dentist' } as never);
ok('an unrelated goal gets no lessons', unrelated.length === 0, unrelated.map((l) => l.text).join(' | '));
failLesson!.failuresAfter = 5;
failLesson!.successesAfter = 1;
ok('a lesson followed by failures is no longer offered', !learning.relevant(similar).some((l) => l.id === failLesson!.id));

console.log('\n--- Feedback from the user ---');
const reply = await learning.feedback(similar, 'Prefer the official documentation over blog posts.');
ok('feedback is kept as a lesson', gm.getLessons().some((l) => l.source === 'user_feedback' && /official documentation/.test(l.text)), reply);
ok('… in long-term memory, with high importance', facts.some((f) => /official documentation/.test(f.fact) && (f.importance ?? 0) >= 8));
ok('… and noted on the goal', (similar.history ?? []).some((h) => h.event === 'feedback'));
ok('the same feedback twice is stored once', /already/.test(await learning.feedback(similar, 'Prefer the official documentation over blog posts.')));
ok('feedback is offered to later similar goals first', learning.relevant({ ...similar, id: 'y' } as never)[0]?.source === 'user_feedback');

console.log('\n--- Repeated failures become a proposal, not a change ---');
script = () => broken('Tool "files" requires permission level 2 (PERMISSION_DENIED)');
for (let i = 0; i < 3; i++) await gm.createManagedGoal({ kind: 'temporary', objective: `Tidy the downloads folder ${i}` });
await rt.idle();
const proposals = learning.proposals();
ok('three permission failures in a week give a proposal', proposals.some((p) => /permission/.test(p) && /suggestion/.test(p)), proposals.join(' | '));
ok('the proposal is reported, and nothing else changed', facts.some((f) => /Repeated problem/.test(f.fact)));
await rt.stop();

console.log('\n--- Memory decay counts each day once ---');
{
  const { memoryManager } = await import('../memory/memoryManager.js');
  await memoryManager.init();
  await memoryManager.rememberFact('The office printer is on the second floor', 'test', 5, 0.9);
  const db = (memoryManager as unknown as { db: { data: { longTerm: { fact: string; importance: number; lastAccessed: number; timestamp: number }[] } } }).db;
  const fact = db.data.longTerm.find((f) => /printer/.test(f.fact))!;
  const t0 = Date.now();
  fact.lastAccessed = t0 - 10 * 86_400_000;
  fact.timestamp = fact.lastAccessed;
  fact.importance = 5;
  await memoryManager.decayMemory(0.1, 1.0, t0);
  const after1 = fact.importance;
  await memoryManager.decayMemory(0.1, 1.0, t0 + 3_600_000);
  await memoryManager.decayMemory(0.1, 1.0, t0 + 7_200_000);
  const after3 = fact.importance;
  await memoryManager.decayMemory(0.1, 1.0, t0 + 86_400_000);
  const nextDay = fact.importance;
  ok('ten unseen days cost 1.0 the first time', Math.abs(after1 - 4) < 1e-6, String(after1));
  ok('running it again an hour later costs only that hour', Math.abs(after1 - after3) < 0.02, `${after1} → ${after3}`);
  ok('a day later it costs one more day', Math.abs(after1 - nextDay - 0.1) < 0.001, `${after1} → ${nextDay}`);
}

console.log('\n--- Status ---');
{
  // Its own data folder: the goals above are not part of this report.
  process.env['JARVIS_DATA_ROOT'] = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-goal-status-'));
  process.env['JARVIS_WORKSPACE_ROOT'] = process.env['JARVIS_DATA_ROOT'];
  await goalManager.init();
  const { goal } = await goalManager.createManagedGoal({ kind: 'permanent', objective: 'Keep JARVIS reliable', milestones: ['fix flaky tests', 'faster startup'] });
  goal.milestones![0]!.status = 'completed';
  goal.progress = { percent: 50, note: '1 of 2 milestone(s) done', updatedAt: Date.now() };
  goalManager.transition(goal, 'waiting', 'next cycle tomorrow');
  goal.waitingFor = 'schedule';
  goal.nextRunAt = Date.now() + 86_400_000;
  const { goal: blocked } = await goalManager.createManagedGoal({ kind: 'temporary', objective: 'Clean up old branches' });
  goalManager.transition(blocked, 'blocked', 'needs a person');
  blocked.blockedReason = '"delete branches": the action was not approved';
  const text = goalStatusText();
  const first = text.split('\n')[0]!;
  ok('the first line is a sentence to say', /^2 active goals, sir/.test(first) && /1 blocked/.test(first), first);
  ok('each goal has a line with its state, kind and progress', /\[waiting: schedule\]\s+permanent/.test(text) && /milestones 1\/2/.test(text) && /\[blocked\]/.test(text));
  ok('a blocked goal says why', /not approved/.test(text));
  const one = goalStatusText('reliable');
  ok('one goal in detail: objective, milestones, history', /Objective: Keep JARVIS reliable/.test(one) && /\[completed\] fix flaky tests/.test(one) && /Recent history/.test(one));
  ok('goalDetail shows criteria marks', /Milestones:/.test(goalDetail(goal)));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
