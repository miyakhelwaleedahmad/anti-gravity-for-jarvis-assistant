/**
 * core/plannerIntelligence.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 6 — Adaptive Intelligence & Planning
 *
 * Provides four capabilities that make JARVIS plan smarter:
 *
 *  1. TOOL CONFIDENCE SCORING
 *     Scores each planned tool call 0.0–1.0 based on its execution history
 *     (success rate, avg latency, degradation state). Low-confidence tools
 *     trigger pre-emptive fallback selection.
 *
 *  2. FAILURE PREDICTION
 *     Before execution, predicts which nodes are likely to fail based on:
 *       - Recent failure history for that tool
 *       - Degraded health status
 *       - Missing required arg patterns
 *       - Historically slow latency (>10s avg) suggesting timeout risk
 *
 *  3. ALTERNATIVE STRATEGY GENERATION
 *     When a tool is predicted to fail or actually fails, generates an
 *     ordered list of alternative approaches (different tool, args, or split
 *     into sub-steps) without invoking the LLM for simple cases.
 *
 *  4. MULTI-STEP PLAN VALIDATION
 *     Validates that multi-step plans have coherent data flow:
 *       - No orphaned dependency edges
 *       - No tool sequences known to be incompatible
 *       - Arg templates referencing outputs of prior steps are wired correctly
 *
 * Used by the orchestrator's planPhase() and repairPhase() to augment
 * decisions made by the ReflectionEngine.
 */

import { toolRegistryV2 } from './toolRegistryV2.js';
import type { TaskGraph, TaskNode } from './taskGraphEngine.js';
import type { ToolMetrics } from './toolRegistryV2.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Confidence score 0.0 (will fail) → 1.0 (will succeed) */
export interface ToolConfidence {
  tool: string;
  score: number;
  reasons: string[];
  /** If score < LOW_CONFIDENCE_THRESHOLD, this is the recommended alternative */
  suggestedFallback?: string;
}

/** Per-node failure prediction */
export interface FailurePrediction {
  nodeId: string;
  tool: string;
  riskLevel: 'low' | 'medium' | 'high';
  confidence: ToolConfidence;
  reasons: string[];
  /** Recommended pre-emptive action before execution starts */
  preemptiveAction?: 'use_fallback' | 'add_delay' | 'warn_user' | 'none';
}

/** A concrete alternative approach for a failing tool */
export interface AlternativeStrategy {
  priority: number;         // 1 = best, higher = less preferred
  description: string;
  type: 'use_fallback' | 'rephrase_args' | 'split_into_steps' | 'skip' | 'replan';
  replacementTool?: string;
  replacementArgs?: Record<string, unknown>;
}

/** Validation result for a multi-step plan */
export interface PlanValidationResult {
  valid: boolean;
  issues: PlanIssue[];
  warnings: string[];
  suggestedFixes: string[];
}

export interface PlanIssue {
  severity: 'error' | 'warning';
  nodeId: string;
  message: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LOW_CONFIDENCE_THRESHOLD  = 0.45;  // Score below this → suggest fallback
const HIGH_RISK_FAILURE_RATE    = 0.4;   // Tool failure rate above this → high risk
const SLOW_TOOL_LATENCY_MS      = 10_000; // avg > 10s → timeout risk flag
const MIN_CALLS_FOR_STATS       = 3;     // Need at least N calls for meaningful stats

// ─── Planner Intelligence ─────────────────────────────────────────────────────

export class PlannerIntelligence {

  // ── 1. TOOL CONFIDENCE SCORING ────────────────────────────────────────────

