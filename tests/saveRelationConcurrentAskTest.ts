/**
 * tests/saveRelationConcurrentAskTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Review INDEPENDENT_REVIEW_FINAL_LOWS.md, LL-1 part A (owner approval R10,
 * 2026-11-23; coverage approved R12): two save_relation calls for the same
 * fact that start at the same moment in one task or request (two parallel
 * graph nodes, two workers) ask the owner once. "Yes" stores the fact once and
 * the other call says it is already kept; "no" is final for both. Different
 * facts and different tasks or requests stay independent. A stopped question,
 * a store error after "yes", a failing question and the call's time budget
 * keep their existing behaviour.
 *
 *   1  same fact at once, "yes" (one request; one agent root task)       barrier
 *   2  same fact at once, "no"                                            barrier
 *   3  different facts at once
 *   4  the same fact at once in a request and in an agent's root task
 *   5  the first question stopped (a) with the whole request, (b) alone
 *   6  a store error after "yes"                                          barrier
 *   8  three calls for the same fact at once                              barrier
 *   9  only the waiting call stopped while the owner is still answering   barrier
 *  10  the question itself fails (throws): no call stays blocked          barrier
 *   7  a call waiting for another call's question is not stopped by its own
 *      time budget (real approval gate, 1.5 s budget, 2.5 s answer), and a
 *      control: the same budget stops a call that really runs past it
 *
 * Cases with "barrier" hold the owner's answer until every call is inside
 * save_relation and the one question is open, so the overlap is established,
 * not assumed from timing. Stand-in memory store, graph and owner; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-save-concurrent-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_') || k.startsWith('JARVIS_VOICE_APPROVAL')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_TOOL_BUDGET_LOW_MS'];
process.env['JARVIS_TOOL_STOP_GRACE_MS'] = '1000';
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const { memoryManager } = await import('../memory/memoryManager.js');
const stored: string[] = [];
let storeFails = 0;
let storeDelayMs = 0;
(memoryManager as unknown as { rememberFact: (fact: string) => Promise<void> }).rememberFact = async (fact: string) => {
  if (storeDelayMs > 0) await new Promise((r) => setTimeout(r, storeDelayMs));
  if (storeFails > 0) { storeFails--; throw new Error('EBUSY: the fact store is busy'); }
  stored.push(fact);
};
const { graphMemory } = await import('../memory/graphMemory.js');
(graphMemory as unknown as { saveRelation: () => Promise<void> }).saveRelation = async () => {};

// The owner. Automatic mode answers each question after a short delay (cases 3-5).
// Held mode keeps every question open until the test answers it (barrier cases).
const { approvalGate } = await import('../security/approvalGate.js');
const realRequestApproval = (approvalGate as any).requestApproval.bind(approvalGate);
const asked: any[] = [];
type OpenQuestion = { request: any; answer: (yes: boolean) => void; fail: (err: Error) => void; answeredAt?: number };
const open: OpenQuestion[] = [];
let hold = false;
let answerFor: (request: any) => boolean = () => true;
let onAsked: (request: any) => void = () => {};
const standInOwner = async (...args: unknown[]): Promise<boolean> => {
  const request = args[0];
  asked.push(request);
  onAsked(request);
  if (hold) {
    return new Promise<boolean>((resolve, reject) => {
      const q: OpenQuestion = {
        request,
        answer: (yes) => { q.answeredAt = Date.now(); resolve(yes); },
        fail: (err) => { q.answeredAt = Date.now(); reject(err); },
      };
      open.push(q);
    });
  }
  await new Promise((r) => setTimeout(r, 150));
  return answerFor(request);
};
(approvalGate as any).requestApproval = standInOwner;

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { saveRelationTool } = await import('../core/tools/memoryTool.js');
const { runAsAgent } = await import('../core/agents/agentScope.js');
const { beginTrace, endTrace } = await import('../core/traceContext.js');

// Records each call as it enters save_relation (the registered tool object; behaviour unchanged).
const entered: string[] = [];
const realExecute = saveRelationTool.execute.bind(saveRelationTool);
(saveRelationTool as any).execute = (args: Record<string, unknown>, signal?: AbortSignal) => {
  entered.push(String(args['entity2'] ?? ''));
  return realExecute(args, signal);
};

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
type Result = { success: boolean; output: string; error?: string };
type Tracked = { result: Promise<Result>; done: boolean; at: number; value?: Result };
const save = (e2: string, signal?: AbortSignal): Promise<Result> =>
  toolRegistryV2.execute('save_relation', { entity1: 'User', relation: 'HAS_EXAM_ON', entity2: e2 }, signal) as Promise<Result>;
function track(result: Promise<Result>): Tracked {
  const t: Tracked = { result, done: false, at: 0 };
  void result.then((v) => { t.done = true; t.at = Date.now(); t.value = v; }, () => { t.done = true; t.at = Date.now(); });
  return t;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (condition()) return true; await sleep(5); }
  return condition();
}
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'STILL WAITING'> {
  return Promise.race([p, sleep(ms).then(() => 'STILL WAITING' as const)]);
}
function reset(): void {
  stored.length = 0; asked.length = 0; open.length = 0; entered.length = 0;
  storeFails = 0; storeDelayMs = 0; hold = false; answerFor = () => true; onAsked = () => {};
}
function startRequest(): void { beginTrace('cli', 'Remember that my exam is on Friday'); }
async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  startRequest();
  try { return await fn(); } finally { endTrace(); }
}
const inAgent = <T>(rootTaskId: string, fn: () => Promise<T>) => runAsAgent({ rootTaskId, taskId: `${rootTaskId}-t-${Math.random().toString(36).slice(2, 6)}`, agentId: `${rootTaskId}-a`, agentPath: 'JARVIS › Memory & Personalization Agent', request: 'Remember that my exam is on Friday', source: 'cli' }, fn);
const brief = (r?: Result) => (r ? r.output.slice(0, 70) : '(no result)');
const isSaved = (r?: Result) => !!r && r.success && /^Saved relation/.test(r.output);
const isKept = (r?: Result) => !!r && r.success && /^Already kept in long-term memory/.test(r.output);
const isDenied = (r?: Result) => !!r && !r.success && r.error === 'APPROVAL_DENIED';
const isStopped = (r: Result) => !r.success && /stopped/i.test(r.output) && stored.length === 0;

/**
 * The barrier: every call is inside save_relation while exactly one question is
 * open and unanswered, and none has returned. Then, after the event loop has run
 * for a while, still none has returned and nothing more was asked: the others wait.
 */
