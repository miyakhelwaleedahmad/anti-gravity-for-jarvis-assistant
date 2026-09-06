/**
 * tests/rollbackManagerTest.ts
 * Verifies RollbackManager records, retrieves, and executes rollback actions.
 */
import { RollbackManager } from '../control/rollbackManager.js';

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

console.log('\n=== Rollback Manager Test ===\n');

const rm = new RollbackManager();

// ── Test 1: Register returns an ID ───────────────────────────────────────────
console.log('--- Test 1: Register rollback point ---');
let undoCalled = false;
const id = rm.register('move_file', 'Move test.txt to backup/', async () => {
  undoCalled = true;
  return true;
});
ok('register() returns a non-empty string ID', typeof id === 'string' && id.length > 0);
ok('ID starts with "rb_"', id.startsWith('rb_'));

// ── Test 2: getHistorySummary returns entry ───────────────────────────────────
console.log('\n--- Test 2: History summary ---');
const summary = rm.getHistorySummary();
ok('getHistorySummary() returns array', Array.isArray(summary));
ok('Summary contains the registered action description', summary.some(s => s.includes('Move test.txt')));

// ── Test 3: rollbackLast() executes undo fn ──────────────────────────────────
console.log('\n--- Test 3: rollbackLast() ---');
const result = await rm.rollbackLast();
ok('rollbackLast() returns { success: true }', result.success === true);
ok('rollbackLast() called the undo function', (undoCalled as boolean) === true);
ok('rollbackLast() returns a message string', typeof result.message === 'string');

// ── Test 4: rollbackLast() with no history ───────────────────────────────────
console.log('\n--- Test 4: rollbackLast() with empty history ---');
const emptyResult = await rm.rollbackLast();
ok('rollbackLast() returns { success: false } when empty', emptyResult.success === false);
ok('Message says no actions available', emptyResult.message.toLowerCase().includes('no rollback') || emptyResult.message.includes('available'));

// ── Test 5: Undo function failure is handled ─────────────────────────────────
console.log('\n--- Test 5: Undo function that throws ---');
rm.register('risky_op', 'Some risky operation', async () => {
  throw new Error('undo failed unexpectedly');
});
const failResult = await rm.rollbackLast();
ok('rollbackLast() handles undo errors gracefully', failResult.success === false);
ok('Error message is captured', failResult.message.includes('failed') || failResult.message.includes('error'));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
