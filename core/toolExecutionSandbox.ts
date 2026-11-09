/**
 * core/toolExecutionSandbox.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5 — Tool Sandboxing & Resource Guard
 *
 * Provides a thin execution sandbox around high-risk tool calls:
 *
 *  1. Concurrency cap per risk level
 *     - low:    unlimited (cache-backed anyway)
 *     - medium: max 4 concurrent executions
 *     - high:   max 2 concurrent executions (dangerous side effects)
 *
 *  2. Per-invocation CPU-time budget via chained AbortSignal
 *     Each risk tier gets a timeout budget separate from the registry's
 *     global 25s cap. This prevents a single runaway high-risk tool from
 *     consuming the entire system budget.
 *
 *  3. High-risk audit log
 *     Every high-risk invocation is written to an append-only audit log at
 *     data/logs/tool_audit.log — tool name, args summary, result, duration.
 *     This is non-blocking (fire-and-forget write).
 *
 *  4. Execution metadata header injection
 *     Injects a sandbox context object into tool args under the reserved key
 *     `__sandbox` (stripped before validation in registry). Tools can read it
 *     for feature flags or abort awareness without coupling to global state.
 *
 * Usage (called by ToolRegistryV2.executeWithTimeout or orchestrator):
 *
 *   const sandbox = new ToolExecutionSandbox();
 *   const output = await sandbox.run(tool, args, externalSignal);
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { dataRoot } from './workspaceRoot.js';
import { fileURLToPath } from 'url';
import { redact, redactDeep } from '../security/redactor.js';
import type { AgentTool, RiskLevel } from './toolRegistryV2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_LOG_PATH = path.join(dataRoot(path.resolve(__dirname, '..')), 'data', 'logs', 'tool_audit.log');

// ─── Concurrency limits per risk level ────────────────────────────────────────

const CONCURRENCY_LIMITS: Record<RiskLevel, number> = {
  low:    Infinity,
  medium: 4,
  high:   2,
};

// ─── Per-risk CPU time budgets (ms) ───────────────────────────────────────────
// These are ADDITIONAL timeouts per sandbox call, independent of the registry's
// global EXECUTION_TIMEOUT_MS. The shorter of the two takes effect.

const TIMEOUT_BUDGETS: Record<RiskLevel, number> = {
  low:    30_000,  // 30s (cache-backed tools are fast, but allow slow searches)
  medium: 20_000,  // 20s
  high:   15_000,  // 15s — high-risk tools should be atomic and fast
};

/** The budget for `risk`; JARVIS_TOOL_BUDGET_<LOW|MEDIUM|HIGH>_MS overrides it. */
function budgetMs(risk: RiskLevel): number {
  const v = Number(process.env[`JARVIS_TOOL_BUDGET_${risk.toUpperCase()}_MS`]);
  return Number.isFinite(v) && v > 0 ? v : TIMEOUT_BUDGETS[risk];
}

/** How long a stopped tool gets to finish before the call ends without it. */
function stopGraceMs(): number {
  const v = Number(process.env['JARVIS_TOOL_STOP_GRACE_MS']);
  return Number.isFinite(v) && v >= 0 ? v : 5_000;
}

// ─── The running call, for a question asked inside it (B4 R3-1) ───────────────

/**
 * The tool call the current code runs inside. A question the tool asks the
 * owner (security/approvalGate.ts) is not part of its time budget: the budget
 * is paused while the owner answers and resumes with exactly the time that was
 * left. AsyncLocalStorage, as security/approvalScope.ts: it follows the call
 * through the skill, the kernel, the action queue and the controller.
 */
export interface ToolCallBudget {
  /** The call's signal: aborted by its budget or by its caller. */
  readonly signal: AbortSignal;
  /** True once the tool's run has finished; work it left behind is no longer part of the call. */
  readonly ended: boolean;
  /** Stops the budget clock (counted: the clock restarts after the last open question). */
  pause(): void;
  /** Restarts it with the time that was left; nothing after the call ended or was stopped. */
  resume(): void;
}

