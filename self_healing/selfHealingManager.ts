/**
 * selfHealingManager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The SINGLE entry point for all self-healing.
 * Wires together: FailureDetector → FailureClassifier → RecoveryPlanner → RepairExecutor
 *
 * HIGH-4: SelfHealingManager is the SOLE authority on restart counts.
 *         restartCounts removed from RepairExecutor.
 *
 * PART B-2: Integrated with PipelineRegistry — reacts to pipeline mismatches
 *           at runtime, not just process crashes.
 *
 * PART B-3: Periodic health check loop — polls pipeline health every 60s.
 */

import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";

import { failureDetector, type FailureEvent } from "./failureDetector.js";
import { classifyFailure } from "./failureClassifier.js";
import { planRecovery } from "./recoveryPlanner.js";
import { repairExecutor } from "./repairExecutor.js";
import { fallbackRouter } from "./fallbackRouter.js";
import { nodeBridge } from "../bridge/nodeBridge.js";
import { pipelineRegistry } from "./pipelineRegistry.js";
import { groqProvider } from "../bridge/groqProvider.js";
import { memoryManager } from "../memory/memoryManager.js";
import { toolRegistryV2 } from "../core/toolRegistryV2.js";
import { conversationBus } from "../core/conversationBus.js";
// ── Phase 8: Self-Healing & Monitoring ─────────────────────────────────────────
import { failureAnalytics } from "./failureAnalytics.js";
import { alertManager } from "./alertManager.js";
import { healthScorer } from "./healthScorer.js";
import { healthChecker } from "./healthChecker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VOICE_DIR  = path.join(__dirname, "..", "voice");

// ─── Process Registry ─────────────────────────────────────────────────────────

interface ManagedProcess {
  name: string;
  script: string;
  proc: ChildProcess | null;
  restarts: number;          // HIGH-4: sole restart counter lives here
  disabledAt?: Date;
}

// ─── SelfHealingManager ───────────────────────────────────────────────────────

export class SelfHealingManager extends EventEmitter {
  private static instance: SelfHealingManager;
  private processes = new Map<string, ManagedProcess>();
  private readonly MAX_RESTARTS = 3;
  private readonly RESTART_BACKOFF_MS = 3_000;

  // PART B-3: Periodic health check interval handle
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private readonly HEALTH_CHECK_INTERVAL_MS = 60_000; // every 60 seconds

  private constructor() {
    super();

    // Subscribe to all failure events from the detector
    failureDetector.on("failure", (event: FailureEvent) => {
      void this.handleFailure(event);
    });
  }

  static getInstance(): SelfHealingManager {
    if (!SelfHealingManager.instance) {
      SelfHealingManager.instance = new SelfHealingManager();
    }
    return SelfHealingManager.instance;
  }

  // ── Process Management ────────────────────────────────────────────────────

  launchPythonService(scriptName: string, label: string): void {
    const entry: ManagedProcess = {
      name: label,
      script: scriptName,
      proc: null,
      restarts: 0,
    };
    this.processes.set(label, entry);
    this.spawnProcess(label);
  }

