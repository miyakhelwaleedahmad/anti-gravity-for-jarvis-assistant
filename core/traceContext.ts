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
 *
 * Background agents (core/agents) are the exception: they run beside the
 * foreground request, so their root task's words and source come from their
 * own AsyncLocalStorage scope (core/agents/agentScope.ts), checked first.
 */

import { currentAgentScope } from './agents/agentScope.js';

let currentTraceId: string | null = null;
let currentSource: 'voice' | 'cli' | undefined;
let currentRequest: string | undefined;

/**
 * Start a new trace and return its id. `source`: how the request arrived;
 * `request`: the user's words (an approval request shows them as WHY).
 */
export function beginTrace(source?: 'voice' | 'cli', request?: string): string {
  currentTraceId = `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  currentSource = source;
  currentRequest = request;
  return currentTraceId;
}

/**
 * Whether the active request was spoken or typed (approvals are asked the same
 * way). Inside a background agent: how its root task was asked
 * (core/agents/agentScope.ts), since the foreground request may have changed.
 */
export function getRequestSource(): 'voice' | 'cli' | undefined {
  return currentAgentScope()?.source ?? currentSource;
}

/** The user's words for the active request; inside an agent, its root task's words. */
export function getRequestText(): string | undefined {
  const agent = currentAgentScope();
  return agent ? agent.request : currentRequest;
}

/** The agent making the current call, as a path from JARVIS; undefined outside agents. */
export function getAgentPath(): string | undefined {
  return currentAgentScope()?.agentPath;
}

/** The active trace id, or undefined outside a request. */
export function getTraceId(): string | undefined {
  return currentTraceId ?? undefined;
}

let currentRepair: string | undefined;

/**
 * Runs `fn` as a repair of a failed step (core/recoveryPlanner.ts): an
 * approval request asked meanwhile shows `reason` — the failure being
 * repaired — as its WHY.
 */
export async function asRepair<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  const previous = currentRepair;
  currentRepair = reason;
  try {
    return await fn();
  } finally {
    currentRepair = previous;
  }
}

/** The failure being repaired, while a repair runs. */
export function getRepairReason(): string | undefined {
  return currentRepair;
}

/** Clear the trace once a request settles. */
export function endTrace(): void {
  currentTraceId = null;
  currentSource = undefined;
  currentRequest = undefined;
  currentRepair = undefined;
}