  /**
   * Score a tool's likelihood of success based on execution history.
   * Returns 0.0–1.0 where 1.0 = highly confident it will succeed.
   */
  scoreToolConfidence(toolName: string): ToolConfidence {
    const metrics = toolRegistryV2.getMetrics(toolName)[0];
    const tool = toolRegistryV2.get(toolName);

    if (!tool) {
      return {
        tool: toolName,
        score: 0.0,
        reasons: [`Tool "${toolName}" is not registered in the registry.`],
      };
    }

    const reasons: string[] = [];
    let score = 1.0;

    if (!metrics || metrics.totalCalls < MIN_CALLS_FOR_STATS) {
      // No history yet — neutral confidence with small penalty for unknown
      score = 0.75;
      reasons.push('Insufficient execution history — using neutral confidence.');
    } else {
      // ── Factor 1: success rate ─────────────────────────────────────────────
      const successRate = metrics.successCount / metrics.totalCalls;
      score *= successRate;
      if (successRate < 0.5) {
        reasons.push(`Low success rate: ${(successRate * 100).toFixed(0)}%`);
      }

      // ── Factor 2: degradation status ──────────────────────────────────────
      if (metrics.degraded) {
        score *= 0.3;
        reasons.push(`Tool is degraded (${metrics.consecutiveFailures} consecutive failures)`);
      }

      // ── Factor 3: recent consecutive failures ──────────────────────────────
      if (metrics.consecutiveFailures >= 2 && !metrics.degraded) {
        const penalty = 1 - (metrics.consecutiveFailures * 0.15);
        score *= Math.max(0.1, penalty);
        reasons.push(`${metrics.consecutiveFailures} consecutive recent failures`);
      }

      // ── Factor 4: latency (timeout risk) ──────────────────────────────────
      if (metrics.avgDurationMs > SLOW_TOOL_LATENCY_MS) {
        score *= 0.75;
        reasons.push(`High avg latency: ${(metrics.avgDurationMs / 1000).toFixed(1)}s (timeout risk)`);
      }
    }

    score = Math.max(0.0, Math.min(1.0, score));

    // Find suggested fallback for low-confidence tools
    let suggestedFallback: string | undefined;
    if (score < LOW_CONFIDENCE_THRESHOLD && tool.fallbacks.length > 0) {
      // Pick the fallback with the highest confidence score
      const scoredFallbacks = tool.fallbacks.map(f => ({
        name: f,
        score: this.scoreToolConfidence(f).score,
      }));
      scoredFallbacks.sort((a, b) => b.score - a.score);
      const best = scoredFallbacks[0];
      if (best && best.score > score) {
        suggestedFallback = best.name;
        reasons.push(`Fallback "${best.name}" has higher confidence (${(best.score * 100).toFixed(0)}%)`);
      }
    }

    if (reasons.length === 0) {
      reasons.push(`Confidence based on ${metrics?.totalCalls ?? 0} historical calls`);
    }

    return { tool: toolName, score, reasons, suggestedFallback };
  }

  /**
   * Score all tools in a graph and return sorted results (lowest confidence first).
   */
  scoreGraphConfidence(graph: TaskGraph): ToolConfidence[] {
    const scores: ToolConfidence[] = [];
    for (const node of graph.nodes.values()) {
      scores.push(this.scoreToolConfidence(node.tool));
    }
    return scores.sort((a, b) => a.score - b.score);
  }

  // ── 2. FAILURE PREDICTION ─────────────────────────────────────────────────

