/**
 * tests/closeByNameTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Closing apps and windows by the names people use (audit 2026-10-25,
 * TRA-04, TRA-18, TRA-06; run ai_workflows/runs/2026-10-25_close-by-name-and-window-close).
 *
 *  1. TRA-04: "close notepad" never matched. The launch aliases turned
 *     notepad into notepad.exe, chrome into chrome.exe and calculator into
 *     calc.exe, and those were compared with Process.ProcessName, which has no
 *     ".exe"; Calculator's window belongs to ApplicationFrameHost.
 *  2. TRA-18: a site name closed whole browser windows. "youtube" matched the
 *     title "YouTube - Google Chrome" and every such Chrome window closed;
 *     "google chrome" closed them all. By the owner's decision (D3) app,
 *     window and process tools never close or kill the browser; closing it
 *     is for JARVIS's own Chrome only. Several matching windows: JARVIS asks.
 *     For "close … tab" the planner is no longer offered the app and window
 *     tools.
 *  3. TRA-06: a process kill took the first name containing the text and
 *     said "Successfully terminated" whatever Stop-Process did.
 *
 * The window list, win_automate.ps1, PowerShell and the approval question
 * are stand-ins given to the controllers; the window and process lists look
 * like the real ones (names as Process.ProcessName gives them). The last part
 * goes through the real kernel, with nothing replaced, to check that a
 * controller's failure is not reported as success.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-close-by-name-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;

const { AppController } = await import('../control/appController.js');
const { WindowController } = await import('../control/windowController.js');
const { ProcessController } = await import('../control/processController.js');
const { permissionSession } = await import('../control/permissionSession.js');
const { pcControlKernel } = await import('../control/pcControlKernel.js');
const { actionQueue } = await import('../control/actionQueue.js');
const { runApproved, currentApproval } = await import('../security/approvalScope.js');
const { VERIFIERS, windowChecks } = await import('../core/verifiers.js');
type WindowsStateResult = import('../perception/windowsState.js').WindowsStateResult;

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
async function error(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ''; } catch (err) { return err instanceof Error ? err.message : String(err); }
}

type App = WindowsStateResult['openApps'][number];
const NOTEPAD: App = { name: 'notepad', pid: 101, windowTitle: 'Untitled - Notepad', hwnd: '0x1A' };
const NOTEPAD_2: App = { name: 'notepad', pid: 102, windowTitle: 'todo.txt - Notepad', hwnd: '0x1B' };
const YOUTUBE: App = { name: 'chrome', pid: 202, windowTitle: 'YouTube - Google Chrome', hwnd: '0x2B' };
const GMAIL: App = { name: 'chrome', pid: 203, windowTitle: 'Inbox - Gmail - Google Chrome', hwnd: '0x2C' };
const EDGE: App = { name: 'msedge', pid: 250, windowTitle: 'YouTube Music - Microsoft Edge', hwnd: '0x2F' };
const CALCULATOR: App = { name: 'ApplicationFrameHost', pid: 303, windowTitle: 'Calculator', hwnd: '0x3D' };
const CODE: App = { name: 'Code', pid: 404, windowTitle: 'app.ts - jarvis - Visual Studio Code', hwnd: '0x4E' };
const DESKTOP = [NOTEPAD, YOUTUBE, GMAIL, CALCULATOR, CODE];

/** A controller's stand-ins: what is on screen, the window actions run, the questions asked. */
function desk(apps: App[], answer = true, everyWindow: App[] = apps) {
  const actions: string[][] = [];
  const asked: string[] = [];
  const deps = {
    windows: async (): Promise<WindowsStateResult> => ({
      activeWindow: { title: apps[0]?.windowTitle ?? '', processName: apps[0]?.name ?? '', pid: apps[0]?.pid ?? 0, hwnd: apps[0]?.hwnd ?? '' },
      openApps: apps.map((a) => ({ ...a })),
    }),
    automate: async (args: string[]) => { actions.push(args); return 'ok'; },
    approve: async (title: string, command: string) => { asked.push(`${title}: ${command}`); return answer; },
    allWindows: async () => everyWindow.map((a) => ({ ...a })),
  };
  const closed = () => actions.filter((a) => a.includes('close')).map((a) => a[a.indexOf('-Hwnd') + 1]);
  const focused = () => actions.filter((a) => a.includes('focus')).map((a) => a[a.indexOf('-Hwnd') + 1]);
  return { deps, actions, asked, closed, focused };
}

permissionSession.activateFullControl(5, 'cli');

console.log('\n=== Close by name ===\n');

