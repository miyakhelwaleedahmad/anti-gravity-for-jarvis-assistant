/**
 * monitoring/healthLedger.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The one place that says whether a pipeline WORKS, from observed effects
 * (self-healing architecture, Phase 1).
 *
 * Before, health came from eight components, and several of them counted a
 * connection or a sent message as success: speech output was "healthy" when
 * text was sent (VOICE-005), speech recognition and the wake word were
 * "healthy" when their process connected. This ledger only takes outcomes of
 * the work itself:
 *
 *   speech output     a reply tts.py reports as played / not played
 *   speech recognition a transcript produced (or a reported STT failure)
 *   wake word         a detection (or a reported wake-word failure)
 *   language model    a chat request answered / failed
 *   tools             a tool call that ran / crashed or timed out
 *                     (a refusal, a denied approval or bad arguments is the
 *                     safety system working, not a tool fault)
 *
 * Status per pipeline, from its own outcomes and what it depends on:
 *   unknown   no outcome yet: never shown as healthy
 *   healthy   the last outcome worked, recently
 *   stale     the last outcome worked, but long ago
 *   degraded  the last outcome failed
 *   failing   the last two or more failed, or a dependency is down
 *
 * Kept in memory (the last outcomes per pipeline, for this run): a restarted
 * JARVIS starts with no evidence, which is "unknown", not "healthy". Failures
 * also go to the issue store (core/issueStore.ts), which persists them.
 */

import { EventEmitter } from 'events';

export const LEDGER_PIPELINES = {
  tts: 'brain_to_tts',
  stt: 'stt_to_brain',
  wake: 'wake_to_stt',
  llm: 'brain_to_llm',
  tools: 'tool_execution',
} as const;

export type LedgerPipeline = typeof LEDGER_PIPELINES[keyof typeof LEDGER_PIPELINES];
export type LedgerState = 'unknown' | 'healthy' | 'stale' | 'degraded' | 'failing';

export interface LedgerOutcome {
  pipeline: LedgerPipeline;
  ok: boolean;
  /** What happened, short and redacted by the caller: "played", "synthesis_failed: …". */
  cause: string;
  /** The request's correlation id, when the outcome belongs to one. */
  correlationId?: string;
  at: number;
}

export interface LedgerStatus {
  pipeline: LedgerPipeline;
  state: LedgerState;
  /** One sentence a person can read. */
  detail: string;
  last?: LedgerOutcome;
  /** Failures in a row, newest first. */
  failuresInRow: number;
  /** What this pipeline needs that is down, if anything. */
  blockedBy?: string;
}

/** Which transport each pipeline needs (the bridge role that must be connected). */
const NEEDS_ROLE: Partial<Record<LedgerPipeline, string>> = {
  brain_to_tts: 'tts',
  stt_to_brain: 'stt',
  wake_to_stt: 'wakeword',
};

/** Pipelines that need another pipeline to work. */
const NEEDS_PIPELINE: Partial<Record<LedgerPipeline, LedgerPipeline>> = {
  stt_to_brain: 'wake_to_stt',
};

const KEEP_PER_PIPELINE = 50;
/** A success older than this is "stale": it says the pipeline worked, not that it works. */
export const LEDGER_STALE_MS = 15 * 60_000;

const LABELS: Record<LedgerPipeline, string> = {
  brain_to_tts: 'speech output',
  stt_to_brain: 'speech recognition',
  wake_to_stt: 'wake word',
  brain_to_llm: 'language model',
  tool_execution: 'tools',
};

export function ledgerLabel(p: LedgerPipeline): string {
  return LABELS[p];
}

/** Whether a failed tool call is a fault of JARVIS's tools, not a refusal or the user's input. */
export function isToolFault(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  const notAFault = /permission|denied|not approved|did not approve|cancel|refused|blocked|rate.?limit|not found|no such|does not exist|invalid|validation|required|unknown tool|not allowed|policy|needs full control|interrupted|superseded|aborted/;
  return !notAFault.test(e);
}

export class HealthLedger extends EventEmitter {
  private outcomes = new Map<LedgerPipeline, LedgerOutcome[]>();

  /** Record one observed outcome. Returns it, as stored. */
  record(pipeline: LedgerPipeline, ok: boolean, cause: string, correlationId?: string, at = Date.now()): LedgerOutcome {
    const outcome: LedgerOutcome = { pipeline, ok, cause: String(cause).slice(0, 240), at, ...(correlationId ? { correlationId } : {}) };
    const list = this.outcomes.get(pipeline) ?? [];
    list.push(outcome);
    if (list.length > KEEP_PER_PIPELINE) list.splice(0, list.length - KEEP_PER_PIPELINE);
    this.outcomes.set(pipeline, list);
    this.emit('outcome', outcome);
    return outcome;
  }

  /** The outcomes kept for a pipeline, oldest first. */
  history(pipeline: LedgerPipeline): LedgerOutcome[] {
    return [...(this.outcomes.get(pipeline) ?? [])];
  }

  /**
   * Status of a pipeline. `connectedRoles`: the bridge roles connected now
   * (nodeBridge.getReadyClients()); without it, transport is not checked.
   */
  status(pipeline: LedgerPipeline, connectedRoles?: string[], now = Date.now()): LedgerStatus {
    const label = LABELS[pipeline];
    const list = this.outcomes.get(pipeline) ?? [];
    const last = list[list.length - 1];
    let failuresInRow = 0;
    for (let i = list.length - 1; i >= 0 && !list[i]!.ok; i--) failuresInRow++;

    const role = NEEDS_ROLE[pipeline];
    if (role && connectedRoles && !connectedRoles.includes(role)) {
      return { pipeline, state: 'failing', detail: `${label}: its service (${role}) is not connected`, ...(last ? { last } : {}), failuresInRow, blockedBy: `${role} not connected` };
    }
    const upstream = NEEDS_PIPELINE[pipeline];
    if (upstream) {
      const up = this.status(upstream, connectedRoles, now);
      if (up.state === 'failing') {
        return { pipeline, state: 'failing', detail: `${label}: depends on the ${LABELS[upstream]}, which is failing (${up.detail})`, ...(last ? { last } : {}), failuresInRow, blockedBy: up.detail };
      }
    }
    if (!last) return { pipeline, state: 'unknown', detail: `${label}: not verified yet (no outcome observed this run)`, failuresInRow: 0 };
    const ago = Math.round((now - last.at) / 1000);
    if (last.ok) {
      if (now - last.at > LEDGER_STALE_MS) return { pipeline, state: 'stale', detail: `${label}: last worked ${Math.round(ago / 60)} min ago (${last.cause})`, last, failuresInRow };
      return { pipeline, state: 'healthy', detail: `${label}: working (${last.cause}, ${ago} s ago)`, last, failuresInRow };
    }
    return {
      pipeline,
      state: failuresInRow >= 2 ? 'failing' : 'degraded',
      detail: `${label}: ${failuresInRow >= 2 ? `failed ${failuresInRow} times in a row` : 'last attempt failed'} (${last.cause})`,
      last,
      failuresInRow,
    };
  }

  /** Status of every pipeline. */
  all(connectedRoles?: string[], now = Date.now()): LedgerStatus[] {
    return Object.values(LEDGER_PIPELINES).map((p) => this.status(p, connectedRoles, now));
  }

  /** For tests: forget everything. */
  clear(): void {
    this.outcomes.clear();
  }
}

export const healthLedger = new HealthLedger();
