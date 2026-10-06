/**
 * core/reflectionEngine.ts  (v3 — proactive reflection)
 * ─────────────────────────────────────────────────────────────────────────────
 * Autonomous self-reflection and repair engine.
 *
 * Phase 1 UPGRADES — Proactive Reflection:
 *
 *   PRE-EXECUTION CHECK  (preExecutionCheck)
 *     Analyzes the planned TaskGraph BEFORE a single node runs.
 *     Detects: unknown tools, missing args, suspicious plans, goal mismatch.
 *     Can BLOCK execution or PATCH the plan inline.
 *
 *   MID-EXECUTION MONITORING  (midExecutionCheck)
 *     Called during execution after each node batch settles.
 *     Detects early failure cascades, rising error rates, and stalls.
 *     Can signal ABORT or REPLAN without waiting for full graph completion.
 *
 *   POST-EXECUTION REFLECTION  (reflect) — unchanged from v2
 *     Full LLM-augmented diagnosis after the graph settles.
 *
 * v2 preserved: LLM fallback for unknown failure classification.
 */

import type { TaskGraph, TaskNode } from './taskGraphEngine.js';
import type { AgentMemory } from '../memory/agentMemory.js';
import type { ILLMMessage } from '../bridge/llmTypes.js';
import { toolRegistryV2 } from './toolRegistryV2.js';
import { APPROVAL_DENIED_REPLY, FULL_CONTROL_HINT, RATE_LIMITED_REPLY, isPermissionDenial } from '../control/permissionDenial.js';
import { verificationFailedReply } from './verifiers.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskOutcome = 'success' | 'partial' | 'failure';

export type FailureClass =
  | 'tool_error'      // Tool threw, returned "Error:", or returned empty string
  | 'plan_error'      // Wrong tool name, wrong args structure, bad planning
  | 'network_error'   // TIMEOUT, connection refused, rate limit
  | 'context_error'   // Missing required context (file not found, permission denied)
  | 'abort_error'     // Execution was interrupted by user
  | 'unknown';

export type RepairStrategy =
  | 'retry_same'        // Retry the same nodes with same args
  | 'retry_with_delay'  // Retry after exponential backoff
  | 'fallback_tool'     // Switch to a fallback tool
  | 'replan'            // Re-run PLANNING phase with more context
  | 'abort'             // Give up — max retries exceeded or unrecoverable
  | 'none';             // No repair needed (success)

export interface ReflectionResult {
  outcome: TaskOutcome;
  failedNodes: TaskNode[];
  succeededNodes: TaskNode[];
  failureClass?: FailureClass;
  repairStrategy: RepairStrategy;
  repairArgs?: Record<string, unknown>;
  summary: string;
  shouldSpeak: boolean;    // Whether to vocalize the outcome
  voiceMessage?: string;   // What to say via TTS
}

// ─── Phase 1: Pre-Execution Types ─────────────────────────────────────────────

export type PreCheckVerdict =
  | 'approved'       // Plan looks good — proceed
  | 'modified'       // Plan was patched inline — proceed with caution
  | 'rejected';      // Plan is fundamentally broken — do not execute

export interface PreExecutionResult {
  verdict: PreCheckVerdict;
  issues: string[];          // Human-readable list of detected problems
  patchedNodes?: string[];   // IDs of nodes that were modified
  blockedNodes?: string[];   // IDs of nodes that were removed/skipped
  summary: string;
}

// ─── Phase 1: Mid-Execution Types ─────────────────────────────────────────────

export type MidCheckSignal =
  | 'continue'       // Execution looks healthy
  | 'warn'           // Minor issues detected — log but continue
  | 'abort'          // Failure cascade detected — stop now
  | 'replan';        // Significant deviation — replan is better than continuing

export interface MidExecutionResult {
  signal: MidCheckSignal;
  reason: string;
  failureRate: number;      // 0.0–1.0
  stalledNodes: string[];   // IDs of nodes running > timeout threshold
}

// ─── Failure Classifiers ──────────────────────────────────────────────────────

