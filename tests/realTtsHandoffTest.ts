/**
 * tests/realTtsHandoffTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE-007 / TEST-102: a reply goes from JARVIS through the real bridge to
 * the real voice/tts.py, and tts.py's lifecycle comes back.
 *
 * Every other voice test talks to a stand-in for tts.py (tests/fakeTts.ts,
 * tests/ttsBridgeClient.ts), so a change on the Python side — the handshake,
 * the message format, the lifecycle events, the speaking_end outcome — could
 * break speech with every test still green.
 *
 * Here tts.py itself runs as a child process, with pygame on SDL's silent
 * "dummy" audio driver. Only edge-tts (Microsoft's online service) is replaced,
 * by a stand-in module that writes a short WAV and records the text it was
 * given, so the test needs no network or speaker. Checked:
 *   - tts.py connects and authenticates with the bridge token;
 *   - orchestrator.speak() reaches it with the exact text;
 *   - it reports speaking_start, then speaking_end with outcome "played";
 *   - JARVIS returns to IDLE and records speech as healthy;
 *   - the same reply a second time is spoken again (VOICE-001, end to end);
 *   - audio that cannot be played is reported as playback_failed. Before,
 *     tts.py ended that turn with no outcome and speech still looked healthy:
 *     a gap in VOICE-005 that only the real tts.py showed.
 *
 * Needs a Python with pygame and websockets: JARVIS_TEST_PYTHON, else JARVIS's
 * .venv. Without one: BLOCKED (exit 3), with the reason.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function blocked(reason: string): never {
  console.log(`BLOCKED: ${reason}`);
  process.exit(3);
}

// ── A Python that can run tts.py ─────────────────────────────────────────────
const venvPython = process.platform === 'win32'
  ? path.join(repo, '.venv', 'Scripts', 'python.exe')
  : path.join(repo, '.venv', 'bin', 'python');
const python = process.env['JARVIS_TEST_PYTHON'] || (fs.existsSync(venvPython) ? venvPython : '');
if (!python) blocked('needs a Python with pygame and websockets: JARVIS\'s .venv, or set JARVIS_TEST_PYTHON.');
const probe = spawnSync(python, ['-c', 'import pygame, websockets'], { encoding: 'utf8', timeout: 60_000 });
if (probe.status !== 0) blocked(`${python} cannot import pygame and websockets: ${(probe.stderr || probe.error?.message || '').trim().split('\n').slice(-1)[0]}`);

// ── A workspace, ports, the bridge token ─────────────────────────────────────
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-real-tts-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
const freePort = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const TOKEN = 'test-bridge-token-real-tts-0123456789';
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.env['BRIDGE_PORT'] = String(await freePort());
process.env['HEALTH_PORT'] = String(await freePort());
process.env['JARVIS_BRIDGE_TOKEN'] = TOKEN;

// The stand-in for edge-tts: 0.8 s of silent MP3 frames (MPEG-1 Layer III,
// 128 kbps, 44.1 kHz; pygame picks its decoder from the .mp3 name, so a WAV
// would not play), and a record of each text.
const stub = path.join(root, 'stub');
const spoken = path.join(root, 'spoken.txt');
fs.mkdirSync(stub);
fs.writeFileSync(path.join(stub, 'edge_tts.py'), `
__version__ = "stand-in"
SILENT_FRAME = bytes([0xFF, 0xFB, 0x90, 0x00]) + bytes(413)
class Communicate:
    def __init__(self, text, voice=None, rate=None, pitch=None, **kw):
        self.text = text
    async def save(self, path):
        with open(${JSON.stringify(spoken)}, "a", encoding="utf-8") as f:
            f.write(self.text + "\\n")
        with open(path, "wb") as f:
            f.write(b"not audio" if "BROKEN" in self.text else SILENT_FRAME * 30)
`);

const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { agentStateMachine, AgentState } = await import('../core/agentStateMachine.js');
const { conversationBus } = await import('../core/conversationBus.js');
const { childEnv } = await import('../system/childEnv.js');
conversationBus.on('idle', () => { if (!agentStateMachine.is(AgentState.IDLE)) agentStateMachine.transition(AgentState.IDLE); });

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, limitMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < limitMs) await sleep(25);
  return cond();
}

const events: { type: string; payload: any }[] = [];
nodeBridge.onBridgeEvent('speaking_start', (p: any) => events.push({ type: 'speaking_start', payload: p }));
nodeBridge.onBridgeEvent('speaking_end', (p: any) => events.push({ type: 'speaking_end', payload: p }));
nodeBridge.start();
await sleep(300);

// ── The real tts.py ──────────────────────────────────────────────────────────
let ttsLog = '';
const tts = spawn(python, [path.join(repo, 'voice', 'tts.py')], {
  cwd: repo,
  env: childEnv({
    BRIDGE_WS_URI: `ws://127.0.0.1:${process.env['BRIDGE_PORT']}`,
    JARVIS_BRIDGE_TOKEN: TOKEN,
    SDL_AUDIODRIVER: 'dummy',
    PYTHONPATH: stub,
    PYTHONUNBUFFERED: '1',
    JARVIS_TTS_FALLBACK: 'off',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
tts.stdout?.on('data', (d) => { ttsLog += d.toString(); });
tts.stderr?.on('data', (d) => { ttsLog += d.toString(); });
const lastLines = () => ttsLog.trim().split('\n').slice(-6).join(' | ').slice(0, 600);

console.log('\n=== The real tts.py behind the real bridge (VOICE-007 / TEST-102) ===\n');
const ready = await until(() => nodeBridge.isRoleReady('tts'), 30_000);
ok('tts.py connects and authenticates', ready, ready ? '' : lastLines());

if (ready) {
  const REPLY = 'Opening Chrome, sir.';
  for (const round of [1, 2]) {
    events.length = 0;
    orchestrator.speak(REPLY);
    const ended = await until(() => events.some((e) => e.type === 'speaking_end'), 20_000);
    const said = fs.existsSync(spoken) ? fs.readFileSync(spoken, 'utf8').trim().split('\n') : [];
    const end = events.find((e) => e.type === 'speaking_end')?.payload ?? {};
    const startIdx = events.findIndex((e) => e.type === 'speaking_start');
    const endIdx = events.findIndex((e) => e.type === 'speaking_end');
    const label = round === 1 ? '' : ' (the same reply again)';
    ok(`tts.py was given the exact text${label}`, said.length === round && said[round - 1] === REPLY, JSON.stringify(said));
    ok(`it reported speaking_start, then speaking_end${label}`, ended && startIdx >= 0 && startIdx < endIdx, events.map((e) => e.type).join(' → ') || lastLines());
    ok(`speaking_end says the reply was played${label}`, end.outcome === 'played', JSON.stringify(end));
    ok(`…by edge-tts, for this reply's id${label}`, end.engine === 'edge-tts' && Array.isArray(end.ids) && end.ids.length === 1 && !nodeBridge.speechInFlight, JSON.stringify(end));
    const idle = await until(() => agentStateMachine.currentState === AgentState.IDLE, 5_000);
    ok(`JARVIS is IDLE again${label}`, idle, agentStateMachine.currentState);
  }
  ok('speech is recorded as healthy', nodeBridge.lastSpeechOutcome?.outcome === 'played', JSON.stringify(nodeBridge.lastSpeechOutcome));

  // Audio that cannot be played: before, the turn ended with no outcome and
  // speech still looked healthy (this test found it).
  events.length = 0;
  orchestrator.speak('BROKEN audio, sir.');
  await until(() => events.some((e) => e.type === 'speaking_end'), 20_000);
  const end = events.find((e) => e.type === 'speaking_end')?.payload ?? {};
  ok('audio that cannot be played ends with outcome playback_failed', end.outcome === 'playback_failed', JSON.stringify(end));
  ok('…and speech is recorded as failing', nodeBridge.lastSpeechOutcome?.outcome === 'playback_failed', JSON.stringify(nodeBridge.lastSpeechOutcome));
  ok('JARVIS is IDLE again after the failure', await until(() => agentStateMachine.currentState === AgentState.IDLE, 5_000), agentStateMachine.currentState);
}

if (process.env["JARVIS_TEST_SHOW_TTS_LOG"]) console.log(ttsLog);
tts.kill();
nodeBridge.stop();
await sleep(200);
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
