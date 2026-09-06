/**
 * monitoring/resourceMonitor.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 9 — Resource Monitor
 *
 * Tracks four real-time production health signals:
 *
 *   1. Event Loop Lag     — measures actual vs scheduled setTimeout delta.
 *                           High lag = thread is blocked by sync code.
 *   2. Memory Leak Guard  — tracks heap growth over a rolling 5-minute window.
 *                           Alerts if heap grows > HEAP_GROWTH_WARN_MB continuously.
 *   3. CPU Spike Detector — computes per-interval CPU% from process.cpuUsage() delta.
 *   4. Long GC Pauses     — integrates with perf_hooks PerformanceObserver to
 *                           detect garbage collection pauses > GC_WARN_MS.
 *
 * All signals feed into:
 *   - Console warnings with structured data
 *   - alertManager (Phase 8) for rate-limited escalation
 *   - Metric history ring buffer (last 60 samples) for trend analysis
 *
 * Runs every SAMPLE_INTERVAL_MS (default: 10s). Unref'd — does NOT keep
 * the process alive.
 */

import { EventEmitter } from 'events';
import { performance, PerformanceObserver } from 'perf_hooks';

// ─── Constants ────────────────────────────────────────────────────────────────

const SAMPLE_INTERVAL_MS    = 10_000;    // 10s sample rate
const EL_LAG_WARN_MS        = 200;       // event loop lag warning threshold
const EL_LAG_CRITICAL_MS    = 1_000;    // event loop lag critical threshold
const HEAP_GROWTH_WARN_MB   = 50;        // heap growth warning in 5 min window
const CPU_WARN_PERCENT       = 80;       // CPU% warning threshold
const GC_WARN_MS             = 100;      // GC pause warning threshold
const MAX_HISTORY            = 60;       // keep 60 samples (~10 min at 10s)

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResourceSample {
  timestamp: number;
  eventLoopLagMs: number;
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  cpuPercent: number;
  gcPauseMs: number;        // last GC pause duration (0 if none)
}

export interface ResourceTrend {
  avgEventLoopLagMs: number;
  maxEventLoopLagMs: number;
  avgCpuPercent: number;
  maxCpuPercent: number;
  heapGrowthMB: number;     // heap difference between oldest and newest sample
  gcPauses: number;         // count of GC pauses in window
  sampleCount: number;
}

// ─── ResourceMonitor ─────────────────────────────────────────────────────────

export class ResourceMonitor extends EventEmitter {
  private static instance: ResourceMonitor;

  private interval:    ReturnType<typeof setInterval> | null = null;
  private history:     ResourceSample[] = [];
  private prevCpuUsage = process.cpuUsage();
  private prevSampleAt = Date.now();
  private lastGcPauseMs = 0;
  private gcObserver:  PerformanceObserver | null = null;
  private isRunning = false;

  private constructor() { super(); }

