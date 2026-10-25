/**
 * tests/voiceRouteMockTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The voice route from the bridge to the deterministic route, with stand-in
 * Python clients and no hardware:
 *
 *   1. stand-in wakeword, tts and stt clients connect to the real bridge (free
 *      local ports, a test token) and register with client_ready
 *   2. sendListenStart() sends listen_start to the ready STT client
 *   3. the wake-word client sends stt_result: the bridge delivers it to the
 *      stt_result handlers (an empty one too, without counting it as a
 *      transcript)
 *   4. orchestrator.process(<delivered text>, 'voice') takes the deterministic
 *      route:
 *        [Orchestrator] ⚡ Deterministic command route: type="open_app" target="youtube"
 *
 * Not covered: jarvis.ts's own stt_result handler (mic release, echo and
 * fragment filters, busy arbitration). jarvis.ts exports nothing, so step 4
 * calls the orchestrator itself.
 *
 * open_app is a dry run. The test fails if the route runs any registered
 * tool but open_app (through the registry or by calling the tool directly),
 * or if a browser or URL opener is started during the test through the
 * main thread's child_process functions (TEST-05, TEST-06). Not seen: a
 * worker thread, the ChildProcess class used directly, a native addon, and a
 * tool's execute captured before the test wraps it.
 */

import { createRequire, syncBuiltinESMExports } from 'module';
import * as net from 'net';
import { promisify } from 'util';

// Child processes, recorded (not replaced) before JARVIS's modules load.
const childProcess = createRequire(import.meta.url)('child_process');
const launches: string[] = [];
let nested = 0;   // exec calls execFile, execFile calls spawn: record the outer call once
function recordCall(real: (...a: unknown[]) => unknown, self: unknown, args: unknown[]) {
  if (nested === 0) launches.push([args[0], ...(Array.isArray(args[1]) ? args[1] : [])].map(String).join(' '));
  nested++;
  try { return real.apply(self, args); } finally { nested--; }
}
for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const real = childProcess[fn];
  const recorded: any = function (this: unknown, ...args: unknown[]) { return recordCall(real, this, args); };
  // exec and execFile have their own promisified form; keep it, recorded.
  const realPromisified = real[promisify.custom];
  if (realPromisified) recorded[promisify.custom] = function (this: unknown, ...args: unknown[]) { return recordCall(realPromisified, this, args); };
  childProcess[fn] = recorded;
}
syncBuiltinESMExports();

/** Programs that open a browser or a URL: openers, shell built-ins, browsers. */
const OPENERS = new Set(['start', 'start-process', 'rundll32', 'xdg-open', 'open', 'gnome-open', 'kde-open', 'sensible-browser', 'x-www-browser', 'wslview',
  'explorer', 'chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'msedge', 'microsoft-edge', 'microsoft-edge-stable',
  'firefox', 'firefox-esr', 'iexplore', 'brave', 'brave-browser', 'opera', 'safari']);
