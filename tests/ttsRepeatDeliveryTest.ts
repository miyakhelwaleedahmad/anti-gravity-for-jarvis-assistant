/**
 * tests/ttsRepeatDeliveryTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE-001: the same reply, asked for twice, must be spoken twice.
 *
 * NodeBridge.speakToClients() dropped any phrase equal to the last phrase it
 * had ever queued, and never forgot it. Asking "open Chrome" twice: the second
 * "Opening Chrome, sir." never reached tts.py, and because speak() had already
 * moved the state machine to SPEAKING, JARVIS then waited for the 12 s
 * watchdog, deaf, with nothing playing.
 *
 * Real NodeBridge, real WebSocket client standing in for tts.py (it answers
 * speaking_start / speaking_end), real orchestrator.speak().
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tts-repeat-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
const freePort = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const TOKEN = 'test-bridge-token-repeat-0123456789';
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
// jarvis.ts's own wiring: when speech has ended and nothing else is going on, IDLE.
conversationBus.on('idle', () => { if (!agentStateMachine.is(AgentState.IDLE)) agentStateMachine.transition(AgentState.IDLE); });

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

nodeBridge.start();
await sleep(300);
const tts = await connectTtsStandIn(Number(process.env['BRIDGE_PORT']), TOKEN);

console.log('\n=== The same reply twice is spoken twice (VOICE-001) ===\n');
const REPLY = 'Opening Chrome, sir.';
orchestrator.speak(REPLY);
const first = await untilIdle(5_000);
ok('(setup) the first reply was spoken and JARVIS is idle again', tts.received.length === 1 && agentStateMachine.currentState === AgentState.IDLE, `${tts.received.length} sent, ${first} ms`);

await sleep(500);
orchestrator.speak(REPLY);
const second = await untilIdle(5_000);
ok('the same reply, a moment later, reaches the speech service again', tts.received.length === 2, `${tts.received.length} sent: ${JSON.stringify(tts.received)}`);
ok('…and JARVIS is idle again without waiting for the 12 s watchdog', agentStateMachine.currentState === AgentState.IDLE && second < 3_000, `${agentStateMachine.currentState} after ${second} ms`);

// The guard's own job: one phrase queued twice in the same instant is sent once.
await sleep(300);
nodeBridge.speakToClients('Checking, sir.');
nodeBridge.speakToClients('Checking, sir.');
await sleep(400);
ok('the same phrase queued twice at once is still sent once', tts.received.filter((t) => t === 'Checking, sir.').length === 1, JSON.stringify(tts.received));

tts.close();
nodeBridge.stop?.();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
