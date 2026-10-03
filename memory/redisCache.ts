/**
 * redisCache.ts — JARVIS Redis Cache Layer
 *
 * Phase 3 additions:
 *   - Hit/miss ratio tracking per key namespace
 *   - cacheStats() endpoint: returns hit ratio, total hits, misses
 *   - Adaptive TTL: vector result TTL extends automatically on high hit ratios
 *   - Memory cleanup: flushByPrefix() removes all JARVIS keys matching a pattern
 *   - SCAN-based cleanup (non-blocking) for large key sets
 *
 * Role: HIGH-SPEED CACHE ONLY.
 * - NOT a source of truth
 * - NOT a replacement for LowDB, VectorPy, or Neo4j
 * - Fully disposable: system works correctly with Redis down or empty
 *
 * Read path:  Check Redis → miss → query real store → cache result
 * Write path: Write LowDB first → then update Redis mirror
 *
 * All public methods are async and NEVER throw — on Redis failure they log
 * a warning and return null/undefined so callers degrade gracefully.
 */

import { Redis } from "ioredis";
import crypto from "crypto";

// ─── Connection ──────────────────────────────────────────────────────────────

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = parseInt(process.env.REDIS_PORT ?? "6379", 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD ?? undefined;

let client: Redis | null = null;
let redisAvailable = false;

/**
 * Initialise the Redis connection once.
 * Safe to call multiple times — idempotent.
 */
export function initRedis(): void {
  if (client) return;

  client = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    // Retry: 3 attempts with exponential backoff, then give up silently
    retryStrategy(times: number) {
      if (times > 3) {
        console.warn("[Redis] Cannot connect after 3 retries — running without cache.");
        redisAvailable = false;
        return null; // stops retrying
      }
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
    enableOfflineQueue: false, // Don't queue commands while disconnected
  });

  const c = client; // narrow type to non-null for event registrations

  // "ready", not "connect": ioredis emits "connect" when the socket opens but
  // only accepts commands once it is "ready". With enableOfflineQueue off, a
  // command sent in between is rejected ("Stream isn't writeable and
  // enableOfflineQueue options is false") — the startup health probe hit
  // exactly that window.
  c.on("ready", () => {
    redisAvailable = true;
    console.log(`[Redis] Connected at ${REDIS_HOST}:${REDIS_PORT}`);
  });

  c.on("error", (err: Error) => {
    if (redisAvailable) {
      console.warn(`[Redis] Connection error — cache disabled: ${err.message}`);
    }
    redisAvailable = false;
  });

  c.on("close", () => {
    redisAvailable = false;
  });

  // Attempt connection (non-blocking — system continues if this fails)
  c.connect().catch(() => {
    console.warn("[Redis] Initial connection failed — running without cache.");
    redisAvailable = false;
  });
}

/** Returns true only if Redis is currently reachable. */
export function isRedisAvailable(): boolean {
  return redisAvailable;
}

/** Gracefully disconnect (call on process exit). */
export async function disconnectRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => {});
    client = null;
    redisAvailable = false;
  }
}

// ─── Key Builders ─────────────────────────────────────────────────────────────
// Centralised key structure — easy to audit, easy to flush by prefix.

export const RedisKeys = {
  /** Recent conversation context for a session */
  recentContext:   (sessionId: string) => `context:chat:${sessionId}`,
  /** Last N short-term messages for a user */
  recentMessages:  (sessionId: string) => `memory:recent:${sessionId}`,
  /** Cached vector search result for a query */
  vectorResult:    (queryHash: string)  => `vector:result:${queryHash}`,
  /** Cached embedding for a specific text */
  embedding:       (textHash: string)   => `embedding:${textHash}`,
  /** Active session state (working context) */
  sessionState:    (sessionId: string) => `session:${sessionId}`,
};