// ── 1. TRA-04: the names people say match Windows' names ─────────────────────
console.log('--- 1. close and focus by common name (TRA-04) ---');
{
  const d = desk(DESKTOP);
  const reply = await new AppController(d.deps).closeApp('notepad').catch((e: Error) => e.message);
  ok('"close notepad" closes the Notepad window', JSON.stringify(d.closed()) === '["0x1A"]', `${reply}; closed ${JSON.stringify(d.closed())}`);
}
{
  const d = desk(DESKTOP);
  const reply = await new AppController(d.deps).closeApp('Notepad.exe').catch((e: Error) => e.message);
  ok('"close Notepad.exe" closes the same window', JSON.stringify(d.closed()) === '["0x1A"]', reply);
}
{
  const d = desk(DESKTOP);
  const reply = await new AppController(d.deps).closeApp('calculator').catch((e: Error) => e.message);
  ok('"close calculator" closes the Calculator window (ApplicationFrameHost), with no extra question', JSON.stringify(d.closed()) === '["0x3D"]' && d.asked.length === 0, `${reply}; asked ${d.asked.join(' | ') || 'nothing'}`);
}
{
  // A Chrome tab about calculators is a tab, not a reason to refuse Calculator.
  const d = desk([{ name: 'chrome', pid: 205, windowTitle: 'calculator - Google Search - Google Chrome', hwnd: '0x2D' }, CALCULATOR]);
  const app = await new AppController(d.deps).closeApp('calculator').catch((e: Error) => e.message);
  const w = desk([{ name: 'chrome', pid: 205, windowTitle: 'calculator - Google Search - Google Chrome', hwnd: '0x2D' }, CALCULATOR]);
  const win = await new WindowController(w.deps).closeWindow('calculator').catch((e: Error) => e.message);
  ok('"close calculator" with a Chrome tab about calculators: Calculator closes, Chrome stays (both tools)',
    JSON.stringify(d.closed()) === '["0x3D"]' && JSON.stringify(w.closed()) === '["0x3D"]', `app: ${app}; window: ${win}`);
}
{
  // Not Calculator: a Notepad file named calculator.py.
  const d = desk([{ ...NOTEPAD, windowTitle: 'calculator.py - Notepad' }], false);
  const message = await error(() => new AppController(d.deps).closeApp('calculator'));
  ok('"close calculator" with only "calculator.py - Notepad" open: asks first; on no, nothing closed', d.asked.length === 1 && d.closed().length === 0, message || d.asked.join(' | '));
}
{
  // A Store app's window: ApplicationFrameHost shows Photos too.
  const d = desk([{ name: 'ApplicationFrameHost', pid: 310, windowTitle: 'calculator.png - Photos', hwnd: '0x3E' }], false);
  const message = await error(() => new AppController(d.deps).closeApp('calculator'));
  ok('"close calculator" with only "calculator.png - Photos" (ApplicationFrameHost): asked first; on no, nothing closed', d.asked.length === 1 && d.closed().length === 0, message || d.asked.join(' | '));
}
for (const [label, win] of [
  ['CalculatorApp (Windows 11)', { name: 'CalculatorApp', pid: 311, windowTitle: 'Calculator', hwnd: '0x3F' }],
  ['SystemSettings, for "settings"', { name: 'SystemSettings', pid: 312, windowTitle: 'Settings', hwnd: '0x40' }],
] as const) {
  const d = desk([win]);
  const target = label.includes('settings') ? 'settings' : 'calculator';
  const reply = await new AppController(d.deps).closeApp(target).catch((e: Error) => e.message);
  ok(`"close ${target}" in ${label}: closed, no extra question`, JSON.stringify(d.closed()) === JSON.stringify([win.hwnd]) && d.asked.length === 0, `${reply}; asked ${d.asked.join(' | ') || 'nothing'}`);
}
{
  const d = desk(DESKTOP);
  const reply = await new AppController(d.deps).focusApp('notepad').catch((e: Error) => e.message);
  ok('"focus notepad" brings the Notepad window to the front', JSON.stringify(d.focused()) === '["0x1A"]', reply);
}
{
  const d = desk([NOTEPAD]);
  const app = new AppController(d.deps);
  let opened = 0;
  app.openApp = async () => { opened++; return 'opened'; };
  await app.restartApp('notepad').catch(() => undefined);
  ok('"restart notepad" closes the running Notepad before opening it once', JSON.stringify(d.closed()) === '["0x1A"]' && opened === 1, `closed ${JSON.stringify(d.closed())}, opened ${opened}`);
}
{
  const d = desk([{ name: 'notepad++', pid: 900, windowTitle: 'new 1 - Notepad++', hwnd: '0x9A' }, NOTEPAD]);
  const reply = await new AppController(d.deps).closeApp('notepad').catch((e: Error) => e.message);
  ok('"close notepad" closes Notepad, not Notepad++, and asks nothing', JSON.stringify(d.closed()) === '["0x1A"]' && d.asked.length === 0, `${reply}; closed ${JSON.stringify(d.closed())}`);
}
{
  // A window list entry without a handle cannot be closed; it is not counted either.
  const d = desk([{ ...NOTEPAD_2, hwnd: '' }, NOTEPAD]);
  const reply = await new AppController(d.deps).closeApp('notepad').catch((e: Error) => e.message);
  ok('a Notepad entry without a window handle is skipped: one window closed, no question', JSON.stringify(d.closed()) === '["0x1A"]' && d.asked.length === 0, reply);
}
{
  const d = desk([{ ...NOTEPAD, hwnd: '' }]);
  const message = await error(() => new AppController(d.deps).closeApp('notepad'));
  ok('no matching window has a handle: a failure, not "Closed 0 window(s)"', /can be closed/.test(message) && d.closed().length === 0, message || 'reported success');
}
{
  // Only Notepad++ is open: "notepad" is part of its name, so the owner is asked first.
  const d = desk([{ name: 'notepad++', pid: 900, windowTitle: 'new 1 - Notepad++', hwnd: '0x9A' }, CODE], false);
  const message = await error(() => new AppController(d.deps).closeApp('notepad'));
  ok('"close notepad" with only Notepad++ open: asks, and the owner says no: nothing closed', d.asked.length === 1 && /Notepad\+\+/.test(d.asked[0]!) && d.closed().length === 0, message || d.asked.join(' | '));
}
{
  // JARVIS runs in Windows Terminal: "close command prompt" must not reach it.
  const JARVIS_TERMINAL: App = { name: 'WindowsTerminal', pid: 700, windowTitle: 'jarvis - pnpm dev', hwnd: '0x77' };
  for (const target of ['command prompt', 'cmd']) {
    const d = desk([JARVIS_TERMINAL, NOTEPAD]);
    const message = await error(() => new AppController(d.deps).closeApp(target));
    const w = desk([JARVIS_TERMINAL, NOTEPAD]);
    const message2 = await error(() => new WindowController(w.deps).closeWindow(target));
    ok(`"close ${target}" with only JARVIS's terminal open: nothing closed (app and window tools)`, d.closed().length === 0 && w.closed().length === 0, `${message} | ${message2}`);
  }
  // Command Prompt in its own Windows Terminal tab, beside JARVIS's terminal; inside an approved call.
  const CMD_TAB: App = { name: 'WindowsTerminal', pid: 701, windowTitle: 'Command Prompt', hwnd: '0x79' };
  for (const answer of [false, true]) {
    const d = desk([JARVIS_TERMINAL, CMD_TAB], answer);
    let inScope: unknown = 'not asked';
    d.deps.approve = async (title: string, command: string) => { d.asked.push(`${title}: ${command}`); inScope = currentApproval(); return answer; };
    const call = { tool: 'control_app', action: 'close', target: 'cmd', args: { action: 'close', target: 'cmd' }, requestId: 'test' };
    await runApproved(call as never, () => new AppController(d.deps).closeApp('cmd')).catch(() => undefined);
    ok(`approved "close cmd", the owner says ${answer ? 'yes' : 'no'}: asked outside the approval, naming the window; ${answer ? 'only Command Prompt closed' : 'nothing closed'}`,
      d.asked.length === 1 && inScope === undefined && /Command Prompt/.test(d.asked[0]!) && JSON.stringify(d.closed()) === (answer ? '["0x79"]' : '[]'),
      `${d.asked.join(' | ')}; closed ${JSON.stringify(d.closed())}`);
  }
}
{
  // Nothing is asked for a close that is refused anyway.
  const d = desk([{ name: 'chrome', pid: 206, windowTitle: 'Visual Studio Code docs - Google Chrome', hwnd: '0x2A' }]);
  const message = await error(() => new AppController(d.deps).closeApp('vs code'));
  ok('"close vs code" with only a Chrome tab about it: the tab refusal, no question first', /tab/i.test(message) && d.asked.length === 0, `${message}; asked ${d.asked.join(' | ') || 'nothing'}`);
}
{
  // "note" is part of three programs' names: no program is chosen; the titles match, so the owner sees all three.
  const d = desk([NOTEPAD, { name: 'notes', pid: 910, windowTitle: 'Notes', hwnd: '0x9B' }, { name: 'onenote', pid: 911, windowTitle: 'OneNote', hwnd: '0x9C' }], false);
  const message = await error(() => new AppController(d.deps).closeApp('note'));
  ok('"note" (part of three programs\' names): asked about all 3 windows; the owner says no: nothing closed', d.asked.length === 1 && /3 windows/.test(d.asked[0]!) && d.closed().length === 0, `${message}; ${d.asked.join(' | ')}`);
}
{
  // "host" is part of two programs' names and of no window title: no app is chosen.
  const d = desk([CALCULATOR, { name: 'sihost', pid: 930, windowTitle: 'Program Manager', hwnd: '0x9E' }]);
  const message = await error(() => new AppController(d.deps).closeApp('host'));
  ok('"host" (inside two programs\' names, no title): no app chosen, nothing asked or closed', /No open application matches/.test(message) && d.asked.length === 0 && d.closed().length === 0, message || d.asked.join(' | '));
}
{
  const d = desk([{ name: 'WindowsTerminal', pid: 920, windowTitle: 'Windows PowerShell', hwnd: '0x9D' }], false);
  const message = await error(() => new AppController(d.deps).closeApp('windows terminal'));
  ok('"close windows terminal" finds Windows Terminal (protected): asked, nothing closed on no', d.asked.length === 1 && /Protected/.test(d.asked[0]!) && d.closed().length === 0, message || d.asked.join(' | '));
}
{
  // control_window, inside an approved "close window jarvis": the protected question is still asked.
  const d = desk([{ name: 'WindowsTerminal', pid: 700, windowTitle: 'jarvis - pnpm dev', hwnd: '0x77' }], false);
  let inScope: unknown = 'not asked';
  d.deps.approve = async (title: string, command: string) => { d.asked.push(`${title}: ${command}`); inScope = currentApproval(); return false; };
  const call = { tool: 'control_window', action: 'close', target: 'jarvis', args: { action: 'close', target: 'jarvis' }, requestId: 'test' };
  await runApproved(call as never, () => new WindowController(d.deps).closeWindow('jarvis')).catch(() => undefined);
  ok('approved control_window "close jarvis": the protected question is asked outside the approval, naming the program', d.asked.length === 1 && inScope === undefined && /WindowsTerminal/.test(d.asked[0]!) && d.closed().length === 0, `${d.asked.join(' | ')}; closed ${JSON.stringify(d.closed())}`);
}
{
  const d = desk([{ name: 'WindowsTerminal', pid: 920, windowTitle: 'Windows PowerShell', hwnd: '0x9D' }], false);
  const message = await error(() => new AppController(d.deps).closeApp('terminal'));
  ok('"close terminal" reaches a protected app (WindowsTerminal): asked, nothing closed on no', d.asked.length === 1 && /Protected/.test(d.asked[0]!) && d.closed().length === 0, message || d.asked.join(' | '));
}
{
  // ''.includes matched every window: an empty name closed them all.
  // No browser on screen: the browser rule must not be what stops it.
  const d = desk([NOTEPAD, CALCULATOR, CODE]);
  const message = await error(() => new AppController(d.deps).closeApp(''));
  ok('an empty app name closes nothing and asks nothing', d.closed().length === 0 && d.asked.length === 0 && /No open application matches/.test(message), message || `closed ${JSON.stringify(d.closed())}`);
}
{
  const d = desk(DESKTOP);
  const message = await error(() => new AppController(d.deps).closeApp('spotify'));
  ok('an app that is not open: "No open application matches", nothing closed', /No open application matches "spotify"/.test(message) && d.closed().length === 0, message);
}

