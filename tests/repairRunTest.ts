/**
 * tests/repairRunTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-healing Phase 4: "heal yourself", bounded and runtime-only.
 *
 *   1. What may be repaired: only restarts of JARVIS's own voice services; a
 *      code defect, the language model, a missing program and a tool failure
 *      are BLOCKED with the reason; a refusal is SKIPPED.
 *   2. Speech output: restarted, then a check phrase must be reported played;
 *      only then is the issue RESOLVED, with that evidence.
 *   3. Bounds: 2 attempts; the same failure twice stops the run (no
 *      progress); the time budget; no model tokens used; one active run.
 *   4. Speech recognition / wake word: restarted and reconnected is not
 *      "fixed": the run waits for a real transcript, which then resolves it.
 *   5. Stop: a run stops between steps; a run JARVIS's restart interrupted
 *      waits for "continue the repair" and never continues by itself.
 *   6. Routes: typed and spoken phrasings; "fix my app" and "stop" keep theirs.
 *   7. selfHealingManager.restartService against a real stand-in process:
 *      the old process is stopped before the new one starts (never two), the
 *      stop is not counted as a crash, an unknown service is refused.
 *   8. Through the real orchestrator: the plan is said, the run ends BLOCKED
 *      honestly when the service is not JARVIS's to restart.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { installFakeTts } from './fakeTts.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-repair-run-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { IssueStore } = await import('../core/issueStore.js');
const { HealthLedger } = await import('../monitoring/healthLedger.js');
const { RepairRunner, planFor, spokenResult, PROBE_PHRASE } = await import('../core/repairRun.js');
const { overclaims } = await import('../core/selfCheck.js');
const { matchDeterministicCommand } = await import('../core/deterministicRoutes.js');

let passed = 0;
let failed = 0;
let skipped = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

let caseN = 0;
/** A fresh store, ledger and runner in their own folder. */
function world(opts: { restart?: (l: string) => Promise<{ ok: boolean; reason: string }>; connected?: (r: string) => boolean; onProbe?: (ledger: InstanceType<typeof HealthLedger>) => void; now?: () => number } = {}) {
  const dir = path.join(root, `case-${++caseN}`);
  const store = new IssueStore(dir);
  const ledger = new HealthLedger();
  store.attachLedger(ledger);
  const restarts: string[] = [];
  const probes: string[] = [];
  const notes: string[] = [];
  const runner = new RepairRunner({
    store, ledger, dir: path.join(dir, 'runs'),
    restart: async (l) => { restarts.push(l); return opts.restart ? opts.restart(l) : { ok: true, reason: `${l} restarted` }; },
    connected: opts.connected ?? (() => true),
    speakProbe: (t) => { probes.push(t); opts.onProbe?.(ledger); },
    notify: (t) => notes.push(t),
    timing: { pollMs: 5, reconnectMs: 200, probeMs: 200 },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { dir, store, ledger, runner, restarts, probes, notes };
}

// ── 1. What may be repaired ─────────────────────────────────────────────────
console.log('\n--- 1. What may be repaired ---');
{
  const { store } = world();
  const mk = (component: string, message: string, pipeline?: string, error?: unknown) => store.recordOccurrence({ component, message, ...(pipeline ? { pipeline } : {}), ...(error ? { error } : {}) }).issue;
  const tts = planFor(mk('brain_to_tts', 'synthesis_failed: edge-tts timed out', 'brain_to_tts'));
  ok('speech output: restart TTS, checked by a played phrase', tts.kind === 'restart' && tts.label === 'TTS' && tts.verify === 'probe');
  const stt = planFor(mk('service:stt', 'Process exited with code 1', 'stt_to_brain'));
  ok('speech recognition: restart STT, checked by real evidence', stt.kind === 'restart' && stt.label === 'STT' && stt.verify === 'evidence');
  const wake = planFor(mk('wake_to_stt', 'wake word stream stalled', 'wake_to_stt'));
  ok('wake word: restart WakeWord', wake.kind === 'restart' && wake.label === 'WakeWord');
  const err = new TypeError("Cannot read properties of undefined (reading 'x')");
  const code = planFor(mk('tool:files', "TypeError: Cannot read properties of undefined (reading 'x')", 'tool_execution', err));
  ok('a code defect: BLOCKED, with where, and that code repair is not enabled', code.kind === 'blocked' && /code change is needed/.test(code.reason) && /tests\/repairRunTest\.ts:\d+/.test(code.reason), JSON.stringify(code));
  const llm = planFor(mk('brain_to_llm', 'Groq API error 401: invalid api key', 'brain_to_llm'));
  ok('the language model: BLOCKED (key, quota, network)', llm.kind === 'blocked' && /API key, quota and network/.test(llm.reason));
  const env = planFor(mk('service:tts', "ModuleNotFoundError: No module named 'edge_tts'", 'brain_to_tts'));
  ok('something missing on this machine: BLOCKED, not restarted', env.kind === 'blocked' && /missing on this machine/.test(env.reason));
  const tool = planFor(mk('tool:open_app', 'Command timed out after 5000 ms', 'tool_execution'));
  ok('a tool failure: BLOCKED (no runtime action)', tool.kind === 'blocked' && /failed tool/.test(tool.reason));
  const refusal = planFor(mk('tool:control_app', 'Permission denied by the owner'));
  ok('a refusal: SKIPPED, it is the safety system', refusal.kind === 'skip');
}

// ── 2. Speech output repaired and checked ───────────────────────────────────
console.log('\n--- 2. Speech output ---');
{
  const w = world({ onProbe: (l) => setTimeout(() => l.record('brain_to_tts', true, 'played (edge-tts)'), 10) });
  const issue = w.store.recordOccurrence({ component: 'brain_to_tts', pipeline: 'brain_to_tts', message: 'synthesis_failed: edge-tts timed out' }).issue;
  const { run, reply, settled } = w.runner.start('all', 'voice');
  ok('the plan is said at once', /restarting speech output, then checking that it works/.test(reply), reply);
  const done = await settled;
  ok('TTS restarted once, the check phrase spoken', w.restarts.join() === 'TTS' && w.probes.join() === PROBE_PHRASE);
  ok('run SUCCEEDED', done.status === 'SUCCEEDED', done.status);
  const after = w.store.get(issue.issueId)!;
  ok('the issue is RESOLVED with the played phrase as evidence', after.status === 'RESOLVED' && /check phrase played \(played \(edge-tts\)\)/.test(after.verification!.evidence), after.verification?.evidence);
  ok('…and left the active queue', w.store.active().length === 0);
  ok('the issue history shows the repair steps', after.history.map((h) => h.to).join('>').includes('REPAIR_PLANNED>REPAIRING>VERIFYING>RESOLVED'), after.history.map((h) => h.to).join('>'));
  ok('no model tokens used, and it says so', done.budget.tokensUsed === 0 && /Model tokens used: 0/.test(done.summary));
  ok('the run is kept on disk', fs.existsSync(path.join(w.dir, 'runs', `${run.runId}.json`)));
  ok('the result is announced, without over-claiming', w.notes.length === 1 && /checked, it works/.test(w.notes[0]!) && !overclaims(w.notes[0]!), w.notes.join(' | '));
}

// ── 3. Bounds ────────────────────────────────────────────────────────────────
console.log('\n--- 3. Bounds ---');
{
  const w = world({ onProbe: (l) => setTimeout(() => l.record('brain_to_tts', false, 'no_audio_device: output device unavailable'), 5) });
  const issue = w.store.recordOccurrence({ component: 'brain_to_tts', pipeline: 'brain_to_tts', message: 'synthesis_failed: edge-tts timed out' }).issue;
  const done = await w.runner.start('all').settled;
  ok('the same failure twice: stopped as no progress', done.status === 'FAILED' && done.items.some((i) => /no progress/.test(i.detail)), JSON.stringify(done.items));
  ok('…after 2 attempts, not more', w.restarts.length === 2 && done.attempts.length === 2, `${w.restarts.length}`);
  const after = w.store.get(issue.issueId)!;
  ok('the issue stays active (OPEN), its failed verification recorded', after.status === 'OPEN' && after.verification?.passed === false);
  ok('the spoken result says it is still failing', /still failing/.test(spokenResult(done)) && !overclaims(spokenResult(done)), spokenResult(done));
}
{
  let n = 0;
  const w = world({ onProbe: (l) => { const c = ++n === 1 ? 'synthesis_failed: edge-tts returned no audio' : 'not_connected: tts.py disconnected'; setTimeout(() => l.record('brain_to_tts', false, c), 5); } });
  w.store.recordOccurrence({ component: 'brain_to_tts', pipeline: 'brain_to_tts', message: 'synthesis_failed: edge-tts timed out' });
  const done = await w.runner.start('all').settled;
  ok('different failures: both attempts used, then FAILED', done.status === 'FAILED' && w.restarts.length === 2 && done.items.some((i) => /2 attempts, still failing/.test(i.detail)), JSON.stringify(done.items));
}
{
  // The run starts at t0; every later reading of the clock is 21 minutes on.
  const t0 = Date.now();
  let reads = 0;
  const w = world({ now: () => (reads++ === 0 ? t0 : t0 + 21 * 60_000), onProbe: () => { /* no report */ } });
  w.store.recordOccurrence({ component: 'brain_to_tts', pipeline: 'brain_to_tts', message: 'synthesis_failed: x', at: t0 - 1000 });
  const done = await w.runner.start('all').settled;
  ok('the 20-minute budget: no attempt after it is used up', done.status === 'FAILED' && w.restarts.length === 0 && done.items.some((i) => /20-minute budget/.test(i.detail)), JSON.stringify(done.items));
}
{
  const w = world({ connected: () => false });
  w.store.recordOccurrence({ component: 'brain_to_tts', pipeline: 'brain_to_tts', message: 'synthesis_failed: x' });
  const first = w.runner.start('all');
  const second = w.runner.start('all');
  ok('one active run: a second "heal yourself" is told, not started', second.run.runId === first.run.runId && /already running/.test(second.reply), second.reply);
  await first.settled;
}
{
  const w = world({ restart: async () => ({ ok: false, reason: 'TTS was disabled after repeated crashes at 2026-10-18T10:00:00.000Z; restart JARVIS to enable it again' }) });
  const issue = w.store.recordOccurrence({ component: 'brain_to_tts', pipeline: 'brain_to_tts', message: 'synthesis_failed: x' }).issue;
  const done = await w.runner.start('all').settled;
  ok('a restart that is not possible: BLOCKED with the reason', done.status === 'BLOCKED' && w.store.get(issue.issueId)!.status === 'BLOCKED' && /disabled after repeated crashes/.test(w.store.get(issue.issueId)!.blockedReason ?? ''));
  ok('"why can\'t you fix it" gives that reason', /disabled after repeated crashes/.test(w.runner.explainBlock()), w.runner.explainBlock());
}
{
  const w = world();
  w.store.recordOccurrence({ component: 'brain_to_llm', pipeline: 'brain_to_llm', message: 'Groq API error 401: invalid api key' });
  const { run, reply } = w.runner.start('all');
  ok('only blocked issues: no restart, run BLOCKED, and you are told why to ask', run.status === 'BLOCKED' && w.restarts.length === 0 && /needs you: brain_to_llm/.test(reply), reply);
  ok('…and the explanation names the key, quota and network', /API key, quota and network/.test(w.runner.explainBlock()));
}
{
  const w = world();
  const { run } = w.runner.start('all');
  ok('nothing open: NOTHING_TO_REPAIR, nothing restarted', run.status === 'NOTHING_TO_REPAIR' && w.restarts.length === 0);
}
{
  const w = world({ onProbe: (l) => setTimeout(() => l.record('brain_to_tts', true, 'played'), 5) });
  w.store.recordOccurrence({ component: 'brain_to_tts', pipeline: 'brain_to_tts', message: 'synthesis_failed: older', at: Date.now() - 5000 });
  w.store.recordOccurrence({ component: 'service:stt', pipeline: 'stt_to_brain', message: 'Process exited with code 1' });
  const done = await w.runner.start('last').settled;
  ok('"fix the last problem": only the latest issue', w.restarts.join() === 'STT' && done.issueIds.length === 1, w.restarts.join());
}

// ── 4. Recognition: reconnected is not fixed ────────────────────────────────
console.log('\n--- 4. Speech recognition ---');
{
  const w = world();
  const issue = w.store.recordOccurrence({ component: 'service:stt', pipeline: 'stt_to_brain', message: 'Process exited with code 1' }).issue;
  const done = await w.runner.start('all').settled;
  ok('restarted and reconnected: WAITING_FOR_EVIDENCE, not SUCCEEDED', done.status === 'WAITING_FOR_EVIDENCE' && w.store.get(issue.issueId)!.status === 'VERIFYING');
  ok('…and says it needs you to speak', /needs you to speak/.test(done.items[0]!.detail) && /confirmed when you next use it/.test(spokenResult(done)), spokenResult(done));
  w.ledger.record('stt_to_brain', true, 'transcript produced');
  ok('a real transcript then resolves it', w.store.get(issue.issueId)!.status === 'RESOLVED');
}
{
  const w = world({ connected: () => false });
  w.store.recordOccurrence({ component: 'service:stt', pipeline: 'stt_to_brain', message: 'Process exited with code 1' });
  const done = await w.runner.start('all').settled;
  ok('not reconnected: a failed attempt, not "waiting"', done.status === 'FAILED' && done.attempts.every((a) => /did not reconnect/.test(a.evidence)), JSON.stringify(done.attempts));
}

// ── 5. Stop, and restart persistence ────────────────────────────────────────
console.log('\n--- 5. Stop and restart ---');
{
  const w = world({ connected: () => false });
  w.store.recordOccurrence({ component: 'brain_to_tts', pipeline: 'brain_to_tts', message: 'synthesis_failed: x' });
  const { settled } = w.runner.start('all');
  await new Promise((r) => setTimeout(r, 20));
  const said = w.runner.stop();
  const done = await settled;
  ok('"stop healing": CANCELLED, no further restart', done.status === 'CANCELLED' && w.restarts.length === 1 && /nothing new starts/.test(said), `${done.status} ${w.restarts.length}`);
  ok('…the record is kept', fs.existsSync(path.join(w.dir, 'runs', `${done.runId}.json`)));
}
{
  const w = world({ onProbe: (l) => setTimeout(() => l.record('brain_to_tts', true, 'played'), 5) });
  const issue = w.store.recordOccurrence({ component: 'brain_to_tts', pipeline: 'brain_to_tts', message: 'synthesis_failed: x' }).issue;
  w.store.flush();
  const runsDir = path.join(w.dir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const interrupted = {
    runId: 'run-20261018100000-0', status: 'VERIFYING', scope: 'all', issueIds: [issue.issueId], startedAt: new Date().toISOString(),
    budget: { maxAttempts: 2, maxMinutes: 20, tokenCap: 20000, tokensUsed: 0 },
    attempts: [{ n: 1, label: 'TTS', startedAt: new Date().toISOString(), action: 'restart TTS', result: 'failed', evidence: '' }],
    items: [], summary: '', history: [{ at: new Date().toISOString(), from: null, to: 'PLANNED', reason: 'heal' }],
  };
  fs.writeFileSync(path.join(runsDir, `${interrupted.runId}.json`), JSON.stringify(interrupted));
  const fresh = new RepairRunner({ store: w.store, ledger: w.ledger, dir: runsDir, restart: async (l) => { w.restarts.push(l); return { ok: true, reason: 'ok' }; }, connected: () => true, speakProbe: () => setTimeout(() => w.ledger.record('brain_to_tts', true, 'played'), 5), notify: () => {}, timing: { pollMs: 5, reconnectMs: 200, probeMs: 200 } });
  fresh.load();
  ok('a run interrupted by a restart of JARVIS waits for approval', fresh.active()?.status === 'AWAITING_APPROVAL' && w.restarts.length === 0);
  const again = fresh.start('all');
  ok('…"heal yourself" does not start over silently: it asks', again.run.runId === interrupted.runId && /continue the repair/.test(again.reply), again.reply);
  const cont = fresh.resume();
  const done = await cont.settled!;
  ok('"continue the repair": it continues within its budget (attempt 2 of 2)', done.status === 'SUCCEEDED' && w.restarts.length === 1 && done.attempts.length === 2, `${done.status} ${done.attempts.length}`);
}
{
  const w = world();
  const runsDir = path.join(w.dir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, 'run-20261018100000-1.json'), JSON.stringify({ runId: 'run-20261018100000-1', status: 'REPAIRING', scope: 'all', issueIds: [], startedAt: new Date().toISOString(), budget: { maxAttempts: 2, maxMinutes: 20, tokenCap: 1, tokensUsed: 0 }, attempts: [], items: [], summary: '', history: [] }));
  const r = new RepairRunner({ store: w.store, ledger: w.ledger, dir: runsDir });
  r.load();
  ok('"stop healing" on a waiting run: CANCELLED', /will not continue/.test(r.stop()) && r.latest()?.status === 'CANCELLED');
  let threw = false;
  try { (r as any).move(r.latest(), 'REPAIRING', 'x'); } catch { threw = true; }
  ok('an illegal run transition throws (CANCELLED → REPAIRING)', threw);
}

// ── 6. Routes ────────────────────────────────────────────────────────────────
console.log('\n--- 6. Routes ---');
const routes: [string, string | null][] = [
  ['heal yourself', 'heal'], ['Jarvis, heal yourself.', 'heal'], ['repair yourself', 'heal'], ['fix yourself', 'heal'],
  ['go into healing mode', 'heal'], ['move into healing mode', 'heal'], ['self healing mode', 'heal'], ['start self repair', 'heal'],
  ['fix the last problem', 'repair_last'], ['fix only the current error', 'repair_last'], ['fix that error', 'repair_last'],
  ['continue the repair', 'repair_continue'], ['stop healing', 'repair_stop'], ['cancel the repair', 'repair_stop'], ['stop healing mode', 'repair_stop'],
  ["why can't you fix it", 'repair_explain_block'], ['why is the repair blocked', 'repair_explain_block'],
  ['start healing', 'heal'],
  ["don't heal yourself", null], ['heal the patient', null], ['fix the sink', null], ['healing', null], ['heal', null], ['fix it', null],
];
for (const [phrase, type] of routes) {
  const r = matchDeterministicCommand(phrase);
  ok(`"${phrase}" → ${type ?? 'no repair route'}`, type === null ? !r || !/^(heal|repair_)/.test(r.type) : r?.type === type, `got ${r?.type ?? 'null'}`);
}
for (const [phrase, type] of [['fix my app', 'diagnose_app'], ['stop', 'stop'], ['cancel', 'stop'], ['check yourself', 'health_check'], ['continue what i was doing', 'continue_work']] as const) {
  ok(`existing route kept: "${phrase}" → ${type}`, matchDeterministicCommand(phrase)?.type === type, `got ${matchDeterministicCommand(phrase)?.type}`);
}

// ── 7. restartService, with a real process ──────────────────────────────────
console.log('\n--- 7. restartService (real stand-in process) ---');
const py = process.platform === 'win32' ? 'python' : 'python3';
if (spawnSync(py, ['--version']).status !== 0) {
  skipped++;
  console.log(`  ⏭️  SKIP: ${py} is not available here, so a real process restart was not tested`);
} else {
  const { selfHealingManager } = await import('../self_healing/selfHealingManager.js');
  selfHealingManager.launchPythonService(path.join('..', 'tests', 'fixtures', 'repairSleeper.py'), 'RepairTestSvc');
  const entry = () => selfHealingManager.getManagedProcesses().get('RepairTestSvc')!;
  await new Promise((r) => setTimeout(r, 300));
  const first = entry().proc!;
  const firstPid = first.pid;
  const alive = (p: typeof first) => p.exitCode === null && p.signalCode === null;
  ok('the stand-in service runs', alive(first) && typeof firstPid === 'number');
  const res = await selfHealingManager.restartService('repairtestsvc');
  await new Promise((r) => setTimeout(r, 300));
  const second = entry().proc!;
  ok('restartService: ok, a new process', res.ok && second.pid !== firstPid && alive(second), JSON.stringify(res));
  ok('the old process was stopped first: never two copies', !alive(first));
  ok('the requested stop is not counted as a crash', entry().restarts === 0 && !entry().disabledAt, `restarts ${entry().restarts}`);
  await new Promise((r) => setTimeout(r, 3500));   // past the automatic restart's back-off
  ok('…and the automatic path did not start a third copy', entry().proc === second && alive(second));
  const unknown = await selfHealingManager.restartService('NotAService');
  ok('an unknown service is refused with the reason', !unknown.ok && /not started by JARVIS/.test(unknown.reason));
  // Leave nothing running.
  (selfHealingManager as any).intendedStops.add(second);
  second.kill();
}

// ── 8. Through the real orchestrator ─────────────────────────────────────────
console.log('\n--- 8. Through the orchestrator ---');
{
  const { registerAllTools } = await import('../core/tools/index.js');
  const { SkillLoader } = await import('../core/skillLoader.js');
  const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
  const { orchestrator } = await import('../core/orchestrator.js');
  const { modelRouter } = await import('../bridge/modelRouter.js');
  const { issueStore } = await import('../core/issueStore.js');
  const { repairRunner } = await import('../core/repairRun.js');
  registerAllTools();
  await new SkillLoader(path.join(repo, 'skills')).loadSkills();
  ok('self_repair is registered, risk 1, with metadata', toolRegistryV2.has('self_repair') && toolRegistryV2.getMeta('self_repair')?.risk === 1);
  let llmCalls = 0;
  modelRouter.chat = (async () => { llmCalls++; return { content: 'x' }; }) as never;
  modelRouter.streamChat = async function* () { llmCalls++; yield 'x'; } as never;
  const spoken: string[] = [];
  installFakeTts(orchestrator, (await import('../bridge/nodeBridge.js')).nodeBridge, 5, spoken, true);
  await orchestrator.process('heal yourself', 'cli');
  ok('nothing recorded: says there is nothing to repair, and gives a self-check', spoken.some((s) => /nothing to repair/.test(s) && /Self-check:/.test(s)), spoken.join(' | '));
  spoken.length = 0;
  issueStore.recordOccurrence({ component: 'brain_to_tts', pipeline: 'brain_to_tts', message: 'synthesis_failed: edge-tts timed out' });
  await orchestrator.process('heal yourself', 'voice');
  ok('with a speech issue: the plan is said', spoken.some((s) => /restarting speech output/.test(s)), spoken.join(' | '));
  for (let i = 0; i < 100 && repairRunner.active(); i++) await new Promise((r) => setTimeout(r, 20));
  const last = repairRunner.latest()!;
  ok('TTS is not JARVIS\'s to restart in this test: BLOCKED with that reason, not "fixed"', last.status === 'BLOCKED' && /not started by JARVIS/.test(last.items[0]?.detail ?? ''), JSON.stringify(last.items));
  spoken.length = 0;
  await orchestrator.process("why can't you fix it", 'cli');
  ok('"why can\'t you fix it" says why', spoken.some((s) => /not started by JARVIS/.test(s)), spoken.join(' | '));
  ok('no language-model request on any of these', llmCalls === 0, `${llmCalls}`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} ===`);
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