async function overlapEstablished(label: string, calls: Tracked[]): Promise<boolean> {
  const inside = await until(() => entered.length === calls.length && open.length === 1);
  ok(`${label}: all ${calls.length} calls are inside save_relation while the one question is open`, inside && asked.length === 1 && calls.every((c) => !c.done), `entered ${entered.length}; open ${open.length}; asked ${asked.length}`);
  await sleep(100);
  ok(`${label}: the others wait: none returns and nothing more is asked before the answer`, calls.every((c) => !c.done) && asked.length === 1 && stored.length === 0, `returned ${calls.filter((c) => c.done).length}; asked ${asked.length}; stored ${stored.length}`);
  return inside;
}
const afterAnswer = (calls: Tracked[], q?: OpenQuestion) => !!q?.answeredAt && calls.every((c) => c.done && c.at >= q.answeredAt!);
/** Waits for every call, answering any further question the same way, so a second question (the defect) fails the checks instead of hanging the test. */
async function settle(calls: Tracked[], yes: boolean): Promise<void> {
  while (!calls.every((c) => c.done)) {
    for (const q of open) if (!q.answeredAt) q.answer(yes);
    await sleep(10);
  }
}

console.log('\n=== save_relation: the same fact asked at the same moment (LL-1 part A) ===\n');

