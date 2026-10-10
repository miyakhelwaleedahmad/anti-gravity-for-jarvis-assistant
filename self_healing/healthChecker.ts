/**
 * self_healing/healthChecker.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 8 — Proactive Health Checker
 *
 * Actively probes each JARVIS subsystem on a schedule rather than waiting
 * for failures to be reported. This enables pre-emptive recovery before
 * a pipeline completely collapses.
 *
 * Probed subsystems:
 *   - LLM API (the configured provider, Gemini or Groq) — lists models; costs
 *     no generation quota. A rate limit counts as reachable; other failures
 *     are classified by HTTP status (bridge/llmStatus.ts), not by message text
 *   - Redis             — PING command via ioredis
 *   - Vector Memory     — the supervisor's state; "loading" while the model
 *                         loads is reported as loading, not as a failure
 *   - Memory Manager    — verifies in-memory DB is initialized
 *   - Tool Registry     — verifies at least 1 tool is registered
 *   - NodeBridge        — the WebSocket server is listening (not only that the object exists)
 *
 * Each subsystem reports to its own pipeline. Vector Memory and Memory
 * Manager used to share one, so in a round where one failed and the other
 * passed, the result depended on which finished last.
 *
 * Each probe result is fed into:
 *   1. PipelineRegistry  — recordSuccess() / recordFailure()
 *   2. FailureAnalytics  — record() for trend tracking
 *   3. AlertManager      — raises warning/critical on probe failure
 *
 * Probes run every PROBE_INTERVAL_MS (default: 120s).
 * During active conversation the probe round is skipped.
 */

import { pipelineRegistry, LLM_PIPELINE, MEMORY_PIPELINE, VECTOR_PIPELINE } from './pipelineRegistry.js';
import { failureAnalytics } from './failureAnalytics.js';
import { alertManager } from './alertManager.js';
import { conversationBus } from '../core/conversationBus.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const PROBE_INTERVAL_MS   = 120_000;  // 2 minutes
const PROBE_TIMEOUT_MS    = 5_000;    // fail a probe if it takes > 5s
const SOURCE              = 'HealthChecker';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProbeResult {
  subsystem: string;
  pipeline: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  /** Starting up (e.g. a model loading): neither a success nor a failure. */
  loading?: boolean;
  /** Not started on purpose or not installed: nothing to record (not "healthy"). */
  inactive?: boolean;
  /** For the LLM probe: the kind of failure (auth, rate_limit, timeout, …). */
  kind?: string;
}

// ─── HealthChecker ────────────────────────────────────────────────────────────

export class HealthChecker {
  private static instance: HealthChecker;
  private interval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  private constructor() {}

  static getInstance(): HealthChecker {
    if (!HealthChecker.instance) {
      HealthChecker.instance = new HealthChecker();
    }
    return HealthChecker.instance;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this._runProbeRound(), PROBE_INTERVAL_MS);
    this.interval.unref?.();
    console.log(`[HealthChecker] 🩺 Proactive health checks started (every ${PROBE_INTERVAL_MS / 1000}s).`);

    // Run first probe after a short startup delay
    setTimeout(() => this._runProbeRound(), 10_000).unref?.();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Run a full probe round immediately (returns results array). */
  async runNow(): Promise<ProbeResult[]> {
    return this._runProbeRound(true);
  }

  // ── Probe Round ───────────────────────────────────────────────────────────

