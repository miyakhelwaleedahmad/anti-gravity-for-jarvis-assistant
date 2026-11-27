/**
 * tests/speechRequestCorrelationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE-005 (the rest of it): each outcome belongs to the reply it is about.
 *
 * The bridge recorded whatever outcome the next speaking_end carried, for
 * whatever was being said: a late or repeated speaking_end from an earlier
 * reply could mark a newer one as played, and close the speaking turn while
 * the newer reply was still waiting. A reply stopped by the speaking watchdog
 * or by the user left no outcome at all.
 *
 * Now every tts message carries an id, tts.py lists the ids a speaking_end
 * covers, and the bridge:
 *   - ignores a speaking_end whose ids are not in flight (stale or repeated);
 *   - keeps the turn open while a newer reply in flight is not covered;
 *   - records timed_out (speaking watchdog) as a failure and cancelled (stop)
 *     as neither success nor failure;
 *   - keeps the engine tts.py names (edge-tts or a fallback voice);
 *   - shows TTS as degraded only for failures, and online again after a
 *     reply plays.
 * Real bridge and WebSocket; the tts.py stand-in from tests/ttsBridgeClient.ts.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-speech-ids-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
const freePort = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const TOKEN = 'test-bridge-token-speech-ids-0123456789';
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.env['BRIDGE_PORT'] = String(await freePort());
process.env['HEALTH_PORT'] = String(await freePort());
process.env['JARVIS_BRIDGE_TOKEN'] = TOKEN;

const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { agentStateMachine, AgentState } = await import('../core/agentStateMachine.js');
const { conversationBus } = await import('../core/conversationBus.js');
const { connectTtsStandIn } = await import('./ttsBridgeClient.js');
const { healthManager } = await import('../monitoring/healthManager.js');
conversationBus.on('idle', () => { if (!agentStateMachine.is(AgentState.IDLE)) agentStateMachine.transition(AgentState.IDLE); });

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const outcome = () => nodeBridge.lastSpeechOutcome as ({ outcome: string; engine?: string } | null);
const ttsHealth = async () => (await healthManager.probe()).services['tts'] as { status: string; detail: string } | undefined;
const end = (payload: Record<string, unknown>) => tts.send({ type: 'speaking_end', payload: { reason: 'queue_empty', ...payload } });

nodeBridge.start();
await sleep(300);
const tts = await connectTtsStandIn(Number(process.env['BRIDGE_PORT']), TOKEN, 100);
tts.respond = false;   // this test writes tts.py's answers itself
console.log('\n=== Each speech outcome belongs to its reply (VOICE-005) ===\n');

// ── Ids ──────────────────────────────────────────────────────────────────────
orchestrator.speak('Opening Chrome, sir.');
await sleep(150);
const idA = tts.payloads[0]?.id;
ok('each tts message carries an id', typeof idA === 'string' && idA.length > 0, JSON.stringify(tts.payloads[0]));
ok('sending it is not counted as played', outcome() === null, JSON.stringify(outcome()));

console.log('\n--- A stale speaking_end ---');
end({ ids: ['tts-from-an-earlier-run'], outcome: 'played', engine: 'edge-tts' });
await sleep(150);
ok('is not recorded as this reply\'s outcome', outcome() === null, JSON.stringify(outcome()));
ok('and does not close the turn', agentStateMachine.currentState === AgentState.SPEAKING, agentStateMachine.currentState);

console.log('\n--- Two replies in flight ---');
nodeBridge.speakToClients('The download is at 40 percent, sir.');
await sleep(150);
const idB = tts.payloads[1]?.id;
ok('(setup) the second reply has its own id', typeof idB === 'string' && idB !== idA, `${idA} / ${idB}`);
end({ ids: [idA], outcome: 'played', engine: 'edge-tts' });
await sleep(150);
ok('the first reply\'s end records its outcome and engine', outcome()?.outcome === 'played' && outcome()?.engine === 'edge-tts', JSON.stringify(outcome()));
ok('…but does not close the turn the second is still waiting on', agentStateMachine.currentState === AgentState.SPEAKING, agentStateMachine.currentState);
end({ ids: [idA], outcome: 'played', engine: 'edge-tts' });
end({ ids: [idB], outcome: 'synthesis_failed', detail: 'edge-tts gave no audio' });
await sleep(200);
ok('a repeated end for the first is ignored; the second\'s failure is recorded', outcome()?.outcome === 'synthesis_failed', JSON.stringify(outcome()));
ok('the turn closes when the last reply in flight ends', agentStateMachine.currentState === AgentState.IDLE, agentStateMachine.currentState);
let h = await ttsHealth();
ok('the dashboard shows TTS degraded', h?.status === 'degraded', JSON.stringify(h));

console.log('\n--- Recovery ---');
orchestrator.speak('Done, sir.');
await sleep(150);
end({ ids: [tts.payloads[2]?.id], outcome: 'played', engine: 'windows-sapi' });
await sleep(200);
h = await ttsHealth();
ok('a reply that plays makes TTS online again', h?.status === 'online', JSON.stringify(h));
ok('…and the fallback voice is named', outcome()?.engine === 'windows-sapi', JSON.stringify(outcome()));

console.log('\n--- Stopped replies ---');
orchestrator.speak('Here is a long answer, sir.');
await sleep(150);
nodeBridge.sendToRole('tts', { type: 'command', payload: { action: 'stop' } });
await sleep(100);
ok('a reply the user stopped is recorded as cancelled', outcome()?.outcome === 'cancelled', JSON.stringify(outcome()));
h = await ttsHealth();
ok('…which is not a TTS failure', h?.status === 'online', JSON.stringify(h));
agentStateMachine.reset();

orchestrator.speak('Another long answer, sir.');
await sleep(150);
agentStateMachine.emit('watchdog_reset', { fromState: AgentState.SPEAKING, reason: 'speaking_timeout' });
await sleep(100);
ok('a reply the speaking watchdog stopped is recorded as timed_out', outcome()?.outcome === 'timed_out', JSON.stringify(outcome()));
h = await ttsHealth();
ok('…which is a TTS failure', h?.status === 'degraded', JSON.stringify(h));

nodeBridge.stop();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
