/**
 * tests/tabTargetingA4Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase A4 (safe tab targeting: TRA-01, TRA-02, TRA-11; owner's PC findings
 * N-PC4, N-PC5, N-PC6, N-PC8; owner decisions Q1–Q4 of 2026-11-01).
 *
 *   1. control_browser close: one finder; the tab on screen among several
 *      matches; a question when none of them is on screen (Q1); an empty
 *      name is the tab on screen, never "the first listed"; a slow close is
 *      still checked as closed (N-PC4); a close that did not happen is not
 *      "verified" (mutation MD); the last tab leaves Chrome open on a blank
 *      tab (Q4, N-PC8)
 *   2. close_current and refresh: the tab on screen, or a question; no
 *      Ctrl+W / Ctrl+R into a browser window when Chrome does not answer
 *   3. browser_tab close (the planner's tool): the same finder and checks;
 *      the tab really closes (mutation ME); the visible one is taken (MB)
 *   4. one permission rule for both tools (Q2, N-PC6)
 *   5. only JARVIS's checked Chrome: not a stale profile file, not 9222
 *   6. "open youtube" twice: the open YouTube tab comes to the front (Q3)
 *   7. "close this tab" and similar wordings have a route
 *
 * Chrome is a fake DevTools server (HTTP, the browser and page WebSockets).
 * Nothing is opened on this machine; key presses are recorded, not sent.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tab-a4-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_CHROME_PROFILE'] = path.join(workspace, 'no-chrome-profile');
process.env['JARVIS_CHROME_AUTOSTART'] = 'off';
delete process.env['JARVIS_CDP_PORT'];
process.chdir(workspace);

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { VISIBILITY_SCRIPT } = await import('../perception/cdpScripts.js');
const { WebSocketServer } = await import('ws');

// ── A fake Chrome ────────────────────────────────────────────────────────────
interface FakePage { id: string; type: 'page'; title: string; url: string; webSocketDebuggerUrl: string; visible: boolean }
interface FakeChrome {
  port: number; socketPath: string; pages: FakePage[]; closed: string[]; opened: string[]; activated: string[];
  /** DevTools methods sent to its pages (Page.reload, Page.navigate, …). */
  methods: string[];
  /** Scripts run in its pages, with the page's id. */
  evaluated: Array<{ page: string; expr: string }>;
  /** ms a closed tab stays listed after /json/close (Chrome closes it a little later). */
  closeDelayMs: number;
  /** /json/close answers but the tab stays. */
  ignoreClose: boolean;
  up: boolean;
  stop(): Promise<void>;
}
const fakes: FakeChrome[] = [];

