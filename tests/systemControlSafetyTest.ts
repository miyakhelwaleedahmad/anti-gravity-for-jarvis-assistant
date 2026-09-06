/**
 * tests/systemControlSafetyTest.ts
 * Verifies SystemController and AdminController safety gates.
 */
import { systemController } from '../control/systemController.js';
import { adminController } from '../control/adminController.js';

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

console.log('\n=== System & Admin Control Safety Test ===\n');

// ── Test 1: getSystemStatus() works ──────────────────────────────────────────
console.log('--- Test 1: getSystemStatus() ---');
let sysStatus: string = '';
try {
  sysStatus = await systemController.getSystemStatus();
  ok('getSystemStatus() resolves without throwing', true);
} catch (err: any) {
  ok(`getSystemStatus() resolves without throwing (got: ${err.message})`, false);
}
ok('getSystemStatus() returns a JSON string', sysStatus.length > 0);
try {
  const parsed = JSON.parse(sysStatus);
  ok('getSystemStatus() is valid JSON', true);
  ok('System status has platform', typeof parsed.platform === 'string');
  ok('System status has freeMemoryMb', typeof parsed.freeMemoryMb === 'number');
} catch {
  ok('getSystemStatus() is valid JSON', false);
}

// ── Test 2: getNetworkStatus() works ─────────────────────────────────────────
console.log('\n--- Test 2: getNetworkStatus() ---');
let netStatus: string = '';
try {
  netStatus = await systemController.getNetworkStatus();
  ok('getNetworkStatus() resolves without throwing', true);
} catch (err: any) {
  ok(`getNetworkStatus() resolves without throwing (got: ${err.message})`, false);
}
ok('getNetworkStatus() returns a string', typeof netStatus === 'string' && netStatus.length > 0);

// ── Test 3: runShellCommand() is always blocked at Level 0 ───────────────────
console.log('\n--- Test 3: runShellCommand() requires Level 3 ---');
let shellBlocked = false;
try {
  await adminController.runShellCommand('echo hello');
} catch (err: any) {
  shellBlocked = err.message.toLowerCase().includes('permission') ||
                 err.message.toLowerCase().includes('level') ||
                 err.message.toLowerCase().includes('confirm') ||
                 err.message.toLowerCase().includes('blocked');
}
ok('runShellCommand() is blocked at Level 0', shellBlocked);

// ── Test 4: runPowerShell() is blocked at Level 0 ────────────────────────────
console.log('\n--- Test 4: runPowerShell() requires Level 3 ---');
let psBlocked = false;
try {
  await adminController.runPowerShell('Get-Process');
} catch (err: any) {
  psBlocked = err.message.toLowerCase().includes('permission') ||
              err.message.toLowerCase().includes('level') ||
              err.message.toLowerCase().includes('confirm') ||
              err.message.toLowerCase().includes('blocked');
}
ok('runPowerShell() is blocked at Level 0', psBlocked);

// ── Test 5: getDiskStatus() works ────────────────────────────────────────────
console.log('\n--- Test 5: getDiskStatus() ---');
let diskStatus: string = '';
try {
  diskStatus = await systemController.getDiskStatus();
  ok('getDiskStatus() resolves without throwing', true);
} catch (err: any) {
  ok(`getDiskStatus() resolves without throwing (got: ${err.message})`, false);
}
ok('getDiskStatus() returns a string', typeof diskStatus === 'string');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
