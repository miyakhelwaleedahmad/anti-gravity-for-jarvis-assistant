/**
 * tests/inputControlTest.ts
 * Verifies InputController wraps mouse+keyboard with permission gates.
 */
import { inputController } from '../control/inputController.js';
import { permissionSession } from '../control/permissionSession.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean) {
  if (condition) { console.log(`  ✅ PASS: ${label}`); passed++; }
  else { console.error(`  ❌ FAIL: ${label}`); failed++; }
}

console.log('\n=== Input Controller Test ===\n');

// Ensure Level 0
permissionSession.deactivateFullControl();

// ── Test 1: typeText blocked at Level 0 ──────────────────────────────────────
console.log('--- Test 1: typeText() blocked at Level 0 ---');
let typeBlocked = false;
try {
  await inputController.typeText('hello world');
} catch (err: any) {
  typeBlocked = err.message.toLowerCase().includes('permission') ||
               err.message.toLowerCase().includes('level') ||
               err.message.toLowerCase().includes('full control') ||
               err.message.toLowerCase().includes('blocked');
}
ok('typeText() blocked at Level 0', typeBlocked);

// ── Test 2: pressHotkey blocked at Level 0 ───────────────────────────────────
console.log('\n--- Test 2: pressHotkey() blocked at Level 0 ---');
let hotkeyBlocked = false;
try {
  await inputController.pressHotkey(['ctrl', 'c']);
} catch (err: any) {
  hotkeyBlocked = err.message.toLowerCase().includes('permission') ||
                  err.message.toLowerCase().includes('level') ||
                  err.message.toLowerCase().includes('full control') ||
                  err.message.toLowerCase().includes('blocked');
}
ok('pressHotkey() blocked at Level 0', hotkeyBlocked);

// ── Test 3: cancelInputAction always works ───────────────────────────────────
console.log('\n--- Test 3: cancelInputAction() always works ---');
try {
  inputController.cancelInputAction();
  ok('cancelInputAction() does not throw', true);
} catch {
  ok('cancelInputAction() does not throw', false);
}

// ── Test 4: After enabling full control, type is allowed ─────────────────────
// Note: We don't actually run the system action in tests — just verify no premature block
console.log('\n--- Test 4: Level 2 removes premature type block ---');
permissionSession.activateFullControl(1);
let level2TypeBlocked = false;
try {
  // In test environment this will likely fail with "not implemented" or powershell error
  // but it should NOT fail with a permission error
  await inputController.typeText('test');
} catch (err: any) {
  level2TypeBlocked = err.message.toLowerCase().includes('permission') ||
                      err.message.toLowerCase().includes('level 2') ||
                      err.message.toLowerCase().includes('full control required');
}
ok('typeText() at Level 2 is NOT blocked by permission', !level2TypeBlocked);
permissionSession.deactivateFullControl();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
