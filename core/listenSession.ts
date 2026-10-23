/**
 * core/listenSession.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Ending a listen session that produced no transcript (BUG-1): STT said
 * stt_no_speech (VAD gate rejected the audio, timeout, empty transcript,
 * error), or the LISTENING watchdog fired.
 *
 * Before this, nothing ended such a session: the state stayed LISTENING, STT
 * kept the mic and the wake word stayed paused, so JARVIS was deaf until
 * something unrelated resumed it (the owner's log: 15 minutes).
 */

import { agentStateMachine, AgentState, tryTransition } from './agentStateMachine.js';
import { healthLedger, LEDGER_PIPELINES } from '../monitoring/healthLedger.js';

export interface ListenSessionDeps {
  /** Who owns the microphone now ('STT', 'WAKE_WORD', 'NONE'). */
  micOwner(): string;
  releaseSttMic(reason: string): void;
  setListening(on: boolean): void;
  resumeWakeWord(): void;
  log(event: string, reason: string): void;
}

/**
 * Back to waiting for the wake word: mic freed, IDLE, wake word resumed.
 * `stuck`: STT never answered (the LISTENING watchdog fired). That is a fault
 * the health check must see (BUG-4: it read all green for the 15 minutes
 * JARVIS was deaf), so it is recorded as a failed STT outcome; the dashboard
 * then shows STT degraded. Silence from the owner (stt_no_speech) is not.
 */
export function endListening(reason: string, deps: ListenSessionDeps, stuck = false): void {
  if (stuck) healthLedger.record(LEDGER_PIPELINES.stt, false, 'listening timed out: STT sent no transcript and no "no speech"');
  deps.setListening(false);
  if (deps.micOwner() === 'STT') deps.releaseSttMic(reason);
  deps.log('STT_NO_SPEECH', reason);
  if (agentStateMachine.is(AgentState.LISTENING)) tryTransition(AgentState.IDLE, `no speech (${reason})`);
  deps.resumeWakeWord();
}
