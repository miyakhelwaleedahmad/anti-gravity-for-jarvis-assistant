/**
 * tests/permissionSessionTest.ts
 * Verifies permission session levels, activation, deactivation, and expiry.
 */
import { permissionSession, basePermissionLevel } from '../control/permissionSession.js';

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

console.log('\n=== Permission Session Test ===\n');

// ── Test 1: Default level ────────────────────────────────────────────────────
// Level 1 ("safe control": open, focus, navigate) by default since upgrade P2;
// JARVIS_DEFAULT_PERMISSION_LEVEL=0 restores the old read-only default.
console.log('--- Test 1: Default level is 1 (SAFE CONTROL) ---');
ok('basePermissionLevel() is 1, or 0 when JARVIS_DEFAULT_PERMISSION_LEVEL=0',
  basePermissionLevel({}) === 1 && basePermissionLevel({ JARVIS_DEFAULT_PERMISSION_LEVEL: '0' }) === 0);
ok('getCurrentLevel() returns 1 by default', permissionSession.getCurrentLevel() === 1);
ok('checkPermission(0, ...) passes at level 1', permissionSession.checkPermission(0, 'Read state'));
ok('checkPermission(1, ...) passes at level 1', permissionSession.checkPermission(1, 'Focus app'));
ok('checkPermission(2, ...) fails at level 1', !permissionSession.checkPermission(2, 'Type text'));

// ── Test 2: Activate FULL CONTROL (level 2) ─────────────────────────────────
console.log('\n--- Test 2: Activate Full Control Mode (level 2) ---');
permissionSession.activateFullControl(30);
ok('getCurrentLevel() is 2 after activateFullControl()', permissionSession.getCurrentLevel() === 2);
ok('isFullControlActive() is true', permissionSession.isFullControlActive());
ok('checkPermission(0, ...) passes at level 2', permissionSession.checkPermission(0, 'Read state'));
ok('checkPermission(1, ...) passes at level 2', permissionSession.checkPermission(1, 'Focus app'));
ok('checkPermission(2, ...) passes at level 2', permissionSession.checkPermission(2, 'Type text'));

// ── Test 3: Level 3 still requires confirmation ──────────────────────────────
console.log('\n--- Test 3: Level 3 requires confirmation even in full control ---');
ok('checkPermission(3, ...) fails even at level 2 (always confirm)',
  !permissionSession.checkPermission(3, 'Delete file'));

// ── Test 4: Deactivate ───────────────────────────────────────────────────────
console.log('\n--- Test 4: Deactivate Full Control Mode ---');
permissionSession.deactivateFullControl();
ok('getCurrentLevel() returns to 1 after deactivate', permissionSession.getCurrentLevel() === 1);
ok('isFullControlActive() is false after deactivate', !permissionSession.isFullControlActive());
ok('checkPermission(2, ...) fails after deactivate', !permissionSession.checkPermission(2, 'Type text'));

// ── Test 5: getStatus() ─────────────────────────────────────────────────────
console.log('\n--- Test 5: getStatus() returns summary string ---');
const status = permissionSession.getStatus();
ok('getStatus() returns a string', typeof status === 'string');
ok('getStatus() contains "level"', status.toLowerCase().includes('level'));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