// ── 2. TRA-18: a site or tab name never closes a browser window ──────────────
console.log('\n--- 2. browser windows (TRA-18, owner decision D3) ---');
for (const target of ['youtube', 'gmail']) {
  const d = desk(DESKTOP);
  const message = await error(() => new AppController(d.deps).closeApp(target));
  ok(`control_app close "${target}": no window closed, the reply points to the tab`,
    d.closed().length === 0 && /tab/i.test(message), message || `closed ${JSON.stringify(d.closed())}`);
}
{
  const d = desk([{ name: 'Arc', pid: 260, windowTitle: 'YouTube - Arc', hwnd: '0x2E' }, NOTEPAD]);
  const message = await error(() => new AppController(d.deps).closeApp('youtube'));
  ok('Arc is a browser too: "youtube" closes no Arc window', d.closed().length === 0 && /tab/i.test(message), message || `closed ${JSON.stringify(d.closed())}`);
}
for (const tool of ['control_app', 'control_window'] as const) {
  // The browser window listed first, an Explorer window with the same word second.
  const d = desk([YOUTUBE, { name: 'explorer', pid: 500, windowTitle: 'YouTube downloads', hwnd: '0x5A' }]);
  const reply = tool === 'control_app'
    ? await new AppController(d.deps).closeApp('youtube').catch((e: Error) => e.message)
    : await new WindowController(d.deps).closeWindow('youtube').catch((e: Error) => e.message);
  ok(`${tool} close "youtube" with Chrome listed first: only the Explorer window, never Chrome`, !d.closed().includes('0x2B') && d.closed().includes('0x5A'), `${reply}; closed ${JSON.stringify(d.closed())}`);
}
for (const target of ['chrome', 'google chrome', 'Chrome.exe', 'edge']) {
  const d = desk([...DESKTOP, EDGE]);
  const message = await error(() => new AppController(d.deps).closeApp(target));
  ok(`control_app close "${target}": the browser is not closed through app control`,
    d.closed().length === 0 && /browser/i.test(message), message || `closed ${JSON.stringify(d.closed())}`);
}
{
  const d = desk(DESKTOP);
  const message = await error(() => new AppController(d.deps).closeApp('youtube'));
  ok('no question is asked for a refused browser close', d.asked.length === 0, `${message}; asked ${d.asked.length}`);
}
for (const [target, says] of [['youtube', /tab/i], ['chrome', /browser/i]] as const) {
  const d = desk(DESKTOP);
  const message = await error(() => new WindowController(d.deps).closeWindow(target));
  ok(`control_window close "${target}": no Chrome window closed, and the reply says why`, d.closed().length === 0 && says.test(message), message || `closed ${JSON.stringify(d.closed())}`);
}
{
  const d = desk(DESKTOP);
  const reply = await new WindowController(d.deps).closeWindow('notepad').catch((e: Error) => e.message);
  ok('control_window close "notepad" still closes Notepad', JSON.stringify(d.closed()) === '["0x1A"]', reply);
}
{
  const d = desk(DESKTOP);
  const message = await error(() => new WindowController(d.deps).closeWindow('0x2B'));
  ok('control_window close by a Chrome window\'s handle (from a window list): refused', d.closed().length === 0 && /browser/i.test(message), message || `closed ${JSON.stringify(d.closed())}`);
}
{
  // A second Chrome window is not in the app list (one main window per program), only in the full list.
  const d = desk([NOTEPAD], true, [NOTEPAD, YOUTUBE, GMAIL]);
  const message = await error(() => new WindowController(d.deps).closeWindow('0x2C'));
  ok('control_window close by a Chrome handle missing from the app list: refused', d.closed().length === 0 && /browser/i.test(message), message || `closed ${JSON.stringify(d.closed())}`);
}
{
  const d = desk([NOTEPAD], true, [NOTEPAD]);
  const message = await error(() => new WindowController(d.deps).closeWindow('0x77'));
  ok('control_window close by a handle no visible window has: refused, nothing closed', d.closed().length === 0 && /no visible window/.test(message), message || `closed ${JSON.stringify(d.closed())}`);
}
{
  // A handle in the app list needs no second window reading.
  const d = desk([NOTEPAD], true, [NOTEPAD, CODE]);
  let fullReads = 0;
  d.deps.allWindows = async () => { fullReads++; throw new Error('not needed'); };
  const reply = await new WindowController(d.deps).closeWindow('0x1A').catch((e: Error) => e.message);
  ok('control_window close by Notepad\'s handle: closed, without reading every window', JSON.stringify(d.closed()) === '["0x1A"]' && fullReads === 0, `${reply}; full reads ${fullReads}`);
}
{
  // A second Windows Terminal window: only in the full list; still a protected app.
  const d = desk([NOTEPAD], false, [NOTEPAD, { name: 'WindowsTerminal', pid: 921, windowTitle: 'Windows PowerShell', hwnd: '0x78' }]);
  const message = await error(() => new WindowController(d.deps).closeWindow('0x78'));
  ok('a protected window known only from the full list: asked; on no, not closed', d.asked.length === 1 && /Protected/.test(d.asked[0]!) && d.closed().length === 0, message || d.asked.join(' | '));
}
{
  // The window in front is JARVIS's terminal, not a main window in the app list: still protected.
  const d = desk([NOTEPAD], false);
  d.deps.windows = async () => ({ activeWindow: { title: 'jarvis - pnpm dev', processName: 'WindowsTerminal', pid: 700, hwnd: '0x77' }, openApps: [{ ...NOTEPAD }] });
  const message = await error(() => new WindowController(d.deps).closeCurrentWindow());
  ok('"close current window" on a protected window missing from the app list: asked; on no, not closed', d.asked.length === 1 && /Protected/.test(d.asked[0]!) && d.closed().length === 0, message || d.asked.join(' | '));
}
// "close current window" with Chrome in front: closed only after the owner confirms that Chrome window,
// also inside an approved call (owner's decision, 2026-10-26).
for (const answer of [false, true]) {
  const d = desk([YOUTUBE, NOTEPAD], answer);
  let inScope: unknown = 'not asked';
  d.deps.approve = async (title: string, command: string) => { d.asked.push(`${title}: ${command}`); inScope = currentApproval(); return answer; };
  const call = { tool: 'control_window', action: 'close_current', target: '', args: { action: 'close_current' }, requestId: 'test' };
  const reply = await runApproved(call as never, () => new WindowController(d.deps).closeCurrentWindow()).catch((e: Error) => e.message);
  ok(`"close current window" with Chrome in front, the owner says ${answer ? 'yes' : 'no'}: asked about that Chrome window (outside the approval); ${answer ? 'only it closed' : 'nothing closed'}`,
    d.asked.length === 1 && inScope === undefined && /Chrome window "YouTube - Google Chrome"/.test(d.asked[0]!) && JSON.stringify(d.closed()) === (answer ? '["0x2B"]' : '[]')
      && (answer || (/not approved/.test(String(reply)) && String(reply).length <= 120)),
    `${String(reply)}; asked ${d.asked.join(' | ') || 'nothing'}`);
}
{
  // The window in front has no program name (an elevated process) and is in no list: asked, not closed on no.
  const d = desk([NOTEPAD], false, [NOTEPAD]);
  d.deps.windows = async () => ({ activeWindow: { title: 'YouTube - Google Chrome', processName: '', pid: 0, hwnd: '0x2B' }, openApps: [{ ...NOTEPAD }] });
  const message = await error(() => new WindowController(d.deps).closeCurrentWindow());
  ok('"close current window" whose program cannot be read: asked first; on no, nothing closed', d.asked.length === 1 && /could not be read/.test(d.asked[0]!) && d.closed().length === 0, message || d.asked.join(' | '));
}
{
  // Same, but the full window list knows it is Chrome: the browser question.
  const d = desk([NOTEPAD], false, [NOTEPAD, YOUTUBE]);
  d.deps.windows = async () => ({ activeWindow: { title: 'YouTube - Google Chrome', processName: '', pid: 0, hwnd: '0x2B' }, openApps: [{ ...NOTEPAD }] });
  const message = await error(() => new WindowController(d.deps).closeCurrentWindow());
  ok('"close current window", no program name but the full list says Chrome: the Chrome question; nothing closed on no', d.asked.length === 1 && /Chrome window/.test(d.asked[0]!) && d.closed().length === 0, message || d.asked.join(' | '));
}
{
  // A long title: the refusal still fits the spoken reply.
  const long = { ...YOUTUBE, windowTitle: 'A very long video title that goes on and on and on - YouTube - Google Chrome' };
  const d = desk([long], false);
  const message = await error(() => new WindowController(d.deps).closeCurrentWindow());
  ok('a refused browser close with a long title: the reply is at most 120 characters', message.length > 0 && message.length <= 120, `${message.length}: ${message}`);
}
{
  const d = desk([NOTEPAD, YOUTUBE]);
  const reply = await new WindowController(d.deps).closeCurrentWindow().catch((e: Error) => e.message);
  ok('"close current window" with Notepad in front: closed, no browser question', JSON.stringify(d.closed()) === '["0x1A"]' && d.asked.length === 0, `${reply}; asked ${d.asked.join(' | ') || 'nothing'}`);
}

