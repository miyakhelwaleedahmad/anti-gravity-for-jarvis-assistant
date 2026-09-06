/**
 * stateMachineVerification.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE 4 — State Machine Verification
 *
 * Tests:
 *   ✅ No illegal transition errors in normal flow
 *   ✅ No INTERRUPTED → SPEAKING direct failures
 *   ✅ No INTERRUPTED → LISTENING direct failures
 *   ✅ No INTERRUPTED → PROCESSING_STT failures (seamless handoff)
 *   ✅ No IDLE → PROCESSING_STT failures (seamless handoff edge case)
 *   ✅ WakeWord flow works correctly
 *   ✅ Speaking flow works correctly
 *   ✅ Interrupt recovery works correctly
 *   ✅ Reasoning loop transitions
 *   ✅ Seamless handoff: has_command=true voice path
 */

import 'dotenv/config';
import { AgentStateMachine, AgentState } from './core/agentStateMachine.js';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function assertThrows(label: string, fn: () => void) {
  try {
    fn();
    console.error(`  ❌ FAIL: ${label} — expected throw but succeeded`);
    failed++;
  } catch (e) {
    console.log(`  ✅ ${label} — correctly rejected: ${(e as Error).message.split('\n')[0]}`);
    passed++;
  }
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
}

// ─── Test 1: WakeWord Flow ────────────────────────────────────────────────────

section('TEST 1: WakeWord Flow');
{
  const sm = new AgentStateMachine();
  assert('Starts in IDLE', sm.currentState === AgentState.IDLE);

  // IDLE → LISTENING (wake word detected)
  sm.transition(AgentState.LISTENING);
  assert('IDLE → LISTENING', sm.currentState === AgentState.LISTENING);

  // LISTENING → PROCESSING_STT
  sm.transition(AgentState.PROCESSING_STT);
  assert('LISTENING → PROCESSING_STT', sm.currentState === AgentState.PROCESSING_STT);

  // PROCESSING_STT → PLANNING
  sm.transition(AgentState.PLANNING);
  assert('PROCESSING_STT → PLANNING', sm.currentState === AgentState.PLANNING);

  // PLANNING → EXECUTING
  sm.transition(AgentState.EXECUTING);
  assert('PLANNING → EXECUTING', sm.currentState === AgentState.EXECUTING);

  // EXECUTING → OBSERVING
  sm.transition(AgentState.OBSERVING);
  assert('EXECUTING → OBSERVING', sm.currentState === AgentState.OBSERVING);

  // OBSERVING → REFLECTING
  sm.transition(AgentState.REFLECTING);
  assert('OBSERVING → REFLECTING', sm.currentState === AgentState.REFLECTING);

  // REFLECTING → SPEAKING
  sm.transition(AgentState.SPEAKING);
  assert('REFLECTING → SPEAKING', sm.currentState === AgentState.SPEAKING);

  // SPEAKING → IDLE
  sm.transition(AgentState.IDLE);
  assert('SPEAKING → IDLE (complete round-trip)', sm.currentState === AgentState.IDLE);
}

// ─── Test 2: Speaking Flow ────────────────────────────────────────────────────

section('TEST 2: Direct Speaking Flow (IDLE → SPEAKING)');
{
  const sm = new AgentStateMachine();

  // IDLE can go directly to SPEAKING (autonomous proactive speech)
  sm.transition(AgentState.SPEAKING);
  assert('IDLE → SPEAKING (proactive)', sm.currentState === AgentState.SPEAKING);

  sm.transition(AgentState.IDLE);
  assert('SPEAKING → IDLE', sm.currentState === AgentState.IDLE);
}

// ─── Test 3: Interrupt Recovery ───────────────────────────────────────────────

section('TEST 3: Interrupt Recovery');
{
  const sm = new AgentStateMachine();

  // Put in SPEAKING state
  sm.transition(AgentState.SPEAKING);
  assert('In SPEAKING state', sm.currentState === AgentState.SPEAKING);

  // Interrupt during speaking
  sm.interrupt();
  assert('SPEAKING → INTERRUPTED', sm.currentState === AgentState.INTERRUPTED);
  assert('isInterrupted() true', sm.isInterrupted());

  // INTERRUPTED → LISTENING (resume listening after interrupt)
  sm.transition(AgentState.LISTENING);
  assert('INTERRUPTED → LISTENING (recovery)', sm.currentState === AgentState.LISTENING);
  assert('isInterrupted() false after recovery', !sm.isInterrupted());
}

