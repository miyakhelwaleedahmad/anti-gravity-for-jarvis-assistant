/**
 * core/environmentContext.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1 — Controlled Autonomy Layer: ENVIRONMENT CONTEXT
 *
 * Provides JARVIS with real-time awareness of its runtime environment.
 * This context is injected into the LLM planning prompt so the planner
 * can make OS-aware, path-aware decisions without guessing.
 *
 * Captured data:
 *   - OS type, platform, architecture
 *   - Current working directory
 *   - Node.js version + runtime info
 *   - Environment type (development / production)
 *   - Available memory (heap + system)
 *   - Active environment variables relevant to JARVIS
 *   - Running child processes tracked by JARVIS (non-invasive)
 *
 * Design notes:
 *   - getSystemContext() is synchronous-first (no blocking I/O in hot path)
 *   - Heavy data (process list) is cached with a 30s TTL
 *   - Safe: read-only — never modifies system state
 */

import os from 'os';
import process from 'process';
import path from 'path';
import { execSync } from 'child_process';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SystemContext {
  // Core OS info
  platform: string;       // 'win32' | 'linux' | 'darwin'
  osType: string;         // 'Windows' | 'Linux' | 'macOS'
  arch: string;           // 'x64' | 'arm64'
  hostname: string;
  username: string;

  // Runtime
  nodeVersion: string;
  nodeEnv: string;        // 'development' | 'production' | 'test'
  workingDirectory: string;
  scriptDirectory: string;

  // Resources
  totalMemoryMB: number;
  freeMemoryMB: number;
  cpuCount: number;
  uptime: number;         // seconds

  // JARVIS-specific
  jarvisRootDir: string;
  activeProcesses: string[];  // Names of system processes JARVIS is aware of

  // Formatted for LLM injection
  contextString: string;
}

// ─── Process List Cache ───────────────────────────────────────────────────────

interface ProcessCache {
  processes: string[];
  capturedAt: number;
}

const PROCESS_CACHE_TTL_MS = 30_000; // 30 seconds — avoids hammering the OS
let processCache: ProcessCache | null = null;

function getCachedProcessList(): string[] {
  const now = Date.now();
  if (processCache && now - processCache.capturedAt < PROCESS_CACHE_TTL_MS) {
    return processCache.processes;
  }

  const processes = captureProcessList();
  processCache = { processes, capturedAt: now };
  return processes;
}

/**
 * Capture top-level process names from the OS.
 * Non-invasive: only reads names, no PIDs or memory details exposed to LLM.
 */
