/**
 * tests/goalLifecycleAuditTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Verification audit for Goal Lifecycle state transitions:
 *   - pending
 *   - planning
 *   - executing
 *   - waiting
 *   - completed (ONLY on successful execution)
 *   - failed (NEVER completed on planning failures or watchdog resets)
 *   - retry
 *   - paused
 */

import { goalManager } from '../core/goalManager.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

async function runAudit() {
  console.log('\n=== Goal Lifecycle Audit & State Transition Test ===\n');

  await goalManager.init();

  // Test 1: Goal Creation -> Pending
  console.log('--- Test 1: Goal Creation (pending) ---');
  const g1 = await goalManager.createGoal('Open WhatsApp', 'cli', 2);
  assert(g1.status === 'pending', 'Created goal status is "pending"');
  assert(g1.retries === 0, 'Initial retries is 0');

  // Test 2: Transition to Planning
  console.log('\n--- Test 2: Transition to Planning ---');
  await goalManager.updateGoalStatus(g1.id, 'planning');
  let fetched = goalManager.getGoal(g1.id);
  assert(fetched?.status === 'planning', 'Goal status updated to "planning"');

  // Test 3: Transition to Executing
  console.log('\n--- Test 3: Transition to Executing ---');
  await goalManager.updateGoalStatus(g1.id, 'executing', { taskGraphId: 'graph_123' });
  fetched = goalManager.getGoal(g1.id);
  assert(fetched?.status === 'executing', 'Goal status updated to "executing"');
  assert(fetched?.taskGraphId === 'graph_123', 'TaskGraph ID attached');

  // Test 4: Transition to Waiting
  console.log('\n--- Test 4: Transition to Waiting ---');
  await goalManager.updateGoalStatus(g1.id, 'waiting');
  fetched = goalManager.getGoal(g1.id);
  assert(fetched?.status === 'waiting', 'Goal status updated to "waiting"');

  // Test 5: Successful Execution -> Completed
  console.log('\n--- Test 5: Successful Execution -> Completed ---');
  await goalManager.completeGoal(g1.id);
  fetched = goalManager.getGoal(g1.id);
  assert(fetched?.status === 'completed', 'Goal status updated to "completed"');
  assert(fetched?.completedAt !== undefined, 'completedAt timestamp set');

  // Test 6: Planning Failure / Watchdog Reset -> Failed (NOT Completed)
  console.log('\n--- Test 6: Planning Failure / Watchdog Reset (Must NEVER be completed) ---');
  const g2 = await goalManager.createGoal('Open YouTube', 'voice', 2);
  await goalManager.updateGoalStatus(g2.id, 'planning');
  
  // Simulate watchdog interrupt / planning failure
  const canRetry = await goalManager.failGoal(g2.id, 'Planning interrupted by watchdog');
  fetched = goalManager.getGoal(g2.id);
  
  assert(fetched?.status === 'retry', 'First failure transitions to "retry" state (retries < maxRetries)');
  assert(fetched?.status !== 'completed', 'Failed/Interrupted goal is NEVER marked completed');
  assert(canRetry === true, 'canRetry returns true for attempt 1/2');

  // Simulate second failure (exhausting retries)
  const canRetrySecond = await goalManager.failGoal(g2.id, 'Second planning failure');
  fetched = goalManager.getGoal(g2.id);

  assert(fetched?.status === 'failed', 'Permanent failure sets status to "failed" when retries cap hit');
  assert(fetched?.status !== 'completed', 'Permanently failed goal is NEVER marked completed');
  assert(canRetrySecond === false, 'canRetry returns false when maxRetries reached');

  // Test 7: Paused & Resume
  console.log('\n--- Test 7: Paused & Resume ---');
  const g3 = await goalManager.createGoal('Open Calculator', 'cli', 3);
  await goalManager.updateGoalStatus(g3.id, 'paused');
  fetched = goalManager.getGoal(g3.id);
  assert(fetched?.status === 'paused', 'Goal status updated to "paused"');

  const resumed = await goalManager.resumeGoal(g3.id);
  fetched = goalManager.getGoal(g3.id);
  assert(resumed === true, 'resumeGoal returned true');
  assert(fetched?.status === 'pending', 'Resumed goal reset to "pending"');

  // Test 8: Active Goals Filter Audit
  console.log('\n--- Test 8: Active Goals Filter Audit ---');
  const activeGoals = goalManager.getActiveGoals();
  assert(activeGoals.some(g => g.id === g3.id), 'Active goals includes pending resumed goal');
  assert(!activeGoals.some(g => g.id === g1.id), 'Active goals excludes completed goal');
  assert(!activeGoals.some(g => g.id === g2.id), 'Active goals excludes permanently failed goal');

  await goalManager.flush();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('❌ Goal Lifecycle Audit FAILED.');
    process.exit(1);
  } else {
    console.log('✅ Goal Lifecycle Audit & State Transitions PASSED!');
    process.exit(0);
  }
}

runAudit().catch((err) => {
  console.error('[GoalAudit] Unexpected error:', err);
  process.exit(1);
});
