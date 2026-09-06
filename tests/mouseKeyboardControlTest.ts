/**
 * tests/mouseKeyboardControlTest.ts
 * Verifies mouse/keyboard controllers enforce permission requirements.
 */
import { mouseController } from '../control/mouseController.js';
import { keyboardController } from '../control/keyboardController.js';
import { permissionSession } from '../control/permissionSession.js';

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

console.log('\n=== Mouse & Keyboard Control Test ===\n');

// Ensure we start at Level 0 (Read Only)
permissionSession.deactivateFullControl();

// ── Test 1: Mouse actions blocked at Level 0 ─────────────────────────────────
console.log('--- Test 1: Mouse actions require Level 2 ---');
const mouseActions = [
  () => mouseController.moveMouse(100, 100),
  () => mouseController.clickMouse(100, 100),
  () => mouseController.scrollMouse(3),
];

for (const action of mouseActions) {
  let blocked = false;
  try {
    await action();
  } catch (err: any) {
    blocked = err.message.toLowerCase().includes('permission') ||
              err.message.toLowerCase().includes('level') ||
              err.message.toLowerCase().includes('full control') ||
              err.message.toLowerCase().includes('blocked');
  }
  ok('Mouse action blocked at Level 0', blocked);
}

// ── Test 2: Keyboard actions blocked at Level 0 ──────────────────────────────
console.log('\n--- Test 2: Keyboard actions require Level 2 ---');
const kbActions = [
  () => keyboardController.typeText('test text'),
  () => keyboardController.pressKey('a'),
];

for (const action of kbActions) {
  let blocked = false;
  try {
    await action();
  } catch (err: any) {
    blocked = err.message.toLowerCase().includes('permission') ||
              err.message.toLowerCase().includes('level') ||
              err.message.toLowerCase().includes('full control') ||
              err.message.toLowerCase().includes('blocked');
  }
  ok('Keyboard action blocked at Level 0', blocked);
}

// ── Test 3: Dangerous hotkeys require Level 3 confirmation ─────────────────
console.log('\n--- Test 3: Dangerous hotkeys require confirmation ---');
// Even at Level 2, these require Level 3 confirmation
permissionSession.activateFullControl(1);

const dangerousKeys = [
  () => keyboardController.pressAltF4(),
  () => keyboardController.pressCtrlW(),
];

for (const action of dangerousKeys) {
  let requiresConfirmation = false;
  try {
    await action();
  } catch (err: any) {
    requiresConfirmation = err.message.toLowerCase().includes('confirm') ||
                           err.message.toLowerCase().includes('level 3') ||
                           err.message.toLowerCase().includes('dangerous') ||
                           err.message.toLowerCase().includes('permission');
  }
  ok('Dangerous hotkey requires Level 3 confirmation (even in full control)', requiresConfirmation);
}

permissionSession.deactivateFullControl();

// ── Test 4: pressEnter() and pressEscape() are safer ─────────────────────────
console.log('\n--- Test 4: pressEnter/pressEscape require at least Level 2 ---');
let enterBlocked = false;
try {
  await keyboardController.pressEnter();
} catch (err: any) {
  enterBlocked = true;
}
ok('pressEnter() is blocked at Level 0 (requires Level 2)', enterBlocked);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