const callScope = new AsyncLocalStorage<ToolCallBudget>();

/**
 * The sandboxed tool call this code runs inside, if any. Background work a
 * tool started keeps its AsyncLocalStorage context after the call ends; it is
 * then no longer part of that call (review F3).
 */
export function currentToolCall(): ToolCallBudget | undefined {
  const call = callScope.getStore();
  return call && !call.ended ? call : undefined;
}

/** Runs `fn` with the current call's budget paused (waiting for the owner is not execution time). */
export async function whileOwnerAnswers<T>(fn: () => Promise<T>): Promise<T> {
  const call = currentToolCall();
  if (!call) return fn();
  call.pause();
  try {
    return await fn();
  } finally {
    call.resume();
  }
}

/**
 * The budget clock of one call: `budget` ms of running time, not counting
 * paused time. Time used before a pause is deducted; a resume gets exactly
 * what was left, never the full budget again. Measured with the monotonic
 * clock: a change of the system time does not move it (review F5).
 */
function budgetClock(budget: number, onTimeUp: () => void, signal: AbortSignal) {
  let deadline = performance.now() + budget;
  let remaining = budget;
  let pauses = 0;
  let ended = false;
  let timeUp = false;
  const fire = () => { timer = undefined; timeUp = true; onTimeUp(); };
  let timer: NodeJS.Timeout | undefined = setTimeout(fire, budget);
  return {
    pause(): void {
      if (ended || timeUp) return;
      if (pauses++ === 0) {
        remaining = Math.min(budget, Math.max(0, deadline - performance.now()));
        if (timer) { clearTimeout(timer); timer = undefined; }
        // Nothing left (the timer had not fired yet, e.g. a blocked event
        // loop): the budget ends now, so the owner is not asked (review F8).
        if (remaining === 0) fire();
      }
    },
    resume(): void {
      if (ended || timeUp || pauses === 0) return;
      if (--pauses > 0) return;
      // A call stopped (cancelled) while paused gets no new budget.
      if (signal.aborted) return;
      deadline = performance.now() + remaining;
      timer = setTimeout(fire, remaining);
    },
    end(): void {
      ended = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
    },
  };
}

// ─── Sandbox ──────────────────────────────────────────────────────────────────

export class ToolExecutionSandbox {
  private _activeCounts: Record<RiskLevel, number> = { low: 0, medium: 0, high: 0 };
  private _auditReady: Promise<void> | null = null;