section('TEST 3b: Interrupt → SPEAKING Recovery');
{
  const sm = new AgentStateMachine();

  // Put in PLANNING state
  sm.transition(AgentState.PLANNING);
  sm.interrupt();
  assert('PLANNING → INTERRUPTED', sm.isInterrupted());

  // INTERRUPTED → SPEAKING (e.g. error announcement)
  sm.transition(AgentState.SPEAKING);
  assert('INTERRUPTED → SPEAKING (error recovery speech)', sm.currentState === AgentState.SPEAKING);

  sm.transition(AgentState.IDLE);
  assert('SPEAKING → IDLE (clean finish)', sm.currentState === AgentState.IDLE);
}

section('TEST 3c: INTERRUPTED → IDLE via reset()');
{
  const sm = new AgentStateMachine();

  // Navigate to EXECUTING via valid path: IDLE → PLANNING → EXECUTING
  sm.transition(AgentState.PLANNING);
  sm.transition(AgentState.EXECUTING);
  sm.interrupt();
  assert('EXECUTING → INTERRUPTED', sm.isInterrupted());

  sm.reset();
  assert('reset() → IDLE', sm.currentState === AgentState.IDLE);
}

// ─── Test 4: Illegal Transitions Must Throw ───────────────────────────────────

section('TEST 4: Illegal Transition Rejection');
{
  const sm = new AgentStateMachine();

  // LISTENING → SPEAKING (illegal — must go through PROCESSING_STT first)
  assertThrows('LISTENING → SPEAKING rejected', () => {
    sm.transition(AgentState.LISTENING);
    sm.transition(AgentState.SPEAKING);
  });

  const sm2 = new AgentStateMachine();
  // EXECUTING → PLANNING (illegal — no backward leap)
  assertThrows('EXECUTING → PLANNING rejected', () => {
    sm2.transition(AgentState.PLANNING);
    sm2.transition(AgentState.EXECUTING);
    sm2.transition(AgentState.PLANNING); // backward — illegal
  });

  const sm3 = new AgentStateMachine();
  // IDLE → OBSERVING (skip) — illegal
  assertThrows('IDLE → OBSERVING rejected', () => {
    sm3.transition(AgentState.OBSERVING);
  });
}

// ─── Test 5: Idempotent Transitions ──────────────────────────────────────────

section('TEST 5: Idempotent Self-Transitions');
{
  const sm = new AgentStateMachine();
  sm.transition(AgentState.LISTENING);

  // Same state should return true without throwing
  const result = sm.transition(AgentState.LISTENING);
  assert('LISTENING → LISTENING (idempotent, no throw)', result === true && sm.currentState === AgentState.LISTENING);
}

// ─── Test 6: Interrupt from any active state ──────────────────────────────────

section('TEST 6: Interrupt from Any Active State');
{
  const activeStates = [
    AgentState.LISTENING,
    AgentState.PROCESSING_STT,
    AgentState.PLANNING,
    AgentState.EXECUTING,
    AgentState.OBSERVING,
    AgentState.REFLECTING,
    AgentState.REPAIRING,
    AgentState.SPEAKING,
  ];

  for (const startState of activeStates) {
    // Check if IDLE can reach this state
    const sm = new AgentStateMachine();
    try {
      // Navigate to the state manually based on valid paths
      const paths: Record<string, AgentState[]> = {
        [AgentState.LISTENING]:       [AgentState.LISTENING],
        [AgentState.PROCESSING_STT]:  [AgentState.LISTENING, AgentState.PROCESSING_STT],
        [AgentState.PLANNING]:        [AgentState.PLANNING],
        [AgentState.EXECUTING]:       [AgentState.PLANNING, AgentState.EXECUTING],
        [AgentState.OBSERVING]:       [AgentState.PLANNING, AgentState.EXECUTING, AgentState.OBSERVING],
        [AgentState.REFLECTING]:      [AgentState.PLANNING, AgentState.EXECUTING, AgentState.OBSERVING, AgentState.REFLECTING],
        [AgentState.REPAIRING]:       [AgentState.PLANNING, AgentState.EXECUTING, AgentState.OBSERVING, AgentState.REFLECTING, AgentState.REPAIRING],
        [AgentState.SPEAKING]:        [AgentState.SPEAKING],
      };

      for (const step of paths[startState] ?? [startState]) {
        sm.transition(step);
      }

      sm.interrupt();
      assert(`${startState} → INTERRUPTED`, sm.isInterrupted());
    } catch (e) {
      assert(`${startState} interrupt test`, false, (e as Error).message);
    }
  }
}

