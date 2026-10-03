/**
 * core/agentStateMachine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Unified state machine for the full JARVIS agent lifecycle.
 *
 * Covers BOTH the voice pipeline (LISTENING, SPEAKING) AND the autonomous
 * agent reasoning loop (PLANNING → EXECUTING → OBSERVING → REFLECTING → REPAIRING).
 *
 * Replaces: core/systemController.ts (voice-only states)
 * Backward-compat shim: systemController still works as a proxy to this class.
 *
 * Phase 1 — Core Runtime Stability hardening:
 *   - Atomic transitions via a synchronous lock flag (_transitioning).
 *   - Queued transitions: concurrent callers are enqueued, not dropped.
 *   - Watchdog resets use the same validated path (no direct _state mutation).
 *   - interrupt() validates the from-state and uses the transition queue.
 *   - safeTransitionToSpeaking() is idempotent and re-entrance-safe.
 *
 * Watchdog timers:
 *   SPEAKING  → auto-resets to IDLE after SPEAKING_WATCHDOG_MS (default 12s)
 *               Protects against tts.py crashing without sending speaking_end.
 *   PLANNING  → auto-resets to IDLE after PLANNING_WATCHDOG_MS (default 15s)
 *               Protects against LLM hanging indefinitely.
 */

import { EventEmitter } from 'events';

// PHASE2-LATENCY-1: Watchdog timeouts reduced to match actual TTS/LLM timeouts.
const SPEAKING_WATCHDOG_MS = parseInt(
  process.env.JARVIS_SPEAKING_WATCHDOG_MS ?? '12000',
  10
);
/** Upper bound for a SPEAKING watchdog stretched to fit queued speech. */
const MAX_SPEAKING_WATCHDOG_MS = 120_000;

/**
 * Rough playback time for a TTS utterance: ~0.4 s per word (neural voices
 * speak 2.5–3 words a second) plus 1 s for synthesis.
 */
export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return 1_000 + words * 400;
}

const PLANNING_WATCHDOG_MS = parseInt(
  process.env.JARVIS_PLANNING_WATCHDOG_MS ?? '15000',
  10
);

// ─── State Enum ───────────────────────────────────────────────────────────────

export enum AgentState {
  // Voice pipeline states (pre-existing, preserved)
  IDLE              = 'IDLE',
  LISTENING         = 'LISTENING',
  PROCESSING_STT    = 'PROCESSING_STT',
  SPEAKING          = 'SPEAKING',
  INTERRUPTED       = 'INTERRUPTED',

  // Agent reasoning loop states
  PLANNING          = 'PLANNING',      // LLM is building task graph
  EXECUTING         = 'EXECUTING',     // DAG nodes are being dispatched
  OBSERVING         = 'OBSERVING',     // Collecting results from executed nodes
  REFLECTING        = 'REFLECTING',    // Analyzing outcomes, classifying errors
  REPAIRING         = 'REPAIRING',     // Retrying failed tasks or re-planning
}

// ─── Transition Rules ─────────────────────────────────────────────────────────

const VALID_TRANSITIONS: Readonly<Record<AgentState, AgentState[]>> = {
  [AgentState.IDLE]:           [AgentState.LISTENING, AgentState.PLANNING, AgentState.SPEAKING, AgentState.PROCESSING_STT],
  [AgentState.LISTENING]:      [AgentState.PROCESSING_STT, AgentState.INTERRUPTED, AgentState.IDLE],
  [AgentState.PROCESSING_STT]: [AgentState.PLANNING, AgentState.INTERRUPTED, AgentState.IDLE],
  [AgentState.PLANNING]:       [AgentState.EXECUTING, AgentState.INTERRUPTED, AgentState.IDLE, AgentState.SPEAKING],
  [AgentState.EXECUTING]:      [AgentState.OBSERVING, AgentState.INTERRUPTED],
  [AgentState.OBSERVING]:      [AgentState.REFLECTING, AgentState.INTERRUPTED],
  [AgentState.REFLECTING]:     [AgentState.REPAIRING, AgentState.SPEAKING, AgentState.IDLE],
  [AgentState.REPAIRING]:      [AgentState.EXECUTING, AgentState.PLANNING, AgentState.IDLE],
  [AgentState.SPEAKING]:       [AgentState.IDLE, AgentState.INTERRUPTED],
  [AgentState.INTERRUPTED]:    [AgentState.IDLE, AgentState.SPEAKING, AgentState.LISTENING, AgentState.PROCESSING_STT],
};

