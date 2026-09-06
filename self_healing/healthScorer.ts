/**
 * self_healing/healthScorer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 8 — Health Scoring
 *
 * Computes a deterministic 0–100 health score for every pipeline segment
 * based on four observable signals:
 *
 *   1. Failure rate      — recent failures / total observations (last 10 min)
 *   2. Recency of success — how long since last success (penalises stale pipelines)
 *   3. Consecutive failures — exponential penalty for runs of back-to-back fails
 *   4. Heal attempt ratio  — more failed heal attempts = lower score floor
 *
 * Score bands:
 *   90–100  EXCELLENT   — fully operational, no recent issues
 *   70–89   GOOD        — minor hiccups, self-correcting
 *   50–69   DEGRADED    — recurrent issues, operator should be aware
 *   30–49   POOR        — frequent failures, healing is struggling
 *   0–29    CRITICAL    — pipeline is functionally broken
 */

import type { PipelineHealth } from './pipelineRegistry.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const OBSERVATION_WINDOW_MS  = 10 * 60 * 1000;  // 10 minutes
const STALE_SUCCESS_WARN_MS  = 5  * 60 * 1000;  // 5 minutes
const STALE_SUCCESS_CRIT_MS  = 15 * 60 * 1000;  // 15 minutes
const MAX_HEAL_ATTEMPTS      = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

export type HealthBand = 'excellent' | 'good' | 'degraded' | 'poor' | 'critical';

export interface HealthScore {
  pipeline: string;
  score: number;          // 0–100
  band: HealthBand;
  breakdown: {
    failureRatePenalty:   number;
    recencyPenalty:       number;
    consecutivePenalty:   number;
    healAttemptPenalty:   number;
  };
  recommendation: string;
}

// ─── Scorer ───────────────────────────────────────────────────────────────────

export class HealthScorer {

  /**
   * Compute health score for a single pipeline.
   */
  score(health: PipelineHealth): HealthScore {
    const now = Date.now();
    let score = 100;
    const breakdown = {
      failureRatePenalty:   0,
      recencyPenalty:       0,
      consecutivePenalty:   0,
      healAttemptPenalty:   0,
    };

    // ── Factor 1: Failure rate penalty ────────────────────────────────────────
    // Penalise based on how many failures occurred in the last observation window
    const withinWindow = health.lastFailure > 0 &&
      (now - health.lastFailure) < OBSERVATION_WINDOW_MS;

    if (withinWindow && health.failureCount > 0) {
      // Up to -40 pts for failure rate
      const failurePenalty = Math.min(40, health.failureCount * 10);
      breakdown.failureRatePenalty = failurePenalty;
      score -= failurePenalty;
    }

    // ── Factor 2: Recency of last success ─────────────────────────────────────
    if (health.lastSuccess > 0) {
      const sinceSuccess = now - health.lastSuccess;
      if (sinceSuccess > STALE_SUCCESS_CRIT_MS) {
        breakdown.recencyPenalty = 30;
        score -= 30;
      } else if (sinceSuccess > STALE_SUCCESS_WARN_MS) {
        breakdown.recencyPenalty = 15;
        score -= 15;
      }
    } else if (health.status !== 'unknown') {
      // Never succeeded but status is set — suspicious
      breakdown.recencyPenalty = 20;
      score -= 20;
    }

    // ── Factor 3: Status-based floor ──────────────────────────────────────────
    if (health.status === 'broken') {
      breakdown.consecutivePenalty = 25;
      score -= 25;
    } else if (health.status === 'degraded') {
      breakdown.consecutivePenalty = 10;
      score -= 10;
    }

    // ── Factor 4: Failed heal attempts ────────────────────────────────────────
    if (health.autoHealAttempts > 0) {
      const healPenalty = Math.min(20, health.autoHealAttempts * Math.ceil(20 / MAX_HEAL_ATTEMPTS));
      breakdown.healAttemptPenalty = healPenalty;
      score -= healPenalty;
    }

    score = Math.max(0, Math.min(100, score));

    return {
      pipeline: health.pipeline,
      score,
      band: this._band(score),
      breakdown,
      recommendation: this._recommend(score, health),
    };
  }

  /**
   * Score all pipelines and return sorted by score ascending (worst first).
   */
  scoreAll(healthReport: Record<string, PipelineHealth>): HealthScore[] {
    return Object.values(healthReport)
      .map(h => this.score(h))
      .sort((a, b) => a.score - b.score);
  }

  /**
   * Compute an aggregate system health score (0–100) as a weighted average,
   * where the bottom 20% worst pipelines are double-weighted.
   */
  systemScore(scores: HealthScore[]): number {
    if (scores.length === 0) return 100;
    const sorted = [...scores].sort((a, b) => a.score - b.score);
    const criticalCount = Math.max(1, Math.ceil(sorted.length * 0.2));
    let weightedSum = 0;
    let totalWeight = 0;
    for (let i = 0; i < sorted.length; i++) {
      const weight = i < criticalCount ? 2 : 1;
      weightedSum += sorted[i].score * weight;
      totalWeight += weight;
    }
    return Math.round(weightedSum / totalWeight);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _band(score: number): HealthBand {
    if (score >= 90) return 'excellent';
    if (score >= 70) return 'good';
    if (score >= 50) return 'degraded';
    if (score >= 30) return 'poor';
    return 'critical';
  }

  private _recommend(score: number, health: PipelineHealth): string {
    if (score >= 90) return 'No action required.';
    if (score >= 70) return `Monitor '${health.pipeline}' — minor instability detected.`;
    if (score >= 50) return `Investigate '${health.pipeline}' — repeated failures within 10 min.`;
    if (score >= 30) return `Auto-heal recommended for '${health.pipeline}' — pipeline degraded.`;
    return `CRITICAL: '${health.pipeline}' is functionally broken — immediate intervention.`;
  }
}

export const healthScorer = new HealthScorer();
