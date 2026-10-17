/**
 * tests/windowControlTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WindowController on a real Windows desktop: the active window, the window
 * list, the permission check on close, and focusing a window that is not open.
 *
 * TEST-101: this test used to pass anywhere. It checked only that a string
 * came back, and when PowerShell could not read the windows, the empty
 * result ("pid 0, no apps") was still a string: 8/8 on Linux. Now:
 *   - not Windows: BLOCKED (exit 3), with the reason, never a pass;
 *   - PowerShell is asked directly how many windows have a title; if it lists
 *     any, JARVIS's list must not be empty and its active window must be a
 *     real one (pid > 0). A desktop with no windows at all cannot show
 *     anything: BLOCKED, with the reason;
 *   - focusing a window that is not open must say it was not found.
 */
import { execFileSync } from 'child_process';
import { windowController } from '../control/windowController.js';

function blocked(reason: string): never {
  console.log(`BLOCKED: ${reason}`);
  process.exit(3);
}

if (process.platform !== 'win32') blocked('needs Windows: JARVIS reads windows through Windows PowerShell.');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = '') {
  const line = `${label}${detail ? ` (${detail})` : ''}`;
  if (condition) { console.log(`  ✅ PASS: ${line}`); passed++; }
  else { console.error(`  ❌ FAIL: ${line}`); failed++; }
}

console.log('\n=== Window Control Test ===\n');

// ── What Windows itself says is open ─────────────────────────────────────────
let titled: number;
try {
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    '@([System.Diagnostics.Process]::GetProcesses() | Where-Object { $_.MainWindowTitle }).Count'],
  { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  titled = Number(out.trim());
  if (!Number.isFinite(titled)) throw new Error(`unexpected answer "${out.trim()}"`);
} catch (err) {
  blocked(`PowerShell could not be asked which windows are open: ${(err as Error).message}`);
}
console.log(`  (PowerShell lists ${titled} window(s) with a title)`);
if (titled === 0) blocked('this desktop has no window with a title, so there is nothing to read (a CI runner without a desktop?).');

// ── Test 1: getActiveWindow() ─────────────────────────────────────────────────
console.log('--- Test 1: getActiveWindow() ---');
let active: { title?: string; processName?: string; pid?: number } = {};
try {
  active = JSON.parse(await windowController.getActiveWindow());
  ok('getActiveWindow() answers with a window', true);
} catch (err: any) {
  ok('getActiveWindow() answers with a window', false, err.message);
}
ok('…a real one, read from Windows (pid > 0)', (active.pid ?? 0) > 0, JSON.stringify(active));

// ── Test 2: listOpenWindows() ─────────────────────────────────────────────────
console.log('\n--- Test 2: listOpenWindows() ---');
let open: { name?: string; pid?: number; windowTitle?: string }[] = [];
try {
  const parsed = JSON.parse(await windowController.listOpenWindows());
  open = Array.isArray(parsed) ? parsed : [];
  ok('listOpenWindows() answers with a list', Array.isArray(parsed));
} catch (err: any) {
  ok('listOpenWindows() answers with a list', false, err.message);
}
ok('…that is not empty when Windows lists windows', open.length > 0, `${open.length} listed by JARVIS, ${titled} by PowerShell`);
ok('…each with a name, pid and title', open.length > 0 && open.every((w) => w.name && (w.pid ?? 0) > 0 && w.windowTitle),
  JSON.stringify(open.slice(0, 2)));

// ── Test 3: closeCurrentWindow() needs Level 2 ───────────────────────────────
console.log('\n--- Test 3: closeCurrentWindow() permission check ---');
let closeError = '';
try {
  await windowController.closeCurrentWindow();
} catch (err: any) {
  closeError = err.message;
}
ok('closeCurrentWindow() below Level 2 is refused, nothing closed', /permission|level|confirm|blocked/i.test(closeError), closeError || 'it did not refuse');

// ── Test 4: focusWindow() on a window that is not open ───────────────────────
console.log('\n--- Test 4: focusWindow() on a window that is not open ---');
const focus = await windowController.focusWindow('definitely_not_open_window_xyz');
ok('focusWindow() says the window was not found', /not found/i.test(focus), focus);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