  private spawnProcess(label: string): void {
    const entry = this.processes.get(label);
    if (!entry || entry.disabledAt) {
      console.warn(`[SelfHeal] Skipping spawn of disabled module: ${label}`);
      return;
    }

    const scriptPath = path.join(VOICE_DIR, entry.script);
    
    // Resolve project root and virtual env python if it exists
    const projectRoot = path.resolve(__dirname, "..");
    const venvPython = process.platform === "win32"
      ? path.join(projectRoot, ".venv", "Scripts", "python.exe")
      : path.join(projectRoot, ".venv", "bin", "python");
    
    const pythonExe = fs.existsSync(venvPython)
      ? venvPython
      : (process.platform === "win32" ? "python" : "python3");

    console.log(`[SelfHealing] Python executable: ${pythonExe}`);
    console.log(`[SelfHeal] Spawning ${label} (${entry.script})…`);
    const proc = spawn(pythonExe, [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    entry.proc = proc;

    proc.stdout?.on("data", (d: Buffer) =>
      process.stdout.write(`[${label}] ${d}`)
    );

    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      process.stderr.write(`[${label}] ${text}`);

      // Only escalate genuine Python errors — not INFO/DEBUG log lines
      const isRealError = /traceback \(most recent call last\)|error:|exception:|critical:|failed to|oserror|valueerror|attributeerror|importerror|runtimeerror/i.test(text);
      if (isRealError) {
        failureDetector.reportError(text, label.toLowerCase());
      }
    });

    proc.on("error", (err) => {
      failureDetector.reportError(err, label.toLowerCase());
    });

    proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        failureDetector.reportError(
          `Process exited with code ${code}`,
          label.toLowerCase()
        );
        this.scheduleRestart(label);
      } else {
        console.log(`[SelfHeal] ${label} exited cleanly (code ${code}).`);
      }
    });
  }

  scheduleRestart(label: string, delayMs?: number): void {
    const entry = this.processes.get(label);
    if (!entry || entry.disabledAt) return;

    entry.restarts += 1;  // HIGH-4: count incremented only here

    if (entry.restarts > this.MAX_RESTARTS) {
      entry.disabledAt = new Date();
      repairExecutor.circuitBreak(label);
      // Phase 8: record circuit break in analytics + alert
      failureAnalytics.record(label, 'circuit_break', `Disabled after ${entry.restarts} restarts`);
      alertManager.critical(label, `Module "${label}" circuit-broken after ${entry.restarts} crashes`, 'SelfHealingManager');
      console.error(`[SelfHeal] 🔴 Circuit breaker: ${label} crashed ${entry.restarts} times. DISABLED.`);
      nodeBridge.speakToClients(`Sir, my ${label} module has failed repeatedly and has been disabled.`);
      return;
    }

    // Phase 8: use policy-driven backoff if provided, else default exponential
    const delay = delayMs ?? (this.RESTART_BACKOFF_MS * entry.restarts);
    console.warn(`[SelfHeal] Scheduling restart of ${label} in ${delay}ms (attempt ${entry.restarts}/${this.MAX_RESTARTS})…`);
    setTimeout(() => this.spawnProcess(label), delay);
  }

  // ── Failure Pipeline ──────────────────────────────────────────────────────

  private async handleFailure(event: FailureEvent): Promise<void> {
    const { failure } = event;

    if (failure.severity === "low") return;

    console.log(
      `[SelfHeal] Handling [${failure.type}] in ${failure.module} (${failure.severity})`
    );

    // Phase 8: Record to analytics
    failureAnalytics.record(failure.module, 'failure', `${failure.type}: ${failure.message ?? ''}`);

    // Phase 8: Raise an alert
    const alertSeverity = failure.severity === 'critical' ? 'critical' : 'warning';
    alertManager.raise(alertSeverity, failure.module, `${failure.type} detected in ${failure.module}`, 'SelfHealingManager');

    const entry = [...this.processes.values()].find(
      (p) => p.name.toLowerCase() === failure.module.toLowerCase()
    );
    const currentRestarts = entry?.restarts ?? 0;

    const plan = planRecovery(failure, currentRestarts + 1, this.MAX_RESTARTS);

    for (const action of plan.actions) {
      const result = await repairExecutor.execute(action);

      if (action.kind === "restart_process" && result.success) {
        const lbl = this.resolveLabel(action.target);
        // Phase 8: Use policy backoff delay for restart scheduling
        if (lbl) this.scheduleRestart(lbl, plan.recommendedDelayMs);
      }
    }

    if (plan.notify) {
      nodeBridge.speakToClients(
        `Sir, I have detected and am recovering from a ${failure.type} in my ${failure.module} system.`
      );
    }
  }

  // ── B-6: Handle Watchdog Actions ──────────────────────────────────────────

  async executeHealAction(pipeline: string, actionPlan: { action: string; target: string }): Promise<void> {
    console.log(`[SelfHeal] Executing action '${actionPlan.action}' on '${actionPlan.target}' for broken pipeline '${pipeline}'`);

    try {
      if (actionPlan.action === "retry_connection" && actionPlan.target === "groq") {
        console.log(`[SelfHeal] Pinging Groq API...`);
        await groqProvider.chat({ messages: [{ role: "user", content: "ping" }], max_tokens: 5 });
        pipelineRegistry.recordSuccess(pipeline);
        console.log(`[SelfHeal] Groq ping successful, pipeline '${pipeline}' healed.`);
      } 
      else if (actionPlan.action === "reinit_memory" && actionPlan.target === "memoryManager") {
        console.log(`[SelfHeal] Re-initializing memoryManager...`);
        await memoryManager.init();
        pipelineRegistry.recordSuccess(pipeline);
      } 
      else if (actionPlan.action === "reload_tools" && actionPlan.target === "toolExecutor") {
        console.log(`[SelfHeal] Reloading ToolExecutor...`);
        // toolRegistryV2.reload() not needed in V2
        pipelineRegistry.recordSuccess(pipeline);
      } 
      else if (actionPlan.action === "restart_process" || actionPlan.action === "restart_script") {
        let foundLabel = null;
        for (const [key, value] of this.processes.entries()) {
           if (key.toLowerCase() === actionPlan.target.toLowerCase() || value.script.toLowerCase() === actionPlan.target.toLowerCase()) {
               foundLabel = key;
               break;
           }
        }
        if (foundLabel) {
           this.scheduleRestart(foundLabel);
        } else {
           console.warn(`[SelfHeal] Target ${actionPlan.target} not managed directly by continuous process spawner. Skipping raw spawn.`);
        }
      }
    } catch (err) {
      console.error(`[SelfHeal] Failed to heal pipeline '${pipeline}' using action '${actionPlan.action}':`, err);
    }
  }

  // ── B-3: Periodic Health Checks ───────────────────────────────────────────

  /** Start a 60-second periodic health check loop for all pipeline segments. */
  startHealthChecks(): void {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = setInterval(() => {
      if (!conversationBus.isIdle) {
        console.log("[SelfHeal] 🩺 Health check skipped — JARVIS is active (conversation or speaking).");
        return;
      }
      this.runHealthCheck();
    }, this.HEALTH_CHECK_INTERVAL_MS);
    console.log(`[SelfHeal] 🩺 Health checks started (every ${this.HEALTH_CHECK_INTERVAL_MS / 1000}s).`);

    // Phase 8: Also start the proactive health checker
    healthChecker.start();
  }

  /** Stop the periodic health check loop. */
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    healthChecker.stop();
  }

  /** Check each managed process for missing/stale state and respawn if needed. */
  private runHealthCheck(): void {
    console.log("[SelfHeal] 🩺 Running periodic health check…");
    const report = pipelineRegistry.getHealth();

    // Phase 8: Score all pipelines and alert on poor health
    const scores = healthScorer.scoreAll(report);
    const systemScore = healthScorer.systemScore(scores);
    console.log(`[SelfHeal] 📊 System health score: ${systemScore}/100`);

    for (const hs of scores) {
      if (hs.band === 'critical') {
        alertManager.critical(hs.pipeline, hs.recommendation, 'HealthCheck');
      } else if (hs.band === 'poor') {
        alertManager.warn(hs.pipeline, hs.recommendation, 'HealthCheck');
      }
    }

    for (const [pipeline, health] of Object.entries(report)) {
      if (health.status === "unknown") {
        const label = this.resolveLabel(pipeline);
        if (label) {
          const entry = this.processes.get(label);
          if (entry && !entry.disabledAt && entry.proc === null) {
            console.warn(`[SelfHeal] Respawning never-started process for pipeline '${pipeline}'.`);
            this.spawnProcess(label);
          }
        }
      }
    }
  }

  /**
   * Phase 8: Generate a structured diagnostics report.
   * Runs an immediate probe round + health scoring + failure analytics digest.
   */
  async generateDiagnosticsReport(): Promise<{
    systemScore: number;
    scores: import('./healthScorer.js').HealthScore[];
    digest: import('./failureAnalytics.js').FailureDigest;
    probeResults: import('./healthChecker.js').ProbeResult[];
    alerts: import('./alertManager.js').Alert[];
    generatedAt: number;
  }> {
    console.log('[SelfHeal] 📈 Generating diagnostics report...');
    const [probeResults] = await Promise.allSettled([healthChecker.runNow()]);
    const results = probeResults.status === 'fulfilled' ? probeResults.value : [];

    const report   = pipelineRegistry.getHealth();
    const scores   = healthScorer.scoreAll(report);
    const sysScore = healthScorer.systemScore(scores);

    const allPipelines = [...failureAnalytics.trackedPipelines()];
    const digest = failureAnalytics.generateDigest(allPipelines);
    const recentAlerts = alertManager.getRecent(10);

    console.log(`[SelfHeal] 📈 Diagnostics: score=${sysScore} | probes=${results.length} | alerts=${recentAlerts.length}`);
    return {
      systemScore: sysScore,
      scores,
      digest,
      probeResults: results,
      alerts: recentAlerts,
      generatedAt: Date.now(),
    };
  }

  // ── External API ──────────────────────────────────────────────────────────

  reportError(err: unknown, module: string): void {
    failureDetector.reportError(err, module);
  }

  isModuleAvailable(label: string): boolean {
    const entry = this.processes.get(label);
    if (!entry) return false;
    return !entry.disabledAt;
  }

  getEngineStatus(): { tts: string; stt: string } {
    return fallbackRouter.getStatus();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private resolveLabel(target: string): string | null {
    for (const key of this.processes.keys()) {
      if (key.toLowerCase().includes(target.toLowerCase())) return key;
    }
    return null;
  }

  /**
   * Public getter for managed processes — used by FSWatcher without
   * resorting to (selfHealingManager as any).processes type-unsafe access.
   */
  getManagedProcesses(): Map<string, { name: string; script: string; proc: ChildProcess | null; restarts: number; disabledAt?: Date }> {
    return this.processes;
  }
}

export const selfHealingManager = SelfHealingManager.getInstance();
