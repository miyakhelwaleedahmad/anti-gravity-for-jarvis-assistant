/**
 * self_healing/failureAnalytics.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 8 — Failure Analytics
 *
 * Tracks failure events over time and derives actionable intelligence:
 *
 *   - Failure frequency per pipeline (sliding 1h window)
 *   - Mean Time To Recovery (MTTR) per pipeline
 *   - Recurrence detection: pipelines that fail, heal, then fail again quickly
 *   - Failure digest: structured summary ready for logging or voice reporting
 *   - Trend analysis: is a pipeline getting worse or improving over time?
 *
 * Data is kept in-process only (no disk persistence) for performance.
 * The ring buffer is capped at MAX_EVENTS_PER_PIPELINE events per pipeline.
 */

import * as fs from 'fs';
import * as path from 'path';
import { dataRoot } from '../core/workspaceRoot.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_EVENTS_PER_PIPELINE = 100;
const SLIDING_WINDOW_MS       = 60 * 60 * 1000;    // 1 hour
const RECURRENCE_WINDOW_MS    = 10 * 60 * 1000;    // 10 minutes
const ANALYTICS_LOG_PATH      = path.join(dataRoot(path.resolve(__dirname, '..')), 'data', 'logs', 'failure_analytics.jsonl');

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventKind = 'failure' | 'recovery' | 'heal_attempt' | 'heal_success' | 'circuit_break';

export interface FailureEvent {
  timestamp: number;
  kind: EventKind;
  pipeline: string;
  detail: string;
}

export interface PipelineAnalytics {
  pipeline: string;
  failuresInWindow: number;       // failures in last 1h
  meanTimeToRecoveryMs: number;   // avg ms between failure and next recovery
  isRecurring: boolean;           // failed → healed → failed again within 10 min
  trend: 'improving' | 'stable' | 'worsening';
  lastFailureMs: number;          // ms since last failure
  totalFailures: number;
  totalRecoveries: number;
  circuitBroken: boolean;
}

export interface FailureDigest {
  generatedAt: number;
  systemHealthSummary: string;
  criticalPipelines: string[];
  recurringPipelines: string[];
  avgMttrMs: number;
  totalFailuresInWindow: number;
  recommendations: string[];
}

// ─── Analytics Engine ─────────────────────────────────────────────────────────

export class FailureAnalytics {
  private static instance: FailureAnalytics;
  private events: Map<string, FailureEvent[]> = new Map();

  private constructor() {}

  static getInstance(): FailureAnalytics {
    if (!FailureAnalytics.instance) {
      FailureAnalytics.instance = new FailureAnalytics();
    }
    return FailureAnalytics.instance;
  }

  // ── Event Recording ────────────────────────────────────────────────────────

  record(pipeline: string, kind: EventKind, detail = ''): void {
    if (!this.events.has(pipeline)) {
      this.events.set(pipeline, []);
    }
    const buf = this.events.get(pipeline)!;
    const event: FailureEvent = { timestamp: Date.now(), kind, pipeline, detail };
    buf.push(event);

    // Rolling trim — keep only the most recent N events
    if (buf.length > MAX_EVENTS_PER_PIPELINE) {
      buf.splice(0, buf.length - MAX_EVENTS_PER_PIPELINE);
    }

    // Async append to disk log (non-blocking)
    this._appendLog(event);
  }

  // ── Per-pipeline Analytics ─────────────────────────────────────────────────