interface FailurePattern {
  pattern: RegExp | string;
  class: FailureClass;
  strategy: RepairStrategy;
}

const FAILURE_PATTERNS: FailurePattern[] = [
  // Network / timeout
  { pattern: /TIMEOUT/i,             class: 'network_error', strategy: 'retry_with_delay' },
  { pattern: /ECONNREFUSED/i,        class: 'network_error', strategy: 'retry_with_delay' },
  { pattern: /ENOTFOUND/i,           class: 'network_error', strategy: 'retry_with_delay' },
  { pattern: /rate.?limit/i,         class: 'network_error', strategy: 'retry_with_delay' },
  { pattern: /network/i,             class: 'network_error', strategy: 'retry_with_delay' },
  { pattern: /fetch failed/i,        class: 'network_error', strategy: 'retry_with_delay' },
  { pattern: /ECONNRESET/i,          class: 'network_error', strategy: 'retry_with_delay' },

  // Abort / interrupt
  { pattern: /ABORTED/i,             class: 'abort_error',   strategy: 'abort' },
  { pattern: /interrupt/i,           class: 'abort_error',   strategy: 'abort' },

  // Tool / schema errors
  { pattern: /Unknown tool/i,        class: 'plan_error',    strategy: 'replan' },
  { pattern: /not registered/i,      class: 'plan_error',    strategy: 'replan' },
  { pattern: /Missing required/i,    class: 'plan_error',    strategy: 'replan' },
  { pattern: /Invalid argument/i,    class: 'plan_error',    strategy: 'replan' },
  { pattern: /parse/i,               class: 'plan_error',    strategy: 'replan' },
  { pattern: /JSON/i,                class: 'plan_error',    strategy: 'replan' },
  { pattern: /expects type/i,        class: 'plan_error',    strategy: 'replan' },
  { pattern: /must be one of/i,      class: 'plan_error',    strategy: 'replan' },

  // Context / filesystem / safety errors
  { pattern: /PERMISSION_DENIED|permission level \d/i, class: 'context_error', strategy: 'abort' },
  { pattern: /allowlist|policy/i,    class: 'context_error', strategy: 'abort' },
  { pattern: /no open application/i, class: 'context_error', strategy: 'abort' },
  { pattern: /ENOENT/i,              class: 'context_error', strategy: 'retry_same' },
  { pattern: /Permission denied/i,   class: 'context_error', strategy: 'abort' },
  { pattern: /blocked by safety/i,   class: 'context_error', strategy: 'abort' },
  { pattern: /cancelled by user/i,   class: 'context_error', strategy: 'abort' },
  { pattern: /protected file/i,      class: 'context_error', strategy: 'abort' },
  { pattern: /not found/i,           class: 'context_error', strategy: 'retry_same' },
  { pattern: /File not found/i,      class: 'context_error', strategy: 'retry_same' },

  // Generic tool error
  { pattern: /^Error:/i,             class: 'tool_error',    strategy: 'fallback_tool' },
  { pattern: /threw an error/i,      class: 'tool_error',    strategy: 'fallback_tool' },
  { pattern: /failed:/i,             class: 'tool_error',    strategy: 'fallback_tool' },
];

/**
 * The registry refused the call before running the tool (bad arguments,
 * unknown tool). Nothing happened on the PC, so a new plan is safe even for a
 * step that is never retried.
 */
const REFUSED_BEFORE_RUNNING = /missing required argument|expects type|must be one of|unknown tool|not registered/i;

function classifyError(errorMsg: string): { class: FailureClass; strategy: RepairStrategy } {
  for (const fp of FAILURE_PATTERNS) {
    const matched = fp.pattern instanceof RegExp
      ? fp.pattern.test(errorMsg)
      : errorMsg.toLowerCase().includes(fp.pattern.toLowerCase());

    if (matched) {
      return { class: fp.class, strategy: fp.strategy };
    }
  }
  return { class: 'unknown', strategy: 'retry_same' };
}

// ─── LLM-Based Failure Analysis ───────────────────────────────────────────────