// ─── Test 7: can() gating ────────────────────────────────────────────────────

section('TEST 7: can() Action Gating');
{
  const sm = new AgentStateMachine();
  assert('can(stt_listen) false in IDLE', !sm.can('stt_listen'));
  assert('can(plan) true in IDLE', sm.can('plan'));
  assert('can(tts_speak) true in IDLE', sm.can('tts_speak'));

  sm.transition(AgentState.LISTENING);
  assert('can(stt_listen) true in LISTENING', sm.can('stt_listen'));
  assert('can(plan) false in LISTENING', !sm.can('plan'));

  sm.transition(AgentState.PROCESSING_STT);
  sm.transition(AgentState.PLANNING);
  sm.transition(AgentState.EXECUTING);
  assert('can(tool_execute) true in EXECUTING', sm.can('tool_execute'));
  assert('can(plan) false in EXECUTING', !sm.can('plan'));

  sm.interrupt();
  assert('can(tts_output) false when INTERRUPTED', !sm.can('tts_output'));
}

// ─── Test 8: Event emissions ─────────────────────────────────────────────────

section('TEST 8: Event Emissions');
{
  const sm = new AgentStateMachine();
  const events: string[] = [];

  sm.on('transition', ({ from, to }) => events.push(`${from}→${to}`));
  sm.on('state_changed', (s) => events.push(`changed:${s}`));
  sm.on('interrupted', () => events.push('interrupted_event'));

  sm.transition(AgentState.LISTENING);
  sm.interrupt();

  assert('transition event fired', events.some(e => e.includes('IDLE→LISTENING')));
  assert('state_changed event fired', events.some(e => e === 'changed:LISTENING'));
  assert('interrupted event fired on interrupt()', events.includes('interrupted_event'));
}

// ─── Test 9: State history ───────────────────────────────────────────────────────

section('TEST 9: State History Tracking');
{
  const sm = new AgentStateMachine();
  sm.transition(AgentState.LISTENING);
  sm.transition(AgentState.PROCESSING_STT);
  sm.transition(AgentState.PLANNING);

  const hist = sm.stateHistory;
  assert('History has 3 entries', hist.length === 3);
  assert('History[0] is LISTENING', hist[0].state === AgentState.LISTENING);
  assert('History[2] is PLANNING', hist[2].state === AgentState.PLANNING);

  const stats = sm.getStats();
  assert('getStats() includes PLANNING', stats[AgentState.PLANNING] === 1);
}

// ─── Test 10: Seamless Handoff ──────────────────────────────────────────────────

section('TEST 10: Seamless Handoff — IDLE → INTERRUPTED → PROCESSING_STT');
{
  // Simulates: user was idle, wake word + command came in one utterance
  // State was IDLE, interrupt fired from speech_detected, then stt_result arrived
  const sm = new AgentStateMachine();

  // speech_detected fires an interrupt even from IDLE
  sm.interrupt();
  assert('IDLE → INTERRUPTED (speech_detected)', sm.isInterrupted());

  // stt_result arrives immediately (has_command=true seamless handoff)
  sm.transition(AgentState.PROCESSING_STT);
  assert('INTERRUPTED → PROCESSING_STT (seamless handoff)', sm.currentState === AgentState.PROCESSING_STT);

  // Pipeline continues normally
  sm.transition(AgentState.PLANNING);
  assert('PROCESSING_STT → PLANNING', sm.currentState === AgentState.PLANNING);
  sm.transition(AgentState.EXECUTING);
  assert('PLANNING → EXECUTING', sm.currentState === AgentState.EXECUTING);
  sm.transition(AgentState.OBSERVING);
  sm.transition(AgentState.REFLECTING);
  sm.transition(AgentState.SPEAKING);
  sm.transition(AgentState.IDLE);
  assert('Full pipeline completes after seamless handoff', sm.currentState === AgentState.IDLE);
}