/** SHA-256 hash of a string — used as cache key component. */
export function hashKey(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ─── TTL Constants (seconds) ─────────────────────────────────────────────────

export const TTL = {
  recentContext:  60 * 30,           // 30 minutes — sliding
  recentMessages: 60 * 60 * 2,       // 2 hours
  vectorResult:   60 * 60 * 24,      // 24 hours base — adaptive on high hit ratio
  embedding:      60 * 60 * 24 * 14, // 14 days — embeddings are stable
  sessionState:   60 * 60,           // 1 hour
};

// ─── Hit/Miss Ratio Tracking ──────────────────────────────────────────────────

type CacheNamespace = 'vectorResult' | 'embedding' | 'recentMessages' | 'recentContext' | 'sessionState';

interface HitMissCounter { hits: number; misses: number; }

const _counters: Record<CacheNamespace, HitMissCounter> = {
  vectorResult:   { hits: 0, misses: 0 },
  embedding:      { hits: 0, misses: 0 },
  recentMessages: { hits: 0, misses: 0 },
  recentContext:  { hits: 0, misses: 0 },
  sessionState:   { hits: 0, misses: 0 },
};

function _inferNamespace(key: string): CacheNamespace | null {
  if (key.startsWith('vector:result:'))  return 'vectorResult';
  if (key.startsWith('embedding:'))      return 'embedding';
  if (key.startsWith('memory:recent:'))  return 'recentMessages';
  if (key.startsWith('context:chat:'))   return 'recentContext';
  if (key.startsWith('session:'))        return 'sessionState';
  return null;
}

function _recordHit(key: string): void { const ns = _inferNamespace(key); if (ns) _counters[ns].hits++; }
function _recordMiss(key: string): void { const ns = _inferNamespace(key); if (ns) _counters[ns].misses++; }

/**
 * Returns hit ratio, hit count, miss count per namespace.
 * Useful for tuning TTLs and diagnosing cache effectiveness.
 */
export function cacheStats(): Record<CacheNamespace, { hits: number; misses: number; total: number; hitRatio: number }> {
  const result = {} as ReturnType<typeof cacheStats>;
  for (const [ns, c] of Object.entries(_counters) as [CacheNamespace, HitMissCounter][]) {
    const total = c.hits + c.misses;
    result[ns] = { hits: c.hits, misses: c.misses, total, hitRatio: total === 0 ? 0 : Math.round((c.hits / total) * 1000) / 1000 };
  }
  return result;
}

/**
 * Adaptive TTL for vector results: extends to 48h on high hit ratio (>0.7),
 * reduces to 12h on low hit ratio (<0.2). Defaults to 24h.
 */
export function adaptiveVectorTtl(): number {
  const s = _counters.vectorResult;
  const total = s.hits + s.misses;
  if (total < 10) return TTL.vectorResult;
  const ratio = s.hits / total;
  if (ratio > 0.7) return TTL.vectorResult * 2;  // 48h — hot cache
  if (ratio < 0.2) return Math.round(TTL.vectorResult / 2); // 12h — cold cache
  return TTL.vectorResult;
}

/**
 * Memory cleanup: delete all Redis keys matching a prefix using non-blocking SCAN.
 * Use with care — called periodically or on session end to reclaim memory.
 * Example: flushByPrefix('vector:result:') clears all cached vector results.
 */
export async function flushByPrefix(prefix: string): Promise<number> {
  if (!redisAvailable || !client) return 0;
  let cursor = '0';
  let deleted = 0;
  try {
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await client.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');
    if (deleted > 0) console.log(`[Redis] Flushed ${deleted} keys with prefix "${prefix}"`);
  } catch (err) {
    console.warn(`[Redis] flushByPrefix("${prefix}") failed: ${(err as Error).message}`);
  }
  return deleted;
}

// ─── Core Get / Set / Delete ──────────────────────────────────────────────────


/**
 * Get a cached JSON value.
 * Returns null on cache miss OR if Redis is unavailable.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redisAvailable || !client) return null;
  try {
    const raw = await client.get(key);
    if (!raw) {
      _recordMiss(key);
      return null;
    }
    _recordHit(key);
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[Redis] cacheGet("${key}") failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Set a cached JSON value with TTL.
 * No-op if Redis is unavailable.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!redisAvailable || !client) return;
  try {
    await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (err) {
    console.warn(`[Redis] cacheSet("${key}") failed: ${(err as Error).message}`);
  }
}

/**
 * Invalidate a cache key.
 * No-op if Redis is unavailable.
 */
export async function cacheDel(key: string): Promise<void> {
  if (!redisAvailable || !client) return;
  try {
    await client.del(key);
  } catch (err) {
    console.warn(`[Redis] cacheDel("${key}") failed: ${(err as Error).message}`);
  }
}

/**
 * Reset a key's TTL without changing its value (sliding expiry).
 */
export async function cacheTTLRefresh(key: string, ttlSeconds: number): Promise<void> {
  if (!redisAvailable || !client) return;
  try {
    await client.expire(key, ttlSeconds);
  } catch {
    // Non-critical — silent
  }
}

// ─── High-Level Cache Utilities ───────────────────────────────────────────────

/**
 * Cache a vector search result.
 * Uses adaptive TTL based on hit ratio — hot caches get 48h, cold 12h.
 */
export async function cacheVectorResult(
  query: string,
  topK: number,
  results: unknown
): Promise<void> {
  const key = RedisKeys.vectorResult(hashKey(`${query}::${topK}`));
  await cacheSet(key, results, adaptiveVectorTtl());
}

/**
 * Retrieve a cached vector search result.
 * Returns null on miss.
 */
export async function getCachedVectorResult<T>(
  query: string,
  topK: number
): Promise<T | null> {
  const key = RedisKeys.vectorResult(hashKey(`${query}::${topK}`));
  return cacheGet<T>(key);
}

/**
 * Invalidate all cached vector results for a query.
 * Call this after a fact is added/updated/deleted to prevent stale hits.
 */
export async function invalidateVectorCache(query?: string): Promise<void> {
  if (!redisAvailable || !client) return;
  if (query) {
    // Invalidate specific known query variants
    for (const topK of [1, 3, 5, 8, 10, 15]) {
      await cacheDel(RedisKeys.vectorResult(hashKey(`${query}::${topK}`)));
    }
  }
  // Note: full pattern-based flush (SCAN + DEL) avoided deliberately —
  // it would be expensive and is unnecessary for single-user load.
}

/**
 * Cache recent short-term messages for a session.
 */
export async function cacheRecentMessages(
  sessionId: string,
  messages: unknown[]
): Promise<void> {
  const key = RedisKeys.recentMessages(sessionId);
  await cacheSet(key, messages, TTL.recentMessages);
}

/**
 * Get cached recent messages.
 */
export async function getCachedRecentMessages<T>(
  sessionId: string
): Promise<T[] | null> {
  const key = RedisKeys.recentMessages(sessionId);
  return cacheGet<T[]>(key);
}

/**
 * Cache the assembled context packet for a session.
 * TTL is short — context is turn-specific and must stay fresh.
 */
export async function cacheContextPacket(
  sessionId: string,
  packet: unknown
): Promise<void> {
  const key = RedisKeys.recentContext(sessionId);
  await cacheSet(key, packet, TTL.recentContext);
}

/**
 * Retrieve a cached context packet.
 */
export async function getCachedContextPacket<T>(
  sessionId: string
): Promise<T | null> {
  const key = RedisKeys.recentContext(sessionId);
  return cacheGet<T>(key);
}

/**
 * Invalidate context cache — call after ANY memory write so the next
 * context build always gets a fresh read.
 */
export async function invalidateContextCache(sessionId: string): Promise<void> {
  // OPT-7: Both keys are independent — delete in parallel instead of sequentially
  await Promise.all([
    cacheDel(RedisKeys.recentContext(sessionId)),
    cacheDel(RedisKeys.recentMessages(sessionId)),
  ]);
}

/**
 * Cache an embedding result.
 */
export async function cacheEmbedding(text: string, embedding: number[]): Promise<void> {
  const key = RedisKeys.embedding(hashKey(text));
  await cacheSet(key, embedding, TTL.embedding);
}

/**
 * Retrieve a cached embedding.
 */
export async function getCachedEmbedding(text: string): Promise<number[] | null> {
  const key = RedisKeys.embedding(hashKey(text));
  return cacheGet<number[]>(key);
}

// ─── Phase 7: Pipeline Batch Operations ──────────────────────────────────────
// Converts N sequential GET/SET round-trips into 1 pipelined flush.
// ~80% latency reduction when retrieving/storing multiple embeddings.

/**
 * Retrieve multiple embeddings in a single Redis pipeline.
 * Returns a Map of text → embedding (missing entries are omitted).
 */
export async function batchGetEmbeddings(texts: string[]): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (!client || !redisAvailable || texts.length === 0) return result;

  try {
    const pipeline = client.pipeline();
    const keys = texts.map(t => RedisKeys.embedding(hashKey(t)));
    keys.forEach(k => pipeline.get(k));
    const responses = await pipeline.exec();

    if (!responses) return result;

    for (let i = 0; i < responses.length; i++) {
      const [err, raw] = responses[i] as [Error | null, string | null];
      if (err || !raw) continue;
      try {
        result.set(texts[i], JSON.parse(raw));
      } catch { /* corrupt entry — skip */ }
    }
  } catch (err) {
    console.warn('[Redis] batchGetEmbeddings failed (non-fatal):', (err as Error).message);
  }

  return result;
}

