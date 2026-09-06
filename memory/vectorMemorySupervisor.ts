/**
 * memory/vectorMemorySupervisor.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3 — Vector Memory Supervisor
 *
 * Automatically manages the lifecycle of the Python vectorMemory.py FastAPI
 * server. Integrates directly with the circuit breaker in memoryManager.ts.
 *
 * Responsibilities:
 *   - Start vectorMemory.py on JARVIS startup
 *   - Health-check every 20s via HTTP GET /health
 *   - Restart on failure with exponential backoff (max 5 attempts)
 *   - Emit pipelineRegistry events for self-healing integration
 *   - Reset memoryManager circuit breaker after successful restart
 *
 * Phase 3 additions:
 *   - Embed retry queue: failed embed calls are queued and re-submitted
 *     automatically once the server recovers (up to MAX_RETRY_QUEUE_SIZE)
 *   - Batch embed helper: batchEmbed() sends texts to /batch_embed in one call
 *   - Post-restart dedup trigger: after a successful restart, triggers /dedup
 *     to clean up near-duplicates from partial writes before the crash
 *
 * Design principles:
 *   - Never blocks the main thread (all async)
 *   - Failure is non-fatal — JARVIS continues without vector search
 *   - Maximum 5 restart attempts per session; after that, logs and moves on
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ─── Constants ────────────────────────────────────────────────────────────────

const VECTOR_SCRIPT  = path.resolve('memory/vectorMemory.py');
const HEALTH_URL     = 'http://127.0.0.1:8000/health';
const LIVENESS_URL   = 'http://127.0.0.1:8000/liveness';
const EMBED_URL      = 'http://127.0.0.1:8000/embed';
const BATCH_EMBED_URL = 'http://127.0.0.1:8000/batch_embed';
const DEDUP_URL      = 'http://127.0.0.1:8000/dedup';
const HEALTH_INTERVAL_MS    = 20_000;
const STARTUP_WAIT_MS       = 20_000;
const STARTUP_POLL_MS       = 300;
const MAX_RESTARTS          = 5;
const BACKOFF_BASE_MS       = 1_000;
const DEFAULT_READY_TIMEOUT_MS = 25_000;

/** Maximum embed texts queued for retry while server is down */
const MAX_RETRY_QUEUE_SIZE  = 200;
/** Batch size for retry flush (matches /batch_embed max) */
const RETRY_BATCH_SIZE      = 32;

// ─── Supervisor ───────────────────────────────────────────────────────────────

interface RetryQueueEntry {
  text: string;
  addedAt: number;
}

class VectorMemorySupervisor {
  private proc: ChildProcess | null = null;
  private restartCount = 0;
  private healthy = false;
  private running = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number | null = null;

  // ── Startup readiness gate ────────────────────────────────────────────────
  private _readyResolve: ((ready: boolean) => void) | null = null;
  private _readyPromise: Promise<boolean> | null = null;
  private _startupReady = false;

  // ── Embed retry queue ─────────────────────────────────────────────────────
  // Texts that failed to embed while server was down are kept here and
  // re-submitted in batches once the server recovers.
  private _retryQueue: RetryQueueEntry[] = [];
  private _retryFlushing = false;

