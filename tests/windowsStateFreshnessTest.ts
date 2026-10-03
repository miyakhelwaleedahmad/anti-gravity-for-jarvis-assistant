/**
 * tests/windowsStateFreshnessTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Two faults in perception/windowsState.ts that made window and app commands
 * act on the wrong window, or on none:
 *
 *  1. The persistent PowerShell session printed window handles in decimal
 *     (IntPtr.ToString()). win_automate.ps1 parses -Hwnd as hex, so handle
 *     1311204 became 0x1311204 = 19993092, another handle: "close Notepad"
 *     reported success and nothing closed, and "close this window" could not
 *     find its own window. Handles are now "0x" + hex.
 *
 *  2. While a background poll was running, an action was handed the previous
 *     poll's window list. Switch window and say "close this window" during a
 *     poll, and the window that WAS active was targeted. Actions now wait for
 *     a current reading, or get none and fail; only background polls reuse
 *     the last result.
 *
 * A stand-in "PowerShell" (a Node script) replaces powershell.exe, so this runs
 * anywhere. It reports whatever window the test puts "on screen".
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PersistentPSSession, getWindowsState, normalizeHwnd, psSession } from '../perception/windowsState.js';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-winstate-'));
const screen = path.join(dir, 'screen.json');
const show = (s: { title: string; hwnd: string; delayMs?: number; hang?: boolean }) =>
  fs.writeFileSync(screen, JSON.stringify(s));

// Answers queries strictly in order, like PowerShell, with handles in decimal
// as IntPtr.ToString() prints them. Each answer describes the screen at the
// moment PowerShell starts on that query.
const fakePs = path.join(dir, 'fake-ps.mjs');
fs.writeFileSync(fakePs, `
import * as fs from 'fs';
const screen = process.argv[2];
let pending = '';
let chain = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  pending += d;
  let m;
  while ((m = pending.match(/^([\\s\\S]*?)Write-Output '__JARVIS_END__:(\\d+)'\\n/))) {
    pending = pending.slice(m[0].length);
    const id = m[2];
    chain = chain.then(async () => {
      const s = JSON.parse(fs.readFileSync(screen, 'utf8'));
      if (s.hang) return new Promise(() => {});
      await new Promise((r) => setTimeout(r, s.delayMs ?? 20));
      const w = { title: s.title, processName: s.title.toLowerCase(), pid: 42, hwnd: s.hwnd };
      const apps = [{ name: w.processName, pid: 42, windowTitle: s.title, hwnd: s.hwnd }];
      process.stdout.write(JSON.stringify({ activeWindow: w, openApps: apps }) + '\\n__JARVIS_END__:' + id + '\\n');
    });
  }
});
`);

console.log('\n=== Windows State Freshness Test ===\n');

console.log('--- Window handles ---');
ok('a decimal handle becomes hex', normalizeHwnd('1311204') === '0x1401E4', normalizeHwnd('1311204'));
ok('a hex handle is kept', normalizeHwnd('0x2b2c') === '0x2B2C');
ok('handle 0 is 0x0 (no active window)', normalizeHwnd('0') === '0x0' && normalizeHwnd(0) === '0x0');
ok('anything else is empty', normalizeHwnd('') === '' && normalizeHwnd(undefined) === '' && normalizeHwnd('notepad') === '');

show({ title: 'Chrome', hwnd: '1311204' });
const session = new PersistentPSSession(process.execPath, [fakePs, screen], 3_000, 1_500, 30_000);
session.start();
await sleep(200);
const first = await getWindowsState({}, session);
ok('the active window handle from the session is hex', first.activeWindow.hwnd === '0x1401E4', first.activeWindow.hwnd);
ok('open-app handles too', first.openApps[0]?.hwnd === '0x1401E4', first.openApps[0]?.hwnd);

console.log('\n--- You switch window while a background poll is running ---');
show({ title: 'Chrome', hwnd: '1311204', delayMs: 800 });
const poll = getWindowsState({ allowStale: true }, session);
await sleep(50);
show({ title: 'Notepad', hwnd: '11052' });

let t = Date.now();
const snapshot = await getWindowsState({ allowStale: true }, session);
ok('a second background poll gets the last result at once', snapshot.activeWindow.title === 'Chrome' && Date.now() - t < 300, `${Date.now() - t}ms`);

t = Date.now();
const action = await getWindowsState({}, session);
const waited = Date.now() - t;
ok('an action waits for the running poll', waited >= 500, `${waited}ms`);
ok('and gets the window that is active now', action.activeWindow.title === 'Notepad' && action.activeWindow.hwnd === '0x2B2C',
  `${action.activeWindow.title} ${action.activeWindow.hwnd}`);
await poll;

console.log('\n--- PowerShell stuck on a query ---');
show({ title: 'Paint', hwnd: '77', hang: true });
await getWindowsState({ allowStale: true }, session); // times out after 1.5 s and keeps running
t = Date.now();
const stuck = await getWindowsState({ waitMs: 600 }, session);
ok('an action gives up after its wait', Date.now() - t >= 550, `${Date.now() - t}ms`);
ok('and gets no window rather than an old one', !stuck.activeWindow.hwnd && stuck.activeWindow.title === '' && stuck.openApps.length === 0,
  JSON.stringify(stuck.activeWindow));
const background = await getWindowsState({ allowStale: true }, session);
ok('background polls still get the last good state', background.activeWindow.title === 'Notepad', background.activeWindow.title);

session.stop();
psSession.stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
