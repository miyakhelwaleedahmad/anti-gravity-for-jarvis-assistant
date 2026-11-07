/**
 * tests/browserContractsB2Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase B2: the audit's browser contracts (2026-10-25, section F) that no
 * test covered. The others have their checks elsewhere (map in
 * ai_workflows/runs/2026-11-07_browser-contracts-b2/diagnosis.md).
 *
 *  1. Contracts 5 and 6 — a Chrome that is slow to answer is busy, not "not
 *     running", and a change it may already have made is not sent again: one
 *     "open this address" opened two tabs (diagnosis D1, D2). A fake Chrome
 *     that does the change at once and answers late. "Connection refused"
 *     keeps its wording (D3).
 *  2. Contract 2 — closing a tab does not disconnect: in a real headless
 *     Chromium, after a tab closes, another tab is read and acted on, and the
 *     reply says nothing about the browser closing or a lost connection.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { findChromium, startChromium } from './chromeHelper.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!findChromium()) {
  console.error('No Chromium or Chrome found (set JARVIS_TEST_CHROME): section 2 needs a real browser.');
  process.exit(1);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-b2-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_CHROME_PROFILE'] = path.join(workspace, 'chrome-profile');
process.env['JARVIS_LEVEL2_POLICY'] = 'ask';
delete process.env['JARVIS_CDP_PORT'];
process.chdir(workspace);

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return '(no error)'; } catch (err) { return String((err as Error)?.message ?? err); }
};

const { openTab, closeTabById, activateTab, listPages } = await import('../perception/cdpClient.js');
const { actionQueue } = await import('../control/actionQueue.js');

// ── A fake Chrome that does each change at once and answers late ─────────────

interface SlowChrome {
  port: number;
  /** Requests per endpoint: new, close, activate, list, version; `upgrade`: DevTools connections (Browser.close goes through one). */
  hits: Record<'new' | 'close' | 'activate' | 'list' | 'version' | 'upgrade', number>;
  stop(): Promise<void>;
}