section('TEST 10b: Seamless Handoff — SPEAKING → INTERRUPTED → PROCESSING_STT');
{
  // Simulates: JARVIS was speaking, user interrupted with a new voice command
  const sm = new AgentStateMachine();
  sm.transition(AgentState.SPEAKING);
  assert('In SPEAKING', sm.currentState === AgentState.SPEAKING);

  sm.interrupt();
  assert('SPEAKING → INTERRUPTED', sm.isInterrupted());

  // stt_result arrives immediately from the interrupting utterance
  sm.transition(AgentState.PROCESSING_STT);
  assert('INTERRUPTED → PROCESSING_STT (interrupt-replace handoff)', sm.currentState === AgentState.PROCESSING_STT);

  sm.transition(AgentState.PLANNING);
  sm.transition(AgentState.EXECUTING);
  sm.transition(AgentState.OBSERVING);
  sm.transition(AgentState.REFLECTING);
  sm.transition(AgentState.SPEAKING);
  sm.transition(AgentState.IDLE);
  assert('Pipeline completes after interrupt-replace handoff', sm.currentState === AgentState.IDLE);
}

section('TEST 10c: wake_word has_command=true — no LISTENING detour');
{
  // In has_command=true path, we skip LISTENING entirely.
  // Verify: IDLE → INTERRUPTED → PROCESSING_STT (no LISTENING in path)
  const sm = new AgentStateMachine();

  // speech_detected always fires interrupt
  sm.interrupt();
  assert('speech_detected → INTERRUPTED', sm.isInterrupted());

  // stt_result arrives (has_command=true handoff bypasses listen_start)
  sm.transition(AgentState.PROCESSING_STT);
  assert('PROCESSING_STT reached without LISTENING (has_command=true)', sm.currentState === AgentState.PROCESSING_STT);

  // Verify LISTENING was never visited
  const hist = sm.stateHistory;
  const visitedListening = hist.some(h => h.state === AgentState.LISTENING);
  assert('LISTENING state never visited (bypassed by seamless handoff)', !visitedListening);
}

section('TEST 10d: stt_result immediately after wake_word — idempotent guard');
{
  // Verify that if PROCESSING_STT is already active (somehow), transition is idempotent
  const sm = new AgentStateMachine();
  sm.transition(AgentState.LISTENING);
  sm.transition(AgentState.PROCESSING_STT);

  // Simulates stt_result handler calling transition when already PROCESSING_STT
  const result = sm.transition(AgentState.PROCESSING_STT); // idempotent
  assert('PROCESSING_STT → PROCESSING_STT is idempotent (no throw)', result === true);
}

section('TEST 10e: INTERRUPTED → PROCESSING_STT does NOT allow unsafe jumps');
{
  // Verify that PROCESSING_STT from INTERRUPTED does NOT allow skipping to OBSERVING etc.
  assertThrows('INTERRUPTED cannot jump to OBSERVING', () => {
    const sm = new AgentStateMachine();
    sm.interrupt();
    sm.transition(AgentState.OBSERVING); // still illegal
  });

  assertThrows('INTERRUPTED cannot jump to EXECUTING', () => {
    const sm = new AgentStateMachine();
    sm.interrupt();
    sm.transition(AgentState.EXECUTING); // still illegal
  });

  assertThrows('INTERRUPTED cannot jump to REPAIRING', () => {
    const sm = new AgentStateMachine();
    sm.interrupt();
    sm.transition(AgentState.REPAIRING); // still illegal
  });
}

section('TEST 10f: IDLE → PROCESSING_STT seamless handoff edge case');
{
  // Verify that an immediate stt_result from IDLE directly transitions to PROCESSING_STT
  const sm = new AgentStateMachine();
  sm.transition(AgentState.PROCESSING_STT);
  assert('IDLE → PROCESSING_STT (seamless handoff edge case)', sm.currentState === AgentState.PROCESSING_STT);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  STATE MACHINE VERIFICATION REPORT');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Tests Passed: ${passed}`);
console.log(`  Tests Failed: ${failed}`);
console.log(`  Score: ${Math.round((passed / (passed + failed)) * 100)}%`);
if (failed === 0) {
  console.log('\n  ✅ ALL STATE MACHINE TESTS PASSED — TRANSITIONS ARE VERIFIED');
} else {
  console.log('\n  ❌ STATE MACHINE HAS FAILURES — REVIEW ABOVE');
}
console.log('═══════════════════════════════════════════════════════════════');

process.exit(failed === 0 ? 0 : 1);
