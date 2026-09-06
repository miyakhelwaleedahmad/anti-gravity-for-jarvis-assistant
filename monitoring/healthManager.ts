/**
 * monitoring/healthManager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE 2 — Runtime Health Manager
 *
 * Centralized probe system that polls each JARVIS subsystem and maintains
 * a live health snapshot. Designed to be polled by runtimeDashboard.ts.
 *
 * Probes:
 *   - Redis (ioredis ping)
 *   - Vector Memory (HTTP GET /stats on port 8000)
 *   - LLM (reads env config — no live ping to avoid cost)
 *   - Tool Registry (count check)
 *   - STT / TTS / WakeWord (process existence via pipelineRegistry)
 *   - Memory (process.memoryUsage)
 *   - CPU (simple load estimate via hrtime delta)
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ServiceStatus = 'online' | 'offline' | 'degraded' | 'unknown';

export interface ServiceHealth {
  name: string;
  status: ServiceStatus;
  latencyMs?: number;
  detail?: string;
  checkedAt: number;
}

export interface SystemMetrics {
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  uptimeSeconds: number;
  loadAvg1m: number;
  freeRamMB: number;
  totalRamMB: number;
}

export interface HealthSnapshot {
  timestamp: number;
  services: Record<string, ServiceHealth>;
  metrics: SystemMetrics;
  activeAgents: string[];
  overallStatus: ServiceStatus;
}

// ─── HealthManager ────────────────────────────────────────────────────────────

class HealthManager {
  private snapshot: HealthSnapshot = this.emptySnapshot();
  private activeAgents: Set<string> = new Set();
  private startTime = Date.now();

  // ── Agent tracking ─────────────────────────────────────────────────────────

  registerAgent(name: string): void {
    this.activeAgents.add(name);
  }

  unregisterAgent(name: string): void {
    this.activeAgents.delete(name);
  }

  // ── Probe: Redis ───────────────────────────────────────────────────────────

  private async probeRedis(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      const { isRedisAvailable, cacheSet, cacheGet, initRedis } = await import('../memory/redisCache.js');
      initRedis();
      if (!isRedisAvailable()) {
        return { name: 'redis', status: 'online', detail: 'in-memory cache fallback', checkedAt: Date.now() };
      }
      await cacheSet('__health_probe__', { ts: Date.now() }, 10);
      const val = await cacheGet<{ ts: number }>('__health_probe__');
      const latencyMs = Date.now() - start;
      return {
        name: 'redis',
        status: val !== null ? 'online' : 'degraded',
        latencyMs,
        detail: val !== null ? 'round-trip OK' : 'in-memory fallback active',
        checkedAt: Date.now(),
      };
    } catch (err) {
      return {
        name: 'redis',
        status: 'online',
        latencyMs: Date.now() - start,
        detail: 'in-memory cache fallback',
        checkedAt: Date.now(),
      };
    }
  }

  // ── Probe: Vector Memory (FastAPI) ─────────────────────────────────────────

  private async probeVectorMemory(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      const { memoryManager } = await import('../memory/memoryManager.js');
      const { vectorMemorySupervisor } = await import('../memory/vectorMemorySupervisor.js');

      // If supervisor confirms vector service is healthy, ensure circuit breaker is cleared
      if (vectorMemorySupervisor.isHealthy() && memoryManager.isVectorCircuitOpen) {
        memoryManager.resetVectorCircuit();
      }

      if (memoryManager.isVectorCircuitOpen && !vectorMemorySupervisor.isHealthy()) {
        return {
          name: 'vector_memory',
          status: 'degraded',
          detail: 'circuit breaker active (lexical fallback)',
          checkedAt: Date.now(),
        };
      }

      const controller = new AbortController();
      // Probe timeout of 2000ms prevents false timeouts on Windows/CPU-constrained environments
      const t = setTimeout(() => controller.abort(), 2000);
      const res = await fetch('http://127.0.0.1:8000/stats', {
        signal: controller.signal,
      });
      clearTimeout(t);
      const latencyMs = Date.now() - start;

      if (res.ok) {
        const data = await res.json() as any;
        const vectorCount = data.count ?? data.total_vectors ?? '?';
        return {
          name: 'vector_memory',
          status: 'online',
          latencyMs,
          detail: `${vectorCount} vectors stored`,
          checkedAt: Date.now(),
        };
      }

      if (res.status === 503) {
        return { name: 'vector_memory', status: 'degraded', latencyMs, detail: 'model loading...', checkedAt: Date.now() };
      }

      return { name: 'vector_memory', status: 'degraded', latencyMs, detail: `HTTP ${res.status}`, checkedAt: Date.now() };
    } catch (err) {
      const msg = (err as Error).message;
      const latencyMs = Date.now() - start;
      const isRefused = msg.includes('ECONNREFUSED');

      // Check if supervisor confirmed startup ready despite probe fetch error
      try {
        const { vectorMemorySupervisor } = await import('../memory/vectorMemorySupervisor.js');
        if (vectorMemorySupervisor.isHealthy()) {
          return {
            name: 'vector_memory',
            status: 'online',
            latencyMs,
            detail: 'service active',
            checkedAt: Date.now(),
          };
        }
      } catch {}

      return {
        name: 'vector_memory',
        status: 'degraded',
        latencyMs,
        detail: isRefused ? 'offline (lexical fallback active)' : 'probe timed out',
        checkedAt: Date.now(),
      };
    }
  }

  // ── Probe: LLM ─────────────────────────────────────────────────────────────

  private async probeLLM(): Promise<ServiceHealth> {
    try {
      const { llmConfig } = await import('../config/llmconfig.js');
      const hasKey = !!(process.env.GROQ_API_KEY || process.env.XAI_API_KEY);
      return {
        name: 'llm',
        status: hasKey ? 'online' : 'degraded',
        detail: hasKey ? `model: ${llmConfig.model ?? 'groq'}` : 'missing API key',
        checkedAt: Date.now(),
      };
    } catch {
      return { name: 'llm', status: 'unknown', detail: 'config unavailable', checkedAt: Date.now() };
    }
  }

  // ── Probe: Tool Registry ───────────────────────────────────────────────────

  private async probeToolRegistry(): Promise<ServiceHealth> {
    try {
      const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
      try { await import('../core/terminalTools.js'); } catch {}
      const count = toolRegistryV2.names().length;
      return {
        name: 'tool_registry',
        status: 'online',
        detail: `${count} tools registered`,
        checkedAt: Date.now(),
      };
    } catch (err) {
      return { name: 'tool_registry', status: 'degraded', detail: (err as Error).message, checkedAt: Date.now() };
    }
  }

  // ── Probe: Pipeline (STT / TTS / WakeWord) ─────────────────────────────────

  private async probePipelines(): Promise<ServiceHealth[]> {
    try {
      const { nodeBridge } = await import('../bridge/nodeBridge.js');
      const readyRoles = nodeBridge.getReadyClients();
      
      const results: ServiceHealth[] = [];
      const expectedServices = ['stt', 'tts', 'wakeword'];
      
      for (const svc of expectedServices) {
        const isReady = readyRoles.includes(svc);
        const displayName = svc === 'wakeword' ? 'wake_word' : svc;
        if (isReady) {
          results.push({
            name: displayName,
            status: 'online',
            detail: 'connected via bridge',
            checkedAt: Date.now()
          });
        } else {
          results.push({
            name: displayName,
            status: 'offline',
            detail: 'not connected',
            checkedAt: Date.now()
          });
        }
      }
      return results;
    } catch {
      return ['stt', 'tts', 'wake_word'].map(name => ({
        name, status: 'unknown' as ServiceStatus, detail: 'NodeBridge unavailable', checkedAt: Date.now(),
      }));
    }
  }

  // ── System Metrics ─────────────────────────────────────────────────────────

  private collectMetrics(): SystemMetrics {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const load = os.loadavg();
    const totalRam = os.totalmem();
    const freeRam = os.freemem();
    return {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
      loadAvg1m: Math.round(load[0] * 100) / 100,
      freeRamMB: Math.round(freeRam / 1024 / 1024),
      totalRamMB: Math.round(totalRam / 1024 / 1024),
    };
  }

  // ── Full Health Snapshot ───────────────────────────────────────────────────

  async probe(): Promise<HealthSnapshot> {
    const [redis, vector, llm, toolReg, pipelines] = await Promise.all([
      this.probeRedis(),
      this.probeVectorMemory(),
      this.probeLLM(),
      this.probeToolRegistry(),
      this.probePipelines(),
    ]);

    const services: Record<string, ServiceHealth> = {
      redis,
      vector_memory: vector,
      llm,
      tool_registry: toolReg,
    };

    for (const p of pipelines) {
      services[p.name] = p;
    }

    const metrics = this.collectMetrics();
    
    // Core critical services that determine overall system online status
    const coreServices = [services.llm, services.tool_registry];
    const isCoreOnline = coreServices.every(s => s && s.status === 'online');

    // Memory components (redis + vector_memory) - online or active fallback
    const memoryServices = [services.redis, services.vector_memory];
    const isCoreMemoryFunctional = memoryServices.every(s => s && (s.status === 'online' || s.status === 'degraded'));

    let overallStatus: ServiceStatus = 'degraded';
    if (isCoreOnline && isCoreMemoryFunctional) {
      // Core system intelligence & memory are fully operational.
      // Disconnected optional voice modules ('offline') do not degrade overall system status.
      overallStatus = 'online';
    } else if (isCoreOnline) {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'offline';
    }

    this.snapshot = {
      timestamp: Date.now(),
      services,
      metrics,
      activeAgents: [...this.activeAgents],
      overallStatus,
    };

    return this.snapshot;
  }

  /** Returns the last computed snapshot without reprobing. */
  getSnapshot(): HealthSnapshot {
    return this.snapshot;
  }

  // ── JSON Lines log output ──────────────────────────────────────────────────

  async writeLog(logPath = 'logs/jarvis-health.jsonl'): Promise<void> {
    try {
      const dir = path.dirname(logPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify(this.snapshot) + '\n';
      fs.appendFileSync(logPath, line, 'utf8');
    } catch { /* non-fatal */ }
  }

  private emptySnapshot(): HealthSnapshot {
    return {
      timestamp: Date.now(),
      services: {},
      metrics: {
        heapUsedMB: 0, heapTotalMB: 0, rssMB: 0, externalMB: 0,
        cpuUserMs: 0, cpuSystemMs: 0, uptimeSeconds: 0,
        loadAvg1m: 0, freeRamMB: 0, totalRamMB: 0,
      },
      activeAgents: [],
      overallStatus: 'unknown',
    };
  }
}

export const healthManager = new HealthManager();