// States from which an emergency interrupt is always legal, regardless of
// the normal transition table (covers states that don't list INTERRUPTED).
const INTERRUPTIBLE_STATES: ReadonlySet<AgentState> = new Set([
  AgentState.LISTENING,
  AgentState.PROCESSING_STT,
  AgentState.PLANNING,
  AgentState.EXECUTING,
  AgentState.OBSERVING,
  AgentState.REFLECTING,
  AgentState.REPAIRING,
  AgentState.SPEAKING,
]);

// ─── Agent State Machine ──────────────────────────────────────────────────────

export class AgentStateMachine extends EventEmitter {
  private _state: AgentState = AgentState.IDLE;
  private _stateHistory: Array<{ state: AgentState; timestamp: number }> = [];
  private readonly MAX_HISTORY = 50;

  // ── Concurrency guard ────────────────────────────────────────────────────────
  // Prevents re-entrant / concurrent calls from racing inside transition().
  // Because Node.js is single-threaded, a simple boolean flag is sufficient —
  // any second synchronous caller during event emission will see it set.
  private _transitioning = false;
  private _transitionQueue: Array<() => void> = [];

  // ── Watchdog timers ──────────────────────────────────────────────────────────
  private _speakingWatchdog: ReturnType<typeof setTimeout> | null = null;
  private _planningWatchdog: ReturnType<typeof setTimeout> | null = null;

  get currentState(): AgentState {
    return this._state;
  }

  get stateHistory(): Array<{ state: AgentState; timestamp: number }> {
    return [...this._stateHistory];
  }

  // ── Core transition ───────────────────────────────────────────────────────────

  /**
   * Attempt a state transition. Returns true on success, throws on illegal
   * transition. Re-entrant calls (triggered by event listeners during an
   * in-progress transition) are queued and executed after the current one
   * settles, preserving serialisation without deadlock.
   */
  transition(newState: AgentState): boolean {
    if (this._transitioning) {
      // Enqueue rather than drop — serialises re-entrant callers.
      this._transitionQueue.push(() => {
        try { this.transition(newState); } catch { /* caller already threw */ }
      });
      return true; // optimistic — will be executed after current settles
    }

    this._transitioning = true;
    try {
      return this._doTransition(newState);
    } finally {
      this._transitioning = false;
      this._drainQueue();
    }
  }

  private _doTransition(newState: AgentState): boolean {
    const allowed = VALID_TRANSITIONS[this._state];

    // Idempotent — same-state is a no-op.
    if (this._state === newState) return true;

    if (!allowed.includes(newState)) {
      const errMsg =
        `[AgentStateMachine] ⛔ ILLEGAL TRANSITION REJECTED: ` +
        `${this._state} -> ${newState}. Allowed: [${allowed.join(', ')}]`;
      console.error(errMsg);
      throw new Error(errMsg);
    }

    const prev = this._state;
    this._state = newState;

    this._recordHistory(newState);
    console.log(`[AgentStateMachine] ${prev} → ${newState}`);

    // ── Watchdog management ────────────────────────────────────────────────────
    if (prev === AgentState.SPEAKING)  this._clearSpeakingWatchdog();
    if (prev === AgentState.PLANNING)  this._clearPlanningWatchdog();
    if (newState === AgentState.SPEAKING) this._armSpeakingWatchdog();
    if (newState === AgentState.PLANNING) this._armPlanningWatchdog();

    // ── Event emission ─────────────────────────────────────────────────────────
    this.emit('transition', { from: prev, to: newState });
    this.emit('state_changed', newState);
    this.emit(newState.toLowerCase());
    if (newState === AgentState.INTERRUPTED) this.emit('interrupted');

    return true;
  }

  private _drainQueue(): void {
    while (this._transitionQueue.length > 0 && !this._transitioning) {
      const next = this._transitionQueue.shift()!;
      next();
    }
  }

  private _recordHistory(state: AgentState): void {
    this._stateHistory.push({ state, timestamp: Date.now() });
    if (this._stateHistory.length > this.MAX_HISTORY) {
      this._stateHistory.shift();
    }
  }

  // ── Watchdog helpers ──────────────────────────────────────────────────────────

  /** Estimated playback still queued at the TTS process (reset on speaking_end). */
  private _pendingSpeechMs = 0;

