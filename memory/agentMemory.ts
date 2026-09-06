/**
 * memory/agentMemory.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-layer memory system for the autonomous agent loop.
 *
 * Layers:
 *   1. WorkingMemory  — current task context (cleared per task)
 *   2. EpisodicMemory — timestamped event log (auto-compressed after 100 entries)
 *   3. SemanticMemory — delegates to memoryManager (long-term facts + vector search)
 *   4. CacheLayer     — fast in-memory TTL cache for repeated lookups
 *
 * Does NOT replace memoryManager. It wraps and extends it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { memoryManager } from './memoryManager.js';
import { getWorkspaceRoot } from '../core/workspaceRoot.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EpisodeType =
  | 'task_start'
  | 'task_complete'
  | 'task_failed'
  | 'tool_used'
  | 'tool_failed'
  | 'reflection'
  | 'repair'
  | 'user_input'
  | 'system_event';

export interface Episode {
  id: string;
  timestamp: number;
  type: EpisodeType;
  summary: string;
  data?: Record<string, unknown>;
  importance: number; // 1-10
}

export interface WorkingContext {
  taskId: string;
  goal: string;
  startedAt: number;
  toolResults: Record<string, string>;  // nodeId -> result
  observations: string[];
  iteration: number;
  metadata: Record<string, unknown>;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

// ─── Agent Memory ─────────────────────────────────────────────────────────────

export class AgentMemory {
  // ── Layer 1: Working Memory ───────────────────────────────────────────────
  private _workingContext: WorkingContext | null = null;

  setWorkingContext(ctx: WorkingContext): void {
    this._workingContext = ctx;
  }

  getWorkingContext(): WorkingContext | null {
    return this._workingContext;
  }

  updateWorkingContext(update: Partial<WorkingContext>): void {
    if (!this._workingContext) return;
    this._workingContext = { ...this._workingContext, ...update };
  }

  addToolResult(nodeId: string, result: string): void {
    if (!this._workingContext) return;
    this._workingContext.toolResults[nodeId] = result;
  }

  addObservation(observation: string): void {
    if (!this._workingContext) return;
    this._workingContext.observations.push(observation);
  }

  clearWorkingContext(): void {
    this._workingContext = null;
  }

  // ── Layer 2: Episodic Memory ─────────────────────────────────────────────
  private episodes: Episode[] = [];
  private readonly MAX_EPISODES = 200;
  private readonly COMPRESS_THRESHOLD = 100;

  /**
   * Episodes were RAM-only: every restart discarded the agent's entire record
   * of what it had done, including all failure episodes that reflection and
   * repair reason over (JARVIS-009). They are now appended to a JSONL log and
   * the most recent are reloaded on first use.
   *
   * The log is append-only and never rewritten from memory, so in-memory
   * pruning cannot delete history that is already on disk.
   */
  private episodesLoaded = false;
  private readonly EPISODE_LOG = path.join(getWorkspaceRoot(), 'data', 'episodes.jsonl');
  private readonly EPISODE_RELOAD_COUNT = 200;

  /** Load recent episodes from disk once, lazily. Never throws. */
  private loadEpisodesOnce(): void {
    if (this.episodesLoaded) return;
    this.episodesLoaded = true;
    try {
      if (!fs.existsSync(this.EPISODE_LOG)) return;
      const lines = fs.readFileSync(this.EPISODE_LOG, 'utf-8').split('\n');
      const recent = lines.slice(-this.EPISODE_RELOAD_COUNT);
      const restored: Episode[] = [];
      for (const line of recent) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Episode;
          // A truncated final line from an interrupted write is skipped rather
          // than aborting the whole restore.
          if (parsed && typeof parsed.id === 'string' && typeof parsed.timestamp === 'number') {
            restored.push(parsed);
          }
        } catch {
          // Ignore an unparseable line and keep the rest.
        }
      }
      this.episodes = [...restored, ...this.episodes];
      console.log(`[AgentMemory] Restored ${restored.length} episode(s) from disk.`);
    } catch (err) {
      console.warn('[AgentMemory] Episode restore failed (continuing empty):', err);
    }
  }

  /** Append one episode to the JSONL log. Never throws. */
  private appendEpisodeToDisk(episode: Episode): void {
    try {
      fs.mkdirSync(path.dirname(this.EPISODE_LOG), { recursive: true });
      fs.appendFileSync(this.EPISODE_LOG, `${JSON.stringify(episode)}\n`, 'utf-8');
    } catch (err) {
      console.warn('[AgentMemory] Episode persist failed (kept in memory):', err);
    }
  }

  /** Episodes currently held in memory, restoring from disk on first access. */
  getEpisodeCount(): number {
    this.loadEpisodesOnce();
    return this.episodes.length;
  }

  pushEpisode(
    type: EpisodeType,
    summary: string,
    data?: Record<string, unknown>,
    importance = 5
  ): Episode {
    const episode: Episode = {
      id: `ep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      type,
      summary,
      data,
      importance,
    };

    this.loadEpisodesOnce();
    this.episodes.push(episode);
    this.appendEpisodeToDisk(episode);

    // Auto-compress when threshold exceeded. This prunes the in-memory working
    // set only — the on-disk log keeps the full history.
    if (this.episodes.length >= this.MAX_EPISODES) {
      this.pruneOldEpisodes();
    }

    return episode;
  }

  getRecentEpisodes(limit = 20): Episode[] {
    return this.episodes.slice(-limit);
  }

  getEpisodesByType(type: EpisodeType, limit = 10): Episode[] {
    return this.episodes
      .filter(e => e.type === type)
      .slice(-limit);
  }

  getHighImportanceEpisodes(minImportance = 7, limit = 10): Episode[] {
    return this.episodes
      .filter(e => e.importance >= minImportance)
      .slice(-limit);
  }

  /**
   * Remove oldest/lowest-importance episodes when over limit.
   * Keeps the most recent COMPRESS_THRESHOLD episodes and
   * all episodes with importance >= 8.
   */
  private pruneOldEpisodes(): void {
    const critical = this.episodes.filter(e => e.importance >= 8);
    const recent = this.episodes.slice(-this.COMPRESS_THRESHOLD);

    // Merge and deduplicate
    const keepIds = new Set([
      ...critical.map(e => e.id),
      ...recent.map(e => e.id),
    ]);

    const before = this.episodes.length;
    this.episodes = this.episodes.filter(e => keepIds.has(e.id));
    console.log(`[AgentMemory] Pruned episodic memory: ${before} → ${this.episodes.length} episodes`);
  }

  // ── Layer 3: Semantic Memory (delegates to memoryManager) ────────────────

  async rememberFact(fact: string, importance = 5, source = 'agent'): Promise<void> {
    await memoryManager.rememberFact(fact, source, importance);
  }

  async recallRelevant(query: string, topK = 5): Promise<string[]> {
    try {
      const facts = await memoryManager.searchFacts(query, topK);
      return facts.map(f => f.fact);
    } catch (err) {
      console.error('[AgentMemory] Semantic recall failed:', err);
      return [];
    }
  }

  getConversationHistory(limit = 10): { role: string; content: string }[] {
    return memoryManager.getConversationHistory(limit);
  }

  async addConversationMessage(
    role: 'user' | 'assistant' | 'system',
    content: string
  ): Promise<void> {
    await memoryManager.addMessage(role, content);
  }

  buildSemanticSummary(): string {
    return memoryManager.buildContextSummary();
  }

  // ── Layer 4: Cache ────────────────────────────────────────────────────────
  private cache = new Map<string, CacheEntry>();
  private readonly DEFAULT_TTL_SECONDS = 300; // 5 minutes

  cacheSet(key: string, value: string, ttlSeconds = this.DEFAULT_TTL_SECONDS): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  cacheGet(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  cacheClear(): void {
    this.cache.clear();
  }

  cacheDelete(key: string): void {
    this.cache.delete(key);
  }

  // ── Context Builder ───────────────────────────────────────────────────────

  /**
   * Assembles the full memory context string to inject into LLM system prompt.
   * Combines: working context + recent episodes + semantic summary.
   */
  buildFullContext(): string {
    const parts: string[] = [];

    // Working context
    if (this._workingContext) {
      const ctx = this._workingContext;
      parts.push([
        `## Current Task`,
        `Goal: ${ctx.goal}`,
        `Iteration: ${ctx.iteration}`,
        ctx.observations.length > 0
          ? `Observations:\n${ctx.observations.map(o => `  - ${o}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n'));
    }

    // Recent high-importance episodes
    const importantEpisodes = this.getHighImportanceEpisodes(6, 5);
    if (importantEpisodes.length > 0) {
      parts.push([
        `## Notable Recent Events`,
        ...importantEpisodes.map(e =>
          `[${new Date(e.timestamp).toISOString()}] ${e.type}: ${e.summary}`
        ),
      ].join('\n'));
    }

    // Semantic memory summary
    const semantic = this.buildSemanticSummary();
    if (semantic && semantic !== 'No long-term facts stored yet.') {
      parts.push(`## Long-Term Memory\n${semantic}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : '';
  }

  /**
   * Summarize all working context tool results for reflection.
   */
  getTaskResultSummary(): string {
    if (!this._workingContext) return 'No active task.';
    const { goal, toolResults, observations } = this._workingContext;
    const resultLines = Object.entries(toolResults)
      .map(([nodeId, result]) => `  ${nodeId}: ${result.substring(0, 200)}`)
      .join('\n');

    return [
      `Goal: ${goal}`,
      `Tool Results:\n${resultLines || '  (none)'}`,
      observations.length > 0
        ? `Observations:\n${observations.map(o => `  - ${o}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n');
  }

  getStats(): Record<string, unknown> {
    return {
      hasWorkingContext: this._workingContext !== null,
      episodeCount: this.episodes.length,
      cacheSize: this.cache.size,
      memoryStats: memoryManager.getStats(),
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const agentMemory = new AgentMemory();
