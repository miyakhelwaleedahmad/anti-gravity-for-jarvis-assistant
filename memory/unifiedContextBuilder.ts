/**
 * memory/unifiedContextBuilder.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Combines short-term, long-term, graph, and system context for LLM planning.
 *
 * Phase 3 additions:
 *   - Priority memory selection: facts are sorted by composite score
 *     (importance × recency × access frequency) before section budget is applied.
 *   - Context compression scoring: each section reports its token estimate;
 *     total context size is bounded by TOTAL_CONTEXT_BUDGET tokens.
 *   - Adaptive context building: the budget is split between STM/LTM/Graph
 *     based on what's available and what the query type needs.
 *     Heavy queries (tool use, planning) get more LTM; simple queries get more STM.
 *   - Fast retrieval: LRU-cached contexts survive for 30s to absorb repeated calls.
 *   - Redis-backed: STM reads from Redis if available, falls back to in-memory.
 */

import { memoryManager } from './memoryManager.js';
import { graphMemory } from './graphMemory.js';
import { getCachedRecentMessages } from './redisCache.js';
import { AdaptiveLruCache } from '../core/adaptiveRamManager.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UnifiedContext {
  shortTerm: string;
  longTermFacts: string;
  relationships: string;
  systemState: string;
  mergedContext: string;
  /** Diagnostic: section token estimates */
  tokenBudget?: {
    stm: number;
    ltm: number;
    graph: number;
    system: number;
    total: number;
    budget: number;
  };
}

export interface BuildContextOptions {
  /**
   * Include expensive LTM/graph memory (default: false for fast/simple queries)
   * Set to true for planning, tool selection, and multi-step reasoning.
   */
  includeHeavy?: boolean;
  /**
   * Hint about query complexity. Affects how the budget is split:
   *   'fast'     — 60% STM, 20% LTM, 20% graph   (low-latency queries)
   *   'balanced' — 50% STM, 30% LTM, 20% graph   (default)
   *   'deep'     — 30% STM, 50% LTM, 20% graph   (planning, research)
   */
  depthHint?: 'fast' | 'balanced' | 'deep';
  /**
   * Override the total context token budget (default: TOTAL_CONTEXT_BUDGET).
   */
  budgetOverride?: number;
}

// ─── Budget constants ─────────────────────────────────────────────────────────

/** Total context budget in approximate tokens (1 token ≈ 4 chars) */
const TOTAL_CONTEXT_BUDGET = 2400;

/** Minimum guaranteed allocation per non-empty section (tokens) */
const MIN_SECTION_TOKENS = 80;

/** Budget split profiles [stm%, ltm%, graph%] */
const BUDGET_PROFILES: Record<NonNullable<BuildContextOptions['depthHint']>, [number, number, number]> = {
  fast:     [0.65, 0.20, 0.15],
  balanced: [0.50, 0.30, 0.20],
  deep:     [0.30, 0.55, 0.15],
};

// ─── UnifiedContextBuilder ────────────────────────────────────────────────────

export class UnifiedContextBuilder {
  /** L2: 60s TTL, 100 slot LRU — survives inter-request gaps */
  private cache = new AdaptiveLruCache<string, UnifiedContext>(100, 60_000, 'uctx');
  /** L1: 5s TTL, 32 slot hot cache — absorbs burst calls within one turn */
  private hotCache = new AdaptiveLruCache<string, UnifiedContext>(32, 5_000, 'uctx-hot');