  private async _runProbeRound(force = false): Promise<ProbeResult[]> {
    if (!force && !conversationBus.isIdle) {
      console.log('[HealthChecker] Probe skipped — JARVIS is active.');
      return [];
    }

    if (this.isRunning) return [];
    this.isRunning = true;

    console.log('[HealthChecker] 🔬 Running subsystem probes...');
    const results: ProbeResult[] = [];

    const probes: Array<() => Promise<ProbeResult>> = [
      () => this._probeLLM(),
      () => this._probeRedis(),
      () => this._probeVectorMemory(),
      () => this._probeMemoryManager(),
      () => this._probeToolRegistry(),
      () => this._probeNodeBridge(),
    ];

    // Run all probes concurrently
    const settled = await Promise.allSettled(probes.map(p => p()));
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
        this._handleProbeResult(result.value);
      }
    }

    this.isRunning = false;

    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    console.log(`[HealthChecker] ✅ Probes complete: ${passed} OK, ${failed} failed.`);

    return results;
  }

  private _handleProbeResult(result: ProbeResult): void {
    if (result.inactive) {
      console.log(`[HealthChecker]   – ${result.subsystem}: ${result.error ?? 'not running'}`);
      return;
    }
    if (result.loading) {
      pipelineRegistry.recordLoading(result.pipeline);
      console.log(`[HealthChecker]   ◌ ${result.subsystem}: ${result.error ?? 'loading'}`);
      return;
    }
    if (result.ok) {
      pipelineRegistry.recordSuccess(result.pipeline);
      failureAnalytics.record(result.pipeline, 'recovery', `Probe OK in ${result.latencyMs}ms`);
      console.log(`[HealthChecker]   ✅ ${result.subsystem} (${result.latencyMs}ms)`);
    } else {
      const errMsg = result.error ?? 'probe failed';
      pipelineRegistry.recordFailure(result.pipeline, errMsg);
      failureAnalytics.record(result.pipeline, 'failure', errMsg);

      const severity = result.latencyMs > PROBE_TIMEOUT_MS ? 'critical' : 'warning';
      alertManager.raise(severity, result.pipeline, `${result.subsystem} probe failed: ${errMsg}`, SOURCE);
      console.warn(`[HealthChecker]   ❌ ${result.subsystem}: ${errMsg}`);
    }
  }

  // ── Individual Probes ──────────────────────────────────────────────────────

  /**
   * LLM reachability. Lists the provider's models instead of generating a
   * reply: a generation probe spent rate-limited quota every round, and with a
   * thinking model (Gemini) a 1-token reply always came back empty, so the probe
   * reported a healthy API as down.
   */
  private async _probeLLM(): Promise<ProbeResult> {
    const t0 = Date.now();
    const { llmConfig } = await import('../config/llmconfig.js');
    const subsystem = `LLM API (${llmConfig.provider})`;
    try {
      const { groqProvider } = await import('../bridge/groqProvider.js');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error('LLM_TIMEOUT')), PROBE_TIMEOUT_MS);
      try {
        await groqProvider.ping(ctrl.signal);
      } finally {
        clearTimeout(timer);
      }
      return { subsystem, pipeline: LLM_PIPELINE, ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      const { classifyLLMError } = await import('../bridge/llmStatus.js');
      const c = classifyLLMError(err);
      // A rate limit means the API answered: reachable, so not a health failure.
      // (This used to look for "(429)" in the text; the model-list error says
      // "returned 429", so a rate-limited provider was reported as down.)
      const ok = c.kind === 'rate_limit';
      return {
        subsystem,
        pipeline: LLM_PIPELINE,
        ok,
        kind: c.kind,
        latencyMs: Date.now() - t0,
        error: ok ? undefined : `${c.kind}: ${c.message.slice(0, 120)}`,
      };
    }
  }

  private async _probeRedis(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      // Dynamic import to avoid hard Redis dependency at startup
      const { isRedisAvailable, pingRedis } = await import('../memory/redisCache.js').then(
        m => ({ isRedisAvailable: (m as any).isRedisAvailable, pingRedis: (m as any).pingRedis })
      );
      if (typeof isRedisAvailable === 'function' && !isRedisAvailable()) {
        return { subsystem: 'Redis', pipeline: 'memory_to_context', ok: true, latencyMs: Date.now() - t0 };
      }
      if (typeof pingRedis === 'function') await pingRedis();
      return { subsystem: 'Redis', pipeline: 'memory_to_context', ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { subsystem: 'Redis', pipeline: 'memory_to_context', ok: false, latencyMs: Date.now() - t0, error: e.slice(0, 120) };
    }
  }

  private async _probeVectorMemory(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const { vectorMemorySupervisor } = await import('../memory/vectorMemorySupervisor.js');
      const state = vectorMemorySupervisor.state();
      const base = { subsystem: 'Vector Memory', pipeline: VECTOR_PIPELINE, latencyMs: Date.now() - t0 };
      if (state === 'ready') return { ...base, ok: true };
      if (state === 'loading') return { ...base, ok: false, loading: true, error: `embedding model loading (${vectorMemorySupervisor.loadingSeconds()} s)` };
      // Not started (e.g. Python dependencies missing): lexical search is used; not a fault to heal.
      if (state === 'stopped') return { ...base, ok: true, inactive: true, error: 'not running (lexical search fallback)' };
      return { ...base, ok: false, error: 'service down' };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { subsystem: 'Vector Memory', pipeline: VECTOR_PIPELINE, ok: false, latencyMs: Date.now() - t0, error: e.slice(0, 120) };
    }
  }

  private async _probeMemoryManager(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const { memoryManager } = await import('../memory/memoryManager.js');
      const stats = memoryManager.getStats?.();
      const ok    = stats !== undefined && stats !== null;
      return { subsystem: 'MemoryManager', pipeline: MEMORY_PIPELINE, ok, latencyMs: Date.now() - t0, error: ok ? undefined : 'getStats returned null' };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { subsystem: 'MemoryManager', pipeline: MEMORY_PIPELINE, ok: false, latencyMs: Date.now() - t0, error: e.slice(0, 120) };
    }
  }

  private async _probeToolRegistry(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
      const defs = toolRegistryV2.getLLMDefinitions();
      const ok   = defs.length > 0;
      return { subsystem: 'ToolRegistry', pipeline: 'tool_execution', ok, latencyMs: Date.now() - t0, error: ok ? undefined : 'no tools registered' };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { subsystem: 'ToolRegistry', pipeline: 'tool_execution', ok: false, latencyMs: Date.now() - t0, error: e.slice(0, 120) };
    }
  }

  private async _probeNodeBridge(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const { nodeBridge } = await import('../bridge/nodeBridge.js');
      // The server must be listening; an existing object alone said nothing.
      // Whether TTS/STT clients are connected is shown on the dashboard per service.
      const ok = !!nodeBridge && nodeBridge.isListening();
      return { subsystem: 'NodeBridge', pipeline: 'brain_to_tts', ok, latencyMs: Date.now() - t0, error: ok ? undefined : 'WebSocket server not listening' };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { subsystem: 'NodeBridge', pipeline: 'brain_to_tts', ok: false, latencyMs: Date.now() - t0, error: e.slice(0, 120) };
    }
  }
}

export const healthChecker = HealthChecker.getInstance();