/** An opener named anywhere in the command line (also inside `sh -c "…"` or `cmd /c …`), or anything naming YouTube. */
function isBrowserLaunch(cmd: string): boolean {
  if (/youtube/i.test(cmd)) return true;
  return cmd.split(/[\s()]+/).some((word) => {
    let w = word.replace(/^["']+|["',;]+$/g, '').toLowerCase();
    // C:\…\msedge.exe, /usr/bin/xdg-open, ./node_modules/open/xdg-open (not C:\start, a folder argument)
    if (w.endsWith('.exe') || w.includes('/')) w = w.replace(/\.exe$/, '').split(/[\\/]/).pop() ?? w;
    return OPENERS.has(w);
  });
}

const freePort = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const TOKEN = 'test-bridge-token-voice-route-0123456789';
// Set before the bridge loads; .env does not override them (the owner's PC).
process.env['BRIDGE_HOST'] = '127.0.0.1';
const bridgePort = await freePort();
let healthPort = await freePort();
while (healthPort === bridgePort) healthPort = await freePort();
process.env['BRIDGE_PORT'] = String(bridgePort);
process.env['HEALTH_PORT'] = String(healthPort);
process.env['JARVIS_BRIDGE_TOKEN'] = TOKEN;
process.env['JARVIS_BRIDGE_DEV_MODE'] = 'false';

const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { orchestrator } = await import('../core/orchestrator.js');
const { agentStateMachine, AgentState } = await import('../core/agentStateMachine.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { healthLedger, LEDGER_PIPELINES } = await import('../monitoring/healthLedger.js');
const WebSocket = (await import('ws')).default;

// Every registered tool, recorded when it runs: through toolRegistryV2.execute
// or called directly (toolRegistryV2.get(name).execute). The skill tools
// (open_app among them) register while the orchestrator loads them: wait for
// that first, with the same bounded wait process() uses.
await (orchestrator as any).waitForSkills();
const toolsRun: string[] = [];
let recordTools = false;
const WATCHED = Symbol('watched');
for (const tool of new Set(toolRegistryV2.getAll())) {
  const real = tool.execute.bind(tool);
  const watched: any = (args: Record<string, unknown>, signal?: AbortSignal) => { if (recordTools) toolsRun.push(tool.name); return real(args, signal); };
  watched[WATCHED] = true;
  (tool as any).execute = watched;
}

let passed = 0;
let failed = 0;
const log: string[] = [];

// Capture all console output
const origLog   = console.log.bind(console);
const origWarn  = console.warn.bind(console);
const origError = console.error.bind(console);

function capture(...args: any[]) {
  const line = args.map(String).join(' ');
  log.push(line);
  origLog(...args);
}
console.log   = capture;
console.warn  = (...args) => { log.push(args.map(String).join(' ')); origWarn(...args); };
console.error = (...args) => { log.push(args.map(String).join(' ')); origError(...args); };

function assert(condition: boolean, label: string) {
  if (condition) {
    origLog(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    origLog(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function logContains(fragment: string): boolean {
  return log.some(line => line.includes(fragment));
}

/** Waits until `cond` holds, at most `ms`; a miss fails the check that follows. */
async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

const PORT = Number(process.env['BRIDGE_PORT']);

/** A stand-in Python client: connects, answers the handshake with client_ready, records what it receives. */
async function connectRole(role: string) {
  const received: { type: string }[] = [];
  const end = Date.now() + 5_000;
  for (;;) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      received.push(msg);
      if (msg.type === 'status' && msg.payload?.status === 'connected') {
        ws.send(JSON.stringify({ type: 'client_ready', payload: { role, token: TOKEN } }));
      }
    });
    const opened = await new Promise<boolean>((resolve) => { ws.once('open', () => resolve(true)); ws.once('error', () => resolve(false)); });
    if (opened) return { ws, received };
    if (Date.now() > end) throw new Error(`could not connect ${role} to the bridge on port ${PORT}`);
    await new Promise((r) => setTimeout(r, 50));   // the server is still binding
  }
}

async function runTests() {
  origLog('\n=== Voice Route Mock Test ===\n');

  const delivered: unknown[] = [];
  nodeBridge.on('stt_result', (msg: any) => { delivered.push(msg.payload?.text); });
  nodeBridge.start();

  // ── Setup: stand-in clients register through client_ready ────────────────
  origLog('--- Registering stand-in clients ---');
  const wakeword = await connectRole('wakeword');
  const tts      = await connectRole('tts');
  const stt      = await connectRole('stt');
  await waitFor(() => ['wakeword', 'tts', 'stt'].every((r) => nodeBridge.getReadyClients().includes(r)));

  const roles = nodeBridge.getReadyClients();
  assert(roles.includes('wakeword'), 'wakeword registered');
  assert(roles.includes('tts'),      'tts registered');
  assert(roles.includes('stt'),      'stt registered');

  // ── Test: wake_word has_command=false → listen_start ─────────────────────
  origLog('\n--- Test: wake_word has_command=false ---');
  stt.received.length = 0;
  const listenSent = nodeBridge.sendListenStart();
  await waitFor(() => stt.received.some((m) => m.type === 'listen_start'));
  assert(listenSent && stt.received.some((m) => m.type === 'listen_start'), 'sendListenStart sent listen_start to the ready STT client');

  // ── Test: stt_result through the bridge ───────────────────────────────────
  origLog('\n--- Test: stt_result through the bridge ---');
  const sttState = () => healthLedger.status(LEDGER_PIPELINES.stt, nodeBridge.getReadyClients()).state;
  wakeword.ws.send(JSON.stringify({ type: 'stt_result', payload: { text: '' } }));
  await waitFor(() => delivered.length === 1);
  assert(delivered.length === 1 && delivered[0] === '' && sttState() !== 'healthy',
    'an empty stt_result reaches the handlers but is not counted as a transcript');

  wakeword.ws.send(JSON.stringify({ type: 'stt_result', payload: { text: 'open YouTube for me' } }));
  await waitFor(() => delivered.length === 2);
  assert(delivered.length === 2 && delivered[1] === 'open YouTube for me', 'the bridge delivered "open YouTube for me" to the stt_result handlers');
  assert(sttState() === 'healthy', '…and recorded a transcript');
  const engineFromWakeword = nodeBridge.lastTranscriptEngine;
  stt.ws.send(JSON.stringify({ type: 'stt_result', payload: { text: 'what time is it' } }));
  await waitFor(() => delivered.length === 3);
  assert(engineFromWakeword === 'Google STT' && delivered[2] === 'what time is it' && nodeBridge.lastTranscriptEngine === 'Whisper',
    `…and took the engine from the sender (wakeword: ${engineFromWakeword}, stt: ${nodeBridge.lastTranscriptEngine})`);

  // ── Test: deterministic route for the delivered text ─────────────────────
  // open_app is a dry run: the route, risk engine and skill run for real, but
  // the skill stops before launching the browser (this test used to open
  // YouTube twice on every run).
  origLog('\n--- Test: deterministic route for "open YouTube for me" ---');
  origLog('(jarvis.ts\'s stt_result handler is not part of this test: the delivered text goes to orchestrator.process directly)');
  const openAppResults: { target: unknown; success: boolean; output: string }[] = [];
  const originalExecute = toolRegistryV2.execute.bind(toolRegistryV2);
  (toolRegistryV2 as any).execute = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    if (name !== 'open_app') return originalExecute(name, args, signal);
    const result = await originalExecute(name, { ...args, dryRun: true }, signal);
    openAppResults.push({ target: args['target'], success: result.success, output: String(result.output) });
    return result;
  };

  try {
    (agentStateMachine as any)._state = AgentState.IDLE;
  } catch {}
  log.length = 0;

  recordTools = true;
  await orchestrator.process(String(delivered[1]), 'voice');
  recordTools = false;
  (toolRegistryV2 as any).execute = originalExecute;

  assert(
    logContains('Deterministic command route: type="open_app" target="youtube"'),
    'Deterministic pre-router chose open_app for "youtube"'
  );
  assert(
    openAppResults.length === 1 && openAppResults[0].target === 'youtube' && openAppResults[0].success
      && openAppResults[0].output.includes('https://www.youtube.com'),
    'open_app ran once for "youtube" (https://www.youtube.com)'
  );
  assert(
    openAppResults.length > 0 && openAppResults.every((r) => /"dryRun":\s*true/.test(r.output)),
    'open_app was a dry run (no browser launched)'
  );
  const unwatched = toolRegistryV2.getAll().filter((t) => !(t.execute as any)[WATCHED]).map((t) => t.name);
  assert(toolsRun.join(',') === 'open_app' && unwatched.length === 0,
    `the route ran no tool but open_app (ran: ${toolsRun.join(', ') || 'none'}${unwatched.length ? `; not watched: ${unwatched.join(', ')}` : ''})`);

  for (const c of [wakeword, tts, stt]) c.ws.close();
  nodeBridge.stop();

  // Checked over the whole test, not only the route: a launch while the
  // bridge handles stt_result counts too.
  const browserLaunches = launches.filter(isBrowserLaunch);
  assert(browserLaunches.length === 0, `no browser or opener process was started during the test${browserLaunches.length ? ` (started: ${browserLaunches.join(' | ')})` : ''}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  origLog(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    origLog('❌ Some voice route tests FAILED.');
    process.exit(1);
  } else {
    origLog('✅ All voice route mock tests PASSED.');
    process.exit(0);
  }
}

runTests().catch(err => {
  origLog('[VoiceRouteMockTest] Unexpected error:', err);
  process.exit(1);
});