console.log('--- 1. Same fact at once, "yes" ---');
{
  reset();
  hold = true;
  startRequest();
  let calls: Tracked[];
  try {
    calls = [track(save('Friday')), track(save('Friday'))];
    if (await overlapEstablished('one request', calls)) open[0]!.answer(true);
    await settle(calls, true);
  } finally { endTrace(); }
  const [a, b] = [calls[0]!.value, calls[1]!.value];
  ok('one request: asked once, stored once', asked.length === 1 && stored.length === 1, `asked ${asked.length}; stored ${stored.length}`);
  ok('…one call saves it and the other says it is already kept, both after the answer', ((isSaved(a) && isKept(b)) || (isKept(a) && isSaved(b))) && afterAnswer(calls, open[0]), `${brief(a)} | ${brief(b)}`);

  reset();
  hold = true;
  const workers = [track(inAgent('root-two-workers', () => save('Friday'))), track(inAgent('root-two-workers', () => save('Friday')))];
  if (await overlapEstablished('two workers of one agent root task', workers)) open[0]!.answer(true);
  await settle(workers, true);
  const [c, d] = [workers[0]!.value, workers[1]!.value];
  ok('two workers: asked once, stored once; one saves, the other says it is already kept', asked.length === 1 && stored.length === 1 && ((isSaved(c) && isKept(d)) || (isKept(c) && isSaved(d))), `asked ${asked.length}; stored ${stored.length}; ${brief(c)} | ${brief(d)}`);
}

console.log('\n--- 2. Same fact at once, "no" ---');
{
  reset();
  hold = true;
  startRequest();
  let calls: Tracked[];
  try {
    calls = [track(save('Friday')), track(save('Friday'))];
    if (await overlapEstablished('"no"', calls)) open[0]!.answer(false);
    await settle(calls, false);
  } finally { endTrace(); }
  ok('asked once, nothing stored', asked.length === 1 && stored.length === 0, `asked ${asked.length}; stored ${stored.length}`);
  ok('…both calls report the owner\'s denial (APPROVAL_DENIED), after the answer', isDenied(calls[0]!.value) && isDenied(calls[1]!.value) && afterAnswer(calls, open[0]), `${calls[0]!.value?.error} | ${calls[1]!.value?.error}`);
}

console.log('\n--- 3. Different facts at once ---');
{
  reset();
  const [a, b] = await inRequest(() => Promise.all([save('Friday'), save('Monday')]));
  ok('each fact is asked once', asked.length === 2 && new Set(asked.map((q) => String(q?.target ?? ''))).size === 2, `asked ${asked.length}: ${asked.map((q) => q?.target).join(', ')}`);
  ok('…and each is stored once', stored.length === 2 && isSaved(a) && isSaved(b), `stored ${stored.length}; ${brief(a)} | ${brief(b)}`);
}

console.log('\n--- 4. The same fact at once in a request and in an agent\'s root task ---');
{
  reset();
  // The owner says no to the request's question and yes to the agent's (review p1 J).
  answerFor = (q) => !!q?.rootTaskId;
  const [fore, agent] = await inRequest(() => Promise.all([save('Friday'), inAgent('root-separate', () => save('Friday'))]));
  ok('each context asks its own question', asked.length === 2 && asked.filter((q) => q?.rootTaskId).length === 1, `asked ${asked.length}`);
  ok('…the request\'s "no" does not stop the agent\'s "yes": only the agent\'s fact is stored', isDenied(fore) && isSaved(agent) && stored.length === 1, `${brief(fore)} | ${brief(agent)}; stored ${stored.length}`);
}

console.log('\n--- 5. The first question stopped ---');
{
  // (a) The whole request is stopped while the owner is asked.
  reset();
  const ac = new AbortController();
  onAsked = () => { setTimeout(() => ac.abort(), 30); };
  answerFor = () => false;
  const [a, b] = await inRequest(() => Promise.all([save('Friday', ac.signal), save('Friday', ac.signal)]));
  ok('a stopped request: asked once, nothing stored', asked.length === 1 && stored.length === 0, `asked ${asked.length}; stored ${stored.length}`);
  ok('…both calls say the request was stopped, not "not confirmed"', isStopped(a) && isStopped(b) && !/not confirmed/i.test(a.output + b.output), `${brief(a)} | ${brief(b)}`);

  // (b) Only the first call is stopped: the second asks for itself, as a new call does after a stopped one.
  reset();
  const first = new AbortController();
  let n = 0;
  onAsked = () => { if (n++ === 0) setTimeout(() => first.abort(), 30); };
  const [x, y] = await inRequest(() => Promise.all([save('Friday', first.signal), save('Friday')]));
  ok('only the first stopped: it stores nothing and says it was stopped', !x.success && /stopped/i.test(x.output), brief(x));
  ok('…the other call is asked itself and stores the fact once on "yes"', asked.length === 2 && stored.length === 1 && isSaved(y), `asked ${asked.length}; stored ${stored.length}; ${brief(y)}`);
}