  getAnalytics(pipeline: string): PipelineAnalytics {
    const events = this.events.get(pipeline) ?? [];
    const now    = Date.now();

    // Failures in last 1h
    const windowStart      = now - SLIDING_WINDOW_MS;
    const failures         = events.filter(e => e.kind === 'failure');
    const failuresInWindow = failures.filter(e => e.timestamp > windowStart).length;
    const recoveries       = events.filter(e => e.kind === 'heal_success' || e.kind === 'recovery');

    // MTTR computation: pair each failure with the next recovery
    let totalRecoveryMs = 0;
    let pairedCount     = 0;
    for (const failure of failures) {
      const nextRecovery = recoveries.find(r => r.timestamp > failure.timestamp);
      if (nextRecovery) {
        totalRecoveryMs += nextRecovery.timestamp - failure.timestamp;
        pairedCount++;
      }
    }
    const meanTimeToRecoveryMs = pairedCount > 0 ? Math.round(totalRecoveryMs / pairedCount) : 0;

    // Recurrence detection: failure → recovery → failure within RECURRENCE_WINDOW_MS
    let isRecurring = false;
    for (let i = 0; i < recoveries.length; i++) {
      const rec  = recoveries[i];
      const nextFail = failures.find(
        f => f.timestamp > rec.timestamp && f.timestamp - rec.timestamp < RECURRENCE_WINDOW_MS
      );
      if (nextFail) { isRecurring = true; break; }
    }

    // Trend: compare failure count in first vs second half of window
    const midPoint       = windowStart + SLIDING_WINDOW_MS / 2;
    const firstHalfFails = failures.filter(e => e.timestamp > windowStart && e.timestamp <= midPoint).length;
    const secondHalfFails = failures.filter(e => e.timestamp > midPoint).length;
    let trend: PipelineAnalytics['trend'] = 'stable';
    if (secondHalfFails > firstHalfFails + 1)  trend = 'worsening';
    if (firstHalfFails  > secondHalfFails + 1) trend = 'improving';

    const lastFailure = failures.at(-1);
    const circuitBroken = events.some(e => e.kind === 'circuit_break' &&
      e.timestamp > now - SLIDING_WINDOW_MS);

    return {
      pipeline,
      failuresInWindow,
      meanTimeToRecoveryMs,
      isRecurring,
      trend,
      lastFailureMs: lastFailure ? now - lastFailure.timestamp : -1,
      totalFailures: failures.length,
      totalRecoveries: recoveries.length,
      circuitBroken,
    };
  }

  // ── System-wide Digest ─────────────────────────────────────────────────────

  generateDigest(allPipelines: string[]): FailureDigest {
    const analytics = allPipelines.map(p => this.getAnalytics(p));
    const now       = Date.now();

    const criticalPipelines  = analytics
      .filter(a => a.failuresInWindow >= 3 || a.circuitBroken)
      .map(a => a.pipeline);

    const recurringPipelines = analytics
      .filter(a => a.isRecurring)
      .map(a => a.pipeline);

    const totalFailuresInWindow = analytics.reduce((s, a) => s + a.failuresInWindow, 0);

    const mttrValues = analytics.filter(a => a.meanTimeToRecoveryMs > 0);
    const avgMttrMs  = mttrValues.length > 0
      ? Math.round(mttrValues.reduce((s, a) => s + a.meanTimeToRecoveryMs, 0) / mttrValues.length)
      : 0;

    // Build recommendations
    const recommendations: string[] = [];
    if (criticalPipelines.length > 0) {
      recommendations.push(`Critical pipelines need attention: ${criticalPipelines.join(', ')}`);
    }
    if (recurringPipelines.length > 0) {
      recommendations.push(`Recurrent failures detected in: ${recurringPipelines.join(', ')} — root cause investigation recommended`);
    }
    if (avgMttrMs > 120_000) {
      recommendations.push(`Average MTTR is ${(avgMttrMs / 1000).toFixed(0)}s — consider more aggressive recovery policies`);
    }
    const worseningPipelines = analytics.filter(a => a.trend === 'worsening').map(a => a.pipeline);
    if (worseningPipelines.length > 0) {
      recommendations.push(`Worsening trend detected in: ${worseningPipelines.join(', ')}`);
    }
    if (recommendations.length === 0) {
      recommendations.push('All pipelines are stable. No action required.');
    }

    // Human-readable summary
    const healthWord = criticalPipelines.length > 0 ? 'CRITICAL' :
      totalFailuresInWindow > 5 ? 'DEGRADED' : 'HEALTHY';
    const systemHealthSummary = `System is ${healthWord}. ${totalFailuresInWindow} failure(s) in last 1h across ${analytics.length} pipeline(s).`;

    return {
      generatedAt: now,
      systemHealthSummary,
      criticalPipelines,
      recurringPipelines,
      avgMttrMs,
      totalFailuresInWindow,
      recommendations,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Return all tracked pipeline names (for digest generation).
   */
  trackedPipelines(): string[] {
    return [...this.events.keys()];
  }

  /**
   * Clear all analytics data (for testing / reset).
   */
  reset(): void {
    this.events.clear();
  }

  // ── Async Disk Logging (non-blocking) ─────────────────────────────────────

  private _appendLog(event: FailureEvent): void {
    const line = JSON.stringify(event) + '\n';
    fs.appendFile(ANALYTICS_LOG_PATH, line, { encoding: 'utf8' }, (err) => {
      if (err && !err.message.includes('ENOENT')) {
        // ENOENT = logs dir not created yet — silent, non-fatal
        // Other errors are also non-fatal but log once
        process.stderr.write(`[FailureAnalytics] Log write failed: ${err.message}\n`);
      }
    });
  }
}

export const failureAnalytics = FailureAnalytics.getInstance();
