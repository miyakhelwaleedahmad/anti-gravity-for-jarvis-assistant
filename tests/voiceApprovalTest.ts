/**
 * tests/voiceApprovalTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 12 — voice. A simulated speech stream against the real approval gate
 * and the real orchestrator:
 *
 *  1. The spoken request asks the question and ends on "cancel", so an echo
 *     of its last word can only deny; level 4 says voice cannot approve it.
 *  2. Spoken answers: "approve" after JARVIS has finished approves; the
 *     request heard back is ignored; anything heard while JARVIS says
 *     something else (or just after) is ignored; no answer denies.
 *  3. Level 4: voice cannot approve; the echo of "voice cannot approve this
 *     one" does not deny; the typed code approves.
 *  4. Voice and typed requests get the same decisions for the same calls.
 *  5. Questions answered by voice from real readings, in at most three
 *     sentences, with no LLM request and no JSON read out.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-voice-')));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_PROJECT_DIRS'] = workspace;
process.env['JARVIS_LEVEL2_POLICY'] = 'ask';
process.chdir(workspace);

// A server on a free port, and Chrome's port pointed at a closed one.
const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Backend</title>ok'); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const serverPort = (server.address() as net.AddressInfo).port;
process.env['JARVIS_DEV_PORTS'] = String(serverPort);
const closed = net.createServer();
await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
const closedPort = (closed.address() as net.AddressInfo).port;
await new Promise<void>((r) => closed.close(() => r()));
process.env['JARVIS_CDP_PORT'] = String(closedPort);

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { approvalGate } = await import('../security/approvalGate.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');
const requests: any = await import('../security/approvalRequest.js');
const { assessRisk, decide, level2Policy } = await import('../security/riskEngine.js');
const { beginTrace, endTrace } = await import('../core/traceContext.js');
const summaries: any = await import('../core/voiceSummaries.js' as string).catch(() => ({}));

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sentences = (text: string) => (text.match(/[.!?](\s|$)/g) ?? []).length;

registerAllTools();
await new SkillLoader(path.join(repo, 'skills')).loadSkills();
approvalGate.attachConsole(); // as in the running app: a typed answer counts too
await memoryManager.init();

let llmCalls = 0;
modelRouter.chat = async () => { llmCalls++; return { content: 'Done, sir.' } as any; };
modelRouter.streamChat = async function* () { llmCalls++; yield 'Done, sir.'; } as any;
const spoken: string[] = [];
(orchestrator as any).speak = (t: string) => { spoken.push(t); };

// The speaker: each thing JARVIS says plays for 150 ms.
const said: string[] = [];
(nodeBridge as any).speakToClients = (text: string) => {
  said.push(text);
  nodeBridge.ttsStartedMs = Date.now();
  setTimeout(() => { nodeBridge.ttsEndedMs = Date.now(); }, 150);
};
const pendingRequest = () => (approvalGate as any).pending?.request;
async function whenListening(): Promise<void> {
  for (let i = 0; i < 100 && !(approvalGate as any).pending; i++) await sleep(20);
  for (let i = 0; i < 100; i++) {
    const p = (approvalGate as any).pending;
    if (p && Date.now() >= p.listeningFrom && nodeBridge.ttsEndedMs >= nodeBridge.ttsStartedMs) break;
    await sleep(20);
  }
  await sleep(350); // past the echo tail
}
function build(risk = 2) {
  return requests.buildApprovalRequest({ tool: 'files', action: 'delete', target: '/tmp/old-report.txt', risk, reason: 'test', source: 'voice' });
}

console.log('\n=== Voice Approval Test ===\n');

console.log('--- 1. The spoken request ---');
const text = requests.spokenApprovalRequest(build());
ok('it asks "Do you approve this action?" and ends on "Say approve or cancel."', text.includes('Do you approve this action?') && /Say approve or cancel\.$/.test(text), text);
ok('level 4: voice cannot approve it', /Voice cannot approve it\./.test(requests.spokenApprovalRequest(build(4))));

console.log('\n--- 2. Spoken answers ---');
let asked = approvalGate.requestApproval(build());
await whenListening();
ok('"approve" after JARVIS has finished asking approves', approvalGate.offerVoiceAnswer('approve') && (await asked) === true);

asked = approvalGate.requestApproval(build());
await whenListening();
ok('the request heard back ("say approve or cancel") is ignored', approvalGate.offerVoiceAnswer('say approve or cancel') === false && !!pendingRequest());
ok('…then the user\'s "approve" approves', approvalGate.offerVoiceAnswer('Approve, sir.') && (await asked) === true);

asked = approvalGate.requestApproval(build());
await whenListening();
ok('an echo of the last word ("cancel") can only deny', approvalGate.offerVoiceAnswer('cancel') && (await asked) === false);

asked = approvalGate.requestApproval(build());
await whenListening();
(nodeBridge as any).speakToClients('One moment, sir, I am still here.');
await sleep(20);
const duringOther = approvalGate.offerVoiceAnswer('approve');
ok('"approve" heard while JARVIS says something else is ignored', duringOther === false && !!pendingRequest());
await sleep(500);
ok('…and accepted once it has finished', approvalGate.offerVoiceAnswer('approve') && (await asked) === true);

asked = approvalGate.requestApproval(build(), '', '', '', 'voice', 1);
ok('no answer: denied', (await asked) === false);

console.log('\n--- 3. Level 4 ---');
said.length = 0;
asked = approvalGate.requestApproval(build(4));
await whenListening();
const code = pendingRequest()?.code;
const voiceTaken = approvalGate.offerVoiceAnswer('approve');
await sleep(30); // the message goes to the speaker a moment later
ok('voice "approve" is not an approval; JARVIS says it cannot be done by voice', voiceTaken && !!pendingRequest() && said.some((t) => /Voice cannot approve this one/.test(t)), said.join(' | '));
ok('the echo of that message, heard while it plays, does not deny', approvalGate.offerVoiceAnswer('voice cannot approve this one sir type the code shown in the console') === false && !!pendingRequest());
await sleep(500);
ok('the typed code approves', approvalGate.offerConsoleAnswer(`APPROVE ${code}`) && (await asked) === true);

console.log('\n--- 4. Same decisions by voice and by typing ---');
fs.writeFileSync(path.join(workspace, 'notes.txt'), 'x');
const calls: Array<[string, Record<string, unknown>]> = [
  ['files', { action: 'list', path: workspace }],
  ['files', { action: 'create', path: path.join(os.tmpdir(), 'jarvis-voice-same.txt'), content: 'a' }],
  ['files', { action: 'create', path: path.join(workspace, 'a.md'), content: 'a' }],
  ['files', { action: 'delete', path: path.join(workspace, 'notes.txt') }],
  ['files', { action: 'delete', path: workspace }],
  ['files', { action: 'list', path: '/etc' }],
  ['run_command', { command: 'git status' }],
  ['run_command', { command: 'rm -rf /' }],
];
const decisionFor = (tool: string, args: Record<string, unknown>) => {
  const a = assessRisk({ tool, args, baseRisk: toolRegistryV2.riskOf(tool, args) });
  return JSON.stringify(decide(a, { sessionLevel: 1, policy: level2Policy() }));
};
const byVoice = calls.map(([t, a]) => { beginTrace('voice', 'test'); try { return decisionFor(t, a); } finally { endTrace(); } });
const byText = calls.map(([t, a]) => { beginTrace('cli', 'test'); try { return decisionFor(t, a); } finally { endTrace(); } });
ok('the risk engine decides the same for eight calls, spoken or typed', byVoice.join('|') === byText.join('|'), byVoice.map((d) => JSON.parse(d).outcome).join(','));

console.log('\n--- 5. Questions answered by voice ---');
async function voice(q: string) {
  spoken.length = 0;
  llmCalls = 0;
  await orchestrator.process(q, 'voice');
  return { reply: spoken.join(' '), llm: llmCalls };
}
let r = await voice('what is open in my browser');
ok('"what is open in my browser": a short answer, no LLM, no JSON', r.llm === 0 && sentences(r.reply) <= 3 && !/[{[]/.test(r.reply) && /Chrome/.test(r.reply), r.reply);
r = await voice('what is open');
ok('"what is open": at most three sentences, no JSON', r.llm === 0 && sentences(r.reply) <= 3 && !/[{[]/.test(r.reply), r.reply);
r = await voice("what's running");
ok('"what\'s running": from real readings (the server on its port), no LLM', r.llm === 0 && sentences(r.reply) <= 3 && r.reply.includes(String(serverPort)), r.reply);
r = await voice('is my backend running');
ok('"is my backend running": at most three sentences, no LLM', r.llm === 0 && sentences(r.reply) <= 3 && r.reply.includes(String(serverPort)), r.reply);
r = await voice('what can you do');
ok('"what can you do": at most three sentences, no LLM', r.llm === 0 && sentences(r.reply) <= 3, r.reply);
r = await voice('yes');
ok('"yes" with nothing pending does not say "Confirmed"', r.llm === 0 && !/confirmed/i.test(r.reply), r.reply);
if (summaries.tabsSummary) {
  const tabs = [
    { title: 'Shop {"x": 1}', url: 'http://127.0.0.1/app', visible: true },
    { title: 'Next', url: 'http://127.0.0.1/next' },
    { title: 'A very long title that goes on and on and on past forty characters', url: 'https://example.com/' },
    { title: '', url: 'https://news.example.org/x' },
    { title: 'Fifth', url: 'https://e.com/' },
  ];
  const line = summaries.tabsSummary(tabs);
  ok('the tab summary: count, the tab on screen, a few others, no braces', /^5 tabs are open, sir\. On screen: Shop x 1\. Others include Next, .*… and news\.example\.org\.$/.test(line)
    && sentences(line) === 3, line);
} else {
  ok('core/voiceSummaries.ts exists', false);
}

console.log('\n--- 6. A slow speaker that queues, as on the owner\'s PC ---');
// The owner's log: every spoken full-control request was denied before it
// could be answered. Their speaker took seconds to start (synthesis), queued
// messages behind each other, and said speaking_end only when its queue was
// empty; the gate waited 2 s for speech to start and 15 s for it to end, then
// gave 10 s. This stand-in behaves like that speaker.
{
  const queue: string[] = [];
  let playing = false;
  const queueSpeaker = (synthMs: number, playMs: number) => (text: string) => {
    said.push(text);
    queue.push(text);
    if (playing) return;
    playing = true;
    void (async () => {
      await sleep(synthMs);
      nodeBridge.ttsStartedMs = Date.now();
      while (queue.length) { queue.shift(); await sleep(playMs); }
      nodeBridge.ttsEndedMs = Date.now();
      playing = false;
    })();
  };
  const fastSpeaker = (nodeBridge as any).speakToClients;
  // Answers once the speaker has said everything queued since `since`.
  const answerAfterSpeech = async (since: number, words: string) => {
    for (let i = 0; i < 1_000 && !(nodeBridge.ttsEndedMs > since && nodeBridge.ttsEndedMs >= nodeBridge.ttsStartedMs); i++) await sleep(20);
    await sleep(350); // past the echo tail
    return approvalGate.offerVoiceAnswer(words);
  };

  (nodeBridge as any).speakToClients = queueSpeaker(2_500, 800);
  let since = Date.now();
  asked = approvalGate.requestApproval(build(), '', '', '', 'voice', 1);
  let taken = await answerAfterSpeech(since, 'approve');
  ok('speech that starts 2.5 s late: the answer window opens after JARVIS has asked, and "approve" approves', taken && (await asked) === true);

  (nodeBridge as any).speakToClients = queueSpeaker(300, 8_000);
  (nodeBridge as any).speakToClients('Cancelled, sir. You did not approve it, so nothing was done.');
  since = Date.now();
  asked = approvalGate.requestApproval(build(), '', '', '', 'voice', 1);
  taken = await answerAfterSpeech(since, 'approve');
  ok('a question queued behind 8 s of other speech (16 s in all): still answerable after it is said', taken && (await asked) === true);

  // Asked while JARVIS is already talking: no new speaking_start, and one
  // speaking_end once the reply and the question are both said.
  (nodeBridge as any).speakToClients = queueSpeaker(300, 3_000);
  (nodeBridge as any).speakToClients('Sir, I need to check that first. One moment.');
  for (let i = 0; i < 100 && !(nodeBridge.ttsStartedMs > nodeBridge.ttsEndedMs); i++) await sleep(20);
  since = Date.now();
  asked = approvalGate.requestApproval(build(), '', '', '', 'voice', 1);
  await sleep(4_000); // the question is still playing: an answer now is not taken
  const early = approvalGate.offerVoiceAnswer('approve');
  for (let i = 0; i < 1_000 && !(nodeBridge.ttsEndedMs > since && nodeBridge.ttsEndedMs >= nodeBridge.ttsStartedMs); i++) await sleep(20);
  await sleep(1_400); // the gate allows 1 s in case the speaker starts again
  taken = approvalGate.offerVoiceAnswer('approve');
  ok('asked while JARVIS is already speaking: listens once the whole queue is said, not before', !early && taken && (await asked) === true, `early=${early} taken=${taken}`);

  (nodeBridge as any).speakToClients = fastSpeaker;
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); log(...a); };
  try {
    asked = approvalGate.requestApproval(build());
    await whenListening();
    approvalGate.offerVoiceAnswer('cancel');
    await asked;
  } finally {
    console.log = log;
  }
  ok('a spoken request gives 20 s to answer once JARVIS has asked (10 s was too short)', lines.some((l) => /within 20 s/.test(l)), lines.find((l) => /within \d+ s/.test(l)) ?? 'no time shown');

  const full = requests.buildApprovalRequest({
    tool: 'enable_full_control_session', target: '{"durationMinutes":15,"source":"llm"}',
    risk: 3, reason: 'test', source: 'voice',
  });
  const question = requests.spokenApprovalRequest(full);
  ok('the spoken question does not read out code ({"durationMinutes":15,...})', !/[{}"]/.test(question) && /full control mode/.test(question) && /Say approve or cancel\.$/.test(question), question);

  ok('"approved approved approved" approves (said again when JARVIS seemed not to hear)',
    requests.classifyVoiceAnswer('approved approved approved') === 'approve' && requests.classifyVoiceAnswer('approve approve') === 'approve'
    && requests.classifyVoiceAnswer('yes yes') === 'approve');
  ok('…but not mixed with a refusal or JARVIS\'s own words',
    requests.classifyVoiceAnswer('approve cancel') !== 'approve'
    && requests.classifyVoiceAnswer('do you approve this action approved approved approved cancelled') !== 'approve'
    && requests.classifyVoiceAnswer('approved date') !== 'approve');
}

server.close();
try { await memoryManager.flush(); } catch { /* best effort */ }
process.chdir(os.tmpdir());
fs.rmSync(workspace, { recursive: true, force: true });
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
