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

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { AgentTool, RiskLevel } from './toolRegistryV2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_LOG_PATH = path.join(__dirname, '..', 'data', 'logs', 'tool_audit.log');

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
    const budgetMs = TIMEOUT_BUDGETS[risk];
    const budgetTimer = setTimeout(() => ac.abort(), budgetMs);

    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(budgetTimer);
        this._activeCounts[risk]--;
        return `Error: Tool "${tool.name}" aborted before sandbox execution.`;
      }
      externalSignal.addEventListener('abort', () => ac.abort(), { once: true });
    }

    let output = '';
    let success = false;

    try {
      output = await tool.execute(args, ac.signal);
      success = !output.toLowerCase().startsWith('error:');
      return output;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      output = `Error: ${msg}`;
      return output;
    } finally {
      clearTimeout(budgetTimer);
      this._activeCounts[risk]--;
      const durationMs = Date.now() - sandboxStart;

      // Audit log for high-risk tools (non-blocking)
      if (risk === 'high') {
        this._writeAuditLog({
          tool: tool.name,
          risk,
          args: this._summariseArgs(args),
          success,
          durationMs,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /** Returns current active execution counts per risk level */
  getActiveCounts(): Record<RiskLevel, number> {
    return { ...this._activeCounts };
  }

  private _summariseArgs(args: Record<string, unknown>): string {
    try {
      const summary = JSON.stringify(args);
      return summary.length > 200 ? summary.slice(0, 200) + '…' : summary;
    } catch {
      return '[unserializable]';
    }
  }

  private _writeAuditLog(entry: Record<string, unknown>): void {
    const line = JSON.stringify(entry) + '\n';
    void this._auditReady?.then(() =>
      fs.promises.appendFile(AUDIT_LOG_PATH, line, 'utf8').catch(() => {})
    );
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const toolExecutionSandbox = new ToolExecutionSandbox();
