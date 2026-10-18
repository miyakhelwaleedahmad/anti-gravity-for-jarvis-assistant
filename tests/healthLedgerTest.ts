/**
 * tests/healthLedgerTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-healing Phase 1: health comes from observed effects, in one ledger.
 *
 * Several pipelines were reported healthy because their process connected
 * (speech recognition and the wake word, on client_ready) or because the
 * provider's model list answered (the language model, while chat failed).
 * monitoring/healthLedger.ts takes only outcomes of the work itself; the
 * dashboard (healthManager) reads it and never shows a pipeline online while
 * its ledger entry is failing.
 *
 *   1. The ledger's own rules: no evidence is "unknown", never "healthy";
 *      one failure "degraded", two in a row "failing"; an old success is
 *      "stale"; a pipeline whose service is not connected is "failing".
 *   2. Fault injection through the real bridge, provider and tool registry:
 *      for speech output, speech recognition, the wake word, the language
 *      model and tools, a failure turns that pipeline red in the ledger and
 *      not-online on the dashboard; a working outcome turns it green.
 *   3. A connection alone is not counted as success any more.
 *   4. Token usage a provider did not report is null, not 0.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-health-ledger-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
const freePort = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const TOKEN = 'test-bridge-token-ledger-0123456789';
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.env['BRIDGE_PORT'] = String(await freePort());
process.env['HEALTH_PORT'] = String(await freePort());
process.env['JARVIS_BRIDGE_TOKEN'] = TOKEN;
process.env['GROQ_API_KEY'] = 'fake-test-key-0123456789012345678901234567890123456789';
process.env['LLM_PROVIDER'] = 'groq';

// The stand-in provider: the model list always answers (with the configured
// models); chat answers per `chatMode`.
const { llmConfig } = await import('../config/llmconfig.js');
const llmModel = llmConfig.model;
const llmFastModel = llmConfig.fastModel;
let chatN = 0;
const ask = () => ({ messages: [{ role: 'user', content: `hello ${++chatN}` }] }) as never;   // distinct: the provider caches answers
let chatMode: 'fail' | 'ok' | 'ok_no_usage' = 'fail';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: llmModel }, { id: llmFastModel }] }), { status: 200 });
  if (u.endsWith('/chat/completions')) {
    if (chatMode === 'fail') return new Response(JSON.stringify({ error: { message: 'internal error' } }), { status: 500 });
    return new Response(JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello, sir.' }, finish_reason: 'stop' }],
      ...(chatMode === 'ok' ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } : {}),
    }), { status: 200 });
  }
  return realFetch(url, init);
}) as typeof fetch;

const { HealthLedger, healthLedger, LEDGER_PIPELINES, LEDGER_STALE_MS, isToolFault } = await import('../monitoring/healthLedger.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { connectTtsStandIn } = await import('./ttsBridgeClient.js');
const { healthManager } = await import('../monitoring/healthManager.js');
const { pipelineRegistry } = await import('../self_healing/pipelineRegistry.js');
const { groqProvider } = await import('../bridge/groqProvider.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const WebSocket = (await import('ws')).default;

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = LEDGER_PIPELINES;

console.log('\n=== Health from observed effects (self-healing Phase 1) ===\n');

// ── 1. The ledger's rules ────────────────────────────────────────────────────
console.log('--- 1. The rules ---');
{
  const l = new HealthLedger();
  ok('no outcome yet: unknown, not healthy', l.status(P.llm).state === 'unknown', l.status(P.llm).detail);
  l.record(P.llm, true, 'chat answered');
  ok('a working outcome: healthy', l.status(P.llm).state === 'healthy');
  ok('…which turns stale when old', l.status(P.llm, undefined, Date.now() + LEDGER_STALE_MS + 1_000).state === 'stale');
  l.record(P.llm, false, 'server: 500');
  ok('one failure: degraded', l.status(P.llm).state === 'degraded');
  l.record(P.llm, false, 'server: 500');
  ok('two in a row: failing', l.status(P.llm).state === 'failing' && l.status(P.llm).failuresInRow === 2);
  l.record(P.tts, true, 'played');
  ok('a service that is not connected: failing, whatever its last outcome', l.status(P.tts, ['stt']).state === 'failing' && /not connected/.test(l.status(P.tts, ['stt']).detail));
  l.record(P.wake, false, 'microphone error'); l.record(P.wake, false, 'microphone error');
  l.record(P.stt, true, 'transcript');
  ok('speech recognition depends on the wake word: failing while it fails', l.status(P.stt, ['stt', 'wakeword']).state === 'failing', l.status(P.stt, ['stt', 'wakeword']).detail);
  ok('a refusal is not a tool fault', !isToolFault('Permission denied.') && !isToolFault('Not installed: the owner did not approve.') && !isToolFault('RATE_LIMITED: …'));
  ok('a crash or timeout is', isToolFault('TIMEOUT: the process was stopped') && isToolFault('TypeError: cannot read properties of undefined'));
}

// ── 2. Fault injection ───────────────────────────────────────────────────────
console.log('\n--- 2. Fault injection through the real components ---');
nodeBridge.start();
await sleep(300);
const PORT = Number(process.env['BRIDGE_PORT']);
const svc = async (name: string) => (await healthManager.probe()).services[name] as { status: string; detail: string } | undefined;
const notOnlineWhileRed = async (pipeline: typeof P[keyof typeof P], service: string) => {
  const s = healthLedger.status(pipeline, nodeBridge.getReadyClients());
  const h = await svc(service);
  return { red: s.state === 'degraded' || s.state === 'failing', dash: h?.status, detail: `${s.state} / ${h?.status}: ${h?.detail}` };
};

// Speech output
const tts = await connectTtsStandIn(PORT, TOKEN, 50);
tts.outcome = 'synthesis_failed';
nodeBridge.speakToClients('Opening Chrome, sir.');
await sleep(300);
let r = await notOnlineWhileRed(P.tts, 'tts');
ok('speech output: a reply that was not played turns it red', r.red, r.detail);
ok('…and the dashboard does not show it online', r.dash !== 'online', r.detail);
tts.outcome = 'played';
nodeBridge.speakToClients('Done, sir.');
await sleep(300);
ok('…a reply that plays turns it healthy again', healthLedger.status(P.tts, nodeBridge.getReadyClients()).state === 'healthy');

// Speech recognition and the wake word: a stand-in stt.py / wakeWords.py
async function connectRole(role: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'status' && msg.payload?.status === 'connected') {
        ws.send(JSON.stringify({ type: 'client_ready', payload: { role, token: TOKEN } }));
        setTimeout(resolve, 150);
      }
    });
  });
  return ws;
}
const sttWs = await connectRole('stt');
const wakeWs = await connectRole('wakeword');
ok('connecting is not success: speech recognition is not verified yet', healthLedger.status(P.stt, nodeBridge.getReadyClients()).state === 'unknown', healthLedger.status(P.stt, nodeBridge.getReadyClients()).detail);
ok('…nor in the self-healing registry', pipelineRegistry.getPipeline('stt_to_brain').lastSuccess === 0 && pipelineRegistry.getPipeline('wake_to_stt').lastSuccess === 0,
  `stt ${pipelineRegistry.getPipeline('stt_to_brain').lastSuccess}, wake ${pipelineRegistry.getPipeline('wake_to_stt').lastSuccess}`);
let h = await svc('stt');
ok('…and the dashboard says connected but not verified, not online', h?.status !== 'online' && /not verified/i.test(h?.detail ?? ''), `${h?.status}: ${h?.detail}`);

wakeWs.send(JSON.stringify({ type: 'wake_word', payload: { detected: true } }));
sttWs.send(JSON.stringify({ type: 'stt_result', payload: { text: 'open chrome' } }));
await sleep(300);
ok('a wake-word detection makes the wake word healthy', healthLedger.status(P.wake, nodeBridge.getReadyClients()).state === 'healthy', healthLedger.status(P.wake, nodeBridge.getReadyClients()).detail);
ok('a transcript makes speech recognition healthy', healthLedger.status(P.stt, nodeBridge.getReadyClients()).state === 'healthy', healthLedger.status(P.stt, nodeBridge.getReadyClients()).detail);
h = await svc('stt');
ok('…and the dashboard online', h?.status === 'online', `${h?.status}: ${h?.detail}`);

sttWs.send(JSON.stringify({ type: 'hardware_error', payload: { device: 'stt', error: 'Whisper model failed to load' } }));
await sleep(200);
r = await notOnlineWhileRed(P.stt, 'stt');
ok('speech recognition reporting a failure turns it red', r.red, r.detail);
ok('…and the dashboard does not show it online', r.dash !== 'online', r.detail);
wakeWs.send(JSON.stringify({ type: 'hardware_error', payload: { device: 'wakeword', error: 'no microphone' } }));
await sleep(200);
r = await notOnlineWhileRed(P.wake, 'wake_word');
ok('the wake word reporting a failure turns it red, and not online', r.red && r.dash !== 'online', r.detail);
sttWs.close();
await sleep(300);
ok('speech recognition disconnected: failing', healthLedger.status(P.stt, nodeBridge.getReadyClients()).state === 'failing');

// Language model: the model list answers, chat fails
chatMode = 'fail';
await groqProvider.ping(AbortSignal.timeout(5_000)).catch(() => undefined);
await groqProvider.chat(ask()).catch(() => undefined);
await groqProvider.ping(AbortSignal.timeout(5_000)).catch(() => undefined);   // the model list answers after the failure
r = await notOnlineWhileRed(P.llm, 'llm');
ok('language model: a failed chat turns it red', r.red, r.detail);
ok('…and the dashboard does not show it online because the model list answers', r.dash !== 'online', r.detail);
chatMode = 'ok';
await groqProvider.chat(ask()).catch(() => undefined);
ok('…a chat that answers turns it healthy', healthLedger.status(P.llm).state === 'healthy', healthLedger.status(P.llm).detail);

// Tools
toolRegistryV2.register({
  name: 'test_ledger_crash', description: 'Stand-in tool that crashes.', riskLevel: 'low',
  meta: { category: 'SYSTEM', risk: 0, reversible: 'yes', external: 'none', effect: 'None.', output: { format: 'text', description: 'Text' } },
  inputSchema: {}, fallbacks: [],
  async execute() { throw new TypeError('cannot read properties of undefined (reading "x")'); },
} as never);
toolRegistryV2.register({
  name: 'test_ledger_ok', description: 'Stand-in tool that works.', riskLevel: 'low',
  meta: { category: 'SYSTEM', risk: 0, reversible: 'yes', external: 'none', effect: 'None.', output: { format: 'text', description: 'Text' } },
  inputSchema: {}, fallbacks: [],
  async execute() { return 'done'; },
} as never);
await toolRegistryV2.execute('test_ledger_ok', {});
ok('tools: a call that works: healthy', healthLedger.status(P.tools).state === 'healthy', healthLedger.status(P.tools).detail);
await toolRegistryV2.execute('test_ledger_crash', {});
ok('a tool that crashes: red', ['degraded', 'failing'].includes(healthLedger.status(P.tools).state), healthLedger.status(P.tools).detail);
const before = healthLedger.history(P.tools).length;
await toolRegistryV2.execute('no_such_tool_xyz', {});
ok('an unknown tool name (bad input, not a fault) is not counted', healthLedger.history(P.tools).length === before);

// ── 4. Usage ─────────────────────────────────────────────────────────────────
console.log('\n--- 4. Token usage ---');
chatMode = 'ok_no_usage';
const noUsage = await groqProvider.chat(ask());
ok('a provider that reports no usage: null, not 0', noUsage.usage?.totalTokens === null && noUsage.usage?.promptTokens === null, JSON.stringify(noUsage.usage));
chatMode = 'ok';
const withUsage = await groqProvider.chat(ask());
ok('…reported usage is kept', withUsage.usage?.totalTokens === 13, JSON.stringify(withUsage.usage));

tts.close(); wakeWs.close();
nodeBridge.stop();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
