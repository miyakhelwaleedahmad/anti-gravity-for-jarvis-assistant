/**
 * tests/appControlTest.ts
 * Verifies AppController: isAppOpen, listApps, and protection rules for closeApp.
 */
import { appController } from '../control/appController.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

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

console.log('\n=== App Control Test ===\n');

let testNotepad: ChildProcessWithoutNullStreams | null = null;

async function launchTestNotepad(): Promise<void> {
  if (process.platform !== 'win32') return;
  testNotepad = spawn('notepad.exe');
  await new Promise(resolve => setTimeout(resolve, 1000));
}

function cleanupTestNotepad(): void {
  if (testNotepad && !testNotepad.killed) {
    try { testNotepad.kill(); } catch {}
  }
}

await launchTestNotepad();

// ── Test 1: listApps() returns array ─────────────────────────────────────────
console.log('--- Test 1: listApps() ---');
let listResult: string = '';
try {
  listResult = await appController.listApps();
  ok('listApps() resolves without throwing', true);
} catch (err: any) {
  ok(`listApps() resolves without throwing (got: ${err.message})`, false);
}
ok('listApps() returns a string', typeof listResult === 'string');

// ── Test 2: isAppOpen() for definitely-running processes ─────────────────────
console.log('\n--- Test 2: isAppOpen() ---');
let isNotepadOpen: boolean = false;
try {
  isNotepadOpen = await appController.isAppOpen('notepad');
  ok('isAppOpen("notepad") resolves without throwing', true);
} catch (err: any) {
  ok(`isAppOpen("notepad") resolves without throwing (got: ${err.message})`, false);
}
ok('isAppOpen("notepad") returns a boolean', typeof isNotepadOpen === 'boolean');
ok('isAppOpen("notepad") returns true after test setup', process.platform !== 'win32' || isNotepadOpen === true);

// ── Test 3: isAppOpen() for non-existent app ─────────────────────────────────
console.log('\n--- Test 3: isAppOpen() for non-existent app ---');
let isFakeOpen: boolean = true;
try {
  isFakeOpen = await appController.isAppOpen('definitely_not_running_app_xyz123');
  ok('isAppOpen(fake) resolves without throwing', true);
} catch (err: any) {
  ok(`isAppOpen(fake) resolves without throwing (got: ${err.message})`, false);
  isFakeOpen = false;
}
ok('isAppOpen() returns false for non-running app', isFakeOpen === false);

// ── Test 4: closeApp() on protected app throws ───────────────────────────────
console.log('\n--- Test 4: closeApp() protection for critical apps ---');
const protectedApps = ['Code', 'WindowsTerminal', 'powershell'];
for (const app of protectedApps) {
  let blocked = false;
  try {
    await appController.closeApp(app);
  } catch (err: any) {
    blocked = err.message.toLowerCase().includes('protected') ||
              err.message.toLowerCase().includes('confirm') ||
              err.message.toLowerCase().includes('permission') ||
              err.message.toLowerCase().includes('blocked');
  }
  ok(`closeApp("${app}") is blocked or requires confirmation`, blocked);
}

// ── Test 5: focusApp() is allowed at default permission level ────────────────
console.log('\n--- Test 5: focusApp() permission ---');
// focusApp is Level 1 — should work even at default Level 0 if it's a safe op
// But our default is now Level 0 — so this will either succeed or be blocked depending on impl
let focusResult: string = '';
try {
  focusResult = await appController.focusApp('notepad');
  ok('focusApp("notepad") resolves without throwing', true);
} catch (err: any) {
  // Acceptable if notepad isn't open
  focusResult = err.message;
  ok('focusApp("notepad") resolves without throwing', false);
}
console.log(`  ℹ️  focusApp result: ${focusResult.substring(0, 80)}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
cleanupTestNotepad();
if (failed > 0) process.exit(1);
