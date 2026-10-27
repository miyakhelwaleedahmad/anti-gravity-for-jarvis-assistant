/**
 * tests/jarvisChromeTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS's own Chrome (audit 2026-10-25, TRA-03, TRA-16, TRA-17; owner
 * decisions D1 and D3; run ai_workflows/runs/2026-10-27_jarvis-owned-chrome).
 *
 *  1. TRA-16: the start instructions fit the platform JARVIS runs on.
 *  2. Where JARVIS finds its Chrome: JARVIS_CDP_PORT, else the port its own
 *     profile's DevToolsActivePort names (Chrome writes it for
 *     --remote-debugging-port=0), else 9222.
 *  3. JARVIS starts its Chrome when it needs one, once, and says why when it
 *     cannot (not found, no answer, profile in use, automatic start off).
 *  4. TRA-03: pages JARVIS opens go to that Chrome; nothing falls back to the
 *     default browser (the everyday Chrome); "open chrome" brings JARVIS's
 *     Chrome forward (owner, Q1).
 *  5. TRA-17 + D3: "close the browser" closes JARVIS's Chrome only, after a
 *     question asked every time; a refusal is not retried.
 *  6. The checks, routes, planner offers and catalog level that go with it.
 *  7. A real headless Chromium, when one is found: start, open, close.
 *
 * Chrome is a fake DevTools server (HTTP and the browser WebSocket) started by
 * a fake launcher. Any browser or URL opener started through child_process is
 * recorded and not run, so a failing test never opens a page on the PC.
 */

import { createRequire, syncBuiltinESMExports } from 'module';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