async function fakeChrome(tabs: Array<{ title: string; url: string; visible?: boolean }>, port = 0): Promise<FakeChrome> {
  const chrome: FakeChrome = {
    port: 0, socketPath: `/devtools/browser/${randomUUID()}`, pages: [], closed: [], opened: [], activated: [], methods: [], evaluated: [],
    closeDelayMs: 0, ignoreClose: false, up: true, stop: async () => undefined,
  };
  const page = (url: string, title: string, visible = false): FakePage => {
    const id = randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
    return { id, type: 'page', title, url, visible, webSocketDebuggerUrl: `ws://127.0.0.1:${chrome.port}/devtools/page/${id}` };
  };
  const show = (p: FakePage) => { for (const q of chrome.pages) q.visible = q === p; };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const json = (body: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (u.pathname === '/json/version') return json({ Browser: 'FakeChrome/1', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${chrome.port}${chrome.socketPath}` });
    if (u.pathname === '/json/list' || u.pathname === '/json') return json(chrome.pages.map(({ visible: _v, ...p }) => p));
    if (u.pathname === '/json/new') {
      if (req.method !== 'PUT') { res.statusCode = 405; return res.end(); }
      const url = decodeURIComponent(u.search.slice(1)) || 'about:blank';
      const p = page(url, url);
      chrome.pages.unshift(p);
      chrome.opened.push(url);
      show(p);
      return json(p);
    }
    const m = /^\/json\/(activate|close)\/(.+)$/.exec(u.pathname);
    if (m) {
      const target = chrome.pages.find((p) => p.id === decodeURIComponent(m[2]!));
      if (!target) { res.statusCode = 404; return res.end('No such target id'); }
      if (m[1] === 'activate') {
        chrome.activated.push(target.id);
        chrome.pages = [target, ...chrome.pages.filter((p) => p !== target)];
        show(target);
        return res.end('Target activated');
      }
      chrome.closed.push(target.id);
      if (!chrome.ignoreClose) {
        const remove = () => {
          chrome.pages = chrome.pages.filter((p) => p !== target);
          // Chrome exits when its last tab closes (owner's PC, N-PC8).
          if (chrome.pages.length === 0) void chrome.stop();
        };
        if (chrome.closeDelayMs > 0) setTimeout(remove, chrome.closeDelayMs); else remove();
      }
      return res.end('Target is closing');
    }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (req, socket, head) => {
    const pageId = /^\/devtools\/page\/(.+)$/.exec(req.url ?? '')?.[1];
    if (req.url !== chrome.socketPath && !pageId) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        const p = chrome.pages.find((q) => q.id === pageId);
        chrome.methods.push(String(msg.method));
        let result: unknown = {};
        if (msg.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: `frame-${pageId}` } } };
        else if (msg.method === 'Page.createIsolatedWorld') result = { executionContextId: 1 };
        else if (msg.method === 'Browser.getWindowForTarget') result = { windowId: 1 };
        else if (msg.method === 'Runtime.evaluate') {
          const expr = String(msg.params?.expression ?? '');
          chrome.evaluated.push({ page: String(pageId), expr });
          result = { result: { value: expr === VISIBILITY_SCRIPT ? (p?.visible ? 'visible' : 'hidden') : expr.includes('readyState') ? { readyState: 'complete', url: p?.url ?? '', title: p?.title ?? '' } : {} } };
        }
        ws.send(JSON.stringify({ id: msg.id, result }));
      });
    });
  });
  chrome.stop = async () => {
    if (!chrome.up) return;
    chrome.up = false;
    for (const c of wss.clients) c.terminate();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  };
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
  chrome.port = (server.address() as net.AddressInfo).port;
  for (const t of tabs) chrome.pages.push(page(t.url, t.title, !!t.visible));
  fakes.push(chrome);
  return chrome;
}
const titles = (c: FakeChrome) => c.pages.map((p) => p.title);
const titleOf = (c: FakeChrome, id: string | undefined) => c.pages.find((p) => p.id === id)?.title;

// ── Key presses and the window in front: recorded and played ─────────────────
const { keyboardController } = await import('../control/keyboardController.js');
const pressed: string[] = [];
(keyboardController as any).pressHotkey = async (keys: string[]) => { pressed.push(keys.join('+')); return 'pressed'; };
const { psSession } = await import('../perception/windowsState.js');
(psSession as any).isAlive = () => true;
const inFront = JSON.stringify({ activeWindow: { title: 'Everyday Chrome', processName: 'chrome', pid: 4242, hwnd: 77 }, openApps: [] });
(psSession as any).query = async () => inFront;
(psSession as any).queryWhenFree = async () => inFront;

// ── JARVIS ───────────────────────────────────────────────────────────────────
const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { permissionSession } = await import('../control/permissionSession.js');
const { assessRisk, decide, level2Policy } = await import('../security/riskEngine.js');
const { matchDeterministicCommand } = await import('../core/deterministicRoutes.js');
const { showInJarvisChrome, JarvisChrome } = await import('../control/jarvisChrome.js');
registerAllTools();
await new SkillLoader(skillsDir).loadSkills();

const run = (tool: string, args: Record<string, unknown>) => toolRegistryV2.execute(tool, args);
const said = (r: { output?: string; error?: string; verification?: { evidence?: string } } | undefined) =>
  `${r?.error ?? ''} ${r?.output ?? ''} ${r?.verification?.evidence ?? ''}`.replace(/\s+/g, ' ').slice(0, 300);
/** JARVIS uses this fake (the owner's own debugging port counts as JARVIS's Chrome). */
const use = (c: FakeChrome) => { process.env['JARVIS_CDP_PORT'] = String(c.port); };

const YT_HOME = { title: 'YouTube', url: 'https://www.youtube.com/' };
const YT_SEARCH = { title: 'lofi beats - YouTube', url: 'https://www.youtube.com/results?search_query=lofi' };
const GMAIL = { title: 'Inbox - Gmail', url: 'https://mail.google.com/mail/u/0/' };
const NEWS = { title: 'The Daily News', url: 'https://news.example.com/' };

console.log('\n=== Safe tab targeting (phase A4) ===\n');

// ── 1. control_browser close ────────────────────────────────────────────────
console.log('--- 1. control_browser close (the fast route\'s tool) ---');
{
  const c = await fakeChrome([{ ...YT_SEARCH }, { ...YT_HOME, visible: true }, { ...GMAIL }]);
  use(c);
  const homeId = c.pages[1]!.id;
  const r = await run('control_browser', { action: 'close', target: 'youtube' });
  ok('two YouTube tabs, one on screen: the one on screen closes (mutation MB)', r.success && c.closed.length === 1 && c.closed[0] === homeId, `${said(r)} closed=${c.closed.map((id) => id === homeId ? 'home' : 'other')}`);
  ok('…the other YouTube tab and Gmail stay', titles(c).includes(YT_SEARCH.title) && titles(c).includes(GMAIL.title), titles(c).join(', '));
}
{
  const c = await fakeChrome([{ ...YT_SEARCH }, { ...YT_HOME }, { ...GMAIL, visible: true }]);
  use(c);
  const r = await run('control_browser', { action: 'close', target: 'youtube' });
  ok('two YouTube tabs, neither on screen: nothing closes (Q1)', c.closed.length === 0 && !r.success, said(r));
  ok('…and JARVIS asks which, naming both', /which/i.test(said(r)) && said(r).includes('lofi beats') && /"YouTube"/.test(said(r)), said(r));
  ok('…in words short enough to be said after a failed route (120 characters)', (/Which tab[^{]*?\./.exec(said(r))?.[0] ?? '').length <= 120, /Which tab[^{]*?\./.exec(said(r))?.[0] ?? '');
  const { actionQueue } = await import('../control/actionQueue.js');
  const { TabQuestion } = await import('../perception/tabResolver.js').catch(() => ({ TabQuestion: Error }));
  let calls = 0;
  await actionQueue.enqueue('closeBrowserTab', async () => { calls++; throw new TabQuestion('Which tab, sir? 2 match "youtube": "A", "B".', []); }).catch(() => undefined);
  ok('…and the question is not retried by the action queue', calls === 1, `${calls} call(s)`);
}
{
  const c = await fakeChrome([{ ...GMAIL, visible: true }, { ...YT_HOME }]);
  use(c);
  c.closeDelayMs = 600;
  const r = await run('control_browser', { action: 'close', target: 'youtube' });
  await sleep(700);
  ok('Chrome takes 0.6 s to close the tab: still checked as closed (N-PC4)', r.success && r.verification?.status === 'verified' && !titles(c).includes('YouTube'), said(r));
}
{
  // The close check itself waits too (a second layer: the close also waits since review R8).
  const c = await fakeChrome([{ ...GMAIL, visible: true }, { ...YT_HOME }]);
  use(c);
  const yt = c.pages[1]!;
  const { VERIFIERS } = await import('../core/verifiers.js');
  const verify = VERIFIERS['control_browser'] as (a: Record<string, unknown>, o: string) => Promise<{ status: string; evidence: string }>;
  setTimeout(() => { c.pages = c.pages.filter((p) => p !== yt); }, 600);
  const v = await verify({ action: 'close', target: 'youtube' }, JSON.stringify({ success: true, message: `Closed tab: "YouTube" (tab ${yt.id})` }));
  ok('…the close check waits for a tab Chrome is still closing (0.6 s)', v.status === 'verified', JSON.stringify(v));
}
{
  const c = await fakeChrome([{ ...GMAIL, visible: true }, { ...YT_HOME }]);
  use(c);
  c.ignoreClose = true;
  const r = await run('control_browser', { action: 'close', target: 'youtube' });
  ok('the tab never closes: not "verified", JARVIS says it is still open (mutation MD)', !r.success && r.verification?.status !== 'verified' && /still open/.test(said(r)), said(r));
}
{
  const c = await fakeChrome([{ ...YT_HOME, visible: true }]);
  use(c);
  const r = await run('control_browser', { action: 'close', target: 'youtube' });
  await sleep(150);
  ok('the last tab: it closes (Q4)…', r.success && c.closed.length === 1, said(r));
  ok('…and JARVIS\'s Chrome stays open, on a blank tab (N-PC8)', c.up && c.pages.length === 1 && c.pages[0]!.url === 'about:blank', `up=${c.up} ${c.pages.map((p) => p.url).join(', ')}`);
}
permissionSession.activateFullControl(5, 'cli');
{
  const c = await fakeChrome([{ ...NEWS }, { ...GMAIL }, { ...YT_SEARCH, visible: true }]);
  use(c);
  const r = await run('control_browser', { action: 'close', target: '' });
  ok('no name (full control on): the tab on screen closes, not the first listed', c.closed.length === 1 && c.closed[0] === c.pages.find((p) => p.title === YT_SEARCH.title)?.id || (c.closed.length === 1 && !titles(c).includes(YT_SEARCH.title)), `${said(r)} left=${titles(c).join(', ')}`);
  ok('…"The Daily News" (listed first) stays', titles(c).includes(NEWS.title), titles(c).join(', '));
}
{
  const c = await fakeChrome([{ ...NEWS }, { ...GMAIL }]);
  use(c);
  const r = await run('control_browser', { action: 'close', target: '' });
  ok('no name and no tab on screen (Chrome minimised): nothing closes, JARVIS asks (TRA-02)', c.closed.length === 0 && /which/i.test(said(r)), said(r));
}
permissionSession.deactivateFullControl('test');
{
  const c = await fakeChrome([{ ...NEWS }, { ...YT_HOME, visible: true }]);
  use(c);
  const r = await run('control_browser', { action: 'close', target: '' });
  ok('no name without full control: refused, nothing closes (an empty name is not a "blank tab")', c.closed.length === 0 && !r.success, said(r));
}
{
  // The controller's own rule too, for callers that do not go through the registry.
  const c = await fakeChrome([{ ...NEWS }, { ...YT_HOME, visible: true }]);
  use(c);
  const { browserController } = await import('../control/browserController.js');
  const msg = await browserController.closeTab('').catch((e: Error) => e.message);
  ok('…and the browser controller itself asks for level 2 for an empty name', c.closed.length === 0 && /level 2/i.test(msg), msg);
}

// ── 2. close_current and refresh ────────────────────────────────────────────
console.log('--- 2. close_current and refresh ---');
permissionSession.activateFullControl(5, 'cli');
{
  const c = await fakeChrome([{ ...NEWS }, { ...GMAIL, visible: true }]);
  use(c);
  const r = await run('control_browser', { action: 'close_current' });
  ok('close_current: the tab on screen (Gmail) closes, checked', r.success && !titles(c).includes(GMAIL.title) && titles(c).includes(NEWS.title), said(r));
}
{
  const c = await fakeChrome([{ ...NEWS }, { ...GMAIL }]);
  use(c);
  const r = await run('control_browser', { action: 'close_current' });
  ok('close_current with no tab on screen: nothing closes, JARVIS asks', c.closed.length === 0 && /which/i.test(said(r)), said(r));
}
{
  const dead = await fakeChrome([]);
  const port = dead.port;
  await dead.stop();
  process.env['JARVIS_CDP_PORT'] = String(port);
  pressed.length = 0;
  const r1 = await run('control_browser', { action: 'close_current' });
  ok('Chrome does not answer, a browser window is in front: no Ctrl+W pressed', !pressed.includes('ctrl+w') && !r1.success, `${said(r1)} pressed=${pressed.join(',')}`);
  pressed.length = 0;
  const r2 = await run('control_browser', { action: 'refresh', target: '' });
  ok('…and no Ctrl+R for refresh', !pressed.includes('ctrl+r') && !r2.success, `${said(r2)} pressed=${pressed.join(',')}`);
  ok('…JARVIS says its Chrome is not reachable', /not reachable|not running|not open/i.test(said(r1)) && /not reachable|not running|not open/i.test(said(r2)), `${said(r1)} | ${said(r2)}`);
}

// ── 3. browser_tab close (the planner's tool) ───────────────────────────────
console.log('--- 3. browser_tab close ---');
{
  const c = await fakeChrome([{ ...YT_SEARCH }, { ...YT_HOME, visible: true }, { ...GMAIL }]);
  use(c);
  const homeId = c.pages[1]!.id;
  const r = await run('browser_tab', { action: 'close', tab: 'youtube' });
  ok('two YouTube tabs, one on screen: that one closes (MB)', r.success && c.closed[0] === homeId && c.closed.length === 1, said(r));
  ok('…the tab is really gone from Chrome (mutation ME)', !c.pages.some((p) => p.id === homeId), titles(c).join(', '));
}
{
  const c = await fakeChrome([{ ...YT_SEARCH }, { ...YT_HOME }, { ...GMAIL, visible: true }]);
  use(c);
  const r = await run('browser_tab', { action: 'close', tab: 'youtube' });
  ok('neither on screen: nothing closes, JARVIS asks which (Q1)', c.closed.length === 0 && /which/i.test(said(r)), said(r));
}
{
  const c = await fakeChrome([{ ...YT_HOME, visible: true }]);
  use(c);
  const r = await run('browser_tab', { action: 'close', tab: 'youtube' });
  await sleep(150);
  ok('the last tab: closes, Chrome stays on a blank tab (Q4)', r.success && c.up && c.pages.length === 1 && c.pages[0]!.url === 'about:blank', `${said(r)} up=${c.up}`);
}
{
  const c = await fakeChrome([{ ...NEWS }, { ...GMAIL }]);
  use(c);
  const r = await run('browser_tab', { action: 'close' });
  ok('no tab named and none on screen: nothing closes, JARVIS asks (TRA-02)', c.closed.length === 0 && /which/i.test(said(r)), said(r));
}
permissionSession.deactivateFullControl('test');

// ── 4. One permission rule (Q2, N-PC6) ──────────────────────────────────────
console.log('--- 4. one permission rule for both tools ---');
{
  const level = (tool: string, args: Record<string, unknown>) => {
    const a = assessRisk({ tool, args, baseRisk: toolRegistryV2.riskOf(tool, args) as never });
    return { level: a.level, decision: decide(a, { sessionLevel: 1, policy: level2Policy({}) }).outcome };
  };
  for (const [tool, args, expected] of [
    ['control_browser', { action: 'close', target: 'youtube' }, 1],
    ['browser_tab', { action: 'close', tab: 'youtube' }, 1],
    ['control_browser', { action: 'close', target: 'about:blank' }, 1],
    ['browser_tab', { action: 'close', tab: 'about:blank' }, 1],
    ['control_browser', { action: 'close', target: 'gmail' }, 2],
    ['browser_tab', { action: 'close', tab: 'gmail' }, 2],
    ['control_browser', { action: 'close', target: '' }, 2],
    ['browser_tab', { action: 'close' }, 2],
  ] as const) {
    const l = level(tool, args as Record<string, unknown>);
    ok(`${tool} close ${JSON.stringify((args as any).target ?? (args as any).tab ?? '(tab on screen)')}: level ${expected}`, l.level === expected, `level ${l.level}, ${l.decision}`);
  }
  const c = await fakeChrome([{ ...GMAIL, visible: true }, { ...YT_HOME }]);
  use(c);
  const r = await run('browser_tab', { action: 'close', tab: 'youtube' });
  ok('the planner\'s browser_tab closes YouTube without full control, like the fast route', r.success && !titles(c).includes('YouTube'), said(r));
}

// ── 5. Only JARVIS's checked Chrome ─────────────────────────────────────────
console.log('--- 5. only JARVIS\'s checked Chrome ---');
delete process.env['JARVIS_CDP_PORT'];
{
  const other = await fakeChrome([{ ...YT_HOME, visible: true }, { ...GMAIL }]);
  const profile = path.join(workspace, 'stale-profile');
  fs.mkdirSync(profile, { recursive: true });
  // A profile file left by an earlier JARVIS Chrome; another browser now has the port.
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${other.port}\n/devtools/browser/an-earlier-run`);
  process.env['JARVIS_CHROME_PROFILE'] = profile;
  const r1 = await run('control_browser', { action: 'close', target: 'youtube' });
  const r2 = await run('browser_tab', { action: 'close', tab: 'youtube' });
  ok('a stale profile file pointing at another browser: control_browser closes nothing there', other.closed.length === 0 && !r1.success, said(r1));
  ok('…browser_tab closes nothing there either', other.closed.length === 0 && !r2.success, said(r2));
  process.env['JARVIS_CHROME_PROFILE'] = path.join(workspace, 'no-chrome-profile');
}
{
  let on9222: FakeChrome | undefined;
  try { on9222 = await fakeChrome([{ ...YT_HOME, visible: true }, { ...GMAIL }], 9222); } catch { on9222 = undefined; }
  if (on9222) {
    const r1 = await run('control_browser', { action: 'close', target: 'youtube' });
    const r2 = await run('browser_tab', { action: 'close', tab: 'youtube' });
    ok('no JARVIS Chrome, another Chrome on 9222: nothing closes there (no 9222 guess)', on9222.closed.length === 0 && !r1.success && !r2.success, `${said(r1)} | ${said(r2)}`);
    await on9222.stop();
  } else {
    console.log('  NOT RUN: port 9222 is in use on this machine, so the 9222 case cannot be set up here');
  }
}

// ── 6. "open youtube" twice (Q3, N-PC5) ─────────────────────────────────────
console.log('--- 6. "open youtube" when YouTube is already open ---');
{
  const c = await fakeChrome([{ ...GMAIL, visible: true }, { title: 'Some video - YouTube', url: 'https://www.youtube.com/watch?v=abc' }]);
  const chrome = new JarvisChrome({ env: { JARVIS_CDP_PORT: String(c.port), JARVIS_CHROME_PROFILE: path.join(workspace, 'p6') } });
  const shown = await showInJarvisChrome('https://www.youtube.com/', chrome);
  const yt = c.pages.find((p) => p.url.includes('watch?v=abc'));
  ok('the open YouTube tab comes to the front; no new tab (Q3)', c.opened.length === 0 && shown.tabId === yt?.id && c.activated.includes(yt?.id ?? '-'), `opened=${c.opened.join(',')} shown=${titleOf(c, shown.tabId)}`);
  const s2 = await showInJarvisChrome('https://www.youtube.com/results?search_query=lofi', chrome);
  ok('a YouTube search still opens a new tab', c.opened.length === 1 && s2.tabId !== yt?.id, c.opened.join(','));
  const s3 = await showInJarvisChrome('https://github.com/', chrome);
  ok('a site that is not open opens in a new tab', c.opened.length === 2 && titleOf(c, s3.tabId) !== undefined, c.opened.join(','));
}

// ── 7. "close this tab" and similar wordings ────────────────────────────────
console.log('--- 7. routes ---');
for (const input of ['close this tab', 'close the tab', 'close the current tab', 'close current tab', 'close tab', 'Jarvis, close this tab', 'close my tab', 'close the active tab']) {
  const r = matchDeterministicCommand(input);
  ok(`"${input}" → close_current_tab`, r?.type === 'close_current_tab', r ? `${r.type} ${r.target ?? ''}` : 'none');
}
for (const input of ['close that tab', 'close all tabs', 'close this tab and notepad', 'close the other tabs', 'close this', 'should i close this tab']) {
  const r = matchDeterministicCommand(input);
  ok(`"${input}" is not close_current_tab`, r?.type !== 'close_current_tab', r ? `${r.type} ${r.target ?? ''}` : 'none');
}
{
  const r = matchDeterministicCommand('close the youtube tab');
  ok('"close the youtube tab" keeps its named-tab route (A3)', r?.type === 'close_browser_tab' && r.target === 'youtube', r ? `${r.type} ${r.target}` : 'none');
}

// ── 8. Review round 1 (review.md) ───────────────────────────────────────────
console.log('--- 8. review round 1 ---');
const { approvalGate } = await import('../security/approvalGate.js');
(approvalGate as any).attachConsole?.();
/** Runs fn while answering every approval question with `answer`; returns the questions asked. */
async function answering<T>(answer: string, fn: () => Promise<T>): Promise<{ value: T; asked: number }> {
  let asked = 0;
  let stop = false;
  const loop = (async () => {
    let last: unknown = null;
    while (!stop) {
      const p = (approvalGate as any).pending;
      if (p && p !== last) { last = p; asked++; approvalGate.offerConsoleAnswer(answer); }
      await sleep(10);
    }
  })();
  try { return { value: await fn(), asked }; } finally { stop = true; await loop; }
}
const GITHUB_YTDL = { title: 'GitHub - ytdl-org/youtube-dl', url: 'https://github.com/ytdl-org/youtube-dl' };
const GOOGLE_SIGNIN = { title: 'Sign in - Google Accounts', url: 'https://accounts.google.com/ServiceLogin?continue=https://www.youtube.com/' };
{
  // R2: level 1 is for a YouTube or blank tab, not for any tab whose title or address mentions YouTube.
  for (const [tool, args] of [['control_browser', { action: 'close', target: 'youtube' }], ['browser_tab', { action: 'close', tab: 'youtube' }]] as const) {
    const c = await fakeChrome([{ ...GOOGLE_SIGNIN, visible: true }, { ...GMAIL }]);
    use(c);
    const r = await run(tool, args as Record<string, unknown>);
    ok(`R2 ${tool}: "youtube" matches a Google sign-in page: not closed without full control`, c.closed.length === 0 && !r.success, said(r));
  }
}
{
  // R1: a sensitive (GitHub) tab asks first, whichever tool closes it.
  for (const [tool, args] of [['control_browser', { action: 'close', target: 'youtube-dl' }], ['browser_tab', { action: 'close', tab: 'youtube-dl' }]] as const) {
    const c = await fakeChrome([{ ...GMAIL, visible: true }, { ...GITHUB_YTDL }]);
    use(c);
    permissionSession.activateFullControl(5, 'cli');
    const { value: r, asked } = await answering('no', () => run(tool, args as Record<string, unknown>));
    permissionSession.deactivateFullControl('test');
    ok(`R1 ${tool}: a GitHub tab asks first; answered no, nothing closes`, asked >= 1 && c.closed.length === 0 && !r.success, `${asked} question(s); ${said(r)}`);
  }
  for (const [tool, args] of [['control_browser', { action: 'close', target: 'youtube' }], ['browser_tab', { action: 'close', tab: 'youtube' }]] as const) {
    const c = await fakeChrome([{ ...GMAIL, visible: true }, { ...GITHUB_YTDL }]);
    use(c);
    const r = await run(tool, args as Record<string, unknown>);
    ok(`R1 ${tool}: without full control, "youtube" does not close the GitHub youtube-dl tab`, c.closed.length === 0 && !r.success, said(r));
  }
}
{
  // R3: navigation changes a tab: only in JARVIS's checked Chrome.
  delete process.env['JARVIS_CDP_PORT'];
  const other = await fakeChrome([{ ...YT_HOME, visible: true }, { ...GMAIL }]);
  const profile = path.join(workspace, 'stale-profile-r3');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${other.port}\n/devtools/browser/an-earlier-run`);
  process.env['JARVIS_CHROME_PROFILE'] = profile;
  const r1 = await run('browser_navigate', { action: 'reload', tab: 'youtube' });
  const r2 = await run('browser_navigate', { action: 'go', url: 'https://example.com/', tab: 'gmail' });
  ok('R3 a stale profile file: browser_navigate reload and go send nothing to that other browser', !other.methods.includes('Page.reload') && !other.methods.includes('Page.navigate') && !r1.success && !r2.success, `${other.methods.filter((m) => m.startsWith('Page.r') || m === 'Page.navigate').join(',')} | ${said(r1)}`);
  process.env['JARVIS_CHROME_PROFILE'] = path.join(workspace, 'no-chrome-profile');
}
{
  // R4: the tab id is read from the end of the result, not from a page title.
  const c = await fakeChrome([{ ...GMAIL, visible: true }, { title: 'YouTube (tab DEADBEEF)', url: 'https://www.youtube.com/' }]);
  use(c);
  c.ignoreClose = true;
  const r = await run('control_browser', { action: 'close', target: 'youtube' });
  ok('R4 a title with "(tab DEADBEEF)" in it: a close that did not happen is not "verified"', !r.success && r.verification?.status !== 'verified', said(r));
}
{
  // R5: two windows, each showing a YouTube tab: both are "on screen", so JARVIS asks.
  const c = await fakeChrome([{ ...YT_HOME, visible: true }, { ...YT_SEARCH, visible: true }, { ...GMAIL }]);
  use(c);
  const r = await run('control_browser', { action: 'close', target: 'youtube' });
  ok('R5 two YouTube tabs on screen (two windows): nothing closes, JARVIS asks which', c.closed.length === 0 && /which/i.test(said(r)), said(r));
}
{
  // R6: browser_state's "tab on screen" is not the first listed when none is on screen.
  const c = await fakeChrome([{ ...NEWS }, { ...GMAIL }]);
  const { readBrowserState } = await import('../perception/browserState.js');
  const state = await readBrowserState(c.port);
  ok('R6 no tab on screen: browser_state names no visible tab (not the first listed)', state.visibleTab === undefined, JSON.stringify(state.visibleTab ?? null).slice(0, 120));
}
{
  // R7: a tab is reused only for the same scheme, host and port.
  const c = await fakeChrome([{ title: 'Vite app', url: 'http://localhost:5173/', visible: true }, { title: 'Example login', url: 'http://www.example.com/login' }]);
  const chrome = new JarvisChrome({ env: { JARVIS_CDP_PORT: String(c.port), JARVIS_CHROME_PROFILE: path.join(workspace, 'p7') } });
  await showInJarvisChrome('http://localhost:3000/', chrome);
  ok('R7 localhost:3000 is not the open localhost:5173 tab: a new tab opens', c.opened.includes('http://localhost:3000/'), c.opened.join(','));
  await showInJarvisChrome('https://example.com/', chrome);
  ok('R7 https://example.com/ is not the open http:// tab: a new tab opens', c.opened.includes('https://example.com/'), c.opened.join(','));
}
{
  // R8: the last two tabs closed at once: JARVIS's Chrome stays open.
  const c = await fakeChrome([{ ...YT_HOME, visible: true }, { ...YT_SEARCH }]);
  use(c);
  const { closeTabKeepingChrome } = await import('../control/jarvisChrome.js');
  const [a, b] = c.pages.map((p) => p.id);
  await Promise.all([closeTabKeepingChrome(a!, c.port), closeTabKeepingChrome(b!, c.port)]).catch(() => undefined);
  await sleep(150);
  ok('R8 the last two tabs closed at the same time: Chrome stays open on a blank tab', c.up && c.pages.length === 1 && c.pages[0]!.url === 'about:blank', `up=${c.up} ${c.pages.map((p) => p.url).join(',')}`);
}
{
  // R10: page titles in the question are redacted.
  const key = `sk-proj-${'A1b2C3d4'.repeat(5)}`;
  const c = await fakeChrome([{ title: `YouTube ${key}`, url: 'https://www.youtube.com/' }, { ...YT_SEARCH }, { ...GMAIL, visible: true }]);
  use(c);
  const r = await run('control_browser', { action: 'close', target: 'youtube' });
  ok('R10 a secret in a page title is not repeated in the question', /which/i.test(said(r)) && !said(r).includes(key.slice(0, 20)), said(r));
  const { resolveTab } = await import('../perception/tabResolver.js');
  const choice = await resolveTab('youtube', c.port);
  ok('R10 …the finder\'s own question is redacted (not only later on the way to the reply)', choice.kind === 'ask' && !choice.question.includes(key.slice(0, 20)), choice.kind === 'ask' ? choice.question : choice.kind);
}

// ── 9. Review round 2 ───────────────────────────────────────────────────────
console.log('--- 9. review round 2 ---');
{
  // R12: Chrome minimised, two video tabs: pause goes to the most recently used one (listed first), not the oldest.
  const c = await fakeChrome([
    { title: 'Playing now - YouTube', url: 'https://www.youtube.com/watch?v=now' },
    { title: 'Old video - YouTube', url: 'https://www.youtube.com/watch?v=old' },
  ]);
  use(c);
  const { VIDEO_PAUSE_SCRIPT } = await import('../perception/cdpScripts.js');
  const { playback } = await import('../control/youtubeControl.js');
  await playback('pause').catch(() => undefined);
  const paused = c.evaluated.filter((e) => e.expr === VIDEO_PAUSE_SCRIPT).map((e) => titleOf(c, e.page));
  ok('R12 Chrome minimised, two video tabs: "pause" goes to the most recently used one', paused.length >= 1 && paused.every((t) => t === 'Playing now - YouTube'), paused.join(', ') || 'no pause sent');
}

for (const f of fakes) await f.stop();
permissionSession.deactivateFullControl('test');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
