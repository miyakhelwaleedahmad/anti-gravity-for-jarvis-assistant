/**
 * tests/pcControlKernelTest.ts
 * Verifies PcControlKernel returns correctly shaped KernelResult objects
 * for read-only operations that don't require system access.
 */
import { pcControlKernel } from '../control/pcControlKernel.js';

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

function okResult(label: string, result: any) {
  ok(`${label} — result has .success field`, typeof result.success === 'boolean');
  ok(`${label} — result has .action string`, typeof result.action === 'string');
  ok(`${label} — result has .durationMs number`, typeof result.durationMs === 'number');
  ok(`${label} — result.error is null or string`, result.error === null || typeof result.error === 'string');
}

console.log('\n=== PC Control Kernel Test ===\n');

// ── Test 1: getPcState() ─────────────────────────────────────────────────────
console.log('--- Test 1: getPcState() ---');
const pcState = await pcControlKernel.getPcState();
okResult('getPcState', pcState);
ok('getPcState message is a string', typeof pcState.message === 'string');

// ── Test 2: getSystemResources() ─────────────────────────────────────────────
console.log('\n--- Test 2: getSystemResources() ---');
const resources = await pcControlKernel.getSystemResources();
okResult('getSystemResources', resources);

// ── Test 3: getNetworkStatus() ───────────────────────────────────────────────
console.log('\n--- Test 3: getNetworkStatus() ---');
const network = await pcControlKernel.getNetworkStatus();
okResult('getNetworkStatus', network);

// ── Test 4: getDiskStatus() ──────────────────────────────────────────────────
console.log('\n--- Test 4: getDiskStatus() ---');
const disk = await pcControlKernel.getDiskStatus();
okResult('getDiskStatus', disk);

// ── Test 5: listProcesses() ──────────────────────────────────────────────────
console.log('\n--- Test 5: listProcesses() ---');
const procs = await pcControlKernel.listProcesses();
okResult('listProcesses', procs);

// ── Test 6: getChromeTabs() falls back gracefully ────────────────────────────
console.log('\n--- Test 6: getChromeTabs() does not crash ---');
const tabs = await pcControlKernel.getChromeTabs();
okResult('getChromeTabs', tabs);
// Chrome DevTools probably not running — success or message about unavailability
ok('getChromeTabs returns a message string', typeof tabs.message === 'string');

// ── Test 7: Result shape consistency ─────────────────────────────────────────
console.log('\n--- Test 7: Result shape consistency ---');
const results = [pcState, resources, network, disk, procs, tabs];
for (const r of results) {
  ok('permissionLevel is a number', typeof r.permissionLevel === 'number');
  ok('target is a string', typeof r.target === 'string');
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
