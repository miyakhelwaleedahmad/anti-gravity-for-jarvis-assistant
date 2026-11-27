/**
 * tests/tabRouteReplyA4Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase A4, owner's approval of 2026-11-01: what JARVIS says when the fast
 * tab routes ("close youtube tab", "close this tab") do not act.
 *
 *   1. JARVIS asks which tab: the question alone, not after "I tried to close
 *      … but encountered an issue, sir."
 *   2. JARVIS's Chrome is not running: JARVIS says so (it used to say only
 *      "encountered an issue", the reason being longer than the route keeps)
 *   3. unchanged: success, the full-control hint, other failures
 *
 * Fake Chrome; the real orchestrator.speak() runs, only tts.py is replaced.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { installFakeTts } from './fakeTts.js';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tab-reply-a4-'));
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

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { orchestrator } = await import('../core/orchestrator.js');
{ const { worldState } = await import('../core/worldState.js'); (worldState as any).refresh = async () => {}; }
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { permissionSession } = await import('../control/permissionSession.js');
registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();
modelRouter.chat = async () => ({ content: '' }) as any;
modelRouter.streamChat = async function* () { yield ''; } as any;
const spoken: string[] = [];
installFakeTts(orchestrator, (await import('../bridge/nodeBridge.js')).nodeBridge, 5, spoken, true);

type Tab = { title: string; url: string; visible?: boolean };
/** What JARVIS says for `input`, with these tabs in JARVIS's Chrome (null: no Chrome). */
async function say(input: string, tabs: Tab[] | null, full = false): Promise<{ said: string; chrome?: FakeChrome }> {
  let chrome: FakeChrome | undefined;
  if (tabs) { chrome = await fakeChrome(tabs); process.env['JARVIS_CDP_PORT'] = String(chrome.port); }
  else { const gone = await fakeChrome([]); process.env['JARVIS_CDP_PORT'] = String(gone.port); await gone.stop(); }
  if (full) permissionSession.activateFullControl(5, 'cli'); else permissionSession.deactivateFullControl('test');
  spoken.length = 0;
  await orchestrator.process(input, 'cli');
  await sleep(200);
  return { said: spoken.join(' | '), chrome };
}
const ISSUE = /encountered an issue/i;
const YT = { title: 'YouTube', url: 'https://www.youtube.com/' };
const YTS = { title: 'lofi beats - YouTube', url: 'https://www.youtube.com/results?search_query=lofi' };
const GM = { title: 'Inbox - Gmail', url: 'https://mail.google.com/' };

console.log('\n=== Fast tab routes: what JARVIS says (phase A4) ===\n');

console.log('--- 1. JARVIS asks which tab ---');
{
  const { said, chrome } = await say('close youtube tab', [YT, YTS, { ...GM, visible: true }]);
  ok('two YouTube tabs, neither on screen: JARVIS asks which, naming both', /^Which tab, sir\?/.test(said) && said.includes('lofi beats') && /"YouTube"/.test(said), said);
  ok('…without "I tried to close … but encountered an issue" first', !ISSUE.test(said), said);
  ok('…and nothing closed', chrome!.closed.length === 0);
}
{
  const { said, chrome } = await say('close this tab', [GM, YT], true);
  ok('"close this tab" with no tab on screen: JARVIS says so and asks which', /^No tab is on screen/.test(said) && /which tab/i.test(said), said);
  ok('…without "encountered an issue" first', !ISSUE.test(said), said);
  ok('…and nothing closed', chrome!.closed.length === 0);
}

console.log('--- 2. JARVIS\'s Chrome is not running ---');
{
  const { said } = await say('close youtube tab', null);
  ok('"close youtube tab": JARVIS says its Chrome is not running and no tab was changed', /Chrome is not running/i.test(said) && /did not change any tab/i.test(said), said);
  ok('…not just "encountered an issue"', !ISSUE.test(said), said);
}
{
  const { said } = await say('close this tab', null, true);
  ok('"close this tab" (full control on): the same', /Chrome is not running/i.test(said) && /did not change any tab/i.test(said) && !ISSUE.test(said), said);
}

console.log('--- 3. unchanged ---');
{
  const { said, chrome } = await say('close youtube tab', [{ ...GM, visible: true }, YT]);
  ok('one YouTube tab: "Closing the youtube tab, sir." and it closes', said === 'Closing the youtube tab, sir.' && chrome!.closed.length === 1, said);
}
{
  const { said } = await say('close this tab', [{ ...GM, visible: true }]);
  ok('"close this tab" with full control off: the full-control hint', /full control mode/i.test(said) && !/^Which tab/.test(said), said);
}
{
  const { said, chrome } = await say('close this tab', [{ ...GM, visible: true }, YT], true);
  ok('"close this tab" with full control on: "Closing current tab, sir."', said === 'Closing current tab, sir.' && chrome!.closed.length === 1, said);
}
{
  const { said } = await say('close the gmail tab', [{ ...YT, visible: true }], true);
  ok('no tab matches: not taken for a question or for "Chrome is not running"', !/^Which tab|^No tab is on screen|Chrome is not running/i.test(said) && said.length > 0, said);
}

console.log('--- 4. review round 3 (R18): only JARVIS\'s own reason counts ---');
{
  const { tabRouteReply } = await import('../control/tabClose.js');
  const phrase = "JARVIS's own Chrome is not running, so no tab was changed";
  ok('a refusal that quotes a page titled with the phrase is not taken for "Chrome is not running"',
    tabRouteReply({ error: `Permission level 2 required to close the tab "${phrase}".` }) === undefined);
  ok('…nor an output that contains it', tabRouteReply({ error: 'TOOL_ERROR', output: `title: ${phrase}` }) === undefined);
  ok('the real reason still gives the reply', tabRouteReply({ error: `${phrase} (it starts when JARVIS opens a page).` }) === 'My Chrome is not running, sir, so I did not change any tab.');
  ok('a question in the middle of an error is not said', tabRouteReply({ error: 'Something failed. Which tab, sir? x' }) === undefined);
}

for (const f of fakes) await f.stop();
permissionSession.deactivateFullControl('test');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
