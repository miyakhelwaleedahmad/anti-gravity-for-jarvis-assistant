/**
 * tests/bridgeSecurityTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-01 / SEC-11: the real WebSocket bridge, started on free local ports, in
 * dev mode (no token) and in token mode, each in a child process of its own
 * (the bridge reads its mode once, at start):
 *
 *   - a connection with a browser Origin is refused in both modes, before any
 *     message: a web page cannot send stt_result (a command or an approval)
 *   - a client without Origin (the Python modules) works: dev mode without a
 *     token; token mode only with the right token
 *   - token mode refuses a missing, wrong, non-string or over-long token
 *   - an origin listed in JARVIS_BRIDGE_ALLOWED_ORIGINS is admitted, and still
 *     needs the token in token mode
 *   - a message over the payload limit closes the connection
 *   - /health gives each pipeline's status and nothing more
 */

import { spawn } from 'child_process';
import { createRequire } from 'module';
import * as net from 'net';
import { fileURLToPath } from 'url';

const mode = process.env['BRIDGE_TEST_MODE'];

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

if (!mode) {
  // Parent: one child per mode.
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const self = fileURLToPath(import.meta.url);
  let failedTotal = 0;
  for (const m of ['dev', 'token']) {
    const env = {
      ...process.env,
      BRIDGE_TEST_MODE: m,
      BRIDGE_PORT: String(await freePort()),
      HEALTH_PORT: String(await freePort()),
      JARVIS_BRIDGE_DEV_MODE: m === 'dev' ? 'true' : 'false',
      JARVIS_BRIDGE_TOKEN: m === 'token' ? 'test-bridge-token-0123456789' : '',
      JARVIS_BRIDGE_ALLOWED_ORIGINS: 'http://127.0.0.1:5555',
      JARVIS_BRIDGE_MAX_PAYLOAD_MB: '1',
    };
    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [tsx, self], { env, stdio: 'inherit' });
      child.on('close', (c) => resolve(c ?? 1));
    });
    if (code !== 0) failedTotal++;
  }
  console.log(`\n=== Results: ${failedTotal === 0 ? 'both modes passed' : `${failedTotal} mode(s) failed`} ===`);
  process.exit(failedTotal > 0 ? 1 : 0);
}

const { WebSocket } = await import('ws');
const { nodeBridge } = await import('../bridge/nodeBridge.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: [${mode}] ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: [${mode}] ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = Number(process.env['BRIDGE_PORT']);
const TOKEN = 'test-bridge-token-0123456789';

const delivered: string[] = [];
nodeBridge.on('stt_result', (msg: any) => { delivered.push(String(msg.payload?.text ?? '')); });
nodeBridge.start();
await sleep(300);

interface Outcome { opened: boolean; refused: boolean; closeCode?: number; error?: string }
/** Connects, says client_ready with `token`, sends an stt_result, and reports what happened. */
async function attempt(opts: { origin?: string; token?: unknown; text: string; payloadBytes?: number }): Promise<Outcome> {
  return new Promise((resolve) => {
    const out: Outcome = { opened: false, refused: false };
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, opts.origin ? { origin: opts.origin } : {});
    const done = () => { try { ws.terminate(); } catch { /* closed */ } resolve(out); };
    const timer = setTimeout(done, 1_500);
    ws.on('unexpected-response', (...args: unknown[]) => { out.refused = true; out.error = `HTTP ${(args[1] as { statusCode?: number })?.statusCode}`; clearTimeout(timer); done(); });
    ws.on('error', (e) => { out.error = e.message; });
    ws.on('close', (code) => { out.closeCode = code; clearTimeout(timer); setTimeout(() => resolve(out), 100); });
    ws.on('open', () => {
      out.opened = true;
      const payload: Record<string, unknown> = { role: 'stt' };
      if (opts.token !== undefined) payload['token'] = opts.token;
      ws.send(JSON.stringify({ type: 'client_ready', payload }));
      setTimeout(() => {
        const text = opts.payloadBytes ? opts.text + 'x'.repeat(opts.payloadBytes) : opts.text;
        try { ws.send(JSON.stringify({ type: 'stt_result', payload: { text } })); } catch { /* closed */ }
      }, 100);
    });
  });
}
const got = (text: string) => delivered.includes(text);

console.log(`\n=== Bridge security (${mode} mode) ===\n`);
try {
  let r = await attempt({ origin: 'https://evil.example', token: mode === 'token' ? TOKEN : undefined, text: 'evil approve' });
  ok('a web page (foreign Origin) is refused at the connection', r.refused && !r.opened, r.error ?? '');
  ok('…and its stt_result never arrives', !got('evil approve'));

  r = await attempt({ origin: 'null', text: 'null origin' });
  ok('Origin "null" (a sandboxed page or file) is refused too', r.refused && !got('null origin'), r.error ?? '');

  r = await attempt({ origin: 'http://127.0.0.1:5555', token: mode === 'token' ? TOKEN : undefined, text: 'allowed origin' });
  await sleep(150);
  ok('an origin listed in JARVIS_BRIDGE_ALLOWED_ORIGINS is admitted', r.opened && got('allowed origin'));

  if (mode === 'dev') {
    r = await attempt({ text: 'python dev' });
    await sleep(150);
    ok('dev mode: a local client without Origin works without a token', r.opened && got('python dev'));
  } else {
    r = await attempt({ origin: 'http://127.0.0.1:5555', text: 'allowed origin no token' });
    ok('token mode: an allowed origin still needs the token', r.closeCode === 1008 && !got('allowed origin no token'), String(r.closeCode));
    for (const [label, token] of [['missing', undefined], ['wrong', 'wrong-token'], ['non-string', 12345], ['over-long', 'x'.repeat(5_000)], ['right one with a suffix', TOKEN + 'x']] as const) {
      const text = `bad token ${label}`;
      r = await attempt({ token, text });
      ok(`token mode: a ${label} token is refused (1008), nothing delivered`, r.closeCode === 1008 && !got(text), String(r.closeCode));
    }
    r = await attempt({ token: TOKEN, text: 'python token' });
    await sleep(150);
    ok('token mode: a local client with the right token works', r.opened && got('python token'));
  }

  r = await attempt({ token: mode === 'token' ? TOKEN : undefined, text: 'too big ', payloadBytes: 2 * 1024 * 1024 });
  ok('a message over the payload limit (1 MB here) closes the connection (1009)', r.closeCode === 1009 && !delivered.some((t) => t.startsWith('too big')), String(r.closeCode));

  const health = await fetch(`http://127.0.0.1:${process.env['HEALTH_PORT']}/health`).then((res) => res.json()).catch(() => null) as Record<string, unknown> | null;
  ok('/health answers with each pipeline\'s status only', !!health && Object.values(health).every((v) => typeof v === 'string'), JSON.stringify(health).slice(0, 120));
} finally {
  console.log(`\n=== [${mode}] Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}
