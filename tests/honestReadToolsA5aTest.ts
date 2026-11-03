/**
 * tests/honestReadToolsA5aTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase A5a (audit TRA-07; owner's choices of 2026-11-03: Q1 say so and do not
 * start Chrome, Q2 read Chrome live). Without Chrome or PowerShell the read
 * tools answered an empty list or "false" with success, and "is youtube open"
 * said "No".
 *
 *   1. tab tools, JARVIS's Chrome not running: a failure with the reason, not "false" / []
 *   2. tab tools, JARVIS's Chrome running: read live (not the 12 s snapshot); empty stays empty
 *   3. the routes say so ("My Chrome is not running…"), never a false "No"
 *   4. window tools, the window list cannot be read: a failure, not []; the planner's world state says so too
 *      (PowerShell is a stand-in here, so the test is the same with or without it: review R1)
 *   5. unchanged: an action never gets a stale window list; really-empty is still a success
 *
 * Chrome is a fake DevTools server (HTTP only). Nothing is opened; speech is captured.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { installFakeTts } from './fakeTts.js';

const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-read-a5a-'));
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

/** Connections to the tabs' DevTools sockets: a page touched (review R3: "is X open?" must not touch every page). */
let pageConnections = 0;

/** A fake DevTools endpoint: /json/version and /json/list only. */
async function fakeChrome(tabs: Array<{ title: string; url: string }>): Promise<{ port: number; tabs: typeof tabs; stop(): Promise<void> }> {
  const state = { port: 0, tabs, stop: async () => undefined as void };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/json/version') {
      res.end(JSON.stringify({ Browser: 'Chrome/130.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:1/devtools/browser/fake-a5a` }));
    } else if (req.url === '/json/list' || req.url === '/json') {
      // Page sockets are counted and hung up: details fail fast, the tab is still listed.
      res.end(JSON.stringify(state.tabs.map((t, i) => ({ id: `T${i}`, type: 'page', title: t.title, url: t.url, webSocketDebuggerUrl: `ws://127.0.0.1:${state.port}/devtools/page/T${i}` }))));
    } else {
      res.statusCode = 404; res.end('{}');
    }
  });
  server.on('upgrade', (_req, sock) => { pageConnections++; sock.destroy(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  state.port = (server.address() as { port: number }).port;
  state.stop = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}

const { registerAllTools } = await import('../core/tools/index.js');
const { SkillLoader } = await import('../core/skillLoader.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { orchestrator } = await import('../core/orchestrator.js');
{ const { worldState } = await import('../core/worldState.js'); (worldState as any).refresh = async () => {}; }
const { modelRouter } = await import('../bridge/modelRouter.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { agentStateMachine } = await import('../core/agentStateMachine.js');
const { systemStateObserver } = await import('../perception/systemStateObserver.js');
const { getWindowsState, psSession, freshWindowList } = await import('../perception/windowsState.js');
const { worldState } = await import('../core/worldState.js');
// PowerShell, stood in for on every machine (review R1): no answer unless the test gives one.
let psAnswer: (() => string) | undefined;
psSession.stop();
(psSession as any).isAlive = () => true;
const psQuery = async () => { if (!psAnswer) throw new Error('PowerShell did not answer (test)'); return psAnswer(); };
(psSession as any).query = psQuery;
(psSession as any).queryWhenFree = psQuery;
freshWindowList.read = async () => { throw new Error('a fresh PowerShell failed too (test)'); };
const windowsJson = (apps: Array<{ name: string; pid: number; windowTitle: string }>, active = '') =>
  JSON.stringify({ activeWindow: { title: active, processName: active ? 'notepad' : '', pid: active ? 7 : 0 }, openApps: apps });
registerAllTools();
await new SkillLoader(skillsDir).loadSkills();
await memoryManager.init();
const modelCalls: string[] = [];
modelRouter.chat = async (req: any) => { modelCalls.push('chat'); return { content: 'The model answered, sir.' } as any; };
modelRouter.streamChat = async function* () { modelCalls.push('stream'); yield 'The model answered, sir.'; } as any;
const spoken: string[] = [];
const { nodeBridge } = await import('../bridge/nodeBridge.js');
installFakeTts(orchestrator, nodeBridge, 5, spoken, true);

async function say(input: string): Promise<string> {
  spoken.length = 0;
  agentStateMachine.reset();
  await orchestrator.process(input, 'cli').catch((e: Error) => spoken.push(`THROWN: ${e.message}`));
  await sleep(250);
  return spoken.join(' | ');
}
const run = (tool: string, args: Record<string, unknown> = {}) => toolRegistryV2.execute(tool, args);
/** The observer's snapshot, as a stale 12 s-old reading would leave it. */
const setSnapshot = (patch: Record<string, unknown>) => { Object.assign((systemStateObserver as any).state, patch); };
const NOT_RUNNING = /JARVIS's own Chrome is not running/;

console.log('\n=== Honest read tools (phase A5a) ===\n');

console.log('--- 1. tab tools, JARVIS\'s Chrome not running ---');
{
  setSnapshot({ chrome: { running: false, debugPort: 9222, tabs: [], error: 'Chrome DevTools endpoint unavailable' } });
  const open = await run('is_tab_open', { tabNameOrUrl: 'youtube' });
  ok('is_tab_open: a failure, not "false"', !open.success && open.output !== 'false', `${open.success} ${open.output}`);
  ok('…with the reason: JARVIS\'s Chrome is not running', NOT_RUNNING.test(`${open.error ?? ''} ${open.output}`), open.error ?? open.output);
  const tabs = await run('get_browser_tabs');
  ok('get_browser_tabs: a failure, not []', !tabs.success && tabs.output.trim() !== '[]', `${tabs.success} ${tabs.output.slice(0, 80)}`);
  ok('…with the reason', NOT_RUNNING.test(`${tabs.error ?? ''} ${tabs.output}`), tabs.error ?? tabs.output);
}

console.log('--- 2. tab tools, JARVIS\'s Chrome running: read live ---');
const chrome = await fakeChrome([{ title: 'YouTube', url: 'https://www.youtube.com/' }, { title: 'Inbox - Gmail', url: 'https://mail.google.com/' }]);
process.env['JARVIS_CDP_PORT'] = String(chrome.port);
{
  // A stale snapshot that disagrees with Chrome: an old tab, and no YouTube.
  setSnapshot({ chrome: { running: true, debugPort: chrome.port, tabs: [{ title: 'Old closed tab', url: 'https://old.example/', active: true }] } });
  const yt = await run('is_tab_open', { tabNameOrUrl: 'youtube' });
  ok('is_tab_open youtube: "true", read from Chrome (the snapshot has no YouTube)', yt.success && yt.output === 'true', `${yt.success} ${yt.output}`);
  const old = await run('is_tab_open', { tabNameOrUrl: 'old closed' });
  ok('…a tab only in the stale snapshot: "false"', old.success && old.output === 'false', `${old.success} ${old.output}`);
  const none = await run('is_tab_open', { tabNameOrUrl: 'github' });
  ok('…a tab that is not open: "false", a success', none.success && none.output === 'false', `${none.success} ${none.output}`);
  const tabs = await run('get_browser_tabs');
  const list = (() => { try { return JSON.parse(tabs.output); } catch { return null; } })();
  ok('get_browser_tabs: the live tabs', tabs.success && Array.isArray(list) && list.length === 2 && list.some((t: any) => t.title === 'YouTube') && !list.some((t: any) => /Old closed/.test(t.title)), tabs.output.slice(0, 160));
  // More than 20 tabs (review R2): the oldest is still found and counted.
  chrome.tabs = [...Array.from({ length: 21 }, (_, i) => ({ title: `Page ${i}`, url: `https://example.com/${i}` })), { title: 'Spotify oldest', url: 'https://open.spotify.com/' }];
  pageConnections = 0;
  const far = await run('is_tab_open', { tabNameOrUrl: 'spotify' });
  ok('22 tabs: the 22nd is found ("true")', far.success && far.output === 'true', `${far.success} ${far.output}`);
  ok('…without touching any page (one tab list, no per-tab socket: review R3)', pageConnections === 0, `${pageConnections} page connection(s)`);
  const many = await run('get_browser_tabs');
  const manyList = (() => { try { return JSON.parse(many.output); } catch { return null; } })();
  ok('…and get_browser_tabs lists all 22', many.success && Array.isArray(manyList) && manyList.length === 22, `${Array.isArray(manyList) ? manyList.length : many.output.slice(0, 80)}`);
  ok('(the page counter works: get_browser_tabs, which reads per-tab details, is seen)', pageConnections > 0, `${pageConnections} page connection(s)`);
  chrome.tabs = [];
  const empty = await run('get_browser_tabs');
  ok('…no tab open: [] and a success (really empty)', empty.success && empty.output.trim() === '[]', `${empty.success} ${empty.output}`);
}
{
  // Chrome answers, but its tab list fails: not "no tabs".
  const broken = http.createServer((req, res) => {
    if (req.url === '/json/version') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ Browser: 'Chrome/130.0', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/broken' })); }
    else { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise<void>((r) => broken.listen(0, '127.0.0.1', () => r()));
  const saved = process.env['JARVIS_CDP_PORT'];
  process.env['JARVIS_CDP_PORT'] = String((broken.address() as { port: number }).port);
  const open = await run('is_tab_open', { tabNameOrUrl: 'youtube' });
  ok('Chrome running but its tab list fails: is_tab_open is a failure, not "false"', !open.success && open.output !== 'false', `${open.success} ${(open.error ?? open.output).slice(0, 120)}`);
  process.env['JARVIS_CDP_PORT'] = saved;
  await new Promise<void>((r) => broken.close(() => r()));
}

{
  // JARVIS's own Chrome found by its profile, not JARVIS_CDP_PORT (review R8).
  const profile = process.env['JARVIS_CHROME_PROFILE']!;
  fs.mkdirSync(profile, { recursive: true });
  chrome.tabs = [{ title: 'YouTube', url: 'https://www.youtube.com/' }];
  delete process.env['JARVIS_CDP_PORT'];
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${chrome.port}\n/devtools/browser/another-chrome\n`);
  const stale = await run('is_tab_open', { tabNameOrUrl: 'youtube' });
  ok('a stale profile file (another Chrome on that port): not read, "not running"', !stale.success && NOT_RUNNING.test(stale.error ?? ''), stale.error ?? stale.output);
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${chrome.port}\n/devtools/browser/fake-a5a\n`);
  const mine = await run('is_tab_open', { tabNameOrUrl: 'youtube' });
  ok('JARVIS\'s Chrome from its profile file: read ("true")', mine.success && mine.output === 'true', `${mine.success} ${mine.output}`);
  fs.rmSync(path.join(profile, 'DevToolsActivePort'));
  // JARVIS_CDP_PORT set and nothing answers there (review R6): the owner's Chrome, not "JARVIS's own".
  process.env['JARVIS_CDP_PORT'] = '1';
  const fixed = await run('is_tab_open', { tabNameOrUrl: 'youtube' });
  ok('JARVIS_CDP_PORT set, nothing on it: a failure that names JARVIS_CDP_PORT, not "JARVIS\'s own Chrome"', !fixed.success && /JARVIS_CDP_PORT/.test(fixed.error ?? '') && !NOT_RUNNING.test(fixed.error ?? ''), fixed.error ?? fixed.output);
  process.env['JARVIS_CDP_PORT'] = String(chrome.port);
}

console.log('--- 3. the routes ---');
{
  chrome.tabs = [{ title: 'YouTube', url: 'https://www.youtube.com/' }];
  let said = await say('is youtube open');
  ok('"is youtube open", a YouTube tab open: "Yes…"', /^Yes, the youtube tab is open, sir\.$/.test(said), said);
  chrome.tabs = [{ title: 'Inbox - Gmail', url: 'https://mail.google.com/' }];
  said = await say('is youtube open');
  ok('…no YouTube tab: "No…"', /^No, the youtube tab is not open, sir\.$/.test(said), said);
  said = await say('what tabs are open');
  ok('"what tabs are open": the live tab', /One tab is open, sir\./.test(said) && /Gmail/.test(said), said);
  await chrome.stop();
  delete process.env['JARVIS_CDP_PORT'];
  setSnapshot({ chrome: { running: true, debugPort: 9222, tabs: [{ title: 'YouTube', url: 'https://www.youtube.com/', active: true }] } });
  said = await say('is youtube open');
  ok('JARVIS\'s Chrome down: "is youtube open" says so (Q1), not "No"', /My Chrome is not running, sir, so I can't see its tabs\./.test(said) && !/^No,/.test(said), said);
  ok('…nor "Yes" from the stale snapshot', !/^Yes/.test(said), said);
  said = await say('what tabs are open');
  ok('"what tabs are open" with Chrome down: says so, lists no stale tab', /My Chrome is not running, sir, so I can't see its tabs\./.test(said) && !/YouTube/.test(said), said);
  ok('…and no model call for these routes', modelCalls.length === 0, `${modelCalls.length} call(s)`);
}

console.log('--- 4. window tools, the window list cannot be read ---');
{
  // The stand-in PowerShell does not answer: the read fails.
  const read = await getWindowsState({ allowStale: true });
  ok('getWindowsState says why it has no windows', typeof (read as any).unavailable === 'string' && (read as any).unavailable.length > 0, String((read as any).unavailable));
  await (systemStateObserver as any).pollWindowsState();
  const apps = await run('get_open_apps');
  ok('get_open_apps: a failure, not []', !apps.success && apps.output.trim() !== '[]', `${apps.success} ${apps.output.slice(0, 100)}`);
  ok('…with the reason of this read (not only "not read yet")', /could not be read/.test(apps.error ?? '') && !/has not been read yet/.test(apps.error ?? ''), apps.error ?? '');
  const app = await run('is_app_open', { appName: 'notepad' });
  ok('is_app_open: a failure, not "false", with the reason', !app.success && app.output !== 'false' && /could not be read/.test(app.error ?? ''), `${app.success} ${(app.error ?? app.output).slice(0, 100)}`);
  const win = await run('get_active_window');
  ok('get_active_window: a failure, not an empty window, with the reason', !win.success && /could not be read/.test(win.error ?? ''), `${win.success} ${(win.error ?? win.output).slice(0, 100)}`);
  const planner = worldState.summarize('which apps are running');
  ok('the planner\'s world state says the windows could not be read, not "open: none" (review R4)', /apps[^\n]*not readable/.test(planner) && !/open: none/.test(planner), planner.slice(0, 200));
  const said = await say('whats running');
  ok('"whats running": says the windows could not be read, lists no apps', /can't read the open windows/i.test(said) && !/apps? open, sir/.test(said), said);
}

console.log('--- 5. unchanged ---');
{
  // A good reading first (kept for background polls), then PowerShell stops answering.
  psAnswer = () => windowsJson([{ name: 'notepad', pid: 7, windowTitle: 'notes.txt - Notepad' }], 'notes.txt - Notepad');
  const good = await getWindowsState({ allowStale: true });
  ok('(setup) a reading with Notepad', good.openApps.length === 1 && !good.unavailable, JSON.stringify(good.openApps));
  psAnswer = undefined;
  const forAction = await getWindowsState({});
  ok('an action never gets the stale list when the read fails (no Notepad), and it says why', forAction.openApps.length === 0 && forAction.activeWindow.title === '' && !!forAction.unavailable, `${JSON.stringify(forAction.openApps)} ${forAction.unavailable}`);
  psAnswer = () => windowsJson([]);
  await (systemStateObserver as any).pollWindowsState();
  const apps = await run('get_open_apps');
  ok('a list that was read and is really empty: [] and a success', apps.success && apps.output.trim() === '[]', `${apps.success} ${apps.output}`);
  psAnswer = () => windowsJson([{ name: 'notepad', pid: 7, windowTitle: 'notes.txt - Notepad' }], 'notes.txt - Notepad');
  await (systemStateObserver as any).pollWindowsState();
  const app = await run('is_app_open', { appName: 'notepad' });
  ok('…and an app in a read list is found ("true")', app.success && app.output === 'true', `${app.success} ${app.output}`);
  const said = await say('whats running');
  ok('"whats running" with a read list: the apps, as before', /1 app open, sir: notepad/.test(said), said);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