// ── 3. TRA-18: several matching windows → ask first ──────────────────────────
console.log('\n--- 3. several windows match ---');
{
  const d = desk([NOTEPAD, NOTEPAD_2, CODE], false);
  const message = await error(() => new AppController(d.deps).closeApp('notepad'));
  ok('two Notepad windows, the owner says no: nothing closed', d.closed().length === 0 && /cancel/i.test(message), message);
  ok('the question names both windows', d.asked.length === 1 && /2 windows/.test(d.asked[0]!) && /todo\.txt/.test(d.asked[0]!), d.asked[0] ?? 'not asked');
}
{
  const d = desk([NOTEPAD, NOTEPAD_2, CODE], true);
  const reply = await new AppController(d.deps).closeApp('notepad').catch((e: Error) => e.message);
  ok('two Notepad windows, the owner says yes: both closed, Code left open', JSON.stringify(d.closed().sort()) === '["0x1A","0x1B"]', reply);
}
{
  const d = desk(DESKTOP);
  await new AppController(d.deps).closeApp('notepad').catch(() => undefined);
  ok('one matching window: no extra question', d.asked.length === 0, d.asked.join(' | '));
}
{
  // The registry's approval of "close notepad" did not show which windows: the
  // question must be asked outside that approval (approvalScope answers nested ones).
  const d = desk([NOTEPAD, NOTEPAD_2]);
  let inScope: unknown = 'not asked';
  d.deps.approve = async (title: string, command: string) => { d.asked.push(`${title}: ${command}`); inScope = currentApproval(); return true; };
  const call = { tool: 'control_app', action: 'close', target: 'notepad', args: { action: 'close', target: 'notepad' }, requestId: 'test' };
  await runApproved(call as never, () => new AppController(d.deps).closeApp('notepad')).catch(() => undefined);
  ok('inside an approved "close notepad" call, the several-windows question is asked outside it', d.asked.length === 1 && inScope === undefined, `asked ${d.asked.length}, scope ${inScope === undefined ? 'none' : 'the approved call'}`);
}
{
  // "close terminal" was approved; that it is WindowsTerminal (protected) was not shown.
  const d = desk([{ name: 'WindowsTerminal', pid: 920, windowTitle: 'Windows PowerShell', hwnd: '0x9D' }]);
  let inScope: unknown = 'not asked';
  d.deps.approve = async (title: string, command: string) => { d.asked.push(`${title}: ${command}`); inScope = currentApproval(); return true; };
  const call = { tool: 'control_app', action: 'close', target: 'terminal', args: { action: 'close', target: 'terminal' }, requestId: 'test' };
  await runApproved(call as never, () => new AppController(d.deps).closeApp('terminal')).catch(() => undefined);
  ok('inside an approved "close terminal" call, the protected-app question is asked outside it', d.asked.length === 1 && inScope === undefined, `asked ${d.asked.length}, scope ${inScope === undefined ? 'none' : 'the approved call'}`);
}