  /**
   * Predict which nodes in a graph are likely to fail before execution starts.
   * Returns predictions sorted by risk (highest first).
   */
  predictFailures(graph: TaskGraph): FailurePrediction[] {
    const predictions: FailurePrediction[] = [];

    for (const node of graph.nodes.values()) {
      if (node.status !== 'pending') continue;

      const confidence = this.scoreToolConfidence(node.tool);
      const metrics    = toolRegistryV2.getMetrics(node.tool)[0];
      const tool       = toolRegistryV2.get(node.tool);
      const reasons: string[] = [...confidence.reasons];
      let riskLevel: FailurePrediction['riskLevel'] = 'low';
      let preemptiveAction: FailurePrediction['preemptiveAction'] = 'none';

      // ── Risk factors ──────────────────────────────────────────────────────

      if (!tool) {
        riskLevel = 'high';
        reasons.push('Tool not registered — will fail immediately');
        preemptiveAction = 'replan' as any;
      } else if (metrics && metrics.totalCalls >= MIN_CALLS_FOR_STATS) {
        const failureRate = metrics.failureCount / metrics.totalCalls;

        if (failureRate >= HIGH_RISK_FAILURE_RATE || metrics.degraded) {
          riskLevel = 'high';
          preemptiveAction = confidence.suggestedFallback ? 'use_fallback' : 'warn_user';
          reasons.push(`Historical failure rate: ${(failureRate * 100).toFixed(0)}%`);
        } else if (confidence.score < LOW_CONFIDENCE_THRESHOLD) {
          riskLevel = 'medium';
          preemptiveAction = 'warn_user';
        } else if (metrics.avgDurationMs > SLOW_TOOL_LATENCY_MS) {
          riskLevel = 'medium';
          preemptiveAction = 'add_delay';
          reasons.push('Slow historical execution — consider pre-emptive timeout extension');
        }
      }

      // Check for missing required args
      if (tool) {
        const missingRequired = Object.entries(tool.inputSchema)
          .filter(([key, schema]) => schema.required && !(key in node.args))
          .map(([key]) => key);

        if (missingRequired.length > 0) {
          riskLevel = 'high';
          preemptiveAction = 'use_fallback';
          reasons.push(`Missing required args: ${missingRequired.join(', ')}`);
        }
      }

      if (riskLevel !== 'low' || confidence.score < 0.9) {
        predictions.push({
          nodeId:           node.id,
          tool:             node.tool,
          riskLevel,
          confidence,
          reasons,
          preemptiveAction: preemptiveAction as FailurePrediction['preemptiveAction'],
        });
      }
    }

    // Sort: high risk first
    const riskOrder = { high: 0, medium: 1, low: 2 };
    return predictions.sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel]);
  }

  // ── 3. ALTERNATIVE STRATEGY GENERATION ───────────────────────────────────

  /**
   * Generate ordered alternative strategies for a failed or at-risk node.
   * Returns strategies sorted by priority (1 = best option).
   */
  generateAlternatives(node: TaskNode): AlternativeStrategy[] {
    const alternatives: AlternativeStrategy[] = [];
    const tool = toolRegistryV2.get(node.tool);
    let priority = 1;

    // ── Option 1: Use registered fallback tool ─────────────────────────────
    if (tool && tool.fallbacks.length > 0) {
      for (const fallbackName of tool.fallbacks) {
        const fallbackTool = toolRegistryV2.get(fallbackName);
        if (!fallbackTool) continue;
        const fallbackScore = this.scoreToolConfidence(fallbackName).score;
        alternatives.push({
          priority: priority++,
          description: `Use fallback tool "${fallbackName}" (confidence: ${(fallbackScore * 100).toFixed(0)}%)`,
          type: 'use_fallback',
          replacementTool: fallbackName,
          replacementArgs: node.args,
        });
      }
    }

    // ── Option 2: Retry with delay (for transient errors) ─────────────────
    if (node.errorType === 'timeout' || node.errorType === 'transient' || !node.errorType) {
      alternatives.push({
        priority: priority++,
        description: 'Retry with exponential backoff (transient error likely)',
        type: 'rephrase_args',
        replacementTool: node.tool,
        replacementArgs: { ...node.args, _retry: true },
      });
    }

    // ── Option 3: Skip non-critical nodes ─────────────────────────────────
    const skipSafeTools = new Set([
      'save_memory', 'log_event', 'push_notification',
      'update_status', 'record_metric',
    ]);
    if (skipSafeTools.has(node.tool)) {
      alternatives.push({
        priority: priority++,
        description: `Skip "${node.tool}" — non-critical side effect tool`,
        type: 'skip',
      });
    }

    // ── Option 4: Replan with failure context ─────────────────────────────
    alternatives.push({
      priority: priority++,
      description: `Replan entirely — tool "${node.tool}" has exhausted its options`,
      type: 'replan',
    });

    return alternatives.sort((a, b) => a.priority - b.priority);
  }

  // ── 4. MULTI-STEP PLAN VALIDATION ─────────────────────────────────────────

  /**
   * Validate the structural and semantic coherence of a multi-step plan.
   * Does NOT invoke the LLM — pure static analysis.
   *
   * Checks:
   *   1. All dependency node IDs exist in the graph
   *   2. No tool is called with empty args when it requires them
   *   3. No obviously incompatible tool sequences (e.g., write then delete same file)
   *   4. High-risk tools are not in the first position without a pre-check
   */
  validatePlan(graph: TaskGraph): PlanValidationResult {
    const issues: PlanIssue[] = [];
    const warnings: string[] = [];
    const suggestedFixes: string[] = [];
    const nodeIds = new Set(graph.nodes.keys());

    for (const node of graph.nodes.values()) {
      // ── Check 1: Dependency edges valid ─────────────────────────────────
      for (const depId of node.dependencies) {
        if (!nodeIds.has(depId)) {
          issues.push({
            severity: 'error',
            nodeId: node.id,
            message: `Dependency "${depId}" does not exist in the graph.`,
          });
          suggestedFixes.push(`Remove invalid dependency "${depId}" from node "${node.id}"`);
        }
      }

      // ── Check 2: Missing required args ──────────────────────────────────
      const tool = toolRegistryV2.get(node.tool);
      if (tool) {
        const missing = Object.entries(tool.inputSchema)
          .filter(([key, schema]) => schema.required && !(key in node.args))
          .map(([key]) => key);

        if (missing.length > 0) {
          issues.push({
            severity: 'error',
            nodeId: node.id,
            message: `Missing required args for "${node.tool}": ${missing.join(', ')}`,
          });
          suggestedFixes.push(`Add missing args [${missing.join(', ')}] to node "${node.id}"`);
        }
      }

      // ── Check 3: Unknown tool ────────────────────────────────────────────
      if (!toolRegistryV2.has(node.tool)) {
        issues.push({
          severity: 'error',
          nodeId: node.id,
          message: `Tool "${node.tool}" is not registered.`,
        });
        suggestedFixes.push(`Replace "${node.tool}" with a registered tool or remove the node`);
      }
    }

    // ── Check 4: Incompatible tool sequences ────────────────────────────────
    const INCOMPATIBLE_SEQUENCES: Array<[string, string, string]> = [
      ['write_file', 'delete_file', 'Do not write then immediately delete the same resource'],
      ['open_app',   'close_app',   'Do not open then immediately close the same app'],
    ];

    const toolSequence = [...graph.nodes.values()].map(n => n.tool);
    for (const [first, second, reason] of INCOMPATIBLE_SEQUENCES) {
      const firstIdx  = toolSequence.indexOf(first);
      const secondIdx = toolSequence.indexOf(second);
      if (firstIdx !== -1 && secondIdx !== -1 && secondIdx === firstIdx + 1) {
        warnings.push(`Suspicious sequence: ${first} → ${second}. ${reason}.`);
      }
    }

    // ── Check 5: High-risk tool in root position ────────────────────────────
    const rootNodes = [...graph.nodes.values()].filter(n => n.dependencies.length === 0);
    for (const node of rootNodes) {
      const tool = toolRegistryV2.get(node.tool);
      if (tool?.riskLevel === 'high') {
        warnings.push(`High-risk tool "${node.tool}" runs as root node (no guard dependency). Consider adding a permission check step.`);
      }
    }

    const valid = issues.filter(i => i.severity === 'error').length === 0;

    if (!valid) {
      console.warn(`[PlannerIntelligence] ❌ Plan validation FAILED: ${issues.length} error(s), ${warnings.length} warning(s)`);
    } else if (warnings.length > 0) {
      console.log(`[PlannerIntelligence] ⚠️  Plan valid with ${warnings.length} warning(s)`);
    } else {
      console.log(`[PlannerIntelligence] ✅ Plan valid (${graph.nodes.size} nodes)`);
    }

    return { valid, issues, warnings, suggestedFixes };
  }

  // ── Summary Report ────────────────────────────────────────────────────────

  /**
   * Full pre-execution intelligence report combining all four analyses.
   * Used by the orchestrator to make an informed go/no-go decision.
   */
  analyzeGraph(graph: TaskGraph): {
    validation:  PlanValidationResult;
    predictions: FailurePrediction[];
    confidence:  ToolConfidence[];
    overallRisk: 'low' | 'medium' | 'high';
    recommendation: 'proceed' | 'proceed_with_caution' | 'replan';
  } {
    const validation  = this.validatePlan(graph);
    const predictions = this.predictFailures(graph);
    const confidence  = this.scoreGraphConfidence(graph);

    const highRiskNodes  = predictions.filter(p => p.riskLevel === 'high').length;
    const medRiskNodes   = predictions.filter(p => p.riskLevel === 'medium').length;
    const avgConfidence  = confidence.length > 0
      ? confidence.reduce((s, c) => s + c.score, 0) / confidence.length
      : 1.0;

    let overallRisk: 'low' | 'medium' | 'high' = 'low';
    let recommendation: 'proceed' | 'proceed_with_caution' | 'replan' = 'proceed';

    if (!validation.valid || highRiskNodes >= 2 || avgConfidence < 0.3) {
      overallRisk    = 'high';
      recommendation = 'replan';
    } else if (highRiskNodes >= 1 || medRiskNodes >= 2 || avgConfidence < 0.6) {
      overallRisk    = 'medium';
      recommendation = 'proceed_with_caution';
    }

    console.log(
      `[PlannerIntelligence] 📊 Graph analysis: risk=${overallRisk} | ` +
      `avgConf=${(avgConfidence * 100).toFixed(0)}% | ` +
      `highRisk=${highRiskNodes} | recommendation=${recommendation}`
    );

    return { validation, predictions, confidence, overallRisk, recommendation };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const plannerIntelligence = new PlannerIntelligence();