  /**
   * TTS reports speaking_start once and speaking_end only when its whole queue
   * is empty, so a fixed 12 s watchdog cut off any reply longer than that, or
   * several queued ones (seen on Windows: greeting + warning + error message).
   * The watchdog now allows for the speech actually queued; 12 s stays the
   * minimum, so a crashed TTS is still caught.
   */
  noteSpeechQueued(text: string): void {
    this._pendingSpeechMs = Math.min(this._pendingSpeechMs + estimateSpeechMs(text), MAX_SPEAKING_WATCHDOG_MS);
    if (this._state === AgentState.SPEAKING && this._speakingWatchdog !== null) {
      this._armSpeakingWatchdog(); // stretch the running deadline
    }
  }

  /** The TTS queue is empty (speaking_end) or was cleared by a stop command. */
  noteSpeechFinished(): void {
    this._pendingSpeechMs = 0;
  }

  /** Current SPEAKING watchdog allowance in ms. */
  speakingWatchdogMs(): number {
    if (this._pendingSpeechMs === 0) return SPEAKING_WATCHDOG_MS;
    return Math.min(Math.max(SPEAKING_WATCHDOG_MS, this._pendingSpeechMs + 3_000), MAX_SPEAKING_WATCHDOG_MS);
  }

  private _armSpeakingWatchdog(): void {
    this._clearSpeakingWatchdog(true);
    const ms = this.speakingWatchdogMs();
    this._speakingWatchdog = setTimeout(() => {
      if (this._state !== AgentState.SPEAKING) return; // already left
      console.warn(
        `[AgentStateMachine] ⏰ SPEAKING watchdog fired after ${ms}ms. ` +
        `TTS may have crashed without sending speaking_end. Resetting to IDLE.`
      );
      this._pendingSpeechMs = 0;
      // Use the validated internal path — never bypass transition table.
      this._watchdogReset(AgentState.SPEAKING, 'speaking_timeout');
    }, ms);
  }

  private _clearSpeakingWatchdog(rearming = false): void {
    if (this._speakingWatchdog !== null) {
      clearTimeout(this._speakingWatchdog);
      this._speakingWatchdog = null;
      if (!rearming) console.log('[AgentStateMachine] ✅ SPEAKING watchdog cleared (normal transition).');
    }
  }

  private _armPlanningWatchdog(): void {
    this._clearPlanningWatchdog();
    this._planningWatchdog = setTimeout(() => {
      if (this._state !== AgentState.PLANNING) return; // already left
      console.warn(
        `[AgentStateMachine] ⏰ PLANNING watchdog fired after ${PLANNING_WATCHDOG_MS}ms. ` +
        `LLM may be hanging. Resetting to IDLE.`
      );
      this._watchdogReset(AgentState.PLANNING, 'planning_timeout');
    }, PLANNING_WATCHDOG_MS);
  }

  private _clearPlanningWatchdog(): void {
    if (this._planningWatchdog !== null) {
      clearTimeout(this._planningWatchdog);
      this._planningWatchdog = null;
      console.log('[AgentStateMachine] ✅ PLANNING watchdog cleared (normal transition).');
    }
  }

  /**
   * Internal watchdog reset — validates the transition and goes through the
   * same validated path as transition(), preventing direct _state mutation.
   */
  private _watchdogReset(fromState: AgentState, reason: string): void {
    if (this._state !== fromState) return; // raced — state already changed

    try {
      // SPEAKING → IDLE and PLANNING → IDLE are both in VALID_TRANSITIONS.
      this.transition(AgentState.IDLE);
    } catch (err) {
      // Absolute last resort: force-reset if the transition is blocked.
      console.error(`[AgentStateMachine] Watchdog transition failed — forcing IDLE:`, err);
      this._state = AgentState.IDLE;
      this._recordHistory(AgentState.IDLE);
      this._clearSpeakingWatchdog();
      this._clearPlanningWatchdog();
      this.emit('transition', { from: fromState, to: AgentState.IDLE });
      this.emit('state_changed', AgentState.IDLE);
      this.emit('idle');
    }

    this.emit('watchdog_reset', { fromState, reason });
  }

  // ── Interrupt ─────────────────────────────────────────────────────────────────

