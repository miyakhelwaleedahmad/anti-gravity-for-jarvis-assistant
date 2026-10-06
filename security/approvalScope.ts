/**
 * security/approvalScope.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The tool call the user has just approved, for the duration of that call.
 *
 * The registry asks for approval once, before running a call; the controller
 * that the call reaches (process kill, service control, shell) used to ask
 * again. Inside the scope, `approvalGate.requestApproval` answers yes for the
 * approved call instead of prompting a second time.
 *
 * AsyncLocalStorage, not a module variable: task-graph nodes run in parallel,
 * and an approval for one node must never leak to another.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface ApprovedCall {
  tool: string;
  args: Record<string, unknown>;
  /** Risk level the user approved. */
  level: number;
  /**
   * Session level the approval stands in for during this call (policy `ask`:
   * approving one level-2 action replaces full control mode for that action).
   * 0 when the session already had the level it needed.
   */
  grantsLevel: number;
  approvedAt: number;
  /** The approval request the user answered. */
  requestId?: string;
}

const store = new AsyncLocalStorage<ApprovedCall>();

export function runApproved<T>(call: ApprovedCall, fn: () => Promise<T>): Promise<T> {
  return store.run(call, fn);
}

/** The approved call this code is running inside, if any. */
export function currentApproval(): ApprovedCall | undefined {
  return store.getStore();
}
