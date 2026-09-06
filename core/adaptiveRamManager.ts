import * as os from 'os';
import { EventEmitter } from 'events';

// ─── Phase 7: Object Pool (reduces GC pressure on high-frequency allocations) ─

export class ObjectPool<T> {
  private pool: T[] = [];
  private readonly factory: () => T;
  private readonly reset: (obj: T) => void;
  private readonly maxSize: number;

  constructor(factory: () => T, reset: (obj: T) => void, maxSize = 64) {
    this.factory = factory;
    this.reset   = reset;
    this.maxSize = maxSize;
  }

  acquire(): T {
    return this.pool.length > 0 ? this.pool.pop()! : this.factory();
  }

  release(obj: T): void {
    if (this.pool.length < this.maxSize) {
      this.reset(obj);
      this.pool.push(obj);
    }
  }

  get available(): number { return this.pool.length; }
  get maxCapacity(): number { return this.maxSize; }
}

export enum MemoryPressureLevel {
  LOW = 'LOW',         // > 4 GB free RAM available: max caching, pre-warming
  MODERATE = 'MODERATE', // 2 - 4 GB free RAM: standard caching
  HIGH = 'HIGH',       // 1 - 2 GB free RAM: reduced cache limits
  CRITICAL = 'CRITICAL'// < 1 GB free RAM: clear temporary caches, prioritize core
}

export interface MemoryStats {
  freeRamMb: number;
  totalRamMb: number;
  freeRamPercent: number;
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  pressureLevel: MemoryPressureLevel;
  cacheHitRatio: number;
  totalHits: number;
  totalMisses: number;
}

class AdaptiveRamManager extends EventEmitter {
  private static instance: AdaptiveRamManager;
  private hits = 0;
  private misses = 0;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private caches: Set<AdaptiveLruCache<any, any>> = new Set();

  private constructor() {
    super();
    this.startMonitoring();
  }

  static getInstance(): AdaptiveRamManager {
    if (!AdaptiveRamManager.instance) {
      AdaptiveRamManager.instance = new AdaptiveRamManager();
    }
    return AdaptiveRamManager.instance;
  }

  registerCache(cache: AdaptiveLruCache<any, any>): void {
    this.caches.add(cache);
  }

  unregisterCache(cache: AdaptiveLruCache<any, any>): void {
    this.caches.delete(cache);
  }

  recordHit(): void {
    this.hits++;
  }

  recordMiss(): void {
    this.misses++;
  }

  getPressureLevel(): MemoryPressureLevel {
    const freeMb = Math.round(os.freemem() / 1024 / 1024);
    if (freeMb > 4000) return MemoryPressureLevel.LOW;
    if (freeMb > 2000) return MemoryPressureLevel.MODERATE;
    if (freeMb > 1000) return MemoryPressureLevel.HIGH;
    return MemoryPressureLevel.CRITICAL;
  }

  getStats(): MemoryStats {
    const freeRam = os.freemem();
    const totalRam = os.totalmem();
    const mem = process.memoryUsage();
    const totalReqs = this.hits + this.misses;
    const hitRatio = totalReqs > 0 ? Number((this.hits / totalReqs).toFixed(4)) : 1.0;

    return {
      freeRamMb: Math.round(freeRam / 1024 / 1024),
      totalRamMb: Math.round(totalRam / 1024 / 1024),
      freeRamPercent: Number(((freeRam / totalRam) * 100).toFixed(1)),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      pressureLevel: this.getPressureLevel(),
      cacheHitRatio: hitRatio,
      totalHits: this.hits,
      totalMisses: this.misses,
    };
  }

  private startMonitoring(): void {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => {
      const level = this.getPressureLevel();
      if (level === MemoryPressureLevel.CRITICAL) {
        console.warn('[AdaptiveRAM] ⚠️  CRITICAL memory pressure detected — triggering cache compaction.');
        this.compactAllCaches();
      }
    }, 15_000);
    this.checkTimer.unref();
  }

  compactAllCaches(): void {
    for (const cache of this.caches) {
      cache.compact();
    }
  }

  /**
   * Phase 7: Pre-warm a set of caches with seed data.
   * Called at startup to eliminate cold-start misses on the first planning cycle.
   */
  preWarm<K, V>(cache: AdaptiveLruCache<K, V>, entries: Array<[K, V, number?]>): void {
    for (const [key, value, ttl] of entries) {
      cache.set(key, value, ttl);
    }
    console.log(`[AdaptiveRAM] ☁️  Pre-warmed cache with ${entries.length} entry(ies).`);
  }
}

export const adaptiveRamManager = AdaptiveRamManager.getInstance();

export class AdaptiveLruCache<K, V> {
  private map = new Map<K, { value: V; expiresAt: number }>();
  private baseCapacity: number;
  private defaultTtlMs: number;
  /** Phase 7: optional namespace for prefix-based invalidation */
  readonly namespace: string;

  constructor(baseCapacity = 1000, defaultTtlMs = 600_000, namespace = '') {
    this.baseCapacity   = baseCapacity;
    this.defaultTtlMs  = defaultTtlMs;
    this.namespace     = namespace;
    adaptiveRamManager.registerCache(this);
  }

  get capacity(): number {
    const level = adaptiveRamManager.getPressureLevel();
    switch (level) {
      case MemoryPressureLevel.LOW:      return this.baseCapacity * 3;
      case MemoryPressureLevel.MODERATE: return this.baseCapacity * 2;
      case MemoryPressureLevel.HIGH:     return this.baseCapacity;
      case MemoryPressureLevel.CRITICAL: return Math.max(10, Math.floor(this.baseCapacity * 0.25));
    }
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) { adaptiveRamManager.recordMiss(); return undefined; }
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      adaptiveRamManager.recordMiss();
      return undefined;
    }
    // Refresh LRU order
    this.map.delete(key);
    this.map.set(key, entry);
    adaptiveRamManager.recordHit();
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // Phase 7: sweep expired before hard eviction to avoid evicting hot entries
      const now = Date.now();
      for (const [k, e] of this.map) {
        if (now > e.expiresAt) { this.map.delete(k); break; }
      }
      // If still over capacity, evict oldest
      if (this.map.size >= this.capacity) {
        const oldestKey = this.map.keys().next().value;
        if (oldestKey !== undefined) this.map.delete(oldestKey);
      }
    }
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    this.map.set(key, { value, expiresAt });
  }

  has(key: K): boolean { return this.get(key) !== undefined; }
  delete(key: K): boolean { return this.map.delete(key); }
  clear(): void { this.map.clear(); }

  /** Phase 7: Delete all keys that start with the given string prefix (string keys only) */
  deleteByPrefix(prefix: string): number {
    let deleted = 0;
    for (const key of this.map.keys()) {
      if (typeof key === 'string' && key.startsWith(prefix)) {
        this.map.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  compact(): void {
    const now = Date.now();
    for (const [key, entry] of this.map.entries()) {
      if (now > entry.expiresAt) this.map.delete(key);
    }
    const max = this.capacity;
    while (this.map.size > max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
      else break;
    }
  }

  get size(): number { return this.map.size; }
}