  // ── Start ──────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) {
      console.log('[VectorSupervisor] Already running.');
      return;
    }

    if (!fs.existsSync(VECTOR_SCRIPT)) {
      console.warn(`[VectorSupervisor] Script not found: ${VECTOR_SCRIPT}. Skipping.`);
      return;
    }

    this.running = true;
    this.restartCount = 0;

    // Create the startup readiness promise.
    // This is resolved when the first health check passes, or rejected never
    // (callers use waitUntilReady() with a timeout instead).
    this._startupReady = false;
    this._readyPromise = new Promise<boolean>((resolve) => {
      this._readyResolve = resolve;
    });

    // PHASE1-VEC-1: Non-blocking startup — do NOT await launch().
    // Previously this blocked JARVIS startup for up to 15s waiting for the
    // Python model to warm up.  Now we fire-and-forget in the background;
    // health checks will update this.healthy once the server is ready.
    this.launch().catch((err) =>
      console.error('[VectorSupervisor] Background launch error:', err)
    );
    this.startHealthLoop();
  }

  // ── Stop ───────────────────────────────────────────────────────────────────

  stop(): void {
    this.running = false;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.proc) {
      console.log('[VectorSupervisor] Shutting down vectorMemory.py...');
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.healthy = false;
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  isHealthy(): boolean { return this.healthy; }
  isStartupReady(): boolean { return this._startupReady; }
  getRestartCount(): number { return this.restartCount; }
  getRetryQueueDepth(): number { return this._retryQueue.length; }
  getUptimeSeconds(): number {
    return this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
  }

  // ── Public API: Batch embed ───────────────────────────────────────────────

  /**
   * Embed multiple texts in a single HTTP call to /batch_embed.
   * Falls back to queueing individual texts for retry if the server is down.
   *
   * @param texts       Array of texts to embed (max 64 per call)
   * @param skipDedup   Pass true to bypass vector deduplication (e.g. during rebuild)
   */
  async batchEmbed(texts: string[], skipDedup = false): Promise<any[]> {
    if (!this.healthy) {
      // Queue for retry
      for (const text of texts) this._enqueueRetry(text);
      throw new Error('[VectorSupervisor] Server unhealthy — texts queued for retry.');
    }
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(BATCH_EMBED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts, skip_dedup: skipDedup }),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`batch_embed HTTP ${res.status}`);
      const json = await res.json();
      return json.results ?? [];
    } catch (err) {
      // Queue all for retry
      for (const text of texts) this._enqueueRetry(text);
      throw err;
    }
  }

  /**
   * STARTUP SYNCHRONISATION GATE
   * ─────────────────────────────────────────────────────────────────────────
   * Returns a promise that resolves to:
   *   - `true`  when the Vector API becomes healthy (model loaded, /health 200)
   *   - `false` when the timeout expires without the API becoming healthy
   *
   * This is the ONLY safe way for upstream consumers (orchestrator, planner,
   * contextBuilder) to wait for vector readiness. It eliminates the race
   * condition where fetch() calls hit ECONNREFUSED and trip the circuit breaker
   * before the Python server has finished loading the embedding model.
   *
   * Safe to call multiple times — all callers share the same underlying promise.
   */
  async waitUntilReady(timeoutMs: number = DEFAULT_READY_TIMEOUT_MS): Promise<boolean> {
    // Already confirmed healthy in a previous call
    if (this._startupReady) return true;

    // Not running at all (script not found, etc.)
    if (!this.running) return false;

    // Re-use the existing promise if one is in flight
    if (this._readyPromise) {
      // Race the existing promise against our caller's timeout
      return Promise.race([
        this._readyPromise,
        new Promise<boolean>(resolve =>
          setTimeout(() => resolve(false), timeoutMs),
        ),
      ]);
    }

    // Should not happen, but defensive fallback
    return false;
  }

  // ── Private: check if port 8000 is already bound ──────────────────────────

  private async isPortBound(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1000);
      // Use /liveness instead of /health — always returns 200 if uvicorn is alive,
      // even while the model is still loading (unlike /health which returns 503).
      const res = await fetch(LIVENESS_URL, { signal: controller.signal });
      clearTimeout(t);
      // Any HTTP response (200, 503, etc.) means the port is bound
      return res.status >= 200 && res.status < 600;
    } catch {
      // Connection refused or aborted -> not bound
      return false;
    }
  }

  // ── Private: spawn process ─────────────────────────────────────────────────

  private async launch(): Promise<void> {
    // Check if another process is already serving port 8000 (prevents WINERROR 10048)
    const alreadyRunning = await this.isPortBound();
    if (alreadyRunning) {
      console.log('[VectorSupervisor] Vector memory already running on port 8000 — adopting existing process.');
      this.healthy = true;
      this.startedAt = Date.now();
      // Resolve the startup readiness gate — the existing server is serving
      if (!this._startupReady) {
        this._startupReady = true;
        if (this._readyResolve) {
          this._readyResolve(true);
          this._readyResolve = null;
        }
      }
      this.notifyPipelineRecovery();
      this.resetCircuitBreaker();
      return;
    }

    console.log(`[VectorSupervisor] Launching vectorMemory.py (attempt ${this.restartCount + 1})...`);
    this.startedAt = Date.now();

    // Use venv Python on Windows for correct dependency resolution
    const python = process.platform === 'win32'
      ? '.venv\\Scripts\\python.exe'
      : '.venv/bin/python3';
    this.proc = spawn(python, [VECTOR_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    this.proc.stdout?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log(`[VectorAPI] ${msg}`);
    });

    let isDependencyError = false;
    let isPortConflict = false;

    this.proc.stderr?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg && !msg.includes('WARNING') && !msg.includes('UserWarning')) {
        // Port conflict is non-fatal — another server is already running
        if (msg.includes('10048') || msg.includes('address already in use') || msg.includes('WinError 10048')) {
          isPortConflict = true;
          console.log('[VectorSupervisor] Port 8000 already bound — existing server is active.');
          return;
        }
        if (!isPortConflict) {
          console.error(`[VectorAPI:ERR] ${msg}`);
        }
        if (msg.includes('ModuleNotFoundError') || msg.includes('ImportError')) {
          isDependencyError = true;
        }
      }
    });

    this.proc.on('exit', (code, signal) => {
      // If port was already in use, treat as non-fatal — the existing server handles traffic
      if (isPortConflict) {
        console.log('[VectorSupervisor] New process exited due to port conflict — adopting existing server.');
        this.proc = null;
        this.healthy = true;
        this.startedAt = this.startedAt ?? Date.now();
        // Resolve the startup readiness gate — the existing server is serving
        if (!this._startupReady) {
          this._startupReady = true;
          if (this._readyResolve) {
            this._readyResolve(true);
            this._readyResolve = null;
          }
        }
        this.notifyPipelineRecovery();
        this.resetCircuitBreaker();
        return;
      }

      console.warn(`[VectorSupervisor] Process exited (code=${code}, signal=${signal})`);
      this.proc = null;
      this.healthy = false;
      this.notifyPipelineFailure(`Process exited: code=${code}`);

      if (isDependencyError) {
        console.error('[VectorSupervisor] FATAL: Missing Python dependencies. Halting restarts. Run: pip install -r requirements.txt');
        this.running = false;
        return;
      }

      if (this.running && this.restartCount < MAX_RESTARTS) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, this.restartCount);
        this.restartCount++;
        console.log(`[VectorSupervisor] Restarting in ${delay}ms (attempt ${this.restartCount}/${MAX_RESTARTS})...`);
        setTimeout(() => this.launch(), delay);
      } else if (this.restartCount >= MAX_RESTARTS) {
        console.error(`[VectorSupervisor] Max restarts (${MAX_RESTARTS}) reached. Vector memory offline.`);
        this.running = false;
      }
    });

    this.proc.on('error', (err) => {
      console.error(`[VectorSupervisor] Spawn error: ${err.message}`);
      this.healthy = false;
    });

    await this.waitForStartupHealth();
  }

  // ── Private: health check loop ─────────────────────────────────────────────

  private startHealthLoop(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(async () => {
      await this.checkHealth();
    }, HEALTH_INTERVAL_MS);
    this.healthTimer.unref();
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      // 5s timeout — allows for CPU-constrained environments (8GB Windows)
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(HEALTH_URL, { signal: controller.signal });
      clearTimeout(t);

      if (res.ok) {
        const wasUnhealthy = !this.healthy;
        this.healthy = true;

        // Resolve the startup readiness gate on first healthy signal
        if (!this._startupReady) {
          this._startupReady = true;
          if (this._readyResolve) {
            this._readyResolve(true);
            this._readyResolve = null;
          }
        }

        if (wasUnhealthy) {
          console.log('[VectorSupervisor] ✅ Vector memory is online.');
          this.notifyPipelineRecovery();
          // Post-restart dedup: clean up near-duplicates from partial writes
          this._triggerPostRestartDedup();
          // Flush any queued embeds now that the server is healthy
          this._flushRetryQueue();
        }
        this.resetCircuitBreaker();
        return true;
      }

      // Non-200 from /health (e.g. 503 = model still loading).
      // Server IS alive — don't mark as unhealthy yet.
      // The model may still be warming up.
      if (res.status === 503) {
        console.log('[VectorSupervisor] /health returned 503 — model still loading. Server is alive.');
        return false;
      }
    } catch {
      // fetch threw — either server is dead or network error.
      // Try /liveness as a fallback to distinguish "dead" from "loading".
      try {
        const lc = new AbortController();
        const lt = setTimeout(() => lc.abort(), 2000);
        const lr = await fetch(LIVENESS_URL, { signal: lc.signal });
        clearTimeout(lt);
        if (lr.ok) {
          // Server is alive but /health failed — model probably loading
          console.log('[VectorSupervisor] /health unreachable but /liveness OK — model may be loading.');
          return false;
        }
      } catch {
        // Both endpoints failed — server is truly down
      }
    }

    if (this.healthy) {
      this.healthy = false;
      console.warn('[VectorSupervisor] ⚠️  Vector memory health check failed.');
      this.notifyPipelineFailure('Health check failed');
    }
    return false;
  }

  private async waitForStartupHealth(): Promise<void> {
    const deadline = Date.now() + STARTUP_WAIT_MS;
    while (Date.now() < deadline) {
      if (!this.running || !this.proc) return;
      if (await this.checkHealth()) {
        console.log(`[VectorSupervisor] Startup health ready after ${this.getUptimeSeconds()}s.`);
        return;
      }
      await new Promise(r => setTimeout(r, STARTUP_POLL_MS));
    }
    await this.checkHealth();
  }

  // ── Circuit breaker integration ────────────────────────────────────────────

  private resetCircuitBreaker(): void {
    import('../memory/memoryManager.js').then(({ memoryManager }) => {
      memoryManager.resetVectorCircuit();
    }).catch(() => {});
  }

  // ── Pipeline registry integration ──────────────────────────────────────────

  private notifyPipelineFailure(reason: string): void {
    import('../self_healing/pipelineRegistry.js').then(({ pipelineRegistry }) => {
      pipelineRegistry.recordFailure('vector_memory', reason);
    }).catch(() => {});
  }

  private notifyPipelineRecovery(): void {
    import('../self_healing/pipelineRegistry.js').then(({ pipelineRegistry }) => {
      pipelineRegistry.recordSuccess('vector_memory');
    }).catch(() => {});
  }

  // ── Retry queue ────────────────────────────────────────────────────────────

  private _enqueueRetry(text: string): void {
    if (this._retryQueue.length >= MAX_RETRY_QUEUE_SIZE) {
      // Drop the oldest entry to make room (FIFO eviction)
      this._retryQueue.shift();
    }
    this._retryQueue.push({ text, addedAt: Date.now() });
  }

  private _flushRetryQueue(): void {
    if (this._retryFlushing || this._retryQueue.length === 0) return;
    this._retryFlushing = true;

    const flush = async () => {
      try {
        while (this._retryQueue.length > 0 && this.healthy) {
          const batch = this._retryQueue.splice(0, RETRY_BATCH_SIZE);
          const texts = batch.map(e => e.text);
          console.log(`[VectorSupervisor] Flushing ${texts.length} queued embeds...`);
          try {
            await this.batchEmbed(texts, false);
            console.log(`[VectorSupervisor] ✅ Retry flush: embedded ${texts.length} texts.`);
          } catch (err) {
            // Put them back at the front (re-queue on failure)
            const requeue = batch.map(e => ({ ...e }));
            this._retryQueue.unshift(...requeue);
            console.warn(`[VectorSupervisor] Retry flush failed: ${(err as Error).message}`);
            break;
          }
        }
      } finally {
        this._retryFlushing = false;
      }
    };

    // Fire-and-forget — non-blocking
    flush().catch(err => console.error('[VectorSupervisor] Retry flush error:', err));
  }

  // ── Post-restart dedup ─────────────────────────────────────────────────────

  private _triggerPostRestartDedup(): void {
    // Trigger dedup 5s after recovery to let any in-flight embeds settle
    setTimeout(async () => {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 30_000);
        const res = await fetch(DEDUP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threshold: 0.97 }),
          signal: controller.signal,
        });
        clearTimeout(t);
        if (res.ok) {
          const data = await res.json();
          if (data.removed > 0) {
            console.log(`[VectorSupervisor] Post-restart dedup: removed ${data.removed} near-duplicates.`);
          }
        }
      } catch {
        // Dedup is a best-effort optimisation — non-fatal
      }
    }, 5_000);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const vectorMemorySupervisor = new VectorMemorySupervisor();
