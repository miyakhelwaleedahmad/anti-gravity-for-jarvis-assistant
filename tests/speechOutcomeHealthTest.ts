/**
 * tests/speechOutcomeHealthTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE-005: speech health follows what tts.py actually did with the reply.
 *
 * The bridge recorded "speech output" healthy when it sent the text over the
 * WebSocket, and the dashboard showed TTS "online — connected via bridge".
 * A reply that tts.py could not synthesise or play changed nothing: JARVIS
 * was mute while everything said speech worked.
 *
 * Now tts.py puts an outcome on speaking_end (played, synthesis_failed,
 * no_audio_device, interrupted); the bridge records success or failure from
 * it, and from hardware_error, and the dashboard says why.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-speech-health-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
const freePort = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const TOKEN = 'test-bridge-token-health-0123456789';
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.env['BRIDGE_PORT'] = String(await freePort());
process.env['HEALTH_PORT'] = String(await freePort());
process.env['JARVIS_BRIDGE_TOKEN'] = TOKEN;

const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { pipelineRegistry } = await import('../self_healing/pipelineRegistry.js');
const { healthManager } = await import('../monitoring/healthManager.js');
const { connectTtsStandIn } = await import('./ttsBridgeClient.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const speech = () => pipelineRegistry.getPipeline('brain_to_tts');
const ttsOnDashboard = async () => (await healthManager.probe()).services['tts']!;

nodeBridge.start();
await sleep(300);
const tts = await connectTtsStandIn(Number(process.env['BRIDGE_PORT']), TOKEN);

console.log('\n=== Speech health follows the reply\'s outcome (VOICE-005) ===\n');
tts.outcome = 'synthesis_failed';
nodeBridge.speakToClients('First reply, sir.');
await sleep(500);
ok('a reply tts.py could not synthesise is recorded as a speech failure', speech().failureCount === 1, `failures ${speech().failureCount}, last success ${speech().lastSuccess}`);
let dash = await ttsOnDashboard();
ok('…and the dashboard does not say TTS is online', dash.status !== 'online', `${dash.status}: ${dash.detail}`);
ok('…it says why', /synthesis/i.test(String(dash.detail)), String(dash.detail));

tts.outcome = 'played';
nodeBridge.speakToClients('Second reply, sir.');
await sleep(500);
ok('a reply that played is recorded as success', speech().failureCount === 0 && speech().lastSuccess > 0, `failures ${speech().failureCount}`);
dash = await ttsOnDashboard();
ok('…and the dashboard shows TTS online again', dash.status === 'online', `${dash.status}: ${dash.detail}`);

tts.send({ type: 'hardware_error', payload: { device: 'tts', error: 'WASAPI: no output device' } });
await sleep(300);
ok('a hardware_error from tts.py is recorded as a speech failure', speech().failureCount === 1, `failures ${speech().failureCount}`);
dash = await ttsOnDashboard();
ok('…and the dashboard names the audio device', dash.status !== 'online' && /device/i.test(String(dash.detail)), `${dash.status}: ${dash.detail}`);

tts.close();
nodeBridge.stop();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
