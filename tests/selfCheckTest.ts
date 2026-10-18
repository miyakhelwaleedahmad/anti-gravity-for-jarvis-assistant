/**
 * tests/selfCheckTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-healing Phase 3: read-only questions about JARVIS itself.
 *
 *   1. Routing: typed and speech-recognition phrasings of "check yourself",
 *      "full self-check", "repair report" and "why are you stuck" reach their
 *      routes; negatives and near misses do not; the phrases that already had
 *      a route ("system check", "status", "fix my app", "how are you", agent
 *      questions) keep it.
 *   2. Reports from evidence: no outcome is NOT_VERIFIED (never VERIFIED), a
 *      failure is FAILING, a missing service is BLOCKED; a failed probe is
 *      SKIPPED, not hidden.
 *   3. Honesty: no reply, in any state, claims that everything works or that
 *      all errors are fixed.
 *   4. Read-only: running every mode changes no issue, no file, no ledger entry.
 *   5. "Why are you stuck?": the request in flight (state, step, approval) is
 *      read before the question replaces it; idle says so.
 *   6. Through the real orchestrator: the spoken reply comes from self_check,
 *      with no language-model request.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { installFakeTts } from './fakeTts.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-self-check-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { matchDeterministicCommand } = await import('../core/deterministicRoutes.js');
const { healthLedger } = await import('../monitoring/healthLedger.js');
const { issueStore } = await import('../core/issueStore.js');
const { healthCheck, repairReport, investigateStuck, captureInFlight, overclaims, runSelfCheck } = await import('../core/selfCheck.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

// ── 1. Routing ───────────────────────────────────────────────────────────────
console.log('\n--- 1. Routing ---');
const expect: [string, string | null][] = [
  ['check yourself', 'health_check'],
  ['Jarvis, check yourself.', 'health_check'],
  ['run a self check', 'health_check'],
  ['run a self-check', 'health_check'],
  ['selfcheck', 'health_check'],
  ['do a health check', 'health_check'],
  ['helth check', 'health_check'],                // speech recognition spelling
  ['how is your health', 'health_check'],
  ['are you working properly?', 'health_check'],
  ["what's wrong with you", 'health_check'],
  ['do you have any errors', 'health_check'],
  ['run a full self check', 'self_check_full'],
  ['full self-check', 'self_check_full'],
  ['do a complete health check', 'self_check_full'],
  ['check yourself fully', 'self_check_full'],
  ['show the repair report', 'repair_report'],
  ['show me the last repair report', 'repair_report'],
  ['repair report', 'repair_report'],
  ['what did you fix', 'repair_report'],
  ['what are your open issues', 'repair_report'],
  ['why are you stuck', 'investigate_stuck'],
  ['Why are you stuck?', 'investigate_stuck'],
  ['why r u stuck', 'investigate_stuck'],
  ['are you stuck', 'investigate_stuck'],
  ['what are you waiting for', 'investigate_stuck'],
  ['why is this taking so long', 'investigate_stuck'],
  // Negatives and near misses: not a self-check.
  ["don't check yourself", null],
  ['do not run a self check', null],
  ['check yourself before you wreck yourself', null],
  ['check the weather', null],
  ['why is the sky blue', null],
  ['what are the open issues', null],              // could be a repository's issues
];
for (const [phrase, type] of expect) {
  const r = matchDeterministicCommand(phrase);
  ok(`"${phrase}" → ${type ?? 'no self-check route'}`, type === null ? !r || !/^(health_check|self_check_full|repair_report|investigate_stuck)$/.test(r.type) : r?.type === type, `got ${r?.type ?? 'null'}`);
}
const kept: [string, string][] = [
  ['system check', 'status'], ['status', 'status'], ['fix my app', 'diagnose_app'], ['how are you', 'simple_reply'],
  ['what is open', 'get_system_state'], ['what tabs are open', 'get_browser_tabs'], ['help', 'help'],
  ["what's running", 'whats_running'], ['which agents are stuck', 'agent_status'],
];
for (const [phrase, type] of kept) {
  ok(`existing route kept: "${phrase}" → ${type}`, matchDeterministicCommand(phrase)?.type === type, `got ${matchDeterministicCommand(phrase)?.type ?? 'null'}`);
}

// ── 2. Reports from evidence ────────────────────────────────────────────────
console.log('\n--- 2. Reports from evidence ---');
healthLedger.clear();
const allRoles = () => ['tts', 'stt', 'wakeword'];
let r = await healthCheck(false, { connectedRoles: allRoles });
ok('no outcome yet: every pipeline NOT_VERIFIED, none VERIFIED', r.items.length === 5 && r.items.every((i) => i.state === 'NOT_VERIFIED'), JSON.stringify(r.items.map((i) => i.state)));
ok('…and the reply says so', /0 of 5 checks verified/.test(r.spoken) && /5 not verified yet/.test(r.spoken), r.spoken);
healthLedger.record('brain_to_tts', true, 'played (edge-tts)');
healthLedger.record('brain_to_llm', false, 'Groq API error 503');
r = await healthCheck(false, { connectedRoles: allRoles });
const byName = (n: string) => r.items.find((i) => i.name === n);
ok('a worked outcome is VERIFIED', byName('speech output')?.state === 'VERIFIED');
ok('a failed one is FAILING, named in the reply', byName('language model')?.state === 'FAILING' && /1 failing \(language model\)/.test(r.spoken), r.spoken);
r = await healthCheck(false, { connectedRoles: () => ['stt', 'wakeword'] });
ok('a service that is not connected: BLOCKED, not "not verified"', byName('speech output')?.state === 'BLOCKED', JSON.stringify(byName('speech output')));
r = await healthCheck(true, { connectedRoles: allRoles, services: async () => [{ name: 'redis', status: 'online' }, { name: 'vector', status: 'loading' }] });
ok('full: service probes are included', byName('service redis')?.state === 'VERIFIED' && byName('service vector')?.state === 'NOT_VERIFIED');
ok('full: says what is not observed at all', r.details.some((l) => /Not observed by these checks/.test(l)));
r = await healthCheck(true, { connectedRoles: allRoles, services: async () => { throw new Error('probe timed out'); } });
ok('full: a failed probe is SKIPPED with the reason, not dropped', byName('service probes')?.state === 'SKIPPED' && /timed out/.test(byName('service probes')!.detail));
issueStore.recordOccurrence({ component: 'tool:open_app', tool: 'open_app', message: 'Command timed out after 5000 ms' });
r = await healthCheck(false, { connectedRoles: allRoles });
ok('open issues are counted and the latest named', r.issues.length === 1 && /1 open issue; the latest: tool:open_app/.test(r.spoken), r.spoken);

// ── 3. Honesty ───────────────────────────────────────────────────────────────
console.log('\n--- 3. Honesty ---');
ok('the guard catches the claims it is for', overclaims('All errors are fixed.') && overclaims('Everything is working') && overclaims('all systems operational') && overclaims('I am fully repaired'));
ok('…and not an honest count', !overclaims('5 of 5 checks verified, no open issues are recorded.') && !overclaims('No repair run has been recorded.'));
healthLedger.clear();
for (const p of ['brain_to_tts', 'stt_to_brain', 'wake_to_stt', 'brain_to_llm', 'tool_execution'] as const) healthLedger.record(p, true, 'worked');
const tmpStore = issueStore.active().map((i) => i.issueId);
for (const id of tmpStore) issueStore.resolve(id, { passed: true, evidence: 'open_app ran in 2 s' });
const replies: string[] = [];
for (const mode of ['quick', 'full', 'report', 'stuck'] as const) replies.push((await runSelfCheck(mode, { connectedRoles: allRoles, services: async () => [{ name: 'redis', status: 'online' }], goals: () => [], agents: () => ({ running: 0, waiting: 0, agents: [] }), snapshot: undefined } as never)).spoken);
ok('everything observed working: the reply counts, it does not claim', replies[0] === 'Self-check: 5 of 5 checks verified. No open issues are recorded.', replies[0]);
ok('no reply in any mode over-claims', replies.every((t) => !overclaims(t)), replies.join(' | '));

// ── 4. Read-only ─────────────────────────────────────────────────────────────
console.log('\n--- 4. Read-only ---');
issueStore.flush();
const dataDir = path.join(root, 'data', 'repairs');
const listing = () => fs.readdirSync(dataDir).map((f) => `${f}:${fs.statSync(path.join(dataDir, f)).size}:${fs.statSync(path.join(dataDir, f)).mtimeMs}`).sort().join('|');
const before = { files: listing(), issues: JSON.stringify(issueStore.all()), ledger: JSON.stringify(healthLedger.all()) };
for (const mode of ['quick', 'full', 'report', 'stuck'] as const) await runSelfCheck(mode, { connectedRoles: allRoles, services: async () => [], goals: () => [], agents: () => ({ running: 0, waiting: 0, agents: [] }) });
issueStore.flush();
ok('no issue, file or ledger entry changed', listing() === before.files && JSON.stringify(issueStore.all()) === before.issues && JSON.stringify(healthLedger.all()) === before.ledger);

// ── Repair report ────────────────────────────────────────────────────────────
const rep = await repairReport({});
ok('repair report without a run says so, and lists what was resolved with evidence', /No repair run has been recorded/.test(rep.spoken) && /1 issue was resolved with evidence/.test(rep.spoken) && rep.details.some((l) => /open_app ran in 2 s/.test(l)), rep.spoken);
ok('…and where the full record is', rep.details.some((l) => l.includes(dataDir)));

// ── 5. Why stuck ─────────────────────────────────────────────────────────────
console.log('\n--- 5. Why are you stuck ---');
const t0 = Date.now();
const snap = captureInFlight({
  state: 'EXECUTING', stateHistory: [{ state: 'EXECUTING', timestamp: t0 - 75_000 }], now: t0,
  graph: { goal: 'close notepad and open paint', status: 'running', createdAt: t0 - 80_000, nodes: new Map([['a', { tool: 'control_app', status: 'running', startedAt: t0 - 70_000 }], ['b', { tool: 'open_app', status: 'failed' }]]) },
  approval: 'Close Notepad — notepad.exe (level 3)',
});
const stuck = await investigateStuck({ snapshot: snap, now: () => t0, goals: () => [{ id: 'g1', title: 'Daily backup', status: 'blocked', blockedReason: 'the backup folder is missing' }], agents: () => ({ running: 1, waiting: 0, agents: [{ name: 'Research & Intelligence Agent', status: 'RUNNING', task: 'compare two libraries' }] }) });
ok('names the state and how long', /I was executing for 75 s/.test(stuck.spoken), stuck.spoken);
ok('names the running step and how long it has run', /control_app \(running 70 s\)/.test(stuck.spoken));
ok('says it was waiting for your answer, and what', /waiting for your answer: Close Notepad/.test(stuck.spoken) && stuck.items.some((i) => i.name === 'foreground request' && i.state === 'BLOCKED'));
ok('says asking stopped that request (the orchestrator serialises requests)', /Asking stopped that request/.test(stuck.spoken));
ok('blocked goals and running agents are named', /Daily backup \(the backup folder is missing\)/.test(stuck.spoken) && /1 agent running/.test(stuck.spoken));
ok('failed steps are listed', /Failed steps: open_app/.test(stuck.spoken));
const idle = await investigateStuck({ snapshot: { at: t0, state: 'IDLE' }, now: () => t0, goals: () => [], agents: () => ({ running: 0, waiting: 0, agents: [] }) });
ok('idle with nothing waiting: says it is not stuck', /^I am not stuck/.test(idle.spoken), idle.spoken);
const blind = await investigateStuck({ now: () => t0 + 60_000, goals: () => [], agents: () => ({ running: 0, waiting: 0, agents: [] }) });
ok('no snapshot: says it did not see, instead of "not stuck"', /did not see what was running/.test(blind.spoken), blind.spoken);

// ── 6. Through the real orchestrator ─────────────────────────────────────────
console.log('\n--- 6. Through the orchestrator ---');
const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { taskGraphEngine } = await import('../core/taskGraphEngine.js');
const { approvalGate } = await import('../security/approvalGate.js');
registerAllTools();
await new SkillLoader(path.join(repo, 'skills')).loadSkills();
ok('self_check is registered, risk 0, with metadata', toolRegistryV2.has('self_check') && toolRegistryV2.getMeta('self_check')?.risk === 0);
let llmCalls = 0;
modelRouter.chat = (async () => { llmCalls++; return { content: 'x' }; }) as never;
modelRouter.streamChat = async function* () { llmCalls++; yield 'x'; } as never;
const spoken: string[] = [];
installFakeTts(orchestrator, (await import('../bridge/nodeBridge.js')).nodeBridge, 5, spoken, true);
const calls: string[] = [];
toolRegistryV2.onCall((c) => calls.push(c.tool));
await orchestrator.process('check yourself', 'cli');
ok('"check yourself": the spoken reply is the self-check', spoken.some((s) => /^Self-check: \d+ of \d+ checks verified/.test(s)), spoken.join(' | '));
ok('…with no language-model request', llmCalls === 0, `${llmCalls}`);
ok('…through the registry\'s self_check tool (the checked path)', calls.includes('self_check'), calls.join(','));
spoken.length = 0;
const realGraph = taskGraphEngine.getCurrentGraph.bind(taskGraphEngine);
const realPending = approvalGate.pendingSummary.bind(approvalGate);
(taskGraphEngine as any).getCurrentGraph = () => ({ goal: 'open paint', status: 'running', createdAt: Date.now() - 5000, nodes: new Map([['n', { tool: 'open_app', status: 'running', startedAt: Date.now() - 4000 }]]) });
(approvalGate as any).pendingSummary = () => 'Open Paint — mspaint.exe (level 2)';
await orchestrator.process('why are you stuck', 'voice');
(taskGraphEngine as any).getCurrentGraph = realGraph;
(approvalGate as any).pendingSummary = realPending;
ok('"why are you stuck": describes the request that was in flight', spoken.some((s) => /open.app \(running \d+ s\)/.test(s) && /waiting for your answer: Open Paint/.test(s)), spoken.join(' | '));
ok('…with no language-model request', llmCalls === 0, `${llmCalls}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
