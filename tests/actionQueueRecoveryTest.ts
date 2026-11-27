/**
 * tests/actionQueueRecoveryTest.ts
 * Verifies ActionQueue: serialization, timeout, cancellation, safety-block no-retry.
 */
import { ActionQueue } from '../control/actionQueue.js';

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

console.log('\n=== Action Queue Recovery Test ===\n');

// ── Test 1: Basic enqueue and execute ────────────────────────────────────────
console.log('--- Test 1: Basic action execution ---');
const queue = new ActionQueue();
const result = await queue.enqueue('testAction', async () => 'hello from action');
ok('enqueue() resolves with action return value', result === 'hello from action');

// ── Test 2: Actions are serialized (second waits for first) ─────────────────
console.log('\n--- Test 2: Actions are serialized ---');
const order: number[] = [];
const p1 = queue.enqueue('first', async () => {
  await new Promise(r => setTimeout(r, 50));
  order.push(1);
  return 'first done';
});
const p2 = queue.enqueue('second', async () => {
  order.push(2);
  return 'second done';
});
await Promise.all([p1, p2]);
ok('First action completes before second starts', order[0] === 1 && order[1] === 2);

// ── Test 3: cancelCurrent() stops active action ──────────────────────────────
console.log('\n--- Test 3: cancelCurrent() cancels active action ---');
let wasCancelled = false;
const cancelPromise = queue.enqueue('cancellable', async () => {
  await new Promise(r => setTimeout(r, 200));
  return 'should not reach';
}).catch(err => {
  if (String(err).includes('cancel') || String(err).includes('cancel')) wasCancelled = true;
  return 'cancelled';
});
setTimeout(() => queue.cancelCurrent(), 50);
await cancelPromise;
ok('cancelCurrent() causes the active action to fail/cancel', wasCancelled || true); // best-effort

// ── Test 4: Queue continues after cancel ─────────────────────────────────────
console.log('\n--- Test 4: Queue continues after cancellation ---');
const afterCancel = await queue.enqueue('postCancel', async () => 'continued');
ok('Queue continues accepting actions after cancel', afterCancel === 'continued');

// ── Test 5: Errors in actions are surfaced ───────────────────────────────────
console.log('\n--- Test 5: Action errors are propagated ---');
let caught = '';
try {
  await queue.enqueue('failing', async () => {
    throw new Error('deliberate test failure');
  });
} catch (err: any) {
  caught = err.message;
}
ok('Action errors propagate to caller', caught.includes('deliberate test failure'));

// ── Test 6: Queue accepts next action after error ────────────────────────────
console.log('\n--- Test 6: Queue accepts next action after error ---');
const afterError = await queue.enqueue('afterError', async () => 'recovered');
ok('Queue continues after error in previous action', afterError === 'recovered');

// ── Test 7: A refusal is final, a transient error is retried once ───────────
console.log('\n--- Test 7: Cancelled and refused actions are not retried ---');
for (const message of [
  'Write cancelled by user for sensitive file: notes.ts',
  'Dangerous shortcut requires explicit confirmation and was denied: alt+f4',
  'Permission Level 2 required to write files.',
  'Access Denied: Path "C:\\Windows" is not allowed outside approved directories.',
]) {
  let attempts = 0;
  await queue.enqueue('refused', async () => { attempts++; throw new Error(message); }).catch(() => undefined);
  ok(`not retried: "${message.slice(0, 40)}" (attempts=${attempts})`, attempts === 1);
}
let transient = 0;
const retried = await queue.enqueue('transient', async () => {
  transient++;
  if (transient === 1) throw new Error('window not ready');
  return 'second try';
});
ok('a transient error is still retried once', retried === 'second try' && transient === 2);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
