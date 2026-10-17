/**
 * tests/planningTimeoutSpeechTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE-002: when the PLANNING watchdog ends a request, JARVIS says so.
 *
 * The watchdog reset everything and the request ended in silence: the reset
 * aborts the request, and an aborted request is not allowed to speak. A slow
 * answer looked like JARVIS ignoring the owner.
 *
 * A real request plans against a stand-in model that never answers; the
 * state machine's watchdog reset is then fired (the timer itself waits for
 * the whole retry budget, see llmTimingTest). Real NodeBridge, real WebSocket
 * client standing in for tts.py.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-planning-timeout-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
const freePort = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const TOKEN = 'test-bridge-token-timeout-0123456789';
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.env['BRIDGE_PORT'] = String(await freePort());
process.env['HEALTH_PORT'] = String(await freePort());
process.env['JARVIS_BRIDGE_TOKEN'] = TOKEN;
process.env['GROQ_API_KEY'] = 'fake-test-key';
process.env['LLM_PROVIDER'] = 'groq';

// The stand-in model: lists its models, never answers a chat request (until aborted).
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
  if (u.endsWith('/chat/completions')) {
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted'))));
  }
  return realFetch(url, init);
}) as typeof fetch;

const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { agentStateMachine, AgentState } = await import('../core/agentStateMachine.js');
const { connectTtsStandIn } = await import('./ttsBridgeClient.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

nodeBridge.start();
await sleep(300);
const tts = await connectTtsStandIn(Number(process.env['BRIDGE_PORT']), TOKEN);

console.log('\n=== A request ended by the planning watchdog is not silent (VOICE-002) ===\n');
const request = orchestrator.process('write me a long essay about the history of the printing press', 'voice');
for (let i = 0; i < 250 && !agentStateMachine.is(AgentState.PLANNING); i++) await sleep(20);
ok('(setup) the request is planning, waiting for the model', agentStateMachine.is(AgentState.PLANNING), agentStateMachine.currentState);
const before = tts.received.length;
(agentStateMachine as unknown as { _watchdogReset(s: unknown, r: string): void })._watchdogReset(AgentState.PLANNING, 'planning_timeout');
await Promise.race([request, sleep(8_000)]);
await sleep(500);
const said = tts.received.slice(before);
ok('JARVIS says the answer took too long', said.some((t) => /too long/i.test(t)), JSON.stringify(said));
ok('…once, and nothing else after the reset', said.length === 1, JSON.stringify(said));
for (let i = 0; i < 100 && !agentStateMachine.is(AgentState.IDLE); i++) await sleep(20);
ok('JARVIS is idle again, ready for the next request', agentStateMachine.is(AgentState.IDLE), agentStateMachine.currentState);

tts.close();
nodeBridge.stop();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
