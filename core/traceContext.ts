/**
 * core/traceContext.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Holds the correlation id for the request currently being processed.
 *
 * Everything needed for a joinable execution trace already existed — the
 * structured logger takes a correlationId, and taskGraphEngine emits
 * graph/node events — but nothing tied them together, so a request's plan,
 * tool calls and result could not be reconstructed from the logs (JARVIS-015).
 *
 * A module-level value is sufficient and honest here: the orchestrator
 * explicitly serialises requests (a new `process()` aborts the previous loop),
 * so there is at most one active request. It is deliberately not an
 * AsyncLocalStorage — that would imply a concurrency this agent does not have.
 */

let currentTraceId: string | null = null;

/** Start a new trace and return its id. */
export function beginTrace(): string {
  currentTraceId = `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return currentTraceId;
}

/** The active trace id, or undefined outside a request. */
export function getTraceId(): string | undefined {
  return currentTraceId ?? undefined;
}

/** Clear the trace once a request settles. */
export function endTrace(): void {
  currentTraceId = null;
}