/** `versionAfterMs(n)`: how late the n-th `/json/version` answer comes (0: at once). */
async function slowChrome(answerAfterMs: number, versionAfterMs: (n: number) => number = () => 0): Promise<SlowChrome> {
  const hits = { new: 0, close: 0, activate: 0, list: 0, version: 0, upgrade: 0 };
  const late = (res: http.ServerResponse, body: unknown, ms = answerAfterMs) => setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }, ms);
  let port = 0;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/json/version') {
      hits.version++;
      const body = { Browser: 'Fake/1', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` };
      const after = versionAfterMs(hits.version);
      if (after > 0) { late(res, body, after); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } else if (req.method === 'PUT' && url.startsWith('/json/new')) {
      hits.new++;
      late(res, { id: `tab${hits.new}`, type: 'page', title: '', url: 'https://example.com/', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab${hits.new}` });
    } else if (url.startsWith('/json/close/')) {
      hits.close++;
      late(res, 'Target is closing');
    } else if (url.startsWith('/json/activate/')) {
      hits.activate++;
      late(res, 'Target activated');
    } else if (url === '/json/list') {
      hits.list++;
      late(res, []);
    } else {
      res.writeHead(404); res.end();
    }
  });
  server.on('upgrade', (_req, socket) => { hits.upgrade++; socket.destroy(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  return {
    port, hits,
    async stop() { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

/** Answers after 3.5 s: later than JARVIS's 3 s for a change and 2 s for a read. */
const SLOW_MS = 3_500;
const notRunning = /not running|not reachable/i;

console.log('\n=== Browser contracts (phase B2) ===\n');

const cleanups: Array<() => Promise<void>> = [];
try {
  // ── 1. Contracts 5 and 6: a slow Chrome ──────────────────────────────────
  console.log('--- 1. A Chrome that is slow to answer (contracts 5, 6) ---');
  {
    const c = await slowChrome(SLOW_MS); cleanups.push(() => c.stop());
    const msg = await message(() => actionQueue.enqueue('openUrl', () => openTab('https://example.com/', c.port), 20_000));
    ok('open a tab, Chrome answers late: the request is sent once (no second tab)', c.hits.new === 1, `${c.hits.new} request(s)`);
    ok('…JARVIS says Chrome did not answer and may be busy, not that it is not running',
      /did not answer within 3 s/.test(msg) && /busy/.test(msg) && !notRunning.test(msg), msg.slice(0, 160));
    ok('…and that it does not know whether the tab opened, and did not try again',
      /does not know whether the tab opened/.test(msg) && /not tried again/.test(msg), msg.slice(0, 160));
  }
  {
    const c = await slowChrome(SLOW_MS); cleanups.push(() => c.stop());
    const msg = await message(() => actionQueue.enqueue('closeTab', () => closeTabById('tab9', c.port), 20_000));
    ok('close a tab, Chrome answers late: the request is sent once', c.hits.close === 1, `${c.hits.close} request(s)`);
    ok('…not "not running"; it does not know whether the tab closed', /does not know whether the tab closed/.test(msg) && !notRunning.test(msg), msg.slice(0, 160));
  }
  {
    const c = await slowChrome(SLOW_MS); cleanups.push(() => c.stop());
    const msg = await message(() => actionQueue.enqueue('focusTab', () => activateTab('tab9', c.port), 20_000));
    ok('bring a tab forward, Chrome answers late: the request is sent once', c.hits.activate === 1, `${c.hits.activate} request(s)`);
    ok('…not "not running"', /did not answer within 3 s/.test(msg) && !notRunning.test(msg), msg.slice(0, 160));
  }
  {
    // End to end: "open this address" through the kernel (pcControlKernel → action queue → browserController.openUrl),
    // with the slow Chrome found as JARVIS's own (its profile's port file), as on the owner's PC: no JARVIS_CDP_PORT.
    const c = await slowChrome(SLOW_MS); cleanups.push(() => c.stop());
    const profile = process.env['JARVIS_CHROME_PROFILE']!;
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${c.port}\n/devtools/browser/fake\n`);
    const { pcControlKernel } = await import('../control/pcControlKernel.js');
    const r = await pcControlKernel.openBrowserUrl('https://example.com/');
    fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
    ok('end to end, "open this address" with a slow Chrome: one tab, not two (D2)', c.hits.new === 1, `${c.hits.new} request(s)`);
    ok('…reported as a failure that says Chrome did not answer, not "not running"',
      !r.success && /did not answer within 3 s/.test(r.error ?? '') && !notRunning.test(r.error ?? ''), String(r.error).slice(0, 160));
  }
  {
    const c = await slowChrome(SLOW_MS); cleanups.push(() => c.stop());
    const msg = await message(() => listPages(c.port));
    ok('read the tab list, Chrome answers late: "did not answer within 2 s", not "not running"',
      /did not answer within 2 s/.test(msg) && /busy/.test(msg) && !notRunning.test(msg), msg.slice(0, 160));
    const before = c.hits.list;
    await message(() => actionQueue.enqueue('listTabs', () => listPages(c.port), 20_000));
    ok('…a read is safe to repeat: the action queue still tries it a second time', c.hits.list - before === 2, `${c.hits.list - before} request(s)`);
  }
  {
    // Recoverable: nothing listens (Chrome really not running). The wording stays; opening a page retries,
    // and the retry's ensure() starts JARVIS's Chrome (D3).
    const c = await slowChrome(0); const port = c.port; await c.stop();
    const msg = await message(() => openTab('https://example.com/', port));
    ok('nothing listens on the port: still "Chrome is not reachable … not running" (unchanged)', /not reachable for JARVIS/.test(msg) && /not running/.test(msg), msg.slice(0, 120));
  }

  // ── 1b. Review F1: a Chrome slow to say it is running ───────────────────
  // jarvisChrome's running() reads /json/version. A Chrome slow there was "not running": the tab and
  // read tools said so, and opening a page started Chrome a second time (review round 1, F1).
  console.log('\n--- 1b. A Chrome slow to say it is running (review F1) ---');
  const { JarvisChrome, checkedChromePort } = await import('../control/jarvisChrome.js');
  const { liveTabList } = await import('../perception/readTools.js');
  const portFile = (dir: string, port: number) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/fake\n`);
  };
  {
    const c = await slowChrome(SLOW_MS, () => SLOW_MS); cleanups.push(() => c.stop());
    const dir = path.join(workspace, 'profile-busy');
    portFile(dir, c.port);
    const launches: string[][] = [];
    const chrome = new JarvisChrome({
      env: { JARVIS_CHROME_PROFILE: dir }, findBinary: () => '/fake/chrome', startTimeoutMs: 3_000,
      launch: (_binary: string, args: string[]) => { launches.push(args); return { exitCode: () => null }; },
    });
    const msg = await message(() => chrome.ensure());
    ok('open a page, Chrome slow to say it runs: no second Chrome is started', launches.length === 0, `${launches.length} start(s); ${msg.slice(0, 120)}`);
    ok('…JARVIS says Chrome did not answer, not that it is not running', /did not answer within 2 s/.test(msg) && !notRunning.test(msg), msg.slice(0, 160));
    const tabMsg = await message(() => checkedChromePort(chrome));
    ok('the tab tools: "did not answer", not "not running, so no tab was changed"', /did not answer within 2 s/.test(tabMsg) && !notRunning.test(tabMsg), tabMsg.slice(0, 160));
    let read: { failure?: string; tabs?: unknown[] } | string;
    try { read = await liveTabList(chrome); } catch (err) { read = `threw: ${String((err as Error)?.message ?? err)}`; }
    const failure = typeof read === 'object' ? read.failure ?? '' : '';
    ok('the read tools: a failure, not a crash, that says Chrome did not answer, not "not running"',
      typeof read === 'object' && /did not answer within 2 s/.test(failure) && !notRunning.test(failure), (typeof read === 'string' ? read : failure).slice(0, 160));
  }
  {
    // The same with JARVIS_CDP_PORT (a Chrome the owner starts on a fixed port): busy, not "nothing answers".
    const c = await slowChrome(SLOW_MS, () => SLOW_MS); cleanups.push(() => c.stop());
    const chrome = new JarvisChrome({ env: { JARVIS_CDP_PORT: String(c.port) }, findBinary: () => '/fake/chrome', startTimeoutMs: 3_000 });
    const msg = await message(() => chrome.ensure());
    ok('JARVIS_CDP_PORT, Chrome slow to answer: open a page says it did not answer, not "nothing answers"',
      /did not answer within 2 s/.test(msg) && !/Nothing answers/.test(msg), msg.slice(0, 160));
    const tabMsg = await message(() => checkedChromePort(chrome));
    ok('…and the tab tools say so too', /did not answer within 2 s/.test(tabMsg) && !notRunning.test(tabMsg), tabMsg.slice(0, 160));
  }
  {
    // JARVIS starts its Chrome and the new Chrome is slow to answer at first (a start often is): JARVIS keeps waiting.
    const dir = path.join(workspace, 'profile-start');
    const launches: string[][] = [];
    let started: SlowChrome | undefined;
    const chrome = new JarvisChrome({
      env: { JARVIS_CHROME_PROFILE: dir }, findBinary: () => '/fake/chrome', startTimeoutMs: 15_000,
      launch: (_binary: string, args: string[]) => {
        launches.push(args);
        void slowChrome(0, (n) => (n === 1 ? 2_500 : 0)).then((c) => { started = c; cleanups.push(() => c.stop()); portFile(dir, c.port); });
        return { exitCode: () => null };
      },
    });
    let port: number | string;
    try { port = await chrome.ensure(); } catch (err) { port = String((err as Error)?.message ?? err); }
    ok('JARVIS starts its Chrome, which is slow to answer at first: JARVIS waits for it and uses it',
      typeof port === 'number' && port === started?.port && launches.length === 1, `${String(port).slice(0, 140)}; ${launches.length} start(s)`);
  }

  // ── 1c. Review F10: Chrome busy when "close JARVIS's Chrome" closes it ──
  // Chrome answered "running?", the owner said yes, and Chrome was busy at close()'s own check:
  // JARVIS said "Closed JARVIS's Chrome" without sending the close (review round 2, F10).
  console.log('\n--- 1c. Chrome busy as JARVIS closes it (review F10) ---');
  {
    const { BrowserController } = await import('../control/browserController.js');
    const { permissionSession: session } = await import('../control/permissionSession.js');
    // The first /json/version (running(), before the question) answers at once; every later one is late.
    const c = await slowChrome(SLOW_MS, (n) => (n === 1 ? 0 : SLOW_MS)); cleanups.push(() => c.stop());
    const dir = path.join(workspace, 'profile-close');
    portFile(dir, c.port);
    const chrome = new JarvisChrome({
      env: { JARVIS_CHROME_PROFILE: dir }, findBinary: () => undefined,
      launch: () => { throw new Error('must not start Chrome'); },
    });
    const asked: string[] = [];
    const controller = new (BrowserController as any)({ chrome, approve: async (title: string) => { asked.push(title); return true; } });
    session.activateFullControl(5, 'cli');
    let reply = '';
    const msg = await message(async () => { reply = String(await actionQueue.enqueue('closeBrowser', () => controller.closeBrowser(), 30_000)); });
    session.deactivateFullControl('test');
    ok('Chrome busy when JARVIS closes it: no "Closed JARVIS\'s Chrome"', reply === '' && !/Closed JARVIS's Chrome/.test(msg), (reply || msg).slice(0, 160));
    ok('…it says JARVIS\'s Chrome is still open and did not answer', /JARVIS's Chrome is still open/.test(msg) && /did not answer/.test(msg), msg.slice(0, 160));
    ok('…no close was sent (no DevTools connection to Chrome)', c.hits.upgrade === 0, `${c.hits.upgrade} connection(s)`);
    ok('…the owner was asked once, and the close was not tried again', asked.length === 1 && c.hits.version === 2, `asked ${asked.length}, ${c.hits.version} version request(s)`);
  }

  // ── 2. Contract 2: closing a tab does not disconnect ─────────────────────
  console.log('\n--- 2. Closing a tab does not disconnect (contract 2) ---');
  const PAGES: Record<string, string> = {
    '/alpha': '<!doctype html><html><head><title>Alpha</title></head><body><h1>Alpha</h1></body></html>',
    '/beta': `<!doctype html><html><head><title>Beta</title></head><body><h1>Beta</h1>
      <button id="go" onclick="document.getElementById('out').textContent = 'clicked'">Show details</button>
      <p id="out"></p></body></html>`,
  };
  const site = http.createServer((req, res) => {
    const body = PAGES[(req.url ?? '').split('?')[0]!];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  cleanups.push(async () => { site.closeAllConnections(); await new Promise<void>((r) => site.close(() => r())); });
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

  const chrome = await startChromium(`${base}/alpha`);
  cleanups.push(() => chrome.stop());
  process.env['JARVIS_CDP_PORT'] = String(chrome.port);
  await openTab(`${base}/beta`, chrome.port);
  for (let i = 0; i < 150; i++) {
    const titles = (await listPages(chrome.port)).map((p) => p.title);
    if (titles.includes('Alpha') && titles.includes('Beta')) break;
    await sleep(100);
  }

  const { registerAllTools } = await import('../core/tools/index.js');
  const { SkillLoader } = await import('../core/skillLoader.js');
  const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
  const { approvalGate } = await import('../security/approvalGate.js');
  const { permissionSession } = await import('../control/permissionSession.js');
  registerAllTools();
  await new SkillLoader(path.join(repo, 'skills')).loadSkills();
  (approvalGate as any).requestApproval = async () => true;
  const unwrap = (output: string): any => {
    const m = /^<untrusted_context source="web-page">\n([\s\S]*)\n<\/untrusted_context>$/.exec(output);
    try { return JSON.parse(m ? m[1]! : output); } catch { return null; }
  };

  // Closing a tab that is not YouTube or blank needs full control (phase A4's one close rule).
  permissionSession.activateFullControl(5, 'cli');
  const closed = await toolRegistryV2.execute('browser_tab', { action: 'close', tab: 'Alpha' });
  permissionSession.deactivateFullControl('test');
  ok('browser_tab close "Alpha": done and checked', closed.success && closed.verification?.status === 'verified', `${closed.verification?.status} ${closed.output.slice(0, 100)}`);
  ok('…the reply says nothing about the browser closing or a lost connection',
    !/(browser|chrome) (is |was |has been )?(closed|gone|stopped)|disconnect|connection/i.test(`${closed.output} ${closed.verification?.evidence ?? ''}`),
    closed.output.slice(0, 160));
  const after = await listPages(chrome.port);
  ok('Chrome is still running, with Beta open and Alpha gone',
    after.some((p) => p.title === 'Beta') && !after.some((p) => p.title === 'Alpha'), after.map((p) => p.title).join(', '));

  const look = await toolRegistryV2.execute('browser_page_structure', { tab: 'Beta' });
  const page = unwrap(look.output);
  const button = page?.buttons?.find((b: any) => b.text === 'Show details')?.ref;
  ok('after the close, another tab is read: Beta\'s page structure, with its button', look.success && !!button, look.output.slice(0, 120));

  const click = await toolRegistryV2.execute('browser_click', { ref: button });
  ok('…and acted on: the click in Beta is done and checked', click.success && click.verification?.status === 'verified',
    `${click.verification?.status} ${click.verification?.evidence ?? click.output.slice(0, 100)}`);
  delete process.env['JARVIS_CDP_PORT'];
} catch (err) {
  ok('the test ran to the end', false, String((err as Error)?.stack ?? err).slice(0, 400));
} finally {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