  async buildContext(
    query: string,
    sessionId: string,
    options: BuildContextOptions = {},
  ): Promise<UnifiedContext> {
    const totalStart = performance.now();
    const includeHeavy = options.includeHeavy ?? false;
    const depthHint    = options.depthHint ?? 'balanced';
    const budget       = options.budgetOverride ?? TOTAL_CONTEXT_BUDGET;
    const cacheKey     = this._getCacheKey(query, sessionId, includeHeavy, depthHint);

    const hit = this.hotCache.get(cacheKey) ?? this.cache.get(cacheKey);
    if (hit) {
      console.log(`[UnifiedContext] ⚡ Cache hit total=${(performance.now() - totalStart).toFixed(1)}ms heavy=${includeHeavy}`);
      return hit;
    }

    console.log(`[UnifiedContext] Building context heavy=${includeHeavy} depth=${depthHint} budget=${budget}tok [PARALLEL]`);

    // ── Compute adaptive budget splits ───────────────────────────────────────
    const [stmPct, ltmPct, graphPct] = BUDGET_PROFILES[depthHint];
    const stmBudget   = Math.max(MIN_SECTION_TOKENS, Math.floor(budget * stmPct));
    const ltmBudget   = Math.max(MIN_SECTION_TOKENS, Math.floor(budget * ltmPct));
    const graphBudget = Math.max(MIN_SECTION_TOKENS, Math.floor(budget * graphPct));

    const parallelStart = performance.now();

    // ── Parallel fetch all memory sources ────────────────────────────────────
    const [stmRaw, longTermStr, relationshipsStr] = await Promise.all([

      // 1. Short-term memory (Redis-backed, falls back to in-memory buffer)
      (async (): Promise<any[]> => {
        const cached = await getCachedRecentMessages(sessionId);
        if (cached && cached.length > 0) return cached;
        return memoryManager.getShortTerm(12); // slightly more for better STM coverage
      })(),

      // 2. Long-term vector memory (only on heavy/planning queries)
      includeHeavy
        ? memoryManager.retrieveForPlanning(query, depthHint === 'deep' ? 8 : 5).catch(() => '')
        : Promise.resolve(''),

      // 3. Graph memory — only when heavy and Neo4j is available
      (async (): Promise<string> => {
        if (!includeHeavy || !graphMemory.isAvailable()) return '';
        try {
          const edges = await graphMemory.queryGraph(`
            MATCH (u:User {id: $sessionId})-[r]->(n)
            RETURN type(r) as relation, n.name as target
            LIMIT 8
          `, { sessionId });
          if (edges && edges.length > 0) {
            return edges.map((e: any) => `- User ${e.relation} ${e.target}`).join('\n');
          }
        } catch (err) {
          console.warn('[UnifiedContext] Neo4j graph retrieval failed:', err);
        }
        return '';
      })(),
    ]);

    const parallelMs = performance.now() - parallelStart;

    // ── Priority memory selection: sort STM by recency, LTM already ranked ───
    const stm = stmRaw as any[];
    const formattedStm = stm
      .slice(-Math.ceil(stmBudget / 60)) // rough msg count estimate
      .map((m: any) => `[${m.role}] ${m.content}`)
      .join('\n');

    // ── Apply adaptive section budgets ────────────────────────────────────────
    const shortTermStr  = _enforceBudget(formattedStm, stmBudget);
    const trimmedLtm    = _enforceBudget(longTermStr as string,    ltmBudget);
    const trimmedGraph  = _enforceBudget(relationshipsStr as string, graphBudget);

    // ── Compute token estimates for diagnostics ───────────────────────────────
    const systemStateStr = _buildSystemState(depthHint, budget);
    const tokenEst = {
      stm:    _estimateTokens(shortTermStr),
      ltm:    _estimateTokens(trimmedLtm),
      graph:  _estimateTokens(trimmedGraph),
      system: _estimateTokens(systemStateStr),
      get total() { return this.stm + this.ltm + this.graph + this.system; },
      budget,
    };

    const mergedContext = `
=== UNIFIED MEMORY CONTEXT ===

${systemStateStr}

[SHORT-TERM MEMORY]
${shortTermStr || 'No recent context.'}

[LONG-TERM FACTS]
${trimmedLtm || (includeHeavy ? 'No relevant facts found.' : 'Skipped (fast/simple query).')}

[GRAPH RELATIONSHIPS]
${trimmedGraph || (includeHeavy ? 'No explicit relationships found.' : 'Skipped (fast/simple query).')}

[CONTEXT BUDGET]
STM: ${tokenEst.stm}tok | LTM: ${tokenEst.ltm}tok | Graph: ${tokenEst.graph}tok | Total: ${tokenEst.total}/${budget}tok
==============================
    `.trim();

    const context: UnifiedContext = {
      shortTerm:    shortTermStr,
      longTermFacts: trimmedLtm,
      relationships: trimmedGraph,
      systemState:   systemStateStr,
      mergedContext,
      tokenBudget:   tokenEst,
    };

    this.hotCache.set(cacheKey, context, 5_000);
    this.cache.set(cacheKey, context);

    console.log(
      `[UnifiedContext] parallel=${parallelMs.toFixed(1)}ms total=${(performance.now() - totalStart).toFixed(1)}ms ` +
      `heavy=${includeHeavy} depth=${depthHint} tokens=${tokenEst.total}/${budget}`,
    );

    return context;
  }

  /** Invalidate the LRU cache for a session (call after every memory write) */
  invalidateSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    const l2 = this.cache.deleteByPrefix(prefix);
    const l1 = this.hotCache.deleteByPrefix(prefix);
    if (l2 + l1 > 0) {
      console.log(`[UnifiedContext] Session cache invalidated: ${l2 + l1} entry(ies) removed for "${sessionId}"`);
    }
  }

  private _getCacheKey(query: string, sessionId: string, heavy: boolean, depth: string): string {
    const normalized = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return `${sessionId}::${heavy ? 'heavy' : 'light'}::${depth}::${normalized}`;
  }
}

export const unifiedContextBuilder = new UnifiedContextBuilder();

// ─── Private helpers ──────────────────────────────────────────────────────────

function _enforceBudget(text: string, maxTokens: number): string {
  if (!text) return '';
  const maxChars = maxTokens * 4;
  return text.length > maxChars ? text.substring(0, maxChars) + '... [TRUNCATED]' : text;
}

function _estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}

function _buildSystemState(depth: string, budget: number): string {
  // Phase 7: minimal system state — trimmed from 6 lines to 3 to save ~40 tokens per request
  const now = new Date();
  return `[SYS t=${now.toISOString().slice(11, 19)} depth=${depth} budget=${budget}tok]`;
}
