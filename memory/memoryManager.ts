/**
 * memory/memoryManager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages short-term (conversation) and long-term (fact) memory.
 *
 * Phase 1 UPGRADES (memory-driven planning):
 *   - LongTermFact: added `lastAccessed` timestamp + `accessCount`
 *   - searchFacts(): boosts importance of retrieved facts (reinforcement)
 *   - decayMemory(): scheduled decay — lowers importance of stale facts
 *   - retrieveForPlanning(): rich scoring combining importance + recency + query
 *     relevance; returns formatted string ready for LLM system prompt injection
 *
 * Original fixes preserved:
 *   - db.write() debounced at 500ms
 *   - Multi-token scoring in searchFacts()
 */

import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";
import { memoryConfig } from "../config/llmconfig.js";
import { pipelineRegistry } from "../self_healing/pipelineRegistry.js";
import { spawn, ChildProcess } from "child_process";
import * as readline from "readline";
import { graphMemory } from "./graphMemory.js";
import {
  initRedis,
  cacheVectorResult,
  getCachedVectorResult,
  invalidateVectorCache,
  invalidateContextCache,
  cacheRecentMessages,
  getCachedRecentMessages,
  cacheEmbedding,
  getCachedEmbedding
} from "./redisCache.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  tags?: string[] | undefined;
}

export interface LongTermFact {
  id: string;
  fact: string;
  source: string;
  timestamp: number;
  importance: number;     // 1–10 — dynamically adjusted by decay/reinforcement
  // ── PHASE 1: memory scoring fields ───────────────────────────────────────
  lastAccessed: number;  // epoch ms — updated each time fact is retrieved
  accessCount: number;   // total retrieval count — used in importance boost
  // ── PHASE 2: Conflict Resolution ───────────────────────────────────────
  confidence: number;    // 0.0 to 1.0 — confidence in this fact
  version: number;       // increments on updates/merges
}

interface MemoryDB {
  shortTerm: MemoryEntry[];
  longTerm: LongTermFact[];
  sessionId: string;
  sessionSummary: string | null;
}

// ─── Memory Manager ───────────────────────────────────────────────────────────

export class MemoryManager {
  private db!: Low<MemoryDB>;
  private initialized = false;

  /** Debounce timer for db.write() */
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly WRITE_DEBOUNCE_MS = Number(process.env.JARVIS_MEMORY_WRITE_DEBOUNCE_MS ?? 2000);

  // FIX-2: Write-through STM buffer.
  // addMessage() writes here synchronously so getShortTerm() is always current.
  // scheduledWrite() still debounces the disk I/O — no change to I/O cost.
  private shortTermBuffer: MemoryEntry[] = [];

  // Vector Memory Process
  private vectorProc: ChildProcess | null = null;
  private vectorApiFails = 0;
  private vectorApiCircuitOpen = false;
  private initPromise: Promise<void> | null = null;

  public get isVectorCircuitOpen(): boolean {
    return this.vectorApiCircuitOpen;
  }

  /**
   * STARTUP-RACE-FIX: Lazy-loaded reference to the VectorMemorySupervisor.
   * Uses dynamic import to avoid circular dependency (supervisor imports memoryManager).
   * Once resolved, the reference is cached for all subsequent calls.
   */
  private _supervisorRef: { isStartupReady: () => boolean; waitUntilReady: (ms?: number) => Promise<boolean> } | null = null;
  private _supervisorLoading: Promise<void> | null = null;

  private async getSupervisor(): Promise<typeof this._supervisorRef> {
    if (this._supervisorRef) return this._supervisorRef;
    if (!this._supervisorLoading) {
      this._supervisorLoading = import('./vectorMemorySupervisor.js').then(mod => {
        this._supervisorRef = mod.vectorMemorySupervisor;
      }).catch(() => {
        // If import fails, supervisor is unavailable — that's OK
        this._supervisorRef = null;
      });
    }
    await this._supervisorLoading;
    return this._supervisorRef;
  }

  async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    if (this.initialized) {
      console.log("[Memory] Already initialized. Skipping duplicate init().");
      return;
    }

    const dbPath = path.resolve(memoryConfig.dbPath);
    const adapter = new JSONFile<MemoryDB>(dbPath);

    this.db = new Low<MemoryDB>(adapter, {
      shortTerm: [],
      longTerm: [],
      sessionId: this.generateId(),
      sessionSummary: null,
    });

    await this.db.read();

    this.db.data.shortTerm ??= [];
    this.db.data.longTerm ??= [];
    this.db.data.sessionId ??= this.generateId();
    this.db.data.sessionSummary ??= null;

