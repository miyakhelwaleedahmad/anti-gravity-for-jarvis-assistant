/**
 * core/outcomeUnknown.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * An action whose outcome is unknown (B4): JARVIS stopped waiting for a tool
 * that may still finish, or stopped a command part way. It is neither a
 * success nor a definite failure, and it is never repeated automatically.
 *
 * The marker keeps the word TIMEOUT, so the rules that already refuse to
 * repeat a timeout (control/actionQueue.ts) still apply.
 */

import { randomUUID } from 'crypto';
import { getAgentPath, getRequestText, getTraceId } from './traceContext.js';

export const OUTCOME_UNKNOWN_MARK = 'TIMEOUT (outcome unknown)';

/** Whether `text` reports an action whose outcome is unknown. */
export function isOutcomeUnknown(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(OUTCOME_UNKNOWN_MARK);
}

/** Elapsed wall-clock time in whole seconds: "1 second", "20 seconds". */
export function secondsText(ms: number): string {
  const n = Math.max(0, Math.round(ms / 1000));
  return `${n} second${n === 1 ? '' : 's'}`;
}

/** Who a call belongs to, taken when it starts and never changed afterwards. */
export interface CallOrigin {
  readonly callId: string;
  /** The foreground request's trace id; left out inside a background agent. */
  readonly traceId?: string;
  /** The background agent making the call. */
  readonly agentPath?: string;
  /** The owner's words (cut short), or `fallback` outside a request. */
  readonly userCommand: string;
}

/**
 * The calling request, captured now. The trace id is one module-level value
 * that the next request replaces (core/traceContext.ts), so a result that
 * arrives later must use what was captured here.
 */
export function captureCallOrigin(fallback: string): CallOrigin {
  const agentPath = getAgentPath();
  const traceId = agentPath ? undefined : getTraceId();
  const request = getRequestText()?.trim();
  return Object.freeze({
    callId: `call_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    ...(traceId ? { traceId } : {}),
    ...(agentPath ? { agentPath } : {}),
    userCommand: request ? (request.length > 160 ? `${request.slice(0, 157)}...` : request) : fallback,
  });
}
