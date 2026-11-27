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
 *
 * SEC-08: the scope used to answer yes to any request made inside it. Now
 *   - another tool call made from inside the approved one (a skill calling the
 *     registry) runs outside the scope: no grant, its own approval;
 *   - a controller's own question is answered only when it names what the
 *     user approved (the command, process, file, window…), once per call.
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
  /** The action and target the user was shown (risk engine). */
  action?: string;
  target?: string;
  /** Controller questions answered from this approval so far (SEC-08). */
  nestedAnswered?: number;
}

const store = new AsyncLocalStorage<ApprovedCall>();

export function runApproved<T>(call: ApprovedCall, fn: () => Promise<T>): Promise<T> {
  return store.run(call, fn);
}

/** The approved call this code is running inside, if any. */
export function currentApproval(): ApprovedCall | undefined {
  return store.getStore();
}

/** Runs `fn` with no approved call in scope (a nested call earns its own). */
export function withoutApproval<T>(fn: () => Promise<T>): Promise<T> {
  return store.exit(fn);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Whether `tool(args)` is the approved call itself (a retry of it). */
export function isSameCall(call: ApprovedCall, tool: string, args: Record<string, unknown>): boolean {
  return call.tool === tool && stable(call.args) === stable(args);
}

const norm = (s: string) => s.trim().replace(/^["']|["']$/g, '').replace(/[\\/]+/g, '/').replace(/\s+/g, ' ').toLowerCase();

/** Every value the user saw approved: the target and the arguments. */
function approvedValues(call: ApprovedCall): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
    else if (Array.isArray(v)) { out.push(v.map(String).join('+')); v.forEach(walk); }
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  if (call.target) out.push(call.target);
  // Not the action name ("kill", "delete"): it says what to do, not to what.
  for (const [key, value] of Object.entries(call.args)) if (key !== 'action') walk(value);
  return [...new Set(out.map(norm))].filter((v) => v.length >= 2);
}

/** A controller's question: "Label: subject". */
function subjectOf(target: string): string {
  const m = /^[A-Za-z][A-Za-z ]{0,40}:\s+([\s\S]+)$/.exec(target.trim());
  return norm(m ? m[1]! : target);
}

/**
 * Whether a question asked inside the approved call is the one the user
 * already answered.
 *   - The registry's own request (it names a tool): only the same tool,
 *     action and target.
 *   - A controller's question: its subject must name something approved (a
 *     controller finds its process, window or tab by a part of the name, so
 *     the approved value may be part of it), and only one per approved call.
 */
export function coversNested(call: ApprovedCall, request: { tool?: string; action?: string; target: string }): boolean {
  if (request.tool) {
    return request.tool === call.tool
      && (request.action ?? '') === (call.action ?? '')
      && norm(request.target) === norm(call.target ?? '');
  }
  if ((call.nestedAnswered ?? 0) >= 1) return false;
  const subject = subjectOf(request.target);
  if (!subject) return false;
  // A long subject is shortened to fit the request ("…"): its start must match.
  const cut = subject.endsWith('…') ? subject.slice(0, -1) : '';
  return approvedValues(call).some((v) => subject === v || subject.includes(v) || (cut.length >= 20 && v.startsWith(cut)));
}
