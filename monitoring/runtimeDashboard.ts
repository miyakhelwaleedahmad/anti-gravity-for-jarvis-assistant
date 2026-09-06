/**
 * monitoring/runtimeDashboard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE 2 — Runtime Dashboard
 *
 * Renders a live ASCII terminal dashboard of JARVIS system health.
 * Updates at a configurable interval. Can be run standalone or embedded.
 *
 * Usage (standalone):
 *   npx tsx monitoring/runtimeDashboard.ts
 *
 * Usage (embedded in jarvis.ts):
 *   import { runtimeDashboard } from './monitoring/runtimeDashboard.js';
 *   runtimeDashboard.start(30_000); // refresh every 30s
 */

import { healthManager, HealthSnapshot, ServiceStatus } from './healthManager.js';
import { adaptiveRamManager } from '../core/adaptiveRamManager.js';

// ─── Render helpers ───────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';
const BLUE   = '\x1b[34m';

function statusColor(s: ServiceStatus): string {
  switch (s) {
    case 'online':   return GREEN;
    case 'degraded': return YELLOW;
    case 'offline':  return RED;
    default:         return DIM;
  }
}

function statusIcon(s: ServiceStatus): string {
  switch (s) {
    case 'online':   return '●';
    case 'degraded': return '◐';
    case 'offline':  return '○';
    default:         return '?';
  }
}

function bar(used: number, total: number, width = 20): string {
  const pct = total > 0 ? Math.min(used / total, 1) : 0;
  const filled = Math.round(pct * width);
  const empty  = width - filled;
  const color  = pct > 0.85 ? RED : pct > 0.65 ? YELLOW : GREEN;
  return `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.substring(0, len) : s + ' '.repeat(len - s.length);
}

// ─── Dashboard renderer ───────────────────────────────────────────────────────

class RuntimeDashboard {
  private timer: ReturnType<typeof setInterval> | null = null;
  private logEnabled = false;

  /** Start auto-refresh. intervalMs default = 15 000 (15s). */
  start(intervalMs = 15_000, enableLog = false): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.logEnabled = enableLog;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), intervalMs);
    this.timer.unref(); // Don't keep process alive for dashboard alone
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Probe and render immediately. */
  async refresh(): Promise<HealthSnapshot> {
    const snap = await healthManager.probe();
    this.render(snap);
    if (this.logEnabled) await healthManager.writeLog();
    return snap;
  }

  /** Render the dashboard to stdout. */
  render(snap: HealthSnapshot): void {
    const now = new Date(snap.timestamp).toLocaleTimeString();
    const m = snap.metrics;
    const overallColor = statusColor(snap.overallStatus);

    const lines: string[] = [];

    lines.push('');
    lines.push(`${BOLD}${CYAN}┌${'─'.repeat(60)}┐${RESET}`);
    lines.push(`${BOLD}${CYAN}│${RESET}  ${BOLD}🤖 JARVIS RUNTIME DASHBOARD${RESET}  ${DIM}${now}${RESET}${' '.repeat(18)}${CYAN}│${RESET}`);
    lines.push(`${BOLD}${CYAN}├${'─'.repeat(60)}┤${RESET}`);

    // Overall status
    lines.push(`${CYAN}│${RESET}  System: ${overallColor}${BOLD}${snap.overallStatus.toUpperCase()}${RESET}${' '.repeat(48 - snap.overallStatus.length)}${CYAN}│${RESET}`);
    lines.push(`${CYAN}├${'─'.repeat(60)}┤${RESET}`);

    // Services
    lines.push(`${CYAN}│${RESET}  ${BOLD}SERVICES${RESET}${' '.repeat(50)}${CYAN}│${RESET}`);

    const svcOrder = ['redis', 'vector_memory', 'llm', 'tool_registry', 'stt', 'tts', 'wake_word'];
    const svcLabels: Record<string, string> = {
      redis:          'Redis Cache       ',
      vector_memory:  'Vector Memory     ',
      llm:            'LLM (Groq/xAI)    ',
      tool_registry:  'Tool Registry     ',
      stt:            'STT (Whisper)     ',
      tts:            'TTS (Kokoro)      ',
      wake_word:      'Wake Word         ',
    };

    for (const key of svcOrder) {
      const svc = snap.services[key];
      if (!svc) continue;
      const col  = statusColor(svc.status);
      const icon = statusIcon(svc.status);
      const label = svcLabels[key] ?? pad(key, 18);
      const detail = svc.detail ? `  ${DIM}${svc.detail.substring(0, 22)}${RESET}` : '';
      const latency = svc.latencyMs != null ? `${DIM}${svc.latencyMs}ms${RESET}` : '    ';
      lines.push(`${CYAN}│${RESET}    ${col}${icon}${RESET} ${label} ${latency}${detail}${' '.repeat(Math.max(0, 57 - label.length - (svc.detail?.length ?? 0)))}${CYAN}│${RESET}`);
    }

    lines.push(`${CYAN}├${'─'.repeat(60)}┤${RESET}`);

    // Memory metrics
    lines.push(`${CYAN}│${RESET}  ${BOLD}PROCESS MEMORY & ADAPTIVE RAM${RESET}${' '.repeat(30)}${CYAN}│${RESET}`);
    const heapPct = m.heapTotalMB > 0 ? Math.round((m.heapUsedMB / m.heapTotalMB) * 100) : 0;
    lines.push(`${CYAN}│${RESET}    Heap  ${bar(m.heapUsedMB, m.heapTotalMB)}  ${pad(`${m.heapUsedMB}/${m.heapTotalMB} MB (${heapPct}%)`, 20)}${CYAN}│${RESET}`);
    const ramPct = m.totalRamMB > 0 ? Math.round(((m.totalRamMB - m.freeRamMB) / m.totalRamMB) * 100) : 0;
    lines.push(`${CYAN}│${RESET}    RAM   ${bar(m.totalRamMB - m.freeRamMB, m.totalRamMB)}  ${pad(`${m.freeRamMB} MB free (${100 - ramPct}%)`, 20)}${CYAN}│${RESET}`);
    
    // Adaptive RAM Stats
    const ramStats = adaptiveRamManager.getStats();
    const hitRatioPct = (ramStats.cacheHitRatio * 100).toFixed(1) + '%';
    const pressure = ramStats.pressureLevel;
    lines.push(`${CYAN}│${RESET}    RSS: ${BLUE}${m.rssMB} MB${RESET}  Hit Ratio: ${GREEN}${hitRatioPct}${RESET}  Pressure: ${CYAN}${pressure}${RESET}${' '.repeat(15)}${CYAN}│${RESET}`);

    lines.push(`${CYAN}├${'─'.repeat(60)}┤${RESET}`);

    // Active agents
    const agents = snap.activeAgents.length > 0 ? snap.activeAgents.join(', ') : 'none';
    lines.push(`${CYAN}│${RESET}  ${BOLD}ACTIVE AGENTS:${RESET} ${DIM}${agents.substring(0, 42)}${RESET}${' '.repeat(Math.max(0, 44 - agents.length))}${CYAN}│${RESET}`);

    lines.push(`${CYAN}└${'─'.repeat(60)}┘${RESET}`);
    lines.push('');

    console.log(lines.join('\n'));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── Singleton + standalone mode ──────────────────────────────────────────────

export const runtimeDashboard = new RuntimeDashboard();

// When run directly: npx tsx monitoring/runtimeDashboard.ts
if (process.argv[1]?.includes('runtimeDashboard')) {
  console.log('Starting JARVIS Runtime Dashboard — refreshing every 10s. Ctrl+C to exit.\n');
  runtimeDashboard.start(10_000, true);
}