console.log('\n--- 6. A store error after "yes" ---');
{
  reset();
  hold = true;
  storeFails = 1;
  startRequest();
  let calls: Tracked[];
  try {
    calls = [track(save('Friday')), track(save('Friday'))];
    if (await overlapEstablished('store error', calls)) open[0]!.answer(true);
    await settle(calls, true);
  } finally { endTrace(); }
  const results = calls.map((c) => c.value);
  ok('asked once; the fact is stored once in the end, by the waiting call, without asking again', asked.length === 1 && stored.length === 1 && afterAnswer(calls, open[0]), `asked ${asked.length}; stored ${stored.length}`);
  ok('…one call reports the store error, the other saves it', results.some((r) => !!r && !r.success && /save_relation failed: .*EBUSY/.test(r.output)) && results.some((r) => isSaved(r)), results.map((r) => brief(r)).join(' | '));
}

console.log('\n--- 8. Three calls for the same fact at once ---');
{
  reset();
  hold = true;
  startRequest();
  let calls: Tracked[];
  try {
    calls = [track(save('Friday')), track(save('Friday')), track(save('Friday'))];
    if (await overlapEstablished('three calls', calls)) open[0]!.answer(true);
    await settle(calls, true);
  } finally { endTrace(); }
  const results = calls.map((c) => c.value);
  ok('asked once, stored once', asked.length === 1 && stored.length === 1, `asked ${asked.length}; stored ${stored.length}`);
  ok('…one call saves it and the other two say it is already kept, all after the answer', results.filter((r) => isSaved(r)).length === 1 && results.filter((r) => isKept(r)).length === 2 && afterAnswer(calls, open[0]), results.map((r) => brief(r)).join(' | '));
}

console.log('\n--- 9. Only the waiting call stopped while the owner is still answering ---');
{
  reset();
  hold = true;
  const waiterStop = new AbortController();
  startRequest();
  let calls: Tracked[];
  try {
    calls = [track(save('Friday')), track(save('Friday', waiterStop.signal))];
    const inside = await overlapEstablished('waiter stopped', calls);
    waiterStop.abort();
    const waiterBack = await until(() => calls[1]!.done, 3_000);
    ok('the stopped waiting call returns while the question is still open', inside && waiterBack && !calls[0]!.done && !open[0]?.answeredAt, `waiter returned ${waiterBack}; first returned ${calls[0]!.done}`);
    ok('…it says it was stopped, nothing is stored, nothing more is asked', !!calls[1]!.value && !calls[1]!.value.success && /stopped/i.test(calls[1]!.value.output) && stored.length === 0 && asked.length === 1, brief(calls[1]!.value));
    open[0]?.answer(true);
    await settle(calls, true);
  } finally { endTrace(); }
  ok('…the owner\'s "yes" to the open question still stores the fact once, for the first call', isSaved(calls[0]!.value) && stored.length === 1 && asked.length === 1, `${brief(calls[0]!.value)}; stored ${stored.length}; asked ${asked.length}`);
}