// ── 4. TRA-06: a kill reports what happened ──────────────────────────────────
console.log('\n--- 4. process kill (TRA-06) ---');
type Ps = { exitCode: number; stdout: string; stderr: string };
function procs(list: Array<{ ProcessName: string; Id: number }>, stop: (pid: number) => Ps, stillRunning: (pid: number) => boolean, answer = true, checkAnswer?: Ps) {
  const scripts: string[] = [];
  const asked: string[] = [];
  const started: string[] = [];
  const deps = {
    powershell: async (script: string): Promise<Ps> => {
      scripts.push(script);
      if (/^Get-Process \|/.test(script)) return { exitCode: 0, stdout: JSON.stringify(list), stderr: '' };
      const stopped = /Stop-Process -Id (\d+)/.exec(script);
      if (stopped) return stop(Number(stopped[1]));
      const check = /Get-Process -Id (\d+)/.exec(script);
      if (check) return checkAnswer ?? { exitCode: 0, stdout: stillRunning(Number(check[1])) ? 'running' : 'gone', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: `unexpected script: ${script}` };
    },
    approve: async (title: string, command: string) => { asked.push(`${title}: ${command}`); return answer; },
    start: async (name: string) => { started.push(name); },
  };
  const stops = () => scripts.filter((s) => /Stop-Process/.test(s));
  return { deps, scripts, asked, stops, started };
}
const LIST = [{ ProcessName: 'notepad++', Id: 900 }, { ProcessName: 'notepad', Id: 101 }, { ProcessName: 'chrome', Id: 202 }];
const done: Ps = { exitCode: 0, stdout: '', stderr: '' };
{
  const p = procs(LIST, () => done, () => false);
  const reply = await new ProcessController(p.deps).killProcess('notepad').catch((e: Error) => e.message);
  ok('kill "notepad": the process named exactly notepad (PID 101), not notepad++', p.stops().length === 1 && /-Id 101\b/.test(p.stops()[0]!), `${reply}; ${p.stops().join(' | ')}`);
  ok('the approval question names that PID', p.asked.length === 1 && /PID: 101/.test(p.asked[0]!), p.asked[0] ?? 'not asked');
  ok('the reply says it ended, after the check', /terminated/i.test(reply) && p.scripts.some((s) => /Get-Process -Id 101/.test(s)), reply);
}
{
  const p = procs(LIST, () => ({ exitCode: 1, stdout: '', stderr: 'Stop-Process : Access is denied' }), () => true);
  const message = await error(() => new ProcessController(p.deps).killProcess('notepad'));
  ok('Stop-Process fails: the kill fails, with the reason', /access is denied/i.test(message) && !/Successfully/i.test(message), message || 'reported success');
}
{
  const p = procs(LIST, () => done, () => true);
  const message = await error(() => new ProcessController(p.deps).killProcess('notepad'));
  ok('the process is still running afterwards: the kill fails', /still running/i.test(message), message || 'reported success');
}
{
  // The check's own PowerShell did not run: no answer is not "gone".
  const p = procs(LIST, () => done, () => false, true, { exitCode: undefined as unknown as number, stdout: '', stderr: 'spawn powershell ENOENT' });
  const message = await error(() => new ProcessController(p.deps).killProcess('notepad'));
  ok('the gone-check gives no answer: the kill is not reported as done', /could not confirm/i.test(message), message || 'reported success');
}
{
  const p = procs(LIST, () => done, () => false);
  const reply = await new ProcessController(p.deps).killProcess('notepad.exe').catch((e: Error) => e.message);
  ok('kill "notepad.exe" finds notepad (PID 101)', p.stops().length === 1 && /-Id 101\b/.test(p.stops()[0]!), reply);
}
{
  const p = procs(LIST, () => done, () => false);
  const reply = await new ProcessController(p.deps).restartProcess('notepad').catch((e: Error) => e.message);
  ok('restart "notepad": stops PID 101 and starts notepad, not notepad++', /-Id 101\b/.test(p.stops()[0] ?? '') && JSON.stringify(p.started) === '["notepad"]', `${reply}; started ${JSON.stringify(p.started)}`);
}
{
  const p = procs(LIST, () => done, () => false);
  p.deps.start = async (name: string) => { throw new Error(`spawn ${name} ENOENT`); };
  const message = await error(() => new ProcessController(p.deps).restartProcess('notepad'));
  ok('restart: ended, then could not start: the reply says both', /Ended notepad, but could not start it again/.test(message) && p.stops().length === 1, message || 'reported success');
}
{
  const p = procs(LIST, () => done, () => false);
  const message = await error(() => new ProcessController(p.deps).killProcess('chrome'));
  ok('kill "chrome": refused (the everyday browser), nothing asked or stopped', /browser/i.test(message) && p.stops().length === 0 && p.asked.length === 0, message || 'killed');
}