/**
 * Cache multiple embeddings in a single Redis pipeline.
 * Far more efficient than N individual cacheEmbedding() calls.
 */
export async function batchCacheEmbeddings(pairs: Array<[string, number[]]>): Promise<void> {
  if (!client || !redisAvailable || pairs.length === 0) return;

  try {
    const pipeline = client.pipeline();
    for (const [text, embedding] of pairs) {
      const key = RedisKeys.embedding(hashKey(text));
      pipeline.setex(key, TTL.embedding, JSON.stringify(embedding));
    }
    await pipeline.exec();
  } catch (err) {
    console.warn('[Redis] batchCacheEmbeddings failed (non-fatal):', (err as Error).message);
  }
}

/**
 * Multi-key GET: retrieve several cached values in one pipeline round-trip.
 * Returns a Map of key → parsed value (undefined entries omitted).
 */
export async function pipelineGet<T>(keys: string[]): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  if (!client || !redisAvailable || keys.length === 0) return result;

  try {
    const pipeline = client.pipeline();
    keys.forEach(k => pipeline.get(k));
    const responses = await pipeline.exec();
    if (!responses) return result;

    for (let i = 0; i < responses.length; i++) {
      const [err, raw] = responses[i] as [Error | null, string | null];
      if (err || !raw) continue;
      try { result.set(keys[i], JSON.parse(raw)); } catch { /* skip */ }
    }
  } catch (err) {
    console.warn('[Redis] pipelineGet failed (non-fatal):', (err as Error).message);
  }

  return result;
}
