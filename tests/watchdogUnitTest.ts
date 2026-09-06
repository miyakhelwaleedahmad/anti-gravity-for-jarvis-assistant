/**
 * tests/watchdogUnitTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Safe unit tests for the SPEAKING and PLANNING watchdog timers added to
 * AgentStateMachine in Step 2.
 *
 * Tests:
 *   1. SPEAKING watchdog fires and resets to IDLE after timeout
 *   2. Normal speaking_end clears watchdog before it fires (no false reset)
 *   3. PLANNING watchdog fires and resets to IDLE after timeout
 *   4. Normal PLANNING → EXECUTING clears watchdog before it fires
 *   5. interrupt() clears both watchdogs
 *   6. reset() clears both watchdogs
 *
 * SAFE TO RUN: Pure in-memory logic — no shell, no network, no I/O.
 * Uses short timeouts (50ms / 80ms) so tests finish quickly.
 */

import { AgentStateMachine, AgentState } from '../core/agentStateMachine.js';

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

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('\n=== Watchdog Unit Tests ===\n');

  // ── Test 1: SPEAKING watchdog fires after timeout ─────────────────────────
  console.log('--- Test 1: SPEAKING watchdog auto-resets to IDLE after timeout ---');
  {
    const sm = new AgentStateMachine();
    // Override timeout to 50ms for testing
    (sm as any)._armSpeakingWatchdog = function () {
      (sm as any)._clearSpeakingWatchdog();
      (sm as any)._speakingWatchdog = setTimeout(() => {
        if ((sm as any)._state === AgentState.SPEAKING) {
          (sm as any)._state = AgentState.IDLE;
          (sm as any)._stateHistory.push({ state: AgentState.IDLE, timestamp: Date.now() });
          sm.emit('transition', { from: AgentState.SPEAKING, to: AgentState.IDLE });
          sm.emit('state_changed', AgentState.IDLE);
          sm.emit('idle');
          sm.emit('watchdog_reset', { fromState: AgentState.SPEAKING, reason: 'speaking_timeout' });
        }
      }, 50); // fast for testing
    };

    let watchdogFired = false;
    sm.on('watchdog_reset' as any, ({ fromState }: any) => {
      if (fromState === AgentState.SPEAKING) watchdogFired = true;
    });

    sm.transition(AgentState.SPEAKING);
    ok('State is SPEAKING before watchdog', sm.currentState === AgentState.SPEAKING);

    await wait(100); // wait for watchdog to fire

    ok('State reset to IDLE after SPEAKING watchdog timeout', sm.currentState === AgentState.IDLE);
    ok('watchdog_reset event was emitted', watchdogFired);
  }

  // ── Test 2: Normal speaking_end clears watchdog (no spurious reset) ────────
  console.log('\n--- Test 2: Normal transition out of SPEAKING clears watchdog ---');
  {
    const sm = new AgentStateMachine();
    // Override timeout to 80ms for testing
    (sm as any)._armSpeakingWatchdog = function () {
      (sm as any)._clearSpeakingWatchdog();
      (sm as any)._speakingWatchdog = setTimeout(() => {
        if ((sm as any)._state === AgentState.SPEAKING) {
          (sm as any)._state = AgentState.IDLE;
          sm.emit('watchdog_reset', { fromState: AgentState.SPEAKING, reason: 'speaking_timeout' });
        }
      }, 80);
    };

    let watchdogFired = false;
    sm.on('watchdog_reset' as any, () => { watchdogFired = true; });

    sm.transition(AgentState.SPEAKING);
    ok('State is SPEAKING', sm.currentState === AgentState.SPEAKING);

    // Transition normally before timeout
    await wait(10);
    sm.transition(AgentState.IDLE);
    ok('State transitioned to IDLE normally (before timeout)', sm.currentState === AgentState.IDLE);

    await wait(100); // wait past where watchdog would have fired
    ok('Watchdog did NOT fire after normal transition', !watchdogFired);
  }

  // ── Test 3: PLANNING watchdog fires after timeout ──────────────────────────
  console.log('\n--- Test 3: PLANNING watchdog auto-resets to IDLE after timeout ---');
  {
    const sm = new AgentStateMachine();
    (sm as any)._armPlanningWatchdog = function () {
      (sm as any)._clearPlanningWatchdog();
      (sm as any)._planningWatchdog = setTimeout(() => {
        if ((sm as any)._state === AgentState.PLANNING) {
          (sm as any)._state = AgentState.IDLE;
          (sm as any)._stateHistory.push({ state: AgentState.IDLE, timestamp: Date.now() });
          sm.emit('transition', { from: AgentState.PLANNING, to: AgentState.IDLE });
          sm.emit('state_changed', AgentState.IDLE);
          sm.emit('idle');
          sm.emit('watchdog_reset', { fromState: AgentState.PLANNING, reason: 'planning_timeout' });
        }
      }, 50);
    };

    let watchdogFired = false;
    sm.on('watchdog_reset' as any, ({ fromState }: any) => {
      if (fromState === AgentState.PLANNING) watchdogFired = true;
    });

    sm.transition(AgentState.PLANNING);
    ok('State is PLANNING before watchdog', sm.currentState === AgentState.PLANNING);

    await wait(100);

    ok('State reset to IDLE after PLANNING watchdog timeout', sm.currentState === AgentState.IDLE);
    ok('PLANNING watchdog_reset event was emitted', watchdogFired);
  }

  // ── Test 4: Normal PLANNING → EXECUTING clears watchdog ───────────────────
  console.log('\n--- Test 4: Normal PLANNING transition clears watchdog ---');
  {
    const sm = new AgentStateMachine();
    (sm as any)._armPlanningWatchdog = function () {
      (sm as any)._clearPlanningWatchdog();
      (sm as any)._planningWatchdog = setTimeout(() => {
        if ((sm as any)._state === AgentState.PLANNING) {
          (sm as any)._state = AgentState.IDLE;
          sm.emit('watchdog_reset', { fromState: AgentState.PLANNING, reason: 'planning_timeout' });
        }
      }, 80);
    };

    let watchdogFired = false;
    sm.on('watchdog_reset' as any, () => { watchdogFired = true; });

    sm.transition(AgentState.PLANNING);
    await wait(10);
    sm.transition(AgentState.EXECUTING);
    ok('State transitioned from PLANNING to EXECUTING normally', sm.currentState === AgentState.EXECUTING);

    await wait(100);
    ok('PLANNING watchdog did NOT fire after normal transition', !watchdogFired);
  }

  // ── Test 5: interrupt() clears both watchdogs ──────────────────────────────
  console.log('\n--- Test 5: interrupt() clears both watchdogs ---');
  {
    const sm = new AgentStateMachine();
    let speakingFired = false;
    sm.on('watchdog_reset' as any, ({ fromState }: any) => {
      if (fromState === AgentState.SPEAKING) speakingFired = true;
    });

    // Patch to use very short timeouts
    (sm as any)._armSpeakingWatchdog = function () {
      (sm as any)._clearSpeakingWatchdog();
      (sm as any)._speakingWatchdog = setTimeout(() => {
        if ((sm as any)._state === AgentState.SPEAKING) {
          (sm as any)._state = AgentState.IDLE;
          sm.emit('watchdog_reset', { fromState: AgentState.SPEAKING, reason: 'speaking_timeout' });
        }
      }, 80);
    };

    sm.transition(AgentState.SPEAKING);
    sm.interrupt();
    ok('State is INTERRUPTED after interrupt()', sm.currentState === AgentState.INTERRUPTED);

    await wait(100);
    ok('SPEAKING watchdog did NOT fire after interrupt()', !speakingFired);
  }

  // ── Test 6: reset() clears both watchdogs ─────────────────────────────────
  console.log('\n--- Test 6: reset() clears both watchdogs ---');
  {
    const sm = new AgentStateMachine();
    let planningFired = false;
    sm.on('watchdog_reset' as any, ({ fromState }: any) => {
      if (fromState === AgentState.PLANNING) planningFired = true;
    });

    (sm as any)._armPlanningWatchdog = function () {
      (sm as any)._clearPlanningWatchdog();
      (sm as any)._planningWatchdog = setTimeout(() => {
        if ((sm as any)._state === AgentState.PLANNING) {
          (sm as any)._state = AgentState.IDLE;
          sm.emit('watchdog_reset', { fromState: AgentState.PLANNING, reason: 'planning_timeout' });
        }
      }, 80);
    };

    sm.transition(AgentState.PLANNING);
    (sm as any)._state = AgentState.IDLE; // force idle without clearing watchdog manually
    sm.reset();
    ok('State is IDLE after reset()', sm.currentState === AgentState.IDLE);

    await wait(100);
    ok('PLANNING watchdog did NOT fire after reset()', !planningFired);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('[WatchdogUnitTest] Unexpected error:', err);
  process.exit(1);
});