    this.shortTermBuffer = [...this.db.data.shortTerm];
    await this.db.write();
    this.initialized = true;

    initRedis();

    if (this.db.data.longTerm.length > 0) {
      this.rebuildVectorIndexInBackground();
    }

    console.log("[Memory] Initialized. Short-term:", this.db.data.shortTerm.length, "Long-term:", this.db.data.longTerm.length);
  }

  /** Timestamp of manager initialization — used for circuit breaker grace period. */
  private readonly _initTime = Date.now();
  /**
   * Grace period after startup during which vector API failures do NOT open
   * the circuit breaker. The Python FastAPI server needs ~15s to load the
   * sentence-transformer model; failures during this window are expected.
   * BUG-FIX (2026-07-17): Previously the circuit opened in the first 15s,
   * then stayed closed for 60s, silently blocking all vector operations.
   */
  private readonly VECTOR_STARTUP_GRACE_MS = 25_000; // 25s — model loads in ~15s

  private async vectorRequest(action: string, payload: any): Promise<any> {
    if (this.vectorApiCircuitOpen) {
      throw new Error("Vector API circuit breaker open");
    }

    // ── Tuned constants ──────────────────────────────────────────────────────
    // Embedding/search can take 1-3s on cold paths or large text.
    // Health/stats probes should respond in <1s.
    const isProbe = action === 'stats' || action === 'health' || action === 'liveness';
    const REQUEST_TIMEOUT_MS = isProbe ? 2_000 : 5_000;
    const MAX_RETRIES = 1;             // total attempts: 1 primary + 1 retry
    const RETRY_BACKOFF_MS  = 200;     // 200ms between attempts
    const CIRCUIT_FAIL_THRESHOLD = 3;  // open after 3 consecutive CONNECTION failures

    // Check if we are still within the startup grace period.
    const isStartupGrace = (Date.now() - this._initTime) < this.VECTOR_STARTUP_GRACE_MS;

    // STARTUP-RACE-FIX: During startup grace period, check if the supervisor
    // has confirmed the Vector API is ready. If not, DON'T attempt the HTTP
    // request — it will hit ECONNREFUSED and increment vectorApiFails, which
    // can trip the circuit breaker before the server finishes loading.
    if (isStartupGrace) {
      const supervisor = await this.getSupervisor();
      if (supervisor && !supervisor.isStartupReady()) {
        throw new Error(
          'Vector API not ready yet (startup synchronisation gate). ' +
          'The supervisor will notify when the service is healthy.'
        );
      }
    }

    const isGet = action === 'stats' || action === 'health' || action === 'liveness';

    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        
        const response = await fetch(`http://127.0.0.1:8000/${action}`, {
          method: isGet ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Connection keep-alive — Node.js reuses the underlying TCP socket
            // instead of creating a new connection per request. Eliminates ~30ms
            // per-request overhead and prevents ephemeral port exhaustion on Windows.
            'Connection': 'keep-alive',
          },
          body: isGet ? undefined : JSON.stringify(payload),
          signal: controller.signal,
          // Enable Node.js built-in connection pooling via keepalive
          keepalive: true,
        });
        
        clearTimeout(timeout);
        
        if (!response.ok) {
          const text = await response.text();
          const err = new Error(`HTTP Error ${response.status}: ${text}`);
          if (response.status === 503) {
            // 503 means the server IS alive but the model is still loading.
            // This is NOT a connection failure — do NOT count toward circuit breaker.
            (err as any).noRetry = true;
            (err as any).isServiceUnavailable = true;
          } else if (response.status === 504) {
            // 504 = server-side timeout (our FastAPI middleware). Retryable.
            (err as any).isTimeout = true;
          }
          throw err;
        }
        
        // Success — reset consecutive failure counter
        this.vectorApiFails = 0;
        return await response.json();
      } catch (err) {
        attempt++;

        // ── Error Classification ──────────────────────────────────────────
        // Only CONNECTION-level failures (ECONNREFUSED, DNS, socket reset)
        // should count toward the circuit breaker threshold.
        // Timeouts, 503s, and 504s indicate the server IS alive but busy/loading.
        const errMsg = (err as Error).message ?? '';
        const isAbortTimeout = (err as Error).name === 'AbortError' || errMsg.includes('aborted');
        const is503 = (err as any).isServiceUnavailable === true;
        const is504 = (err as any).isTimeout === true;
        const isConnectionFailure = !isAbortTimeout && !is503 && !is504;

        if (isStartupGrace) {
          // During grace period: log at debug level, never trip circuit breaker.
          console.log(`[Memory] Vector request failed during startup grace (attempt ${attempt}): ${errMsg}`);
        } else {
          // Only increment failure counter for real connection failures
          if (isConnectionFailure) {
            this.vectorApiFails++;
            console.warn(`[Memory] Vector connection failure (attempt ${attempt}, fails=${this.vectorApiFails}):`, errMsg);
          } else if (isAbortTimeout) {
            console.warn(`[Memory] Vector request timeout after ${REQUEST_TIMEOUT_MS}ms (attempt ${attempt}): ${action}`);
          } else if (is503) {
            console.log(`[Memory] Vector model not ready (503) — will not retry: ${action}`);
          } else {
            console.warn(`[Memory] Vector request error (attempt ${attempt}):`, errMsg);
          }

          // Open circuit breaker only on consecutive CONNECTION failures
          if (isConnectionFailure && this.vectorApiFails >= CIRCUIT_FAIL_THRESHOLD) {
            this.vectorApiCircuitOpen = true;
            console.error("[Memory] CRITICAL: Vector API circuit breaker opened!");
            // Auto-reset after 30s. Supervisor will also reset on recovery.
            setTimeout(() => {
              this.vectorApiCircuitOpen = false;
              this.vectorApiFails = 0;
              console.log("[Memory] Vector API circuit breaker auto-reset — will retry.");
            }, 30_000);
          }
        }

        // ── Retry Decision ────────────────────────────────────────────────
        // Do NOT retry: 503 (model loading — pointless to retry immediately)
        // DO retry: timeouts (transient), connection errors (may recover)
        if (attempt > MAX_RETRIES || (err as any).noRetry) throw err;
        await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
      }
    }
  }

  async embed(text: string): Promise<number[]> {
    const cached = await getCachedEmbedding(text);
    if (cached) {
      console.log(`[Memory] Redis cache hit for embedding: "${text.slice(0, 40)}"`);
      return cached;
    }
    const res = await this.vectorRequest('embed', { text });
    if (res?.embedding) {
      cacheEmbedding(text, res.embedding).catch(() => {});
    }
    return res.embedding;
  }

  async deleteVector(text: string): Promise<void> {
    try {
      const res = await this.vectorRequest('delete', { text });
      if (res?.error) {
        console.warn(`[Memory] Vector delete returned error: ${res.error}`);
      } else {
        console.log(`[Memory] Vector deleted: "${text.slice(0, 60)}" (remaining: ${res?.remaining ?? '?'})`);
      }
    } catch (err) {
      console.error(`[Memory] deleteVector failed: ${err}`);
    }
  }

  async searchVector(query: string, top_k: number = 3): Promise<any[]> {
    try {
      const res = await this.vectorRequest('search', { query, top_k });
      return res.results || [];
    } catch (err) {
      console.error("[Memory] Vector DB failed, semantic search bypassed.");
      return [];
    }
  }

  private async isVectorHealthy(): Promise<boolean> {
    if (this.vectorApiCircuitOpen) return false;
    try {
      // Use /health (not /stats) — /health returns 503 when the model isn't ready,
      // while /stats always returns 200 regardless of model state.
      const res = await this.vectorRequest('health', {});
      return res?.status === 'ready';
    } catch {
      return false;
    }
  }

  private rebuildVectorIndexInBackground(): void {
    const candidates = [...this.db.data.longTerm]
      .sort((a, b) => (b.importance - a.importance) || (b.timestamp - a.timestamp))
      .slice(0, 10);

    console.log(`[Memory] Scheduling capped vector rebuild for ${candidates.length}/${this.db.data.longTerm.length} facts.`);

    setTimeout(async () => {
      if (!(await this.isVectorHealthy())) {
        console.log('[Memory] Vector rebuild skipped: vector service unhealthy.');
        return;
      }

      let embedded = 0;
      let index = 0;
      const worker = async () => {
        while (index < candidates.length) {
          const fact = candidates[index++];
          try {
            await this.embed(fact.fact);
            embedded++;
          } catch {
            // Non-fatal. Circuit breaker handles repeated failures.
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, () => worker()));
      console.log(`[Memory] Vector rebuild summary: embedded ${embedded}/${candidates.length} selected facts.`);
    }, 500).unref?.();
  }

  private ensureInit(): void {
    if (!this.initialized) throw new Error("[Memory] Not initialized. Call init() first.");
  }

  /** OPT-VEC-2: Immediately reset the vector API circuit breaker.
   *  Called by VectorMemorySupervisor after confirming the server is healthy.
   *  Eliminates the 30s auto-reset lockout when the Python server recovers. */
  public resetVectorCircuit(): void {
    if (this.vectorApiCircuitOpen) {
      this.vectorApiCircuitOpen = false;
      this.vectorApiFails = 0;
      console.log('[Memory] OPT-VEC-2: Vector circuit breaker manually reset by supervisor.');
    }
  }


  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  // ─── Debounced Write ─────────────────────────────────────────────────────

  /**
   * Schedule a debounced write. Multiple rapid calls collapse into one write
   * that fires WRITE_DEBOUNCE_MS after the last call.
   * Returns a promise that resolves when the write actually completes.
   */
  private scheduledWrite(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.writeTimer) {
        clearTimeout(this.writeTimer);
      }
      this.writeTimer = setTimeout(async () => {
        this.writeTimer = null;
        try {
          await this.db.write();
          resolve();
        } catch (err) {
          pipelineRegistry.recordFailure("groq_to_memory", String(err));
          reject(err);
        }
      }, this.WRITE_DEBOUNCE_MS);
    });
  }

  // ─── Token Estimation ──────────────────────────────────────────────────
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  // ─── Short-Term Memory ──────────────────────────────────────────────────────

  async addMessage(role: MemoryEntry["role"], content: string, tags?: string[]): Promise<void> {
    this.ensureInit();

    const entry: MemoryEntry = {
      id: this.generateId(),
      role,
      content,
      timestamp: Date.now(),
      tags,
    };

    // FIX-2: Write-through — update the in-memory buffer immediately.
    // getShortTerm() reads from this buffer, so planPhase() always sees
    // the current message even before the 500ms debounce flushes to disk.
    this.shortTermBuffer.push(entry);
    this.db.data.shortTerm = this.shortTermBuffer;

    // REDIS: Cache the recent messages
    const sessionId = this.db.data.sessionId ?? "default";
    cacheRecentMessages(sessionId, this.shortTermBuffer).catch(() => {});
    invalidateContextCache(sessionId).catch(() => {});

    // Token-aware STM trimming & summarization compression
    const MAX_STM_TOKENS = 3000;
    
    let totalTokens = this.db.data.shortTerm.reduce((sum, msg) => sum + this.estimateTokens(msg.content), 0);
    
    if (totalTokens > MAX_STM_TOKENS) {
      // Find the oldest half to compress
      const cutoffIndex = Math.floor(this.db.data.shortTerm.length / 2);
      const toCompress = this.db.data.shortTerm.slice(0, cutoffIndex);
      
      // Keep the rest
      this.db.data.shortTerm = this.db.data.shortTerm.slice(cutoffIndex);
      
      // Basic summarization compression logic (in production, this can call an LLM)
      const textToCompress = toCompress.map(m => `[${m.role}] ${m.content}`).join("\n");
      const compressedSummary = `Summarized older context: ${textToCompress.slice(0, 500)}...`;
      
      this.db.data.sessionSummary = this.db.data.sessionSummary 
        ? this.db.data.sessionSummary + "\n" + compressedSummary
        : compressedSummary;
        
      console.log(`[Memory] Compressed ${toCompress.length} messages into sessionSummary due to token limits.`);
    }

    // FIX: Debounced write — does NOT block the caller for 500ms
    this.scheduledWrite().catch((err) => {
      console.error("[Memory] Debounced write failed:", err);
    });
  }

  getShortTerm(limit?: number): MemoryEntry[] {
    this.ensureInit();
    // FIX-2: Read from write-through buffer, not from db.data.shortTerm directly.
    // This ensures reads are never stale within the 500ms debounce window.
    return limit ? this.shortTermBuffer.slice(-limit) : [...this.shortTermBuffer];
  }

  getConversationHistory(limit = 10): { role: string; content: string }[] {
    return this.getShortTerm(limit).map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  async clearShortTerm(): Promise<void> {
    this.ensureInit();
    // FIX-2: Clear both the buffer and the db data together.
    this.shortTermBuffer = [];
    this.db.data.shortTerm = [];
    await this.db.write();
    const sessionId = this.db.data.sessionId ?? "default";
    invalidateContextCache(sessionId).catch(() => {});
    console.log("[Memory] Short-term memory cleared.");
  }

  // ─── Long-Term Memory ───────────────────────────────────────────────────────

  async rememberFact(fact: string, source = "conversation", importance = 5, confidence = 0.8): Promise<void> {
    this.ensureInit();

    const cleanFact = fact.trim();
    if (!cleanFact) {
      throw new Error("[Memory] rememberFact requires a non-empty fact.");
    }

    const fastEntry: LongTermFact = {
      id: this.generateId(),
      fact: cleanFact,
      source,
      timestamp: Date.now(),
      importance,
      lastAccessed: Date.now(),
      accessCount: 0,
      confidence,
      version: 1,
    };

    this.db.data.longTerm.push(fastEntry);

    if (this.db.data.longTerm.length > memoryConfig.maxLongTermItems) {
      const sorted = this.db.data.longTerm.sort((a, b) => b.importance - a.importance);
      const trimmed = sorted.slice(memoryConfig.maxLongTermItems);
      this.db.data.longTerm = sorted.slice(0, memoryConfig.maxLongTermItems);
      for (const removed of trimmed) {
        this.deleteVector(removed.fact).catch(err =>
          console.warn(`[Memory] Trim: vector delete failed for "${removed.fact.slice(0, 40)}": ${err}`)
        );
      }
    }

    this.scheduledWrite().catch((err) => {
      console.error("[Memory] Remember fact write failed:", err);
    });
    console.log(`[Memory] Remembered immediately: "${cleanFact}"`);
    invalidateVectorCache().catch(() => {});
    invalidateContextCache(this.db.data.sessionId ?? "default").catch(() => {});
    this.dedupAndIndexFactInBackground(fastEntry);
    return;
    /*

    // ── PHASE 2: Semantic Deduplication & Conflict Resolution ──────────────
    try {
      const similar = await this.searchVector(fact, 1);
      if (similar.length > 0 && similar[0].score > 0.85) {
        const existingFact = this.db.data.longTerm.find(f => f.fact === similar[0].text);
        if (existingFact) {
          console.log(`[Memory] Semantic overlap found (score: ${similar[0].score.toFixed(2)}). Checking for conflict/merge.`);
          
          if (similar[0].score > 0.95) {
            // Almost exact match -> Deduplicate (boost existing)
            console.log(`[Memory] Exact duplicate found. Boosting importance.`);
            existingFact.importance = Math.min(10, existingFact.importance + 1.0);
            existingFact.lastAccessed = Date.now();
            existingFact.accessCount += 1;
            existingFact.confidence = Math.min(1.0, (existingFact.confidence || 0.8) + 0.05);
            await this.db.write();
            return; 
          } else {
            // Nuance or contradiction (score between 0.85 and 0.95)
            const oldConfidence = existingFact.confidence || 0.5;
            if (confidence >= oldConfidence) {
               console.log(`[Memory] Overwriting/merging older fact due to higher confidence.`);
               
               const oldText = existingFact.fact;
               existingFact.fact = `${existingFact.fact} (Update: ${fact})`;
               existingFact.confidence = confidence;
               existingFact.version = (existingFact.version || 1) + 1;
               existingFact.lastAccessed = Date.now();
               existingFact.importance = Math.max(existingFact.importance, importance);
               
               // FIX-4 + FIX-5: LowDB is SSOT. No Neo4j fact write.
               // Delete old vector embedding (Python now implements this correctly),
               // then embed the updated text.
               await this.deleteVector(oldText);
               await this.embed(existingFact.fact).catch(console.error);
               
               await this.db.write(); // Persist SSOT
               return;
            } else {
               console.log(`[Memory] Ignoring new fact; older fact has higher confidence (${oldConfidence} vs ${confidence}).`);
               return;
            }
          }
        }
      }
    } catch (err) {
      console.error("[Memory] Vector search failed during deduplication, proceeding with insert.", err);
    }

    // ── PHASE 1: initialise scoring fields ────────────────────────────────
    const entry: LongTermFact = {
      id: this.generateId(),
      fact,
      source,
      timestamp: Date.now(),
      importance,
      lastAccessed: Date.now(),
      accessCount: 0,
      confidence,
      version: 1,
    };

    // FIX-4: LowDB is the SSOT. Write here first — it is the only store
    // consulted by all runtime read paths (retrieveForPlanning, searchFacts,
    // buildContextSummary, getShortTerm). Neo4j is kept for relationship
    // edges only; fact content is no longer mirrored there.
    this.db.data.longTerm.push(entry);

    // Trim: keep highest-importance items within budget.
    // PROBLEM-5 FIX: delete trimmed facts from VectorPy so their embeddings
    // don't persist as ghost entries that corrupt semantic search rank.
    if (this.db.data.longTerm.length > memoryConfig.maxLongTermItems) {
      const sorted = this.db.data.longTerm
        .sort((a, b) => b.importance - a.importance);
      const trimmed = sorted.slice(memoryConfig.maxLongTermItems); // facts being removed
      this.db.data.longTerm = sorted.slice(0, memoryConfig.maxLongTermItems);

      // Fire-and-forget vector deletions for trimmed facts (non-blocking)
      for (const removed of trimmed) {
        this.deleteVector(removed.fact).catch(err =>
          console.warn(`[Memory] Trim: vector delete failed for "${removed.fact.slice(0, 40)}": ${err}`)
        );
      }
    }

    // Vector index: embed the fact text (derived index, not SSOT)
    try {
      await this.embed(fact);
      console.log(`[Memory] Vector index updated: "${fact}"`);
    } catch (err) {
      console.error(`[Memory] Failed to embed fact (lexical fallback will be used): ${err}`);
    }

    // Persist SSOT to disk
    await this.db.write();
    console.log(`[Memory] Remembered: "${fact}"`);

    // REDIS: Invalidate cached search results — new fact may change rankings.
    // Fire-and-forget: cache miss is always safe (falls back to VectorPy).
    invalidateVectorCache().catch(() => {});
    invalidateContextCache(this.db.data.sessionId ?? "default").catch(() => {});
  }

    */
  }
  private dedupAndIndexFactInBackground(entry: LongTermFact): void {
    setTimeout(async () => {
      if (this.vectorApiCircuitOpen) {
        console.log('[Memory] Background vector indexing skipped: circuit breaker open.');
        return;
      }

      try {
        const similar = await this.searchVector(entry.fact, 1);
        const match = similar[0];
        if (match && match.score > 0.95 && match.text !== entry.fact) {
          const existingFact = this.db.data.longTerm.find(f => f.fact === match.text);
          const newFact = this.db.data.longTerm.find(f => f.id === entry.id);
          if (existingFact && newFact) {
            existingFact.importance = Math.min(10, existingFact.importance + 1.0);
            existingFact.lastAccessed = Date.now();
            existingFact.accessCount += 1;
            existingFact.confidence = Math.min(1.0, (existingFact.confidence || 0.8) + 0.05);
            this.db.data.longTerm = this.db.data.longTerm.filter(f => f.id !== entry.id);
            this.scheduledWrite().catch(err => console.error("[Memory] Background dedup write failed:", err));
            invalidateVectorCache().catch(() => {});
            invalidateContextCache(this.db.data.sessionId ?? "default").catch(() => {});
            console.log('[Memory] Background dedup merged a duplicate fact.');
            return;
          }
        }

        await this.embed(entry.fact);
        console.log(`[Memory] Background vector index updated: "${entry.fact.slice(0, 80)}"`);
      } catch (err) {
        console.warn(`[Memory] Background vector dedup/index skipped: ${(err as Error).message}`);
      }
    }, 0).unref?.();
  }

  getLongTermFacts(limit = 20): LongTermFact[] {
    this.ensureInit();
    return this.db.data.longTerm
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  /**
   * Semantic search returning the matched facts along with their vector similarity score.
   * REDIS: Results are cached by (query + topK) hash — TTL 24h.
   * Cache is invalidated on every fact write/update/delete.
   */
  private queryCache = new Map<string, { expiresAt: number; data: { fact: LongTermFact; score: number }[] }>();

  async searchFactsWithScores(query: string, topK = 5): Promise<{ fact: LongTermFact; score: number }[]> {
    this.ensureInit();

    // Fast Short-Circuit: If no long-term facts exist in LowDB, return [] in 0ms
    if (!this.db.data.longTerm || this.db.data.longTerm.length === 0) {
      return [];
    }

    const cacheKey = `${query.toLowerCase().trim()}::${topK}`;
    const memCached = this.queryCache.get(cacheKey);
    if (memCached && Date.now() < memCached.expiresAt) {
      return memCached.data.filter(r => this.db.data.longTerm.some(f => f.id === r.fact.id));
    }

    let results: { fact: LongTermFact; score: number }[] = [];

    // ── REDIS fast path: return cached result if available ────────────────
    const cached = await getCachedVectorResult<{ fact: LongTermFact; score: number }[]>(query, topK);
    if (cached && cached.length > 0) {
      console.log(`[Memory] Redis cache hit for query: "${query.slice(0, 40)}"`);
      // Still apply reinforcement on cache hits — data is live LowDB refs
      const now = Date.now();
      let mutated = false;
      for (const r of cached) {
        // Re-resolve against live LowDB to ensure we have current object
        const live = this.db.data.longTerm.find(f => f.id === r.fact.id);
        if (live) {
          live.lastAccessed = now;
          live.accessCount = (live.accessCount ?? 0) + 1;
          live.importance = Math.min(10, (live.importance ?? 5) + 0.5);
          r.fact = live; // point to live object
          mutated = true;
        }
      }
      if (mutated) {
        this.scheduledWrite().catch(err => console.error("[Memory] Reinforcement write failed:", err));
      }
      const validResults = cached.filter(r => this.db.data.longTerm.some(f => f.id === r.fact.id));
      this.queryCache.set(cacheKey, { expiresAt: Date.now() + 30_000, data: validResults });
      return validResults;
    }

    // ── Cache miss: run full vector + lexical search ──────────────────────

    // 1. Vector Search
    try {
      const vectorResults = await this.searchVector(query, topK);
      if (vectorResults && vectorResults.length > 0) {
        for (const vr of vectorResults) {
          const matched = this.db.data.longTerm.find(f => f.fact === vr.text);
          if (matched) {
            results.push({ fact: matched, score: vr.score });
          }
        }
      }
    } catch (err) {
      console.error("[Memory] Vector search failed, falling back to lexical:", err);
    }

    // 2. Lexical Fallback
    if (results.length === 0) {
      const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
      if (tokens.length === 0) {
        results = this.getLongTermFacts(topK).map(f => ({ fact: f, score: 0.5 }));
      } else {
        const scored = this.db.data.longTerm.map((f) => {
          const factLower = f.fact.toLowerCase();
          const score = tokens.reduce((acc, token) => acc + (factLower.includes(token) ? 1 : 0), 0);
          return { fact: f, score: score * 0.2 };
        });
        results = scored
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score || b.fact.importance - a.fact.importance)
          .slice(0, topK);
      }
    }

    // ── PHASE 1: Reinforcement — boost importance of reused facts ─────────
    const now = Date.now();
    let mutated = false;
    for (const r of results) {
      r.fact.lastAccessed = now;
      r.fact.accessCount = (r.fact.accessCount ?? 0) + 1;
      r.fact.importance = Math.min(10, (r.fact.importance ?? 5) + 0.5);
      mutated = true;
    }
    if (mutated) {
      this.scheduledWrite().catch(err => console.error("[Memory] Reinforcement write failed:", err));
    }

    // ── REDIS: store result for next hit (fire-and-forget) ────────────────
    if (results.length > 0) {
      cacheVectorResult(query, topK, results).catch(() => {});
    }

    this.queryCache.set(cacheKey, { expiresAt: Date.now() + 30_000, data: results });
    return results;
  }

  /**
   * Multi-token + vector search with PHASE 1 reinforcement.
   */
  async searchFacts(query: string, topK = 5): Promise<LongTermFact[]> {
    const scoredResults = await this.searchFactsWithScores(query, topK);
    return scoredResults.map(r => r.fact);
  }

  // ─── PHASE 1: Memory-Driven Planning ────────────────────────────────────────

  /**
   * Retrieve the most relevant facts for a given query and format them
   * as a structured string ready for injection into the LLM system prompt.
   *
   * Scoring formula: relevanceScore + (importance / 10) + recencyBonus
   *   - Ensures high-importance AND recently-used facts surface first
   *   - Decay means stale facts naturally drop in ranking
   *
   * Called by orchestrator BEFORE building the planning messages array.
   */
  async retrieveForPlanning(query: string, topK = 8): Promise<string> {
    this.ensureInit();

    const startMs = performance.now();
    const facts = await this.searchFacts(query, topK);
    const ms = Math.round(performance.now() - startMs);
    console.log(`[Timing] retrieveForPlanning: ${ms}ms`);

    if (facts.length === 0) return '';

    const now = Date.now();
    const ONE_DAY_MS = 86_400_000;

    // Score and sort: relevance (already done by searchFacts) + recency bonus
    const ranked = facts
      .map(f => {
        const ageMs = now - (f.lastAccessed ?? f.timestamp);
        const recencyBonus = Math.max(0, 1 - ageMs / (7 * ONE_DAY_MS)); // 0–1 over 7 days
        const compositeScore = (f.importance / 10) + recencyBonus;
        return { fact: f, score: compositeScore };
      })
      .sort((a, b) => b.score - a.score);

    const lines = ranked.map(({ fact: f }) => {
      const age = Math.round((now - f.timestamp) / 60_000);
      const accessed = f.accessCount ?? 0;
      return `• [imp:${f.importance.toFixed(1)}, used:${accessed}x] ${f.fact}`;
    });

    return [
      `[MEMORY CONTEXT — ${facts.length} relevant fact(s) retrieved]`,
      ...lines,
    ].join('\n');
  }

  /**
   * PHASE 1: Memory decay — call periodically (e.g. once per session start).
   * Reduces importance of facts that haven't been accessed recently.
   *
   * Decay formula: importance -= decayAmount per day since lastAccessed
   * Facts that drop below minImportance (1.0) are removed entirely.
   */
  async decayMemory(
    decayPerDay = 0.1,
    minImportance = 1.0
  ): Promise<{ decayed: number; removed: number }> {
    this.ensureInit();

    const now = Date.now();
    const ONE_DAY_MS = 86_400_000;
    let decayed = 0;
    let removed = 0;

    const before = this.db.data.longTerm.length;

    // PROBLEM-5 FIX: capture the facts being removed BEFORE the filter
    // so we can delete their embeddings from VectorPy.
    const removedFacts: LongTermFact[] = [];

    this.db.data.longTerm = this.db.data.longTerm.filter(fact => {
      const lastSeen = fact.lastAccessed ?? fact.timestamp;
      const daysSinceSeen = (now - lastSeen) / ONE_DAY_MS;

      if (daysSinceSeen < 1) return true; // Less than a day old — no decay

      const decay = decayPerDay * daysSinceSeen;
      fact.importance = Math.max(0, fact.importance - decay);
      decayed++;

      if (fact.importance < minImportance) {
        removedFacts.push(fact); // track for vector cleanup
        removed++;
        return false; // Prune from LowDB
      }
      return true;
    });

    if (decayed > 0) {
      this.scheduledWrite().catch(err => console.error("[Memory] Decay write failed:", err));
      console.log(`[Memory] 🌙 Decay applied: ${decayed} facts decayed, ${removed} removed (below ${minImportance} importance).`);

      // Delete removed facts from VectorPy (fire-and-forget, non-blocking)
      for (const fact of removedFacts) {
        this.deleteVector(fact.fact).catch(err =>
          console.warn(`[Memory] Decay: vector delete failed for "${fact.fact.slice(0, 40)}": ${err}`)
        );
      }

      // REDIS: invalidate after decay — stale cached results must not surface
      if (removedFacts.length > 0) {
        invalidateVectorCache().catch(() => {});
        invalidateContextCache(this.db.data.sessionId ?? "default").catch(() => {});
      }
    }

    return { decayed, removed };
  }

  async forgetFact(id: string): Promise<void> {
    this.ensureInit();
    // PROBLEM-5 FIX: capture the fact text before removing it from LowDB
    // so we can also remove its embedding from VectorPy.
    const target = this.db.data.longTerm.find(f => f.id === id);
    this.db.data.longTerm = this.db.data.longTerm.filter(f => f.id !== id);
    this.scheduledWrite().catch(err => console.error("[Memory] forgetFact write failed:", err));
    if (target) {
      this.deleteVector(target.fact).catch(err =>
        console.warn(`[Memory] forgetFact: vector delete failed for "${target.fact.slice(0, 40)}": ${err}`)
      );
      // REDIS: invalidate so forgotten fact can't be served from cache
      invalidateVectorCache(target.fact).catch(() => {});
      invalidateContextCache(this.db.data.sessionId ?? "default").catch(() => {});
    }
  }

  // ─── Feedback Loop ──────────────────────────────────────────────────────────

  /**
   * Apply feedback from AI responses to adjust importance scores.
   * @param factIds List of LTM fact IDs used in the current context.
   * @param impact Score between -1.0 (bad/incorrect context) to 1.0 (highly useful context).
   */
  async applyFeedback(factIds: string[], impact: number): Promise<void> {
    this.ensureInit();
    let updated = false;

    for (const id of factIds) {
      const fact = this.db.data.longTerm.find(f => f.id === id);
      if (fact) {
        // Bounded Normalization: Soft cap asymptote at 10.0
        const impactScaled = impact * (1 - (fact.importance / 10.0));
        fact.importance = Math.max(0, Math.min(10, fact.importance + impactScaled));
        updated = true;
        // FIX-4: LowDB is SSOT. No Neo4j sync needed here.
      }
    }

    if (updated) {
      this.scheduledWrite().catch(err => console.error("[Memory] Feedback write failed:", err));
      console.log(`[Memory] Feedback applied (impact: ${impact}) to ${factIds.length} facts.`);
    }
  }

  // ─── Context Summary ─────────────────────────────────────────────────────────

  buildContextSummary(): string {
    const facts = this.getLongTermFacts(10)
      .map((f) => `- ${f.fact}`)
      .join("\n");

    const summary = facts.length > 0
      ? `What I remember about you:\n${facts}`
      : "No long-term facts stored yet.";

    pipelineRegistry.recordSuccess("memory_to_context");
    return summary;
  }

  getStats() {
    this.ensureInit();
    return {
      shortTermCount: this.db.data.shortTerm.length,
      longTermCount: this.db.data.longTerm.length,
      sessionId: this.db.data.sessionId,
    };
  }

  /**
   * Force-flush any pending debounced write immediately.
   * Call this on graceful shutdown.
   */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.db.write();
  }
}

export const memoryManager = new MemoryManager();
