/**
 * tests/ttsDeliveryLifecycleTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE-001 (the rest of it): a reply that cannot be delivered must not leave
 * JARVIS stuck in SPEAKING with the wake word paused.
 *
 * The orchestrator pauses the wake-word listener and waits in SPEAKING for
 * tts.py's speaking_end. When tts.py was not connected, the reply was queued
 * and nothing ended the turn: JARVIS stayed deaf until the speaking watchdog
 * (12 s or more). The same when tts.py's connection dropped mid-reply.
 *
 * Real NodeBridge.speakToClients(), a real WebSocket, the orchestrator and
 * state machine, and the tts.py stand-in from tests/ttsBridgeClient.ts:
 *   1. a duplicate of a reply still being spoken is not sent twice, and the
 *      turn still closes;
 *   2. a finished turn clears the bridge's transient state;
 *   3. no tts.py connected: the turn closes at once (outcome not_connected),
 *      the wake word is told to resume, and the reply is kept and spoken
 *      when tts.py connects;
 *   4. tts.py's connection drops mid-reply: the turn closes at once;
 *   5. each time JARVIS is IDLE again well inside the watchdog.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tts-delivery-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
const freePort = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const TOKEN = 'test-bridge-token-delivery-0123456789';
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.env['BRIDGE_PORT'] = String(await freePort());
process.env['HEALTH_PORT'] = String(await freePort());
process.env['JARVIS_BRIDGE_TOKEN'] = TOKEN;

const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { agentStateMachine, AgentState } = await import('../core/agentStateMachine.js');
const { connectTtsStandIn } = await import('./ttsBridgeClient.js');
const { conversationBus } = await import('../core/conversationBus.js');
// jarvis.ts's own wiring: IDLE when speech has ended, and the wake word resumed on speaking:end.
conversationBus.on('idle', () => { if (!agentStateMachine.is(AgentState.IDLE)) agentStateMachine.transition(AgentState.IDLE); });
let speakingEnds = 0;
conversationBus.on('speaking:end', () => { speakingEnds++; });

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function untilIdle(limitMs: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs && agentStateMachine.currentState !== AgentState.IDLE) await sleep(20);
  return Date.now() - t0;
}
const bridge = nodeBridge as unknown as { _lastQueuedTts: string; pendingTTS: string[] };
const PORT = Number(process.env['BRIDGE_PORT']);

nodeBridge.start();
await sleep(300);
console.log('\n=== Undeliverable replies do not leave JARVIS stuck (VOICE-001) ===\n');

// ── 1. A duplicate while the first is still being spoken ─────────────────────
console.log('--- 1. A duplicate of a reply still being spoken ---');
let tts = await connectTtsStandIn(PORT, TOKEN, 600);
orchestrator.speak('Opening Chrome, sir.');
await sleep(50);
nodeBridge.speakToClients('Opening Chrome, sir.');
let ms = await untilIdle(5_000);
ok('sent to tts.py once, not twice', tts.received.length === 1, JSON.stringify(tts.received));
ok('the turn still closes', agentStateMachine.currentState === AgentState.IDLE, `${ms} ms`);

// ── 2. A finished turn clears the transient state ────────────────────────────
console.log('\n--- 2. After a finished turn ---');
ok('nothing is remembered as "queued"', bridge._lastQueuedTts === '', JSON.stringify(bridge._lastQueuedTts));
ok('nothing is waiting to be sent', bridge.pendingTTS.length === 0, JSON.stringify(bridge.pendingTTS));
ok('the speaking watchdog is back to its base allowance', agentStateMachine.speakingWatchdogMs() <= 12_000, `${agentStateMachine.speakingWatchdogMs()} ms`);

// ── 3. No tts.py connected ───────────────────────────────────────────────────
console.log('\n--- 3. No tts.py connected ---');
tts.close();
await sleep(300);
const endsBefore = speakingEnds;
orchestrator.speak('Your download has finished, sir.');
ms = await untilIdle(3_000);
ok('the turn closes at once, not at the speaking watchdog', agentStateMachine.currentState === AgentState.IDLE && ms < 1_500, `${agentStateMachine.currentState} after ${ms} ms`);
ok('speaking:end is emitted (jarvis.ts resumes the wake word on it)', speakingEnds > endsBefore, `${speakingEnds - endsBefore}`);
ok('speech is reported as not connected, not played', nodeBridge.lastSpeechOutcome?.outcome === 'not_connected', JSON.stringify(nodeBridge.lastSpeechOutcome));
ok('the reply is kept for when tts.py connects', bridge.pendingTTS.includes('Your download has finished, sir.'), JSON.stringify(bridge.pendingTTS));
tts = await connectTtsStandIn(PORT, TOKEN, 150);
await sleep(400);
ok('…and spoken then', tts.received.includes('Your download has finished, sir.'), JSON.stringify(tts.received));
await untilIdle(3_000);

// ── 4. The connection drops mid-reply ────────────────────────────────────────
console.log('\n--- 4. tts.py\'s connection drops mid-reply ---');
tts.respond = false;
orchestrator.speak('Searching the web, sir.');
await sleep(200);
ok('(setup) tts.py got the reply', tts.received.includes('Searching the web, sir.'));
tts.close();
ms = await untilIdle(3_000);
ok('the turn closes when the connection drops', agentStateMachine.currentState === AgentState.IDLE && ms < 1_500, `${agentStateMachine.currentState} after ${ms} ms`);
ok('speech is reported as not connected', nodeBridge.lastSpeechOutcome?.outcome === 'not_connected', JSON.stringify(nodeBridge.lastSpeechOutcome));

nodeBridge.stop();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