function captureProcessList(): string[] {
  try {
    const platform = process.platform;

    if (platform === 'win32') {
      // Windows: tasklist output, extract only process names
      const raw = execSync('tasklist /fo csv /nh', { timeout: 5000, encoding: 'utf8' });
      const names = raw
        .split('\n')
        .map(line => line.split(',')[0]?.replace(/"/g, '').trim() ?? '')
        .filter(Boolean)
        .filter(name => name.endsWith('.exe'))
        .map(name => name.replace(/\.exe$/i, ''))
        .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
        .slice(0, 30); // cap for LLM context size
      return names;
    }

    if (platform === 'linux' || platform === 'darwin') {
      const raw = execSync("ps -eo comm= | sort -u", { timeout: 5000, encoding: 'utf8' });
      return raw.trim().split('\n').slice(0, 30);
    }

    return [];
  } catch {
    // Non-fatal: process listing is best-effort
    return [];
  }
}

// ─── Environment Context Engine ───────────────────────────────────────────────

export class EnvironmentContextEngine {
  private readonly jarvisRootDir: string;

  constructor() {
    // Resolve root from this file: core/environmentContext.ts → ../
    this.jarvisRootDir = path.resolve(process.cwd());
  }

  /**
   * Primary API — returns a complete SystemContext snapshot.
   * Called by orchestrator before building the planning prompt.
   *
   * @param includeProcesses  If false, skip the process list (faster, smaller)
   */
  getSystemContext(includeProcesses = true): SystemContext {
    const platform = process.platform as string;

    const osType = platform === 'win32' ? 'Windows'
                 : platform === 'darwin' ? 'macOS'
                 : 'Linux';

    const totalMemoryMB = Math.round(os.totalmem() / 1024 / 1024);
    const freeMemoryMB = Math.round(os.freemem() / 1024 / 1024);

    const activeProcesses = includeProcesses ? getCachedProcessList() : [];

    const ctx: Omit<SystemContext, 'contextString'> = {
      platform,
      osType,
      arch: process.arch,
      hostname: os.hostname(),
      username: os.userInfo().username,
      nodeVersion: process.version,
      nodeEnv: process.env['NODE_ENV'] ?? 'development',
      workingDirectory: process.cwd(),
      scriptDirectory: this.jarvisRootDir,
      totalMemoryMB,
      freeMemoryMB,
      cpuCount: os.cpus().length,
      uptime: Math.round(os.uptime()),
      jarvisRootDir: this.jarvisRootDir,
      activeProcesses,
    };

    const contextString = this.formatForLLM(ctx, activeProcesses);

    return { ...ctx, contextString };
  }

  /**
   * Returns a compact string suitable for injection into the LLM system prompt.
   * Structured to be informative without consuming excessive tokens.
   */
  formatForLLM(
    ctx: Omit<SystemContext, 'contextString'>,
    activeProcesses: string[]
  ): string {
    const processLine = activeProcesses.length > 0
      ? `Active system processes: ${activeProcesses.slice(0, 15).join(', ')}`
      : 'Active processes: unavailable';

    const memLine = `Memory: ${ctx.freeMemoryMB}MB free / ${ctx.totalMemoryMB}MB total`;

    return [
      `[ENVIRONMENT CONTEXT]`,
      `OS: ${ctx.osType} | Arch: ${ctx.arch} | User: ${ctx.username}`,
      `Working directory: ${ctx.workingDirectory}`,
      `JARVIS root: ${ctx.jarvisRootDir}`,
      `Node.js: ${ctx.nodeVersion} | Env: ${ctx.nodeEnv}`,
      `CPU cores: ${ctx.cpuCount} | ${memLine}`,
      `System uptime: ${Math.round(ctx.uptime / 3600)}h`,
      processLine,
    ].join('\n');
  }

  /**
   * Minimal context string — used when token budget is tight.
   * Contains only OS + path, nothing else.
   */
  getMinimalContext(): string {
    return [
      `OS: ${process.platform === 'win32' ? 'Windows' : process.platform} (${process.arch})`,
      `CWD: ${process.cwd()}`,
      `User: ${os.userInfo().username}`,
    ].join(' | ');
  }

  /**
   * Check if a specific application is currently running.
   * Used by skills/tools that have platform-specific behavior.
   */
  isProcessRunning(name: string): boolean {
    const processes = getCachedProcessList();
    return processes.some(p => p.toLowerCase().includes(name.toLowerCase()));
  }

  /**
   * Returns OS-appropriate path separator and shell info.
   * Useful for tools that construct shell commands.
   */
  getShellInfo(): { shell: string; separator: string; pathSep: string } {
    const isWindows = process.platform === 'win32';
    return {
      shell: isWindows
        ? (process.env['COMSPEC'] ?? 'cmd.exe')
        : (process.env['SHELL'] ?? '/bin/bash'),
      separator: isWindows ? '\\' : '/',
      pathSep: path.sep,
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const environmentContext = new EnvironmentContextEngine();

/**
 * Convenience export — direct call for the most common usage pattern:
 *   const ctx = getSystemContext();
 *   messages.push({ role: 'system', content: ctx.contextString });
 */
export function getSystemContext(includeProcesses = true): SystemContext {
  return environmentContext.getSystemContext(includeProcesses);
}