  /**
   * Safely interrupt the state machine. Uses the transition queue so it is
   * safe to call from inside an event listener or concurrent context.
   * Only interrupts states that are actually interruptible.
   */
  interrupt(): void {
    if (this._state === AgentState.INTERRUPTED) return;

    if (!INTERRUPTIBLE_STATES.has(this._state)) {
      console.warn(
        `[AgentStateMachine] interrupt() called from non-interruptible state ${this._state} — ignoring.`
      );
      return;
    }

    const prev = this._state;
    // Clear watchdogs before transitioning.
    if (prev === AgentState.SPEAKING) this._clearSpeakingWatchdog();
    if (prev === AgentState.PLANNING) this._clearPlanningWatchdog();

    console.log(`[AgentStateMachine] 🛑 INTERRUPT TRIGGERED: ${prev} → INTERRUPTED`);

    // Route through transition() so concurrency guard and queue are respected.
    this.transition(AgentState.INTERRUPTED);
  }

  // ── Safe Speaking Transition ──────────────────────────────────────────────────

  /**
   * Idempotent, re-entrance-safe path to SPEAKING.
   * Chooses the shortest legal route from the current state.
   */
  safeTransitionToSpeaking(): void {
    const cur = this._state;
    if (cur === AgentState.SPEAKING) return;
    if (cur === AgentState.INTERRUPTED) return; // never speak while interrupted

    try {
      switch (cur) {
        case AgentState.EXECUTING:
          this.transition(AgentState.OBSERVING);
          this.transition(AgentState.REFLECTING);
          this.transition(AgentState.SPEAKING);
          break;
        case AgentState.OBSERVING:
          this.transition(AgentState.REFLECTING);
          this.transition(AgentState.SPEAKING);
          break;
        case AgentState.REFLECTING:
        case AgentState.PLANNING:
        case AgentState.IDLE:
          this.transition(AgentState.SPEAKING);
          break;
        case AgentState.REPAIRING:
          // REPAIRING → IDLE → SPEAKING (no direct path)
          this.transition(AgentState.IDLE);
          this.transition(AgentState.SPEAKING);
          break;
        default:
          // Unknown / unexpected state — reset and speak
          this.reset();
          this.transition(AgentState.SPEAKING);
          break;
      }
    } catch (err) {
      console.warn(`[AgentStateMachine] safeTransitionToSpeaking() failed from ${cur}:`, err);
    }
  }

  // ── Predicates ────────────────────────────────────────────────────────────────

  is(state: AgentState): boolean {
    return this._state === state;
  }

  isOneOf(...states: AgentState[]): boolean {
    return states.includes(this._state);
  }

  isInterrupted(): boolean {
    return this._state === AgentState.INTERRUPTED;
  }

  isIdle(): boolean {
    return this._state === AgentState.IDLE;
  }

  isReasoningLoop(): boolean {
    return this.isOneOf(
      AgentState.PLANNING,
      AgentState.EXECUTING,
      AgentState.OBSERVING,
      AgentState.REFLECTING,
      AgentState.REPAIRING
    );
  }

  /**
   * Gating logic: determines if a given action is permitted in the current state.
   * Backward-compatible with systemController.can().
   */
  can(action: string): boolean {
    switch (action) {
      case 'stt_listen':
        return this._state === AgentState.LISTENING;
      case 'grok_inference':
        return this.isOneOf(AgentState.PROCESSING_STT, AgentState.PLANNING, AgentState.REPAIRING);
      case 'tts_speak':
        return this.isOneOf(AgentState.SPEAKING, AgentState.REFLECTING, AgentState.IDLE);
      case 'tts_output':
        return this._state !== AgentState.INTERRUPTED;
      case 'tool_execute':
        return this._state === AgentState.EXECUTING;
      case 'plan':
        return this.isOneOf(AgentState.IDLE, AgentState.PROCESSING_STT, AgentState.REPAIRING);
      default:
        return true;
    }
  }

  /**
   * Reset to IDLE — call this after interrupt is cleared or on clean shutdown.
   * Always safe; clears all watchdogs first.
   */
  reset(): void {
    this._clearSpeakingWatchdog();
    this._clearPlanningWatchdog();
    // Clear pending queued transitions — they are stale after a hard reset.
    this._transitionQueue.length = 0;

    const prev = this._state;
    this._state = AgentState.IDLE;
    this._recordHistory(AgentState.IDLE);
    this.emit('transition', { from: prev, to: AgentState.IDLE });
    this.emit('state_changed', AgentState.IDLE);
    this.emit('idle');
  }

  getStats(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this._stateHistory) {
      counts[entry.state] = (counts[entry.state] ?? 0) + 1;
    }
    return counts;
  }
}

export const agentStateMachine = new AgentStateMachine();