console.log('\n--- 10. The question itself fails (throws) ---');
{
  reset();
  hold = true;
  startRequest();
  let calls: Tracked[];
  try {
    calls = [track(save('Friday')), track(save('Friday'))];
    if (await overlapEstablished('failing question', calls)) open[0]!.fail(new Error('approval channel failed'));
    // As before LL-1A, nothing was answered, so the waiting call asks the owner itself.
    const reAsked = await until(() => open.length === 2, 3_000);
    ok('the failing call ends; the waiting call is not left blocked and asks the owner itself', reAsked && calls[0]!.done && !calls[1]!.done, `open ${open.length}; first returned ${calls[0]!.done}`);
    ok('…the failing call reports the error and stores nothing (the registry does not retry it: risk 1)', !!calls[0]!.value && !calls[0]!.value.success && /approval channel failed/.test(calls[0]!.value.output) && stored.length === 0, brief(calls[0]!.value));
    open[1]?.answer(true);
    await within(settle(calls, true), 3_000);
    ok('…the waiting call\'s own "yes" stores the fact once', isSaved(calls[1]!.value) && stored.length === 1 && asked.length === 2, `${brief(calls[1]!.value)}; stored ${stored.length}; asked ${asked.length}`);
    const later = await within(save('Friday'), 3_000);
    ok('…a later call for the same fact is not blocked by a leftover entry: it returns "already kept" without asking', later !== 'STILL WAITING' && isKept(later) && asked.length === 2, later === 'STILL WAITING' ? later : brief(later));
  } finally { endTrace(); }
}

console.log('\n--- 7. Waiting for another call\'s question does not use up the call\'s time ---');
{
  reset();
  // The real approval gate pauses the asking call's budget. Low-risk budget 1.5 s; the owner answers after 2.5 s.
  (approvalGate as any).requestApproval = realRequestApproval;
  let shownAt = 0;
  let answeredAt = 0;
  let enteredWhileOpen = 0;
  const prompt = async (request: any) => {
    asked.push(request);
    shownAt = Date.now();
    await sleep(2_500);
    enteredWhileOpen = entered.length;
    answeredAt = Date.now();
    return 'yes';
  };
  (approvalGate as any)._promptWithTimeout = async (_p: string, _ms: number, request: any) => prompt(request);
  (approvalGate as any)._voiceOrTextPromptWithTimeout = async (request: any) => prompt(request);
  process.env['JARVIS_TOOL_BUDGET_LOW_MS'] = '1500';
  try {
    startRequest();
    const t0 = Date.now();
    let calls: Tracked[];
    try {
      calls = [track(save('Friday')), track(save('Friday'))];
      await Promise.all(calls.map((c) => c.result));
    } finally { endTrace(); }
    const waiter = calls.find((c) => isKept(c.value));
    const asker = calls.find((c) => isSaved(c.value));
    ok('asked once, stored once; both calls were inside save_relation while the question was open', asked.length === 1 && stored.length === 1 && enteredWhileOpen === 2, `asked ${asked.length}; stored ${stored.length}; inside while open ${enteredWhileOpen}`);
    ok('…the owner took about 2.5 s to answer', answeredAt - shownAt >= 2_400 && answeredAt - shownAt < 4_000, `${answeredAt - shownAt} ms`);
    ok('…both calls succeed: one saves, the other says it is already kept', !!waiter && !!asker, calls.map((c) => brief(c.value)).join(' | '));
    ok('…the waiting call stayed active past its own 1.5 s budget (paused while it waited) and was not stopped', !!waiter && waiter.at - t0 >= 2_400 && waiter.at >= answeredAt, waiter ? `returned after ${waiter.at - t0} ms` : 'no waiting call');

    // Control: the same 1.5 s budget does stop a call that really runs past it (a 4 s store, not paused).
    reset();
    (approvalGate as any)._promptWithTimeout = async () => 'yes';
    (approvalGate as any)._voiceOrTextPromptWithTimeout = async () => 'yes';
    storeDelayMs = 4_000;
    const c0 = Date.now();
    const slow = await inRequest(() => save('Saturday'));
    const took = Date.now() - c0;
    ok('control: with the same budget, a call whose store runs 4 s is stopped by its budget', !slow.success && /ran past its 2 s budget/.test(slow.output) && took < 3_800, `${took} ms; ${slow.output.slice(0, 90)}`);
    await sleep(2_000);   // let the stopped call's late store end before the process exits
  } finally {
    delete process.env['JARVIS_TOOL_BUDGET_LOW_MS'];
    storeDelayMs = 0;
    (approvalGate as any).requestApproval = standInOwner;
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