  constructor() {
    // Lazily ensure audit log directory exists
    this._auditReady = fs.promises
      .mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true })
      .then(() => undefined)
      .catch(() => undefined);
  }

  /**
   * Run a tool inside the sandbox.
   * Enforces concurrency cap, injects timeout budget, writes audit log for high-risk.
   */
  async run(
    tool: AgentTool,
    args: Record<string, unknown>,
    externalSignal?: AbortSignal,
  ): Promise<string> {
    const risk = tool.riskLevel;
    const limit = CONCURRENCY_LIMITS[risk];

    // ── Concurrency cap check ─────────────────────────────────────────────────
    if (this._activeCounts[risk] >= limit) {
      return `Error: Sandbox concurrency limit reached for "${risk}" tools (max ${limit}). Try again shortly.`;
    }

    this._activeCounts[risk]++;
    const sandboxStart = Date.now();

    // ── Compose abort signal (external OR timeout budget) ─────────────────────
    const ac = new AbortController();
    const budget = budgetMs(risk);
    let overBudget = false;
    // Paused while the owner answers a question the tool asks (B4 R3-1).
    const clock = budgetClock(budget, () => { overBudget = true; ac.abort(); }, ac.signal);

    if (externalSignal) {
      if (externalSignal.aborted) {
        clock.end();
        this._activeCounts[risk]--;
        return `Error: Tool "${tool.name}" aborted before sandbox execution.`;
      }
      externalSignal.addEventListener('abort', () => ac.abort(), { once: true });
    }

    // The slot is held until the tool has really finished, also when the
    // caller stopped waiting for it below.
    let ended = false;
    const call: ToolCallBudget = {
      signal: ac.signal,
      get ended() { return ended; },
      pause: () => clock.pause(),
      resume: () => clock.resume(),
    };
    const execution = Promise.resolve()
      .then(() => callScope.run(call, () => tool.execute(args, ac.signal)))
      .then((output) => ({ output }), (err: unknown) => ({ output: `Error: ${err instanceof Error ? err.message : String(err)}` }));
    void execution.then(({ output }) => {
      ended = true;
      clock.end();
      this._activeCounts[risk]--;
      if (risk === 'high') {
        this._writeAuditLog({
          tool: tool.name,
          risk,
          args: this._summariseArgs(args),
          success: !output.toLowerCase().startsWith('error:'),
          durationMs: Date.now() - sandboxStart,
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Once the signal is aborted (budget or caller), the tool has a short time
    // to stop — the process tools stop their whole process tree. A tool that
    // ignores the signal no longer holds the registry's queue and every later
    // risky action behind it (REL-01): the call ends as a timeout.
    const gaveUp = new Promise<{ output: string; stuck: true }>((resolve) => {
      const onAbort = () => {
        const t = setTimeout(() => resolve({
          output: `Error: TIMEOUT: Tool "${tool.name}" ${overBudget ? `ran past its ${Math.round(budget / 1000)} s budget` : 'was cancelled'} and did not stop within ${Math.round(stopGraceMs() / 1000)} s; JARVIS stopped waiting for it.`,
          stuck: true,
        }), stopGraceMs());
        void execution.then(() => clearTimeout(t));
      };
      if (ac.signal.aborted) onAbort(); else ac.signal.addEventListener('abort', onAbort, { once: true });
    });

    const settled = await Promise.race([execution, gaveUp]);
    if ('stuck' in settled) {
      console.warn(`[ToolSandbox] ⚠️ "${tool.name}" did not stop after its signal; its slot stays taken until it ends.`);
      return settled.output;
    }
    if (overBudget && !settled.output.toLowerCase().startsWith('error:')) {
      // It finished, but only after its budget: the result is real, and late.
      console.warn(`[ToolSandbox] "${tool.name}" finished after its ${budget} ms budget.`);
    }
    return settled.output;
  }

  /** Returns current active execution counts per risk level */
  getActiveCounts(): Record<RiskLevel, number> {
    return { ...this._activeCounts };
  }

  private _summariseArgs(args: Record<string, unknown>): string {
    try {
      // Redacted before it is cut: half a key no longer looks like one.
      const summary = redact(JSON.stringify(args));
      return summary.length > 200 ? summary.slice(0, 200) + '…' : summary;
    } catch {
      return '[unserializable]';
    }
  }

  /**
   * Audit lines are appended one after another. A failed write was dropped
   * without a word; on Windows a file briefly held by another program (EBUSY,
   * EPERM) lost the line of a high-risk call. It is tried once more, and a
   * line that still cannot be written is reported.
   */
  private _auditWrites: Promise<void> = Promise.resolve();

  private _writeAuditLog(entry: Record<string, unknown>): void {
    const line = JSON.stringify(redactDeep(entry)) + '\n';
    const append = () => fs.promises.appendFile(AUDIT_LOG_PATH, line, 'utf8');
    this._auditWrites = this._auditWrites
      .then(() => this._auditReady)
      .then(append)
      .catch(async (err: NodeJS.ErrnoException) => {
        if (err?.code !== 'EBUSY' && err?.code !== 'EPERM') throw err;
        await new Promise((r) => setTimeout(r, 100));
        await append();
      })
      .catch((err: Error) => {
        console.warn(`[ToolSandbox] Could not write the tool audit log (${AUDIT_LOG_PATH}): ${err?.message ?? err}`);
      });
  }

  /** Resolves when every audit line queued so far has been written (or reported). */
  flushAudit(): Promise<void> {
    return this._auditWrites;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const toolExecutionSandbox = new ToolExecutionSandbox();