// ── 5. TRA-18: the planner is not offered window tools for a tab ─────────────
console.log('\n--- 5. planner offers (TRA-18) ---');
const { orchestrator } = await import('../core/orchestrator.js');
await (orchestrator as unknown as { waitForSkills?: () => Promise<void> }).waitForSkills?.();
const planner = orchestrator as unknown as { selectPlanningToolNames(i: string): string[] };
for (const phrase of ['close this tab', 'close the YouTube tab', 'close all tabs', 'close the gmail tab in chrome']) {
  const tools = planner.selectPlanningToolNames(phrase);
  ok(`"${phrase}": tab tools offered, control_app and control_window not`,
    tools.includes('control_browser') && !tools.includes('control_app') && !tools.includes('control_window'), tools.join(', '));
}
for (const phrase of ['close notepad', 'close the calculator window', 'maximize the window with the youtube tab', 'minimize the chrome window with my gmail tab', 'minimize the youtube tab']) {
  const tools = planner.selectPlanningToolNames(phrase);
  const wanted = /minimize|maximize/.test(phrase) ? ['control_window'] : ['control_app', 'control_window'];
  ok(`"${phrase}": ${wanted.join(' and ')} still offered`, wanted.every((t) => tools.includes(t)), tools.join(', '));
}

// ── 5b. The close check uses the same rule (R7), and refusals are not retried (R14) ──
console.log('\n--- 5b. close check and retries ---');
{
  // The check of a close looks at the windows the close named, by handle.
  const verify = VERIFIERS['control_app'] as (args: Record<string, unknown>, output: string) => Promise<{ status: string; evidence: string }>;
  const realChecks = { ...windowChecks };
  const open = new Set<string>(['0x9A']); // Notepad++ stays open; 0x1A (Notepad) was closed
  windowChecks.onWindows = () => true;
  windowChecks.windowState = async (hwnd: string) => ({ exists: open.has(hwnd.toUpperCase().replace(/^0X/, '0x')) }) as never;
  const output = JSON.stringify({ success: true, message: 'Closed 1 window(s) matching "notepad" (windows 0x1A).' });
  const gone = await verify({ action: 'close', target: 'notepad' }, output);
  ok('after "close notepad", Notepad++ still open: the check says the closed window is gone', gone.status === 'verified', `${gone.status}: ${gone.evidence}`);
  open.add('0x1A');
  const left = await verify({ action: 'close', target: 'notepad' }, output);
  ok('the closed window is still there: the check fails', left.status === 'failed', `${left.status}: ${left.evidence}`);
  // The target is quoted earlier in the reply and may itself look like a handle list.
  const tricky = JSON.stringify({ success: true, message: 'Closed 1 window(s) matching "x (windows 0x99)" (windows 0x1A).' });
  const read = await verify({ action: 'close', target: 'x (windows 0x99)' }, tricky);
  ok('the check reads the handle list at the end of the reply, not one inside the target', read.status === 'failed', `${read.status}: ${read.evidence}`);
  Object.assign(windowChecks, realChecks);
  // Without handles (an older reply), the rule of the close itself: a Chrome tab about notepad is not Notepad.
  const appMatch = await import('../control/appMatch.js').catch(() => null);
  ok('fallback rule: a Chrome window titled "notepad tips" is not a Notepad window left open',
    !!appMatch && appMatch.appWindowsLeft('notepad', [{ name: 'chrome', pid: 202, windowTitle: 'notepad tips - Google Chrome' }]).length === 0, appMatch ? '' : 'no shared matching rule');
}
for (const refusal of [
  'I don\'t close the Chrome browser through app, window or process control: that would close your own Chrome windows too. I can close a tab.',
  '"youtube" is a page open in Chrome, not an app. Ask me to close the youtube tab instead.',
  'notepad (PID: 101) is still running after Stop-Process.',
  'Ended notepad, but could not start it again: spawn notepad ENOENT',
  'Window 0x2C was not closed: no visible window has that handle.',
]) {
  let runs = 0;
  await actionQueue.enqueue('closeByNameTest', async () => { runs++; throw new Error(refusal); }).catch(() => undefined);
  ok(`the action queue does not retry: "${refusal.slice(0, 40)}…"`, runs === 1, `ran ${runs} time(s)`);
}

// ── 6. Through the real kernel: a failure is never "success" (B1) ────────────
console.log('\n--- 6. kernel results for app, window and process ---');
const nothing = 'jarvis_test_not_open_xyz';
for (const [label, run] of [
  ['control_app close', () => pcControlKernel.closeApp(nothing)],
  ['control_window close', () => pcControlKernel.closeWindow(nothing)],
  ['control_process kill', () => pcControlKernel.killProcess(nothing)],
] as const) {
  const result = await run();
  ok(`${label} of something not open: success false, with the reason`, result.success === false && !!result.error, `${result.success} ${result.error ?? ''}`.slice(0, 160));
}

permissionSession.deactivateFullControl('close by name test');
fs.rmSync(workspace, { recursive: true, force: true });

console.log(`\n=== Close by name: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
