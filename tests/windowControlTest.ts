/**
 * tests/windowControlTest.ts
 * Verifies WindowController: getActiveWindow, listOpenWindows, and focus behavior.
 */
import { windowController } from '../control/windowController.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

console.log('\n=== Window Control Test ===\n');

// ── Test 1: getActiveWindow() returns structure ───────────────────────────────
console.log('--- Test 1: getActiveWindow() ---');
let activeWindow: string = '';
try {
  activeWindow = await windowController.getActiveWindow();
  ok('getActiveWindow() resolves without throwing', true);
} catch (err: any) {
  ok(`getActiveWindow() resolves without throwing (got: ${err.message})`, false);
}
ok('getActiveWindow() returns a string', typeof activeWindow === 'string');
ok('getActiveWindow() returns non-empty string', activeWindow.length > 0);

// ── Test 2: listOpenWindows() returns results ─────────────────────────────────
console.log('\n--- Test 2: listOpenWindows() ---');
let openWindows: string = '';
try {
  openWindows = await windowController.listOpenWindows();
  ok('listOpenWindows() resolves without throwing', true);
} catch (err: any) {
  ok(`listOpenWindows() resolves without throwing (got: ${err.message})`, false);
}
ok('listOpenWindows() returns a string', typeof openWindows === 'string');

// ── Test 3: closeCurrentWindow() at default permission level ──────────────────
console.log('\n--- Test 3: closeCurrentWindow() permission check ---');
// This is a destructive operation (Level 2). At default Level 0, should be blocked.
let closeBlocked = false;
try {
  await windowController.closeCurrentWindow();
  // If it doesn't throw, it might have closed something — that's concerning
  closeBlocked = false;
} catch (err: any) {
  closeBlocked = err.message.toLowerCase().includes('permission') ||
                 err.message.toLowerCase().includes('level') ||
                 err.message.toLowerCase().includes('confirm') ||
                 err.message.toLowerCase().includes('blocked');
}
ok('closeCurrentWindow() at Level 0 is blocked or requires higher permission', closeBlocked);

// ── Test 4: focusWindow() on a non-existent window gives friendly error ───────
console.log('\n--- Test 4: focusWindow() on non-existent window ---');
let focusResult: string = '';
try {
  focusResult = await windowController.focusWindow('definitely_not_open_window_xyz');
  ok('focusWindow() resolves without throwing', true);
} catch (err: any) {
  focusResult = err.message;
  ok('focusWindow() resolves without throwing', false);
}
ok('focusWindow() returns a string (success or error message)', focusResult.length > 0 || typeof focusResult === 'string');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