async function llmDiagnoseFailure(
  failedNodes: TaskNode[],
  goal: string
): Promise<{ class: FailureClass; strategy: RepairStrategy; context: string }> {
  try {
    // Lazy import to avoid circular dependency at module load time
    const { modelRouter } = await import('../bridge/modelRouter.js');
    const { llmConfig } = await import('../config/llmconfig.js');

    const errorSummary = failedNodes
      .map(n => `Tool: ${n.tool}\nArgs: ${JSON.stringify(n.args).substring(0, 200)}\nError: ${n.error}`)
      .join('\n\n');

    const messages: ILLMMessage[] = [
      {
        role: 'system',
        content: `You are a diagnostic AI. Analyze the following tool execution failures and respond with ONLY a JSON object with these fields:
{
  "failureClass": "tool_error|plan_error|network_error|context_error|unknown",
  "repairStrategy": "retry_same|retry_with_delay|fallback_tool|replan|abort",
  "context": "one sentence explanation of why it failed and what to try next"
}
Do not include any other text.`,
      },
      {
        role: 'user',
        content: `Goal: "${goal}"\n\nFailed tool executions:\n${errorSummary}`,
      },
    ];

    const response = await modelRouter.chat({
      model: llmConfig.model,
      messages,
    });

    const rawContent = (response.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Extract JSON from response
    const jsonMatch = /\{[\s\S]*\}/.exec(rawContent);
    if (!jsonMatch) throw new Error('No JSON in LLM diagnostic response');

    const parsed = JSON.parse(jsonMatch[0]);

    const validClasses: FailureClass[] = ['tool_error', 'plan_error', 'network_error', 'context_error', 'abort_error', 'unknown'];
    const validStrategies: RepairStrategy[] = ['retry_same', 'retry_with_delay', 'fallback_tool', 'replan', 'abort', 'none'];

    return {
      class: validClasses.includes(parsed.failureClass) ? parsed.failureClass : 'unknown',
      strategy: validStrategies.includes(parsed.repairStrategy) ? parsed.repairStrategy : 'retry_same',
      context: String(parsed.context ?? ''),
    };

  } catch (err) {
    console.warn('[Reflection] LLM diagnosis failed, defaulting:', err);
    return { class: 'unknown', strategy: 'retry_same', context: '' };
  }
}

// ─── Reflection Engine ────────────────────────────────────────────────────────

export class ReflectionEngine {

  // ── PHASE 1: PRE-EXECUTION CHECK ────────────────────────────────────────────

  /**
   * Analyze the planned TaskGraph BEFORE execution begins.
   * Catches bad tool names, missing required args, goal-plan mismatches.
   *
   * Called by orchestrator immediately after planPhase() returns a graph.
   * Returns a verdict that the orchestrator uses to decide whether to proceed.
   *
   * Checks performed:
   *   1. All tool names are registered in ToolRegistryV2
   *   2. No node has completely empty args when the tool schema requires some
   *   3. Dependency graph is not obviously circular (caught by builder, but double-check)
   *   4. LLM plan sanity check for plans with many nodes (optional, async)
   */
  async preExecutionCheck(
    graph: TaskGraph,
    performLLMSanity = false
  ): Promise<PreExecutionResult> {
    const issues: string[] = [];
    const patchedNodes: string[] = [];
    const blockedNodes: string[] = [];

    console.log(`[Reflection] 🔍 PRE-CHECK: Analyzing plan for "${graph.goal.substring(0, 80)}" (${graph.nodes.size} nodes)`);

    for (const node of graph.nodes.values()) {
      // ── Check 1: Tool exists in registry ────────────────────────────────
      const toolDefs = toolRegistryV2.getLLMDefinitions();
      const toolExists = toolDefs.some((t: any) => t.function?.name === node.tool || t.name === node.tool);

      if (!toolExists) {
        issues.push(`Node "${node.id}": tool "${node.tool}" is not registered.`);
        node.status = 'skipped';
        node.error = `PRE-CHECK: Tool "${node.tool}" not found in registry.`;
        blockedNodes.push(node.id);
        console.warn(`[Reflection] ⚠️  PRE-CHECK blocked node "${node.id}": unknown tool "${node.tool}"`);
        continue;
      }

      // ── Check 2: Args are not completely empty for non-trivial tools ─────
      const argKeys = Object.keys(node.args ?? {});
      if (argKeys.length === 0 && node.tool !== 'get_time' && node.tool !== 'get_date') {
        // Soft warning — don't block, just flag
        issues.push(`Node "${node.id}" (${node.tool}): args are empty. Tool may fail.`);
        console.warn(`[Reflection] ⚠️  PRE-CHECK: node "${node.id}" has empty args for tool "${node.tool}"`);
      }

      // ── Check 3: Dependency nodes are not already blocked ────────────────
      const hasBlockedDep = node.dependencies.some(depId => blockedNodes.includes(depId));
      if (hasBlockedDep) {
        node.status = 'skipped';
        node.error = 'PRE-CHECK: Depends on a blocked node.';
        blockedNodes.push(node.id);
        issues.push(`Node "${node.id}" blocked because its dependency was blocked.`);
      }
    }

    // ── Check 4: All nodes blocked → reject entire plan ───────────────────
    const executableNodes = [...graph.nodes.values()].filter(n => n.status === 'pending');
    if (executableNodes.length === 0 && graph.nodes.size > 0) {
      const summary = `PRE-CHECK REJECTED: All ${graph.nodes.size} node(s) were blocked. Issues: ${issues.join('; ')}`;
      console.error(`[Reflection] ❌ ${summary}`);
      return { verdict: 'rejected', issues, blockedNodes, summary };
    }

    // ── Optional: LLM sanity check for complex plans (≥4 nodes) ──────────
    if (performLLMSanity && graph.nodes.size >= 4) {
      const llmIssues = await this.llmPlanSanityCheck(graph);
      if (llmIssues.length > 0) {
        issues.push(...llmIssues);
        console.warn(`[Reflection] 🤔 LLM sanity check found issues:`, llmIssues);
      }
    }

    const verdict: PreCheckVerdict = blockedNodes.length > 0 ? 'modified' : 'approved';
    const summary = verdict === 'approved'
      ? `PRE-CHECK APPROVED: ${graph.nodes.size} node(s) ready for execution.`
      : `PRE-CHECK MODIFIED: ${blockedNodes.length} node(s) blocked, ${executableNodes.length} remaining.`;

    console.log(`[Reflection] ✅ PRE-CHECK ${verdict.toUpperCase()}: ${summary}`);
    return { verdict, issues, patchedNodes, blockedNodes, summary };
  }

  /**
   * LLM-assisted plan sanity check.
   * Asks the LLM whether the proposed tool sequence makes sense for the goal.
   * Only called for complex plans (≥4 nodes) to avoid latency overhead.
   */
  private async llmPlanSanityCheck(graph: TaskGraph): Promise<string[]> {
    try {
      const { modelRouter } = await import('../bridge/modelRouter.js');
      const { llmConfig } = await import('../config/llmconfig.js');

      const planDesc = [...graph.nodes.values()]
        .map(n => `  ${n.id}: ${n.tool}(${JSON.stringify(n.args).substring(0, 100)})`)
        .join('\n');

      const messages: ILLMMessage[] = [
        {
          role: 'system',
          content: `You are a plan auditor. Given a goal and a list of tool calls, identify any obvious problems.
Respond ONLY with a JSON array of issue strings. If no issues, respond with [].
Example: ["tool_x requires a file path but none was provided", "step 3 depends on step 1 output but no dependency is wired"]`,
        },
        {
          role: 'user',
          content: `Goal: "${graph.goal}"\n\nPlanned tool calls:\n${planDesc}`,
        },
      ];

      const response = await modelRouter.chat({ model: llmConfig.model, messages });
      const raw = (response.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      const jsonMatch = /\[[\s\S]*\]/.exec(raw);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      return Array.isArray(parsed) ? parsed.filter((s: any) => typeof s === 'string') : [];
    } catch {
      return []; // Non-fatal — sanity check is best-effort
    }
  }

  // ── PHASE 1: MID-EXECUTION MONITORING ───────────────────────────────────────

  /**
   * Called DURING execution after each node batch settles.
   * Detects failure cascades, long-running stalled nodes, and deviation patterns.
   *
   * Called by orchestrator's modified makeToolExecutor() after each batch.
   * Returns a signal telling the orchestrator whether to continue or intervene.
   *
   * @param graph         The active TaskGraph (partially executed)
   * @param nodeTimeouts  Map of nodeId → startedAt (ms) for stall detection
   * @param stallThresholdMs  How long a node can run before flagged as stalled
   */
  midExecutionCheck(
    graph: TaskGraph,
    nodeTimeouts: Map<string, number> = new Map(),
    stallThresholdMs = 30_000
  ): MidExecutionResult {
    const allNodes = [...graph.nodes.values()];
    const total = allNodes.length;
    if (total === 0) return { signal: 'continue', reason: 'No nodes', failureRate: 0, stalledNodes: [] };

    const done = allNodes.filter(n => n.status === 'done').length;
    const failed = allNodes.filter(n => n.status === 'failed').length;
    const running = allNodes.filter(n => n.status === 'running');
    const settled = done + failed;

    // ── Stall detection ─────────────────────────────────────────────────────
    const now = Date.now();
    const stalledNodes: string[] = [];

    for (const node of running) {
      const startedAt = nodeTimeouts.get(node.id) ?? node.startedAt;
      if (startedAt && now - startedAt > stallThresholdMs) {
        stalledNodes.push(node.id);
      }
    }

    if (stalledNodes.length > 0) {
      console.warn(`[Reflection] ⏱️  MID-CHECK: ${stalledNodes.length} stalled node(s): ${stalledNodes.join(', ')}`);
      return {
        signal: 'abort',
        reason: `${stalledNodes.length} node(s) exceeded ${stallThresholdMs / 1000}s stall threshold.`,
        failureRate: failed / total,
        stalledNodes,
      };
    }

    // ── Failure cascade detection ────────────────────────────────────────────
    if (settled === 0) {
      return { signal: 'continue', reason: 'Execution in progress', failureRate: 0, stalledNodes: [] };
    }

    const failureRate = failed / settled;

    // >75% of settled nodes failed → abort immediately
    if (failureRate >= 0.75 && settled >= 2) {
      console.error(`[Reflection] 💥 MID-CHECK: Failure cascade! ${failed}/${settled} nodes failed (${(failureRate * 100).toFixed(0)}%)`);
      return {
        signal: 'abort',
        reason: `Failure cascade: ${(failureRate * 100).toFixed(0)}% of settled nodes failed.`,
        failureRate,
        stalledNodes,
      };
    }

    // 50–75% failure rate → suggest replan
    if (failureRate >= 0.5 && settled >= 2) {
      console.warn(`[Reflection] ⚠️  MID-CHECK: High failure rate (${(failureRate * 100).toFixed(0)}%) — replan suggested.`);
      return {
        signal: 'replan',
        reason: `High failure rate: ${(failureRate * 100).toFixed(0)}% of settled nodes failed.`,
        failureRate,
        stalledNodes,
      };
    }

    // Some failures but within acceptable range
    if (failed > 0) {
      return {
        signal: 'warn',
        reason: `${failed} node(s) failed so far, monitoring...`,
        failureRate,
        stalledNodes,
      };
    }

    return {
      signal: 'continue',
      reason: `${done}/${total} nodes complete, execution healthy.`,
      failureRate: 0,
      stalledNodes,
    };
  }

  /**
   * Main entry point — called after every OBSERVING phase.
   * Analyzes the task graph and decides what to do next.
   *
   * Now async to support LLM-based diagnosis for unknown failures.
   */
  async reflect(graph: TaskGraph, memory: AgentMemory): Promise<ReflectionResult> {
    const allNodes = [...graph.nodes.values()];
    const failedNodes = allNodes.filter(n => n.status === 'failed');
    const succeededNodes = allNodes.filter(n => n.status === 'done');
    const skippedNodes = allNodes.filter(n => n.status === 'skipped');

    console.log(`[Reflection] 🔍 Analyzing graph "${graph.id}": ` +
      `${succeededNodes.length} done, ${failedNodes.length} failed, ${skippedNodes.length} skipped`);

    // ── OBSERVE ────────────────────────────────────────────────────────────

    // Skipped = interrupted — treat as abort
    if (skippedNodes.length > 0 && graph.status === 'interrupted') {
      const result = this.buildResult({
        outcome: 'failure',
        failedNodes: skippedNodes,
        succeededNodes,
        failureClass: 'abort_error',
        repairStrategy: 'abort',
        summary: `Task interrupted by user. ${succeededNodes.length} node(s) completed before interrupt.`,
        shouldSpeak: false,
      });
      this.recordEpisode(graph.goal, result, memory);
      return result;
    }

    // Full success
    if (failedNodes.length === 0) {
      const outputs = succeededNodes
        .map(n => n.result ?? '')
        .filter(Boolean)
        .join(' | ')
        .substring(0, 300);

      const result = this.buildResult({
        outcome: 'success',
        failedNodes: [],
        succeededNodes,
        repairStrategy: 'none',
        summary: `All ${succeededNodes.length} task(s) completed successfully.`,
        shouldSpeak: true,
        voiceMessage: this.buildSuccessVoiceMessage(graph.goal, outputs),
      });
      this.recordEpisode(graph.goal, result, memory);
      return result;
    }

    // ── CLASSIFY ───────────────────────────────────────────────────────────

    // Determine dominant failure class across all failed nodes
    const classifications = failedNodes.map(n => classifyError(n.error ?? ''));
    let dominantClass = this.getDominantClass(classifications);
    let dominantStrategy = this.getDominantStrategy(classifications, dominantClass);
    let llmContext = '';

    // If ALL retries exhausted for all failed nodes, force abort. Steps that
    // change something have no retries, so one failure exhausts them; a call
    // refused before it ran is not counted, so it can still be replanned.
    const allExhausted = failedNodes.every(
      n => n.retryCount >= n.maxRetries && !REFUSED_BEFORE_RUNNING.test(n.error ?? ''),
    );

    // ── LLM FALLBACK: diagnose unknown failures intelligently ──────────────
    // Not once retries are spent: the strategy is forced to abort then, so the
    // diagnosis cost an LLM request (and seconds) for an answer thrown away.
    if (dominantClass === 'unknown' && !allExhausted) {
      console.log('[Reflection] 🤔 Unknown failure class — invoking LLM diagnosis...');
      const diagnosis = await llmDiagnoseFailure(failedNodes, graph.goal);
      dominantClass = diagnosis.class;
      dominantStrategy = diagnosis.strategy;
      llmContext = diagnosis.context;
      console.log(`[Reflection] 🧠 LLM diagnosis: class=${dominantClass}, strategy=${dominantStrategy}`);
      if (llmContext) console.log(`[Reflection]    Context: ${llmContext}`);
    }

    // Partial success (some nodes done, some failed)
    const outcome: TaskOutcome = succeededNodes.length > 0 ? 'partial' : 'failure';

    // ── ANALYZE + DECIDE ───────────────────────────────────────────────────

    const effectiveStrategy = allExhausted ? 'abort' : dominantStrategy;

    // Build human-readable summary
    const failureSummary = failedNodes
      .map(n => `  - ${n.tool} [${n.id}]: ${n.error?.substring(0, 120) ?? 'unknown error'}`)
      .join('\n');

    const summary = [
      `${outcome === 'partial' ? 'Partial success' : 'All tasks failed'}: ` +
        `${succeededNodes.length}/${allNodes.length} nodes completed.`,
      `Failure class: ${dominantClass}`,
      `Repair strategy: ${effectiveStrategy}`,
      llmContext ? `LLM diagnosis: ${llmContext}` : '',
      `Failed nodes:\n${failureSummary}`,
    ].filter(Boolean).join('\n');

    console.log(`[Reflection] 📋 ${summary}`);

    // Repair args based on strategy — inject LLM context into replan
    const repairArgs = this.buildRepairArgs(effectiveStrategy, failedNodes, graph, llmContext);

    const result = this.buildResult({
      outcome,
      failedNodes,
      succeededNodes,
      failureClass: dominantClass,
      repairStrategy: effectiveStrategy,
      repairArgs,
      summary,
      shouldSpeak: effectiveStrategy === 'abort',
      voiceMessage: effectiveStrategy === 'abort'
        ? this.refusalVoiceMessage(failedNodes) ?? this.buildFailureVoiceMessage(graph.goal, dominantClass, failedNodes)
        : undefined,
    });

    this.recordEpisode(graph.goal, result, memory);
    return result;
  }

  // ── Repair Strategy Helpers ───────────────────────────────────────────────

  private buildRepairArgs(
    strategy: RepairStrategy,
    failedNodes: TaskNode[],
    graph: TaskGraph,
    llmContext = ''
  ): Record<string, unknown> {
    switch (strategy) {
      case 'retry_same':
        return {
          nodeIds: failedNodes.map(n => n.id),
          resetStatus: true,
        };

      case 'retry_with_delay':
        return {
          nodeIds: failedNodes.map(n => n.id),
          delayMs: 3000,
          resetStatus: true,
        };

      case 'fallback_tool':
        return {
          nodeIds: failedNodes.map(n => n.id),
          useFallback: true,
        };

      case 'replan': {
        const baseContext = `Previously failed tools: ${failedNodes.map(n => n.tool).join(', ')}. ` +
          `Errors: ${failedNodes.map(n => n.error?.substring(0, 100)).join('; ')}`;
        return {
          goal: graph.goal,
          failedTools: failedNodes.map(n => n.tool),
          context: llmContext ? `${baseContext} Diagnosis: ${llmContext}` : baseContext,
        };
      }

      case 'abort':
        return { reason: 'max_retries_exceeded_or_unrecoverable' };

      default:
        return {};
    }
  }

  /**
   * Reset failed nodes so the TaskGraphEngine can re-execute them.
   */
  resetFailedNodes(graph: TaskGraph, nodeIds: string[]): void {
    for (const id of nodeIds) {
      const node = graph.nodes.get(id);
      if (node && node.status === 'failed') {
        node.status = 'pending';
        node.error = undefined;
        console.log(`[Reflection] ♻️  Reset node "${id}" for retry`);
      }
    }
    // Reset graph status so execution loop can continue
    graph.status = 'running';
    graph.completedAt = undefined;
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private getDominantClass(
    classifications: Array<{ class: FailureClass; strategy: RepairStrategy }>
  ): FailureClass {
    const counts = new Map<FailureClass, number>();
    for (const c of classifications) {
      counts.set(c.class, (counts.get(c.class) ?? 0) + 1);
    }
    let max = 0;
    let dominant: FailureClass = 'unknown';
    for (const [cls, count] of counts) {
      if (count > max) { max = count; dominant = cls; }
    }
    return dominant;
  }

  private getDominantStrategy(
    classifications: Array<{ class: FailureClass; strategy: RepairStrategy }>,
    dominantClass: FailureClass
  ): RepairStrategy {
    // Priority order: abort > replan > fallback_tool > retry_with_delay > retry_same
    const PRIORITY: RepairStrategy[] = ['abort', 'replan', 'fallback_tool', 'retry_with_delay', 'retry_same', 'none'];
    const strategies = classifications
      .filter(c => c.class === dominantClass)
      .map(c => c.strategy);

    for (const p of PRIORITY) {
      if (strategies.includes(p)) return p;
    }
    return 'retry_same';
  }

  private buildResult(params: {
    outcome: TaskOutcome;
    failedNodes: TaskNode[];
    succeededNodes: TaskNode[];
    failureClass?: FailureClass;
    repairStrategy: RepairStrategy;
    repairArgs?: Record<string, unknown>;
    summary: string;
    shouldSpeak: boolean;
    voiceMessage?: string;
  }): ReflectionResult {
    return {
      outcome: params.outcome,
      failedNodes: params.failedNodes,
      succeededNodes: params.succeededNodes,
      failureClass: params.failureClass,
      repairStrategy: params.repairStrategy,
      repairArgs: params.repairArgs,
      summary: params.summary,
      shouldSpeak: params.shouldSpeak,
      voiceMessage: params.voiceMessage,
    };
  }

  private buildSuccessVoiceMessage(goal: string, outputs: string): string {
    const hasOutput = outputs.length > 0;
    if (hasOutput && outputs.length < 150) {
      return outputs;
    }
    return `I have completed the task successfully, sir.`;
  }

  /**
   * A refusal the user can act on, said plainly: a permission level ("needs
   * full control mode") or a tool's own reason (not on the open_app
   * allow-list, nothing open to close, no such window). Undefined otherwise.
   */
  private refusalVoiceMessage(failedNodes: TaskNode[]): string | undefined {
    const failedCheck = failedNodes.find(n => (n.error ?? '').startsWith('VERIFICATION_FAILED'));
    if (failedCheck) return verificationFailedReply(failedCheck.error ?? '');
    const reasons = failedNodes.map(n => (n.error ?? '').replace(/^(RISK_REFUSED|APPROVAL_DENIED|RATE_LIMITED):\s*/, ''));
    if (failedNodes.some(n => (n.error ?? '').startsWith('APPROVAL_DENIED'))) return APPROVAL_DENIED_REPLY;
    if (failedNodes.some(n => (n.error ?? '').startsWith('RATE_LIMITED'))) return RATE_LIMITED_REPLY;
    if (reasons.some(isPermissionDenial)) return FULL_CONTROL_HINT;
    const reason = reasons.find(r => /allowlist|policy|no open application|no process found|window matching .* not found|no active window/i.test(r));
    return reason && reason.length <= 160 ? `I couldn't do that, sir. ${reason.replace(/^Refused by safety policy:\s*/, '')}` : undefined;
  }

  /**
   * Spoken when the task is abandoned. The old wording promised a retry or "an
   * alternative approach" that never came; this says it stopped, and why when
   * the reason is short enough to say.
   */
  private buildFailureVoiceMessage(goal: string, failureClass: FailureClass, failedNodes: TaskNode[] = []): string {
    const messages: Record<FailureClass, string> = {
      network_error:  `I couldn't reach a service I needed, sir.`,
      plan_error:     `I couldn't work out how to do that, sir.`,
      tool_error:     `One of my tools failed, sir.`,
      context_error:  `I'm missing something I need to do that, sir.`,
      abort_error:    `Task aborted as requested, sir.`,
      unknown:        `I encountered an unexpected error and have been unable to complete the task, sir.`,
    };
    const base = messages[failureClass] ?? messages.unknown;
    if (failureClass === 'abort_error') return base;
    const reason = (failedNodes[0]?.error ?? '').split('\n')[0]!.replace(/^Error:\s*/i, '').trim();
    return reason && reason.length <= 120 ? `${base} ${reason}` : base;
  }

  private recordEpisode(
    goal: string,
    result: ReflectionResult,
    memory: AgentMemory
  ): void {
    const type = result.outcome === 'success' ? 'task_complete' :
                 result.outcome === 'partial'  ? 'reflection' : 'task_failed';

    const importance = result.outcome === 'success' ? 4 :
                       result.outcome === 'partial'  ? 6 : 8;

    memory.pushEpisode(type, `[${result.outcome.toUpperCase()}] ${goal}: ${result.summary.substring(0, 200)}`, {
      goal,
      outcome: result.outcome,
      failureClass: result.failureClass,
      repairStrategy: result.repairStrategy,
      failedCount: result.failedNodes.length,
      succeededCount: result.succeededNodes.length,
    }, importance);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const reflectionEngine = new ReflectionEngine();