  static getInstance(): ResourceMonitor {
    if (!ResourceMonitor.instance) {
      ResourceMonitor.instance = new ResourceMonitor();
    }
    return ResourceMonitor.instance;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // GC observer — records longest GC pause between samples
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > this.lastGcPauseMs) {
            this.lastGcPauseMs = entry.duration;
          }
          if (entry.duration > GC_WARN_MS) {
            console.warn(`[ResourceMonitor] ⚠️  Long GC pause: ${entry.duration.toFixed(1)}ms (type: ${entry.name})`);
            this._raiseAlert('warning', 'gc_pause', `GC pause ${entry.duration.toFixed(0)}ms > ${GC_WARN_MS}ms threshold`);
          }
        }
      });
      this.gcObserver.observe({ entryTypes: ['gc'], buffered: false });
    } catch { /* perf_hooks may not be available in all envs */ }

    this.interval = setInterval(() => this._sample(), SAMPLE_INTERVAL_MS);
    this.interval.unref();

    console.log(`[ResourceMonitor] 📊 Started (sampling every ${SAMPLE_INTERVAL_MS / 1000}s).`);
  }

  stop(): void {
    this.isRunning = false;
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    try { this.gcObserver?.disconnect(); } catch { /* ignore */ }
  }

  // ── Sampling ──────────────────────────────────────────────────────────────

  private _sample(): void {
    const now = Date.now();

    // ── Event loop lag: schedule a 0ms timeout and see how late it fires
    const scheduled = performance.now();
    setTimeout(() => {
      const lag = performance.now() - scheduled;
      const mem  = process.memoryUsage();
      const cpuNow = process.cpuUsage();
      const elapsedMs = now - this.prevSampleAt;

      // CPU %: (user + system µs used) / (elapsed ms * 1000µs/ms * cores)
      const cpuUsedUs = (cpuNow.user - this.prevCpuUsage.user) + (cpuNow.system - this.prevCpuUsage.system);
      const cpuPercent = elapsedMs > 0
        ? Math.min(100, Math.round(cpuUsedUs / (elapsedMs * 10)))
        : 0;

      this.prevCpuUsage = cpuNow;
      this.prevSampleAt = now;

      const sample: ResourceSample = {
        timestamp:      now,
        eventLoopLagMs: Math.round(lag),
        heapUsedMB:     Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB:    Math.round(mem.heapTotal / 1024 / 1024),
        rssMB:          Math.round(mem.rss / 1024 / 1024),
        cpuPercent,
        gcPauseMs:      Math.round(this.lastGcPauseMs),
      };
      this.lastGcPauseMs = 0; // reset for next window

      this._addSample(sample);
      this._check(sample);
      this.emit('sample', sample);
    }, 0).unref();
  }

  private _addSample(sample: ResourceSample): void {
    this.history.push(sample);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
  }

  private _check(s: ResourceSample): void {
    // Event loop lag
    if (s.eventLoopLagMs >= EL_LAG_CRITICAL_MS) {
      console.error(`[ResourceMonitor] 🔴 CRITICAL event loop lag: ${s.eventLoopLagMs}ms`);
      this._raiseAlert('critical', 'event_loop', `Event loop lag ${s.eventLoopLagMs}ms (threshold: ${EL_LAG_CRITICAL_MS}ms)`);
    } else if (s.eventLoopLagMs >= EL_LAG_WARN_MS) {
      console.warn(`[ResourceMonitor] ⚠️  Event loop lag: ${s.eventLoopLagMs}ms`);
      this._raiseAlert('warning', 'event_loop', `Event loop lag ${s.eventLoopLagMs}ms (threshold: ${EL_LAG_WARN_MS}ms)`);
    }

    // CPU spike
    if (s.cpuPercent >= CPU_WARN_PERCENT) {
      console.warn(`[ResourceMonitor] ⚠️  High CPU: ${s.cpuPercent}%`);
      this._raiseAlert('warning', 'cpu', `CPU at ${s.cpuPercent}% (threshold: ${CPU_WARN_PERCENT}%)`);
    }

    // Heap growth (compare oldest vs newest in window)
    if (this.history.length >= 30) { // 5-min window at 10s intervals
      const oldest = this.history[this.history.length - 30];
      const growth = s.heapUsedMB - oldest.heapUsedMB;
      if (growth > HEAP_GROWTH_WARN_MB) {
        console.warn(`[ResourceMonitor] ⚠️  Potential memory leak: heap grew +${growth}MB in 5 min (${oldest.heapUsedMB}→${s.heapUsedMB}MB)`);
        this._raiseAlert('warning', 'memory_leak', `Heap grew +${growth}MB in 5 min (now ${s.heapUsedMB}MB)`);
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Get the last N samples (newest first). */
  getHistory(n = 10): ResourceSample[] {
    return this.history.slice(-n).reverse();
  }

  /** Get the latest sample, or null if none yet. */
  getLatest(): ResourceSample | null {
    return this.history.at(-1) ?? null;
  }

  /** Compute rolling trends across all stored samples. */
  getTrend(): ResourceTrend {
    if (this.history.length === 0) {
      return { avgEventLoopLagMs: 0, maxEventLoopLagMs: 0, avgCpuPercent: 0, maxCpuPercent: 0, heapGrowthMB: 0, gcPauses: 0, sampleCount: 0 };
    }

    let sumLag = 0, maxLag = 0, sumCpu = 0, maxCpu = 0, gcPauses = 0;
    for (const s of this.history) {
      sumLag   += s.eventLoopLagMs;
      if (s.eventLoopLagMs > maxLag)   maxLag = s.eventLoopLagMs;
      sumCpu   += s.cpuPercent;
      if (s.cpuPercent > maxCpu)       maxCpu = s.cpuPercent;
      if (s.gcPauseMs > GC_WARN_MS)    gcPauses++;
    }

    const n = this.history.length;
    const first = this.history[0];
    const last  = this.history[n - 1];

    return {
      avgEventLoopLagMs: Math.round(sumLag / n),
      maxEventLoopLagMs: maxLag,
      avgCpuPercent:     Math.round(sumCpu / n),
      maxCpuPercent:     maxCpu,
      heapGrowthMB:      last.heapUsedMB - first.heapUsedMB,
      gcPauses,
      sampleCount:       n,
    };
  }

  // ── Async alert bridge ────────────────────────────────────────────────────

  private async _raiseAlert(severity: 'warning' | 'critical', signal: string, msg: string): Promise<void> {
    try {
      const { alertManager } = await import('../self_healing/alertManager.js');
      alertManager.raise(severity, `resource::${signal}`, msg, 'ResourceMonitor');
    } catch { /* non-fatal */ }
  }
}

export const resourceMonitor = ResourceMonitor.getInstance();
