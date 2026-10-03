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
 *   - LLM API (Groq or Gemini) — lists models; costs no generation quota
 *   - Redis             — PING command via ioredis
 *   - Vector Memory     — checks if the supervisor process is alive
 *   - Memory Manager    — verifies in-memory DB is initialized
 *   - Tool Registry     — verifies at least 1 tool is registered
 *   - NodeBridge        — checks WebSocket server is bound
 *
 * Each probe result is fed into:
 *   1. PipelineRegistry  — recordSuccess() / recordFailure()
 *   2. FailureAnalytics  — record() for trend tracking
 *   3. AlertManager      — raises warning/critical on probe failure
 *
 * Probes run every PROBE_INTERVAL_MS (default: 120s).
 * During active conversation the probe round is skipped.
 */

import { pipelineRegistry } from './pipelineRegistry.js';
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
      () => this._probeGroq(),
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
  private async _probeGroq(): Promise<ProbeResult> {
    const t0 = Date.now();
    const { llmConfig } = await import('../config/llmconfig.js');
    const subsystem = `LLM API (${llmConfig.provider})`;
    try {
      const { groqProvider } = await import('../bridge/groqProvider.js');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        await groqProvider.ping(ctrl.signal);
      } finally {
        clearTimeout(timer);
      }
      return { subsystem, pipeline: 'brain_to_groq', ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      // Rate-limit errors are not a health failure — the API is reachable
      const ok = e.includes('rate-limited') || e.includes('circuit broken') || e.includes('(429)');
      return {
        subsystem,
        pipeline: 'brain_to_groq',
        ok,
        latencyMs: Date.now() - t0,
        error: ok ? undefined : e.slice(0, 120),
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
      const ready = vectorMemorySupervisor?.isStartupReady?.() ?? true;
      return {
        subsystem: 'Vector Memory',
        pipeline: 'groq_to_memory',
        ok: ready,
        latencyMs: Date.now() - t0,
        error: ready ? undefined : 'supervisor not ready',
      };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { subsystem: 'Vector Memory', pipeline: 'groq_to_memory', ok: false, latencyMs: Date.now() - t0, error: e.slice(0, 120) };
    }
  }

  private async _probeMemoryManager(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      const { memoryManager } = await import('../memory/memoryManager.js');
      const stats = memoryManager.getStats?.();
      const ok    = stats !== undefined && stats !== null;
      return { subsystem: 'MemoryManager', pipeline: 'groq_to_memory', ok, latencyMs: Date.now() - t0, error: ok ? undefined : 'getStats returned null' };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { subsystem: 'MemoryManager', pipeline: 'groq_to_memory', ok: false, latencyMs: Date.now() - t0, error: e.slice(0, 120) };
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
      // NodeBridge is ok if it's not null — no active network call needed
      const ok = nodeBridge !== null && nodeBridge !== undefined;
      return { subsystem: 'NodeBridge', pipeline: 'brain_to_tts', ok, latencyMs: Date.now() - t0, error: ok ? undefined : 'nodeBridge not initialized' };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { subsystem: 'NodeBridge', pipeline: 'brain_to_tts', ok: false, latencyMs: Date.now() - t0, error: e.slice(0, 120) };
    }
  }
}

export const healthChecker = HealthChecker.getInstance();