// ── Openers: recorded and replaced before JARVIS's modules load ──────────────
const childProcess = createRequire(import.meta.url)('child_process');
const realSpawn = childProcess.spawn;
const OPENERS = new Set(['start', 'xdg-open', 'open', 'explorer', 'chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'msedge', 'firefox']);
const openers: string[] = [];
/** The program, or a `start` or web address among its arguments (cmd /c start "" https://…). */
function isOpener(args: unknown[]): boolean {
  const program = String(args[0] ?? '').split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase();
  const rest = Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [];
  return OPENERS.has(program) || rest.some((a) => a.toLowerCase() === 'start' || /^https?:\/\//i.test(a));
}
for (const fn of ['spawn', 'execFile', 'exec']) {
  const real = childProcess[fn];
  childProcess[fn] = function (this: unknown, ...args: unknown[]) {
    if (isOpener(args)) {
      openers.push([args[0], ...(Array.isArray(args[1]) ? args[1] : [])].map(String).join(' '));
      const fake: any = new EventEmitter();
      fake.unref = () => fake; fake.kill = () => true; fake.pid = 0;
      const callback = args.find((a) => typeof a === 'function') as ((e: null, out: string, err: string) => void) | undefined;
      setImmediate(() => { fake.emit('exit', 0); callback?.(null, '', ''); });
      return fake;
    }
    return real.apply(this, args);
  };
}
syncBuiltinESMExports();

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-own-chrome-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
delete process.env['JARVIS_CDP_PORT'];
process.env['JARVIS_CHROME_PROFILE'] = path.join(workspace, 'no-chrome-profile');
process.env['JARVIS_CHROME_AUTOSTART'] = 'off';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
async function error(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ''; } catch (err) { return err instanceof Error ? err.message : String(err); }
}
/** A module of this change; on the old code it does not exist and its checks fail. */
async function load<T>(spec: string): Promise<T | undefined> {
  try { return (await import(spec)) as T; } catch (err) { console.error(`  (cannot load ${spec}: ${(err as Error).message.split('\n')[0]})`); return undefined; }
}

const freePort = async (): Promise<number> => {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
};
const answers = (port: number) => fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok).catch(() => false);

// ── A fake Chrome: DevTools HTTP endpoints and the browser WebSocket ────────
interface FakePage { id: string; type: 'page'; title: string; url: string; webSocketDebuggerUrl: string }
interface FakeChrome {
  port: number; socketPath: string; pages: FakePage[]; activated: string[]; closeRequests: number;
  /** Browser.close is answered but the browser stays up. */
  ignoreClose: boolean;
  stop(): Promise<void>;
}
const { WebSocketServer } = await import('ws');

async function fakeChrome(port = 0, titles: string[] = ['New Tab']): Promise<FakeChrome> {
  const id = randomUUID();
  const chrome: FakeChrome = {
    port: 0, socketPath: `/devtools/browser/${id}`, pages: [], activated: [], closeRequests: 0, ignoreClose: false,
    stop: async () => undefined,
  };
  const page = (url: string, title: string): FakePage => {
    const pid = randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
    return { id: pid, type: 'page', title, url, webSocketDebuggerUrl: `ws://127.0.0.1:${chrome.port}/devtools/page/${pid}` };
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const json = (body: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (u.pathname === '/json/version') return json({ Browser: 'FakeChrome/1', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${chrome.port}${chrome.socketPath}` });
    if (u.pathname === '/json/list' || u.pathname === '/json') return json(chrome.pages);
    if (u.pathname === '/json/new') {
      if (req.method !== 'PUT') { res.statusCode = 405; return res.end(); }
      const url = decodeURIComponent(u.search.slice(1)) || 'about:blank';
      const p = page(url, url);
      chrome.pages.unshift(p);
      return json(p);
    }
    const m = /^\/json\/(activate|close)\/(.+)$/.exec(u.pathname);
    if (m) {
      const target = chrome.pages.find((p) => p.id === decodeURIComponent(m[2]!));
      if (!target) { res.statusCode = 404; return res.end('No such target id'); }
      if (m[1] === 'activate') { chrome.activated.push(target.id); chrome.pages = [target, ...chrome.pages.filter((p) => p !== target)]; return res.end('Target activated'); }
      chrome.pages = chrome.pages.filter((p) => p !== target);
      return res.end('Target is closing');
    }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const stop = async () => {
    for (const c of wss.clients) c.terminate();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  };
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== chrome.socketPath) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'Browser.close') {
          chrome.closeRequests++;
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
          if (!chrome.ignoreClose) setTimeout(() => void stop(), 50);
        } else ws.send(JSON.stringify({ id: msg.id, result: {} }));
      });
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  chrome.port = (server.address() as net.AddressInfo).port;
  for (const t of titles) chrome.pages.push(page(t === 'New Tab' ? 'about:blank' : `https://example.com/${encodeURIComponent(t)}`, t));
  chrome.stop = stop;
  return chrome;
}

function writePortFile(profile: string, port: number, socketPath: string): void {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${port}\n${socketPath}`);
}

/** A launcher like the real one: starts a fake Chrome and writes the profile file, or misbehaves. */
function fakeLauncher(mode: 'ok' | 'silent' | 'exits' = 'ok') {
  const calls: { binary: string; args: string[] }[] = [];
  const started: FakeChrome[] = [];
  const launch = (binary: string, args: string[]) => {
    calls.push({ binary, args });
    let exitCode: number | null = null;
    const profile = /^--user-data-dir=(.*)$/.exec(args.find((a) => a.startsWith('--user-data-dir=')) ?? '')?.[1] ?? '';
    if (mode === 'ok') {
      void fakeChrome().then((c) => { started.push(c); setTimeout(() => writePortFile(profile, c.port, c.socketPath), 150); });
    } else if (mode === 'exits') {
      setTimeout(() => { exitCode = 0; }, 100);
    }
    return { exitCode: () => exitCode };
  };
  return { calls, started, launch };
}

// ── 1. TRA-16: start instructions per platform ──────────────────────────────
console.log('\n--- 1. start instructions per platform (TRA-16) ---');
type ProfileModule = typeof import('../perception/chromeProfile.js');
const profileMod = await load<ProfileModule>('../perception/chromeProfile.js');
{
  const hint = (p: NodeJS.Platform) => profileMod?.chromeStartHint(p) ?? '';
  ok('Windows: names chrome.exe and JARVIS_CHROME_PATH', /chrome\.exe/.test(hint('win32')) && /JARVIS_CHROME_PATH/.test(hint('win32')), hint('win32'));
  ok('Linux: names chromium or google-chrome, not chrome.exe', /chromium|google-chrome/.test(hint('linux')) && !/chrome\.exe/.test(hint('linux')) && /JARVIS_CHROME_PATH/.test(hint('linux')), hint('linux'));
  ok('macOS: names Google Chrome.app, not chrome.exe', /Google Chrome\.app/.test(hint('darwin')) && !/chrome\.exe/.test(hint('darwin')), hint('darwin'));
  const { CdpUnavailableError } = await import('../perception/cdpClient.js');
  const message = new CdpUnavailableError(9).message;
  ok(`"Chrome not reachable" on this platform (${process.platform}) gives this platform's instructions`,
    !!profileMod && message.includes(profileMod.chromeStartHint(process.platform)) && (process.platform === 'win32' || !/chrome\.exe/.test(message)), message);
  const { browserController } = await import('../control/browserController.js');
  const instruction = (browserController as unknown as { getInstruction(): string }).getInstruction();
  ok('the tab tools\' instruction is the same text', !!profileMod && instruction.includes(profileMod.chromeStartHint(process.platform)), instruction);
  const { getChromeState } = await import('../perception/chromeState.js');
  process.env['JARVIS_CDP_PORT'] = '9';
  const state = await getChromeState().catch((e: Error) => ({ error: e.message }));
  delete process.env['JARVIS_CDP_PORT'];
  const stateError = String((state as { error?: string }).error ?? '');
  ok('the Chrome state reader gives this platform\'s instructions too', !!profileMod && stateError.includes(profileMod.chromeStartHint(process.platform)), stateError);
}

// ── 2. Where JARVIS finds its Chrome ────────────────────────────────────────
console.log('\n--- 2. the profile and the port ---');
{
  const dir = (env: Record<string, string>, p: NodeJS.Platform) => profileMod?.chromeProfileDir(env, p) ?? '';
  ok('JARVIS_CHROME_PROFILE wins', dir({ JARVIS_CHROME_PROFILE: '/x/p', USERPROFILE: 'C:\\Users\\o', HOME: '/home/o' }, 'linux') === '/x/p');
  ok('Windows: the folder the old instructions named (%USERPROFILE%\\jarvis-chrome-profile)', dir({ USERPROFILE: 'C:\\Users\\owner' }, 'win32') === 'C:\\Users\\owner\\jarvis-chrome-profile', dir({ USERPROFILE: 'C:\\Users\\owner' }, 'win32'));
  ok('elsewhere: ~/.jarvis-chrome-profile', dir({ HOME: '/home/owner' }, 'linux') === '/home/owner/.jarvis-chrome-profile', dir({ HOME: '/home/owner' }, 'linux'));

  const { cdpPort } = await import('../perception/cdpClient.js');
  const prof = path.join(workspace, 'port-order');
  writePortFile(prof, 45678, '/devtools/browser/abc');
  ok('JARVIS_CDP_PORT first', cdpPort({ JARVIS_CDP_PORT: '9333', JARVIS_CHROME_PROFILE: prof }) === 9333);
  ok('then the port in JARVIS\'s profile', cdpPort({ JARVIS_CHROME_PROFILE: prof }) === 45678, String(cdpPort({ JARVIS_CHROME_PROFILE: prof })));
  ok('then 9222', cdpPort({ JARVIS_CHROME_PROFILE: path.join(workspace, 'empty-profile') }) === 9222);
  fs.writeFileSync(path.join(prof, 'DevToolsActivePort'), 'garbage');
  ok('a damaged profile file is ignored', cdpPort({ JARVIS_CHROME_PROFILE: prof }) === 9222);
}

// ── 3. Starting JARVIS's Chrome ─────────────────────────────────────────────
console.log('\n--- 3. starting JARVIS\'s Chrome ---');
type ChromeModule = typeof import('../control/jarvisChrome.js');
const chromeMod = await load<ChromeModule>('../control/jarvisChrome.js');
const cleanup: FakeChrome[] = [];
function chromeFor(profile: string, extra: Partial<import('../control/jarvisChrome.js').JarvisChromeDeps> = {}, mode: 'ok' | 'silent' | 'exits' = 'ok') {
  const l = fakeLauncher(mode);
  const env: Record<string, string | undefined> = { JARVIS_CHROME_PROFILE: profile, JARVIS_CHROME_AUTOSTART: 'on' };
  const chrome = chromeMod ? new chromeMod.JarvisChrome({ env, findBinary: () => '/fake/chrome', launch: l.launch, startTimeoutMs: 3_000, ...extra }) : undefined;
  return { l, env, chrome };
}
if (!chromeMod) {
  ok('control/jarvisChrome.ts exists', false, 'not on this code');
} else {
  {
    const own = await fakeChrome(); cleanup.push(own);
    const { l, env, chrome } = chromeFor(path.join(workspace, 'p-env'));
    env['JARVIS_CDP_PORT'] = String(own.port);
    ok('JARVIS_CDP_PORT set and answering: used, nothing started', await chrome!.ensure() === own.port && l.calls.length === 0);
    env['JARVIS_CDP_PORT'] = String(await freePort());
    const msg = await error(() => chrome!.ensure());
    ok('JARVIS_CDP_PORT set but nothing answers: says so, names the fix, starts nothing',
      /debugging port/.test(msg) && /JARVIS_CDP_PORT/.test(msg) && l.calls.length === 0, msg);
  }
  {
    const prof = path.join(workspace, 'p-running');
    const own = await fakeChrome(); cleanup.push(own);
    writePortFile(prof, own.port, own.socketPath);
    const { l, chrome } = chromeFor(prof);
    ok('its own Chrome already running: used, nothing started', await chrome!.ensure() === own.port && l.calls.length === 0);
    ok('…and reported as running', await chrome!.runningPort() === own.port);
  }
  {
    const prof = path.join(workspace, 'p-stale');
    writePortFile(prof, await freePort(), '/devtools/browser/gone');
    const { l, chrome } = chromeFor(prof);
    ok('a stale profile file (nothing answers): not running', await chrome!.runningPort() === undefined);
    const port = await chrome!.ensure().catch((e: Error) => e.message);
    cleanup.push(...l.started);
    const args = l.calls[0]?.args ?? [];
    ok('…so it starts Chrome once, with port 0 and its own profile',
      l.calls.length === 1 && args.includes('--remote-debugging-port=0') && args.includes(`--user-data-dir=${prof}`) && args.includes('--no-first-run'), JSON.stringify(args));
    ok('…and uses the port the new Chrome wrote', typeof port === 'number' && port === l.started[0]?.port, String(port));
    ok('…without the default-browser opener', openers.length === 0, openers.join(' | '));
  }
  {
    // Another program's Chrome answers on the port the file names: not JARVIS's.
    const prof = path.join(workspace, 'p-other');
    const other = await fakeChrome(); cleanup.push(other);
    writePortFile(prof, other.port, '/devtools/browser/not-this-one');
    const { l, chrome } = chromeFor(prof);
    ok('a file naming a different browser on that port: not JARVIS\'s', await chrome!.runningPort() === undefined);
    await chrome!.ensure().catch(() => undefined);
    cleanup.push(...l.started);
    ok('…so JARVIS starts its own', l.calls.length === 1);
  }
  {
    const { l, chrome } = chromeFor(path.join(workspace, 'p-two'));
    const [a, b] = await Promise.all([chrome!.ensure().catch(() => -1), chrome!.ensure().catch(() => -2)]);
    cleanup.push(...l.started);
    ok('two requests at once start one Chrome', l.calls.length === 1 && a === b && a > 0, `${l.calls.length} start(s); ${a}, ${b}`);
  }
  {
    const { l, chrome } = chromeFor(path.join(workspace, 'p-missing'), { findBinary: () => undefined });
    const msg = await error(() => chrome!.ensure());
    ok('Chrome not installed: says so with this platform\'s fix, starts nothing',
      /not found/i.test(msg) && !!profileMod && msg.includes(profileMod.chromeStartHint(process.platform)) && l.calls.length === 0, msg);
  }
  {
    const { chrome } = chromeFor(path.join(workspace, 'p-silent'), { startTimeoutMs: 600 }, 'silent');
    const msg = await error(() => chrome!.ensure());
    ok('Chrome started but never opened its port: says so', /did not open its debugging port/i.test(msg), msg);
  }
  {
    const { chrome } = chromeFor(path.join(workspace, 'p-inuse'), { startTimeoutMs: 3_000 }, 'exits');
    const started = Date.now();
    const msg = await error(() => chrome!.ensure());
    ok('Chrome handed the start to a window already using the profile: says to close it', /already open|already using/i.test(msg) && /close/i.test(msg) && Date.now() - started < 2_900, msg);
  }
  {
    const { l, env, chrome } = chromeFor(path.join(workspace, 'p-off'));
    env['JARVIS_CHROME_AUTOSTART'] = 'off';
    const msg = await error(() => chrome!.ensure());
    ok('automatic start switched off: says so, starts nothing', /JARVIS_CHROME_AUTOSTART/.test(msg) && l.calls.length === 0, msg);
  }
  {
    // Review R17: a program that cannot run, or a Chrome that fails, is not "a window already open".
    const thrown = chromeFor(path.join(workspace, 'p-throw'), { launch: () => { throw new Error('spawn EINVAL'); } }).chrome!;
    const m1 = await error(() => thrown.ensure());
    ok('Chrome that cannot be run (spawn throws): says so and names JARVIS_CHROME_PATH', /could not be run/.test(m1) && /JARVIS_CHROME_PATH/.test(m1), m1);
    const enoent = chromeFor(path.join(workspace, 'p-enoent'), { launch: () => ({ exitCode: () => -1 }) }).chrome!;
    const m2 = await error(() => enoent.ensure());
    ok('…the same when it fails to start (ENOENT)', /could not be run/.test(m2) && !/already open/.test(m2), m2);
    const crash = chromeFor(path.join(workspace, 'p-crash'), { launch: () => ({ exitCode: () => 21 }) }).chrome!;
    const m3 = await error(() => crash.ensure());
    ok('…and a Chrome that exits with an error code is reported with that code', /exited with code 21/.test(m3) && !/already open/.test(m3), m3);
    // Review R6: every failure has a short spoken form with the fix.
    const missing = chromeFor(path.join(workspace, 'p-missing2'), { findBinary: () => undefined }).chrome!;
    const err = await missing.ensure().then(() => undefined, (e: unknown) => e as { spoken?: string });
    ok('a failure carries a short spoken form that names the fix', !!err?.spoken && /JARVIS_CHROME_PATH/.test(err.spoken) && err.spoken.length < 120, err?.spoken);
  }
  {
    // Review R9: a Chrome JARVIS just started does not keep its blank start tab.
    const { l, chrome } = chromeFor(path.join(workspace, 'p-blank'));
    const shown = await chromeMod.showInJarvisChrome('https://www.youtube.com', chrome!).catch((e: Error) => e.message);
    cleanup.push(...l.started);
    const pages = l.started[0]?.pages ?? [];
    ok('opening a page in a Chrome JARVIS just started leaves no blank tab', typeof shown === 'object' && pages.length === 1 && pages[0]!.url === 'https://www.youtube.com',
      JSON.stringify(pages.map((p) => p.url)));
  }
  {
    const lookups: string[] = [];
    const found = chromeMod.findChrome({ JARVIS_CHROME_PATH: '/opt/my/chrome' }, 'linux', (p) => { lookups.push(p); return p === '/opt/my/chrome'; });
    ok('JARVIS_CHROME_PATH is used when it exists', found === '/opt/my/chrome');
    const missing = chromeMod.findChrome({ JARVIS_CHROME_PATH: '/opt/none' }, 'linux', () => false);
    ok('…and a JARVIS_CHROME_PATH that does not exist finds nothing (not some other Chrome)', missing === undefined);
    const win = chromeMod.findChrome({ ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local' }, 'win32',
      (p) => p === 'C:\\Users\\o\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
    ok('Windows: a per-user install is found', win === 'C:\\Users\\o\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe', String(win));
  }
}

// ── 4. TRA-03: pages open in JARVIS's Chrome, never the default browser ─────
console.log('\n--- 4. opening pages (TRA-03, Q1, Q2) ---');
const { execute: openApp } = await import('../skills/automation/skill.js');
{
  const own = await fakeChrome(0, ['Inbox']); cleanup.push(own);
  process.env['JARVIS_CDP_PORT'] = String(own.port);
  openers.length = 0;
  const r = JSON.parse(await openApp({ target: 'youtube' }));
  const tab = own.pages.find((p) => p.url === 'https://www.youtube.com');
  ok('"open youtube": a new tab in JARVIS\'s Chrome, brought forward', r.success === true && !!tab && own.activated.includes(tab.id) && r.tabId === tab.id, JSON.stringify(r));
  ok('…and no default-browser opener ran', openers.length === 0, openers.join(' | '));
  const before = own.pages.length;
  const c = JSON.parse(await openApp({ target: 'chrome' }));
  ok('"open chrome": JARVIS\'s Chrome is brought forward, no new tab, no opener (Q1)',
    c.success === true && own.pages.length === before && own.activated.length >= 2 && openers.length === 0, JSON.stringify(c));
  const d = JSON.parse(await openApp({ target: 'youtube', dryRun: true }));
  ok('a dry run still opens nothing (DO_NOT_BREAK smoke test)', d.success === true && d.dryRun === true && own.pages.length === before, JSON.stringify(d));

  process.env['JARVIS_CDP_PORT'] = String(await freePort());
  const f = JSON.parse(await openApp({ target: 'youtube' }));
  ok('JARVIS\'s Chrome cannot be reached: "open youtube" fails, says why, opens nothing elsewhere (Q2)',
    f.success === false && /debugging port/.test(String(f.error)) && openers.length === 0, `${JSON.stringify(f)} ${openers.join(' | ')}`);

  ok('…with a short spoken reason that names the fix', /debugging port/.test(String(f.spoken)) && /JARVIS_CDP_PORT/.test(String(f.spoken)), String(f.spoken));

  delete process.env['JARVIS_CDP_PORT'];
  const g = JSON.parse(await openApp({ target: 'youtube' }));
  ok('…and with automatic start off, the reply names the switch',
    g.success === false && /JARVIS_CHROME_AUTOSTART/.test(String(g.error)) && openers.length === 0, `${JSON.stringify(g)} ${openers.join(' | ')}`);

  process.env['JARVIS_CDP_PORT'] = '1';
  const { browserController } = await import('../control/browserController.js');
  const msg = await error(() => browserController.openUrl('https://example.com'));
  ok('control_browser open_url without Chrome: an error that names the fix, no default browser', /JARVIS_CDP_PORT/.test(msg) && openers.length === 0, `${msg} ${openers.join(' | ')}`);
  // Review R1: control_app open (offered to the planner for every launch) goes the same way.
  {
    const { appController } = await import('../control/appController.js');
    const own2 = await fakeChrome(0, ['Inbox']); cleanup.push(own2);
    process.env['JARVIS_CDP_PORT'] = String(own2.port);
    const a1 = await appController.openApp('https://github.com').catch((e: Error) => `threw: ${e.message}`);
    ok('control_app open "https://github.com": a tab in JARVIS\'s Chrome, no opener', /in JARVIS's Chrome \(port \d+, tab /.test(a1)
      && own2.pages.some((p) => p.url === 'https://github.com') && openers.length === 0, `${a1} ${openers.join(' | ')}`);
    const a2 = await appController.openApp('chrome').catch((e: Error) => `threw: ${e.message}`);
    ok('control_app open "chrome": JARVIS\'s Chrome brought forward, no opener', /in JARVIS's Chrome/.test(a2) && openers.length === 0, `${a2} ${openers.join(' | ')}`);
    // Review R2-4: Chrome named by its full path is still Chrome.
    const before4 = own2.activated.length;
    const a4 = await appController.openApp('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe').catch((e: Error) => `threw: ${e.message}`);
    ok('control_app open with the full path to chrome.exe: JARVIS\'s Chrome, no opener', /in JARVIS's Chrome/.test(a4) && own2.activated.length > before4 && openers.length === 0, `${a4} ${openers.join(' | ')}`);
    process.env['JARVIS_CDP_PORT'] = '1';
    const a3 = await appController.openApp('https://github.com').catch((e: Error) => `threw: ${e.message}`);
    ok('…and without JARVIS\'s Chrome it fails and opens nothing elsewhere', /^threw: .*debugging port/.test(a3) && openers.length === 0, `${a3} ${openers.join(' | ')}`);
  }
  const { youtubeSearchTool, siteSearchTool } = await import('../core/tools/youtubeTools.js');
  const ys = JSON.parse(await youtubeSearchTool.execute({ query: 'lofi', open: 'results' }));
  ok('YouTube search without Chrome: fails and says so, no default browser', ys.success === false && openers.length === 0, `${JSON.stringify(ys).slice(0, 200)} ${openers.join(' | ')}`);
  const ss = JSON.parse(await siteSearchTool.execute({ site: 'google', query: 'weather' }));
  ok('site search without Chrome: fails and says so, no default browser', ss.success === false && openers.length === 0, `${JSON.stringify(ss).slice(0, 200)} ${openers.join(' | ')}`);
  delete process.env['JARVIS_CDP_PORT'];
}

// ── 5. TRA-17 + D3: "close the browser" ─────────────────────────────────────
console.log('\n--- 5. close the browser (TRA-17, D3) ---');
const { BrowserController } = await import('../control/browserController.js');
const { runApproved, currentApproval } = await import('../security/approvalScope.js');
const { actionQueue } = await import('../control/actionQueue.js');
type Controller = InstanceType<typeof BrowserController> & { closeBrowser?: () => Promise<string> };
function controllerFor(env: Record<string, string | undefined>, answer: boolean) {
  const asked: string[] = [];
  let inScope: unknown = 'not asked';
  const chrome = chromeMod ? new chromeMod.JarvisChrome({ env, findBinary: () => undefined, launch: () => { throw new Error('must not start Chrome'); } }) : undefined;
  const controller = new (BrowserController as any)({
    chrome,
    approve: async (title: string, command: string) => { asked.push(`${title}: ${command}`); inScope = currentApproval(); return answer; },
  }) as Controller;
  return { asked, controller, scope: () => inScope };
}
const { permissionSession } = await import('../control/permissionSession.js');
{
  const prof = path.join(workspace, 'p-level');
  const own = await fakeChrome(); cleanup.push(own);
  writePortFile(prof, own.port, own.socketPath);
  const c = controllerFor({ JARVIS_CHROME_PROFILE: prof }, true);
  const msg = c.controller.closeBrowser ? await error(() => c.controller.closeBrowser!()) : 'no closeBrowser';
  ok('without full control mode: refused like closing a tab, nothing asked or closed', /Permission Level 2/.test(msg) && c.asked.length === 0 && own.closeRequests === 0, msg);
}
permissionSession.activateFullControl(5, 'cli');
{
  const c = controllerFor({ JARVIS_CHROME_PROFILE: path.join(workspace, 'p-none') }, true);
  const msg = c.controller.closeBrowser ? await error(() => c.controller.closeBrowser!()) : 'no closeBrowser';
  ok('JARVIS\'s Chrome not running: says so, asks nothing, closes nothing', /JARVIS's Chrome is not open/.test(msg) && c.asked.length === 0, msg);
}
for (const answer of [false, true]) {
  const prof = path.join(workspace, `p-close-${answer}`);
  const own = await fakeChrome(0, ['YouTube', 'Gmail', 'Docs', 'News']); cleanup.push(own);
  writePortFile(prof, own.port, own.socketPath);
  const c = controllerFor({ JARVIS_CHROME_PROFILE: prof }, answer);
  const call = { tool: 'control_browser', action: 'close_browser', target: '', args: { action: 'close_browser' }, level: 2, grantsLevel: 0, approvedAt: Date.now(), requestId: 'test' };
  const result = c.controller.closeBrowser
    ? await runApproved(call as never, () => c.controller.closeBrowser!()).catch((e: Error) => e.message) : 'no closeBrowser';
  await new Promise((r) => setTimeout(r, 300));
  const up = await answers(own.port);
  ok(`owner says ${answer ? 'yes' : 'no'}: asked once, outside the earlier approval, naming JARVIS's Chrome, its tabs and that the owner's own Chrome stays open`,
    c.asked.length === 1 && c.scope() === undefined && /JARVIS's Chrome/.test(c.asked[0]!) && /4 tabs/.test(c.asked[0]!) && /YouTube/.test(c.asked[0]!) && /your own Chrome stays open/i.test(c.asked[0]!),
    c.asked.join(' | '));
  ok(answer ? '…closed: Browser.close sent, the port no longer answers, the reply says so' : '…nothing closed, and the reply says it was not approved',
    answer ? own.closeRequests === 1 && !up && /no longer answers/.test(result) : own.closeRequests === 0 && up && /not approved/.test(result), result);
}
{
  // Review R3: an answer that comes after the request ended (time ran out) closes nothing.
  const prof = path.join(workspace, 'p-late');
  const own = await fakeChrome(); cleanup.push(own);
  writePortFile(prof, own.port, own.socketPath);
  const ac = new AbortController();
  const chrome = new chromeMod!.JarvisChrome({ env: { JARVIS_CHROME_PROFILE: prof }, findBinary: () => undefined });
  const controller = new (BrowserController as any)({ chrome, approve: async () => { ac.abort(); return true; } }) as Controller & { closeBrowser(signal?: AbortSignal): Promise<string> };
  const msg = await error(() => controller.closeBrowser(ac.signal));
  ok('a "yes" that comes after the request timed out closes nothing, and says so', own.closeRequests === 0 && /already ended/.test(msg) && await answers(own.port), msg);
}
{
  // Review R2-1: the kernel passes the tool's own signal, not the queue's 10 s
  // timeout, so a "yes" given while the question is still open is not refused.
  const { pcControlKernel } = await import('../control/pcControlKernel.js');
  const { browserController } = await import('../control/browserController.js');
  const real = browserController.closeBrowser;
  let got: AbortSignal | undefined | 'not called' = 'not called';
  (browserController as any).closeBrowser = async (s?: AbortSignal) => { got = s; return 'Closed JARVIS\'s Chrome (0 tabs) (port 1 no longer answers).'; };
  const toolSignal = new AbortController().signal;
  try { await pcControlKernel.closeBrowser(toolSignal); } finally { (browserController as any).closeBrowser = real; }
  ok('the kernel hands closeBrowser the tool\'s own signal (not one the queue\'s 10 s timeout aborts)', (got as unknown) === toolSignal, String(got));
}
{
  // Review R8: the close goes only to the browser that was checked.
  const own = await fakeChrome(); cleanup.push(own);
  const chrome = new chromeMod!.JarvisChrome({ env: { JARVIS_CHROME_PROFILE: path.join(workspace, 'p-y') } });
  const msg = await error(() => chrome.close({ port: own.port, browserPath: '/devtools/browser/a-different-run' }));
  ok('a different browser now on that port is not closed', own.closeRequests === 0 && /not open/.test(msg) && /another browser/.test(msg), msg);
}
{
  const prof = path.join(workspace, 'p-stays');
  const own = await fakeChrome(); cleanup.push(own);
  own.ignoreClose = true;
  writePortFile(prof, own.port, own.socketPath);
  const c = controllerFor({ JARVIS_CHROME_PROFILE: prof }, true);
  const msg = c.controller.closeBrowser
    ? await error(() => actionQueue.enqueue('closeBrowser', () => c.controller.closeBrowser!())) : 'no closeBrowser';
  ok('Chrome still answers after the close: a failure, and the queue does not retry it (asked once)',
    /still open/i.test(msg) && c.asked.length === 1, `${msg}; asked ${c.asked.length}`);
}
{
  const own = await fakeChrome(); cleanup.push(own);
  const c = controllerFor({ JARVIS_CDP_PORT: String(own.port), JARVIS_CHROME_PROFILE: path.join(workspace, 'p-x') }, true);
  const result = c.controller.closeBrowser ? await c.controller.closeBrowser().catch((e: Error) => e.message) : 'no closeBrowser';
  ok('the owner\'s JARVIS_CDP_PORT Chrome counts as JARVIS\'s: closed after the question', own.closeRequests === 1 && c.asked.length === 1, result);
}
{
  const c = controllerFor({ JARVIS_CHROME_PROFILE: path.join(workspace, 'p-none') }, false);
  const declined = c.controller.closeBrowser ? await error(() => actionQueue.enqueue('closeBrowser', () => c.controller.closeBrowser!())) : '';
  ok('"not open" is not retried by the action queue either', /not open/.test(declined) && c.asked.length === 0, declined);
}
{
  const { execute: controlBrowser } = await import('../skills/control_browser/skill.js');
  const r = await controlBrowser({ action: 'close_browser' }).then((s) => JSON.parse(s)).catch((e: Error) => ({ thrown: e.message }));
  ok('control_browser knows close_browser (through the kernel)', !('thrown' in r) && r.action === 'closeBrowser', JSON.stringify(r).slice(0, 200));
}

permissionSession.deactivateFullControl('JARVIS Chrome test');

// ── 6. Checks, routes, planner, catalog, A1 refusal ─────────────────────────
console.log('\n--- 6. checks, routes, planner, catalog ---');
const { VERIFIERS } = await import('../core/verifiers.js');
{
  const verify = VERIFIERS['control_browser'] as (a: Record<string, unknown>, o: string) => Promise<{ status: string; evidence: string }>;
  const gone = await freePort();
  const v1 = await verify({ action: 'close_browser' }, JSON.stringify({ success: true, message: `Closed JARVIS's Chrome (2 tabs) (port ${gone} no longer answers).` }));
  ok('close_browser check: verified when the port is gone', v1.status === 'verified', JSON.stringify(v1));
  const own = await fakeChrome(); cleanup.push(own);
  const v2 = await verify({ action: 'close_browser' }, JSON.stringify({ success: true, message: `Closed JARVIS's Chrome (2 tabs) (port ${own.port} no longer answers).` }));
  ok('…and failed when it still answers', v2.status === 'failed' && /still answers/.test(v2.evidence), JSON.stringify(v2));

  // Review R7: a page title quoting "(port N no longer answers)" does not decide the check.
  const v3 = await verify({ action: 'close_browser' }, JSON.stringify({ success: true, message: `Closed JARVIS's Chrome (1 tab: "(port ${own.port} no longer answers)") (port ${gone} no longer answers).` }));
  ok('…the port is read from the end of the reply, not from a tab title', v3.status === 'verified', JSON.stringify(v3));

  const verifyOpen = VERIFIERS['open_app'] as (a: Record<string, unknown>, o: string) => Promise<{ status: string; evidence: string }>;
  own.pages.push({ id: 'TAB1', type: 'page', title: 'YouTube', url: 'https://www.youtube.com/', webSocketDebuggerUrl: '' });
  const o1 = await verifyOpen({ target: 'youtube' }, JSON.stringify({ success: true, method: 'jarvis-chrome', port: own.port, tabId: 'TAB1', resolvedTarget: 'https://www.youtube.com' }));
  ok('open_app in JARVIS\'s Chrome: verified when its tab is there (not "unverifiable")', o1.status === 'verified', JSON.stringify(o1));
  const o2 = await verifyOpen({ target: 'youtube' }, JSON.stringify({ success: true, method: 'jarvis-chrome', port: own.port, tabId: 'GONE', resolvedTarget: 'https://www.youtube.com' }));
  ok('…failed when the tab is not', o2.status === 'failed', JSON.stringify(o2));
  const verifyApp = VERIFIERS['control_app'] as (a: Record<string, unknown>, o: string) => Promise<{ status: string; evidence: string }>;
  const c1 = await verifyApp({ action: 'open', target: 'chrome' }, JSON.stringify({ success: true, message: `Opened "chrome" in JARVIS's Chrome (port ${own.port}, tab TAB1).` }));
  ok('control_app open in JARVIS\'s Chrome: checked by its tab on any platform', c1.status === 'verified', JSON.stringify(c1));
}
{
  const { matchDeterministicCommand } = await import('../core/deterministicRoutes.js');
  for (const p of ['close the browser', 'close browser', 'close chrome', 'close google chrome', 'close the chrome', 'Close Chrome.']) {
    const r = matchDeterministicCommand(p);
    ok(`"${p}" → close_browser`, r?.type === 'close_browser', JSON.stringify(r));
  }
  for (const [p, type, target] of [['close the youtube tab', '', ''], ['close youtube', 'close_browser_tab', 'youtube'], ['close notepad', 'close_app', 'notepad'],
    ['open youtube for me', 'open_app', 'youtube'], ['launch youtube', 'open_app', 'youtube'], ['open browser', 'open_app', 'chrome'], ['open chrome', 'open_app', 'chrome']] as const) {
    const r = matchDeterministicCommand(p);
    ok(`"${p}" unchanged → ${type || 'no close_browser'}`, type ? r?.type === type && r?.target === target : r?.type !== 'close_browser', JSON.stringify(r));
  }
  ok('"launch cmd /c del *" still matches nothing', matchDeterministicCommand('launch cmd /c del *') === null || matchDeterministicCommand('launch cmd /c del *')?.type !== 'open_app' || matchDeterministicCommand('launch cmd /c del *')?.target !== 'cmd');
}
{
  const { orchestrator } = await import('../core/orchestrator.js');
  await (orchestrator as unknown as { waitForSkills?: () => Promise<void> }).waitForSkills?.();
  const planner = orchestrator as unknown as { selectPlanningToolNames(i: string): string[] };
  for (const phrase of ['close the browser', 'please close chrome', 'close google chrome now']) {
    const tools = planner.selectPlanningToolNames(phrase);
    ok(`"${phrase}": control_browser offered, control_app and control_window not`,
      tools.includes('control_browser') && !tools.includes('control_app') && !tools.includes('control_window'), tools.join(', '));
  }
  const tools = planner.selectPlanningToolNames('close notepad');
  ok('"close notepad" still gets control_app', tools.includes('control_app'), tools.join(', '));
}
{
  const { TOOL_CATALOG } = await import('../core/toolCatalog.js');
  const meta = (TOOL_CATALOG['control_browser'] as unknown as { actions?: Record<string, { risk: number }> }).actions?.['close_browser'];
  ok('catalog: close_browser is risk 2, like closing a tab', meta?.risk === 2, JSON.stringify(meta));
  const description = JSON.parse(fs.readFileSync(path.join('skills', 'control_browser', 'description.json'), 'utf8'));
  ok('the skill lists close_browser for the planner', (description.parameters?.action?.enum ?? []).includes('close_browser') && /close_browser/.test(description.description), description.description);
  const { browserCloseRefusal } = await import('../control/appMatch.js');
  ok('A1\'s browser refusal tells the owner how to close JARVIS\'s Chrome', /close the browser/i.test(browserCloseRefusal('Chrome')), browserCloseRefusal('Chrome'));
}

// ── 7. A real Chromium ──────────────────────────────────────────────────────
console.log('\n--- 7. a real headless Chromium ---');
const { findChromium } = await import('./chromeHelper.js');
const binary = findChromium();
if (!chromeMod) {
  ok('real Chromium: control/jarvisChrome.ts exists', false, 'not on this code');
} else if (!binary) {
  console.log('  SKIP: no Chromium or Chrome found (set JARVIS_TEST_CHROME)');
} else {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-own-chrome-real-'));
  const children: import('child_process').ChildProcess[] = [];
  const chrome = new chromeMod.JarvisChrome({
    env: { JARVIS_CHROME_PROFILE: prof, JARVIS_CHROME_AUTOSTART: 'on' },
    findBinary: () => binary,
    extraArgs: ['--headless=new', '--no-sandbox', '--disable-gpu'],
    startTimeoutMs: 45_000,
    launch: (b, args) => {
      const child = realSpawn(b, args, { stdio: 'ignore', env: process.env });
      children.push(child);
      return { exitCode: () => child.exitCode };
    },
  });
  try {
    const port = await chrome.ensure();
    const file = fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
    ok('started: the port is the one in the profile file', Number(file[0]) === port && await answers(port), `${port} / ${file[0]}`);
    const { cdpPort, openTab, listPages } = await import('../perception/cdpClient.js');
    ok('cdpPort() finds it through the profile', cdpPort({ JARVIS_CHROME_PROFILE: prof }) === port);
    ok('a second request reuses it', await chrome.ensure() === port && children.length === 1, `${children.length} start(s)`);
    const tab = await openTab('data:text/html,<title>JARVIS test page</title>', port);
    await new Promise((r) => setTimeout(r, 500));
    ok('a page opens in it', (await listPages(port)).some((p) => p.id === tab.id));
    const runningNow = await chrome.running();
    const closed = runningNow ? await chrome.close(runningNow) : false;
    await new Promise((r) => setTimeout(r, 500));
    ok('close: the port no longer answers and Chrome exited', closed && !(await answers(port)) && children[0]?.exitCode !== null,
      `closed=${closed} exit=${children[0]?.exitCode}`);
    ok('…and after that it is not running', await chrome.runningPort() === undefined);
  } catch (err) {
    ok('real Chromium run', false, (err as Error).message);
  } finally {
    for (const c of children) { try { c.kill(); } catch { /* gone */ } }
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* in use */ }
  }
}

for (const c of cleanup) await c.stop().catch(() => undefined);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* in use */ }
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
