/**
 * evidence/spoken_probe.mts — what JARVIS says on the fast routes of phase A4
 * (owner's request, 2026-11-01: "confirm that the incorrect spoken fallback
 * message is fixed"). Fake Chrome; the speech is captured, not played.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

const repo = process.cwd();
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-a4-spoken-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_CHROME_PROFILE'] = path.join(workspace, 'no-profile');
process.env['JARVIS_CHROME_AUTOSTART'] = 'off';
delete process.env['JARVIS_CDP_PORT'];
process.chdir(workspace);
const imp = (p: string) => import(path.join(repo, p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { VISIBILITY_SCRIPT } = await imp('perception/cdpScripts.ts');
const { WebSocketServer } = await import(path.join(repo, 'node_modules/ws/wrapper.mjs'));
// ── A fake Chrome ────────────────────────────────────────────────────────────
interface FakePage { id: string; type: 'page'; title: string; url: string; webSocketDebuggerUrl: string; visible: boolean }
interface FakeChrome {
  port: number; socketPath: string; pages: FakePage[]; closed: string[]; opened: string[]; activated: string[];
  /** DevTools methods sent to its pages (Page.reload, Page.navigate, …). */
  methods: string[];
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
    port: 0, socketPath: `/devtools/browser/${randomUUID()}`, pages: [], closed: [], opened: [], activated: [], methods: [],
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

const { registerAllTools } = await imp('core/tools/index.ts');
const { SkillLoader } = await imp('core/skillLoader.ts');
const { orchestrator } = await imp('core/orchestrator.ts');
{ const { worldState } = await imp('core/worldState.ts'); (worldState as any).refresh = async () => {}; }
const { modelRouter } = await imp('bridge/modelRouter.ts');
const { memoryManager } = await imp('memory/memoryManager.ts');
const { permissionSession } = await imp('control/permissionSession.ts');
const { installFakeTts } = await imp('tests/fakeTts.ts');
registerAllTools();
await new SkillLoader(path.join(repo, 'skills')).loadSkills();
await memoryManager.init();
modelRouter.chat = async () => ({ content: '' }) as any;
modelRouter.streamChat = async function* () { yield ''; } as any;
const spoken: string[] = [];
installFakeTts(orchestrator, (await imp('bridge/nodeBridge.ts')).nodeBridge, 5, spoken, true);

async function say(label: string, input: string, tabs: Array<{ title: string; url: string; visible?: boolean }> | null, opts: { full?: boolean; closeDelayMs?: number } = {}) {
  let c: FakeChrome | undefined;
  if (tabs) { c = await fakeChrome(tabs); c.closeDelayMs = opts.closeDelayMs ?? 0; process.env['JARVIS_CDP_PORT'] = String(c.port); }
  else { const d = await fakeChrome([]); process.env['JARVIS_CDP_PORT'] = String(d.port); await d.stop(); }
  if (opts.full) permissionSession.activateFullControl(5, 'cli'); else permissionSession.deactivateFullControl('probe');
  spoken.length = 0;
  await orchestrator.process(input, 'cli');
  await sleep(200);
  console.log(`CASE ${label}\n  typed: "${input}"\n  said:  ${spoken.join(' | ') || '(nothing)'}\n  tabs after: ${c ? (c.up ? c.pages.map((p) => p.title).join(', ') || '(none)' : 'Chrome exited') : '-'}`);
}
const YT = { title: 'YouTube', url: 'https://www.youtube.com/' };
const YTS = { title: 'lofi beats - YouTube', url: 'https://www.youtube.com/results?search_query=lofi' };
const GM = { title: 'Inbox - Gmail', url: 'https://mail.google.com/' };
await say('1 one YouTube tab', 'close youtube tab', [{ ...GM, visible: true }, YT]);
await say('2 slow close (0.6 s)', 'close the youtube tab', [{ ...GM, visible: true }, YT], { closeDelayMs: 600 });
await say('3 two YouTube tabs, neither on screen', 'close youtube tab', [YT, YTS, { ...GM, visible: true }]);
await say('4 the last tab', 'close youtube tab', [{ ...YT, visible: true }]);
await say('5 Chrome not running', 'close youtube tab', null);
await say('6 close this tab, full control off', 'close this tab', [{ ...GM, visible: true }]);
await say('7 close this tab, full control on', 'close this tab', [{ ...GM, visible: true }, YT], { full: true });
await say('8 close this tab, none on screen', 'close this tab', [GM, YT], { full: true });
await say('9 "youtube" matches only a Google sign-in page', 'close youtube tab', [{ title: 'Sign in - Google Accounts', url: 'https://accounts.google.com/ServiceLogin?continue=https://www.youtube.com/', visible: true }]);
for (const f of fakes) await f.stop();
permissionSession.deactivateFullControl('probe');
process.exit(0);
