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
import { childEnv, looksSecret, PYTHON_UTF8 } from "../system/childEnv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VOICE_DIR  = path.join(__dirname, "..", "voice");

// ─── The voice services' environment (SEC-101) ───────────────────────────────

/**
 * Settings voice/*.py and vision/screen_capture.py read, and those of the
 * libraries they load: pygame (SDL_), faster-whisper and its model download
 * (HF_, CT2_), torch and its thread libraries (TORCH_, CUDA_, OMP_, MKL_, KMP_).
 * HF_TOKEN is not passed: the Whisper models are public.
 */
const VOICE_ENV_PREFIXES = ["JARVIS_TTS_", "JARVIS_STT_", "JARVIS_WW_", "JARVIS_WAKEWORD_", "TTS_", "STT_", "VISION_", "SDL_", "PYTHON",
  "HF_", "HUGGINGFACE_", "CT2_", "TORCH_", "CUDA_", "OMP_", "MKL_", "KMP_"];
/** edge-tts and speech recognition reach Microsoft and Google through the user's proxy, if any. */
const VOICE_ENV_NAMES = new Set(["BRIDGE_WS_URI", "JARVIS_BRIDGE_DEV_MODE", "LOG_LEVEL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "PULSE_SERVER", "XDG_CACHE_HOME", "TESSDATA_PREFIX"]);

/** The services' own settings from `env`; never a credential (the bridge token is added by the caller). */
export function voiceServiceEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || looksSecret(name)) continue;
    const upper = name.toUpperCase();
    if (VOICE_ENV_NAMES.has(upper) || VOICE_ENV_PREFIXES.some((p) => upper.startsWith(p))) out[name] = value;
  }
  return out;
}

// ─── Process Registry ─────────────────────────────────────────────────────────

interface ManagedProcess {
  name: string;
  script: string;
  proc: ChildProcess | null;
  restarts: number;          // HIGH-4: sole restart counter lives here
  disabledAt?: Date;
  /** The automatic restart waiting to start, if any (SH-1). */
  pendingRestart?: ReturnType<typeof setTimeout>;
  /** A stop-then-start in progress; other requests join it (SH-1 Option C). */
  replacing?: Promise<{ ok: boolean; reason: string }>;
}

// ─── SelfHealingManager ───────────────────────────────────────────────────────

export class SelfHealingManager extends EventEmitter {
  private static instance: SelfHealingManager;
  private processes = new Map<string, ManagedProcess>();
  /** Processes stopped on purpose (stop-then-start): their exit is not a crash. */
  private intendedStops = new WeakSet<ChildProcess>();
  private readonly MAX_RESTARTS = 3;
  private readonly RESTART_BACKOFF_MS = 3_000;
  /** How long the watchdog's and the file watcher's restarts wait for the old copy to exit. */
  private stopTimeoutMs = 10_000;

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
      // The bridge token and the services' own settings; no other key or
      // token from .env (SEC-101).
      env: childEnv({ ...PYTHON_UTF8, JARVIS_BRIDGE_TOKEN: process.env.JARVIS_BRIDGE_TOKEN, ...voiceServiceEnv() }),
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
      if (this.intendedStops.has(proc)) {
        console.log(`[SelfHeal] ${label} stopped for a requested restart (code ${code}).`);
        return;
      }
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

  /**
   * Option C (owner decision 2026-11-24). A process that has exited gets one
   * restart after the back-off, counted once however many times its exit was
   * reported (SH-1). A process still running (the file watcher's call after a
   * .py change) is stopped first and replaced once; a file change is not a
   * failure, so it is not counted.
   */
  scheduleRestart(label: string, delayMs?: number): void {
    const entry = this.processes.get(label);
    if (!entry || entry.disabledAt) return;

    if (entry.replacing) {
      console.log(`[SelfHeal] A restart of ${label} is already in progress; not starting another copy.`);
      return;
    }
    if (this.isRunning(entry.proc)) {
      void this.replaceProcess(label, entry, { count: false, stopTimeoutMs: this.stopTimeoutMs, why: 'restart requested' });
      return;
    }

    // One crash is reported up to three times (its traceback, its exit code,
    // the exit itself): it gets one restart and counts once (SH-1).
    if (entry.pendingRestart) {
      console.log(`[SelfHeal] A restart of ${label} is already scheduled; not starting another copy.`);
      return;
    }

    if (!this.countRestart(label, entry)) return;

    // Phase 8: use policy-driven backoff if provided, else default exponential
    const delay = delayMs ?? (this.RESTART_BACKOFF_MS * entry.restarts);
    console.warn(`[SelfHeal] Scheduling restart of ${label} in ${delay}ms (attempt ${entry.restarts}/${this.MAX_RESTARTS})…`);
    entry.pendingRestart = setTimeout(() => {
      entry.pendingRestart = undefined;
      if (entry.replacing || this.isRunning(entry.proc)) {
        console.log(`[SelfHeal] ${label} is already running again; not starting another copy.`);
        return;
      }
      this.spawnProcess(label);
    }, delay);
  }

  /** Counts one restart; false when that trips the circuit breaker (the service is then disabled). */
  private countRestart(label: string, entry: ManagedProcess): boolean {
    entry.restarts += 1;  // HIGH-4: count incremented only here

    if (entry.restarts > this.MAX_RESTARTS) {
      entry.disabledAt = new Date();
      repairExecutor.circuitBreak(label);
      // Phase 8: record circuit break in analytics + alert
      failureAnalytics.record(label, 'circuit_break', `Disabled after ${entry.restarts} restarts`);
      alertManager.critical(label, `Module "${label}" circuit-broken after ${entry.restarts} crashes`, 'SelfHealingManager');
      console.error(`[SelfHeal] 🔴 Circuit breaker: ${label} crashed ${entry.restarts} times. DISABLED.`);
      nodeBridge.speakToClients(`Sir, my ${label} module has failed repeatedly and has been disabled.`);
      return false;
    }
    return true;
  }

  /**
   * A restart asked for by a repair run (core/repairRun.ts): the running
   * process, if any, is stopped and waited for before a new one starts, so two
   * copies never run at once. Not counted as a crash; it replaces an automatic
   * restart that is still waiting, and joins a stop-then-start in progress.
   */
  async restartService(label: string, stopTimeoutMs = 10_000): Promise<{ ok: boolean; reason: string }> {
    const key = [...this.processes.keys()].find((k) => k.toLowerCase() === label.toLowerCase());
    const entry = key ? this.processes.get(key) : undefined;
    if (!key || !entry) return { ok: false, reason: `${label} is not started by JARVIS in this run, so it cannot be restarted from here` };
    if (entry.disabledAt) {
      return { ok: false, reason: `${key} was disabled after repeated crashes at ${entry.disabledAt.toISOString()}; restart JARVIS to enable it again` };
    }
    return this.replaceProcess(key, entry, { count: false, stopTimeoutMs, why: 'restart requested' });
  }

  /**
   * Stop-then-start (SH-1 Option C): cancel a waiting automatic restart, stop
   * the running copy and wait for it to exit, then start one. A request while
   * one is in progress joins it. If the old copy does not exit in time, no
   * second copy is started and the failure is returned.
   */
  private replaceProcess(key: string, entry: ManagedProcess, opts: { count: boolean; stopTimeoutMs: number; why: string }): Promise<{ ok: boolean; reason: string }> {
    if (entry.replacing) return entry.replacing;
    const run = (async (): Promise<{ ok: boolean; reason: string }> => {
      await null;   // entry.replacing is set before any of this runs
      try {
        if (entry.disabledAt) return { ok: false, reason: `${key} was disabled after repeated failures; restart JARVIS to enable it again` };
        this.cancelPendingRestart(entry);
        if (opts.count && !this.countRestart(key, entry)) return { ok: false, reason: `${key} was disabled after repeated failures` };
        const old = entry.proc;
        if (this.isRunning(old)) {
          this.intendedStops.add(old);
          const exited = new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), opts.stopTimeoutMs);
            old.once("exit", () => { clearTimeout(timer); resolve(true); });
          });
          old.kill();
          if (!(await exited)) {
            const reason = `${key} did not stop within ${Math.round(opts.stopTimeoutMs / 1000)} s; no second copy was started`;
            console.error(`[SelfHeal] ${reason}.`);
            return { ok: false, reason };
          }
        }
        this.cancelPendingRestart(entry);   // also one scheduled while the old process stopped
        console.log(`[SelfHeal] ${key}: ${opts.why}; the old copy has exited, starting one.`);
        this.spawnProcess(key);
        return { ok: true, reason: `${key} restarted` };
      } finally {
        entry.replacing = undefined;
      }
    })();
    entry.replacing = run;
    return run;
  }

  /** A started process that has not exited (a failed spawn has no pid). */
  private isRunning(proc: ChildProcess | null): proc is ChildProcess {
    return !!proc && proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null;
  }

  /** This start replaces an automatic restart still waiting (SH-1). */
  private cancelPendingRestart(entry: ManagedProcess): void {
    if (!entry.pendingRestart) return;
    clearTimeout(entry.pendingRestart);
    entry.pendingRestart = undefined;
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
      if (action.kind === "restart_process") {
        const lbl = this.resolveLabel(action.target);
        const target = lbl ? this.processes.get(lbl) : undefined;
        // An error from a service that is still running is not a crash: it is
        // recorded above, not restarted and not counted (SH-1 Option C). If the
        // service then exits, its exit restarts it.
        if (target && this.isRunning(target.proc)) {
          console.log(`[SelfHeal] ${lbl} reported an error but is still running: recorded, not restarted.`);
          continue;
        }
      }
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
      // "groq" is the old target name for the same thing: the configured LLM provider.
      if (actionPlan.action === "retry_connection" && (actionPlan.target === "llm" || actionPlan.target === "groq")) {
        // A model listing, not a generated reply: no quota spent, and it cannot
        // come back empty because a thinking model used its token budget.
        console.log(`[SelfHeal] Checking the LLM API...`);
        await groqProvider.ping();
        pipelineRegistry.recordSuccess(pipeline);
        console.log(`[SelfHeal] LLM API reachable, pipeline '${pipeline}' healed.`);
      } 
      else if (actionPlan.action === "reinit_memory" && actionPlan.target === "memoryManager") {
        console.log(`[SelfHeal] Re-initializing memoryManager...`);
        await memoryManager.init();
        pipelineRegistry.recordSuccess(pipeline);
      } 
      else if (actionPlan.action === "reload_tools") {
        // The plan names "toolRegistryV2"; this branch checked "toolExecutor", so it never ran.
        // Tools are registered once at startup; the check is that they still are.
        const { toolRegistryV2 } = await import("../core/toolRegistryV2.js");
        const count = toolRegistryV2.names().length;
        if (count > 0) {
          console.log(`[SelfHeal] Tool registry holds ${count} tools; pipeline '${pipeline}' healed.`);
          pipelineRegistry.recordSuccess(pipeline);
        } else {
          console.warn("[SelfHeal] Tool registry is empty; restart JARVIS to register the tools.");
        }
      }
      else if (actionPlan.action === "supervised") {
        // Vector memory: vectorMemorySupervisor restarts the Python service itself.
        console.log(`[SelfHeal] '${pipeline}' is restarted by its own supervisor (${actionPlan.target}); nothing to do here.`);
      } 
      else if (actionPlan.action === "restart_process" || actionPlan.action === "restart_script") {
        let foundLabel = null;
        for (const [key, value] of this.processes.entries()) {
           if (key.toLowerCase() === actionPlan.target.toLowerCase() || value.script.toLowerCase() === actionPlan.target.toLowerCase()) {
               foundLabel = key;
               break;
           }
        }
        const found = foundLabel ? this.processes.get(foundLabel) : undefined;
        if (foundLabel && found && (this.isRunning(found.proc) || found.replacing)) {
           // The pipeline is broken while its process runs: it is stuck. Stop it,
           // wait for it to exit, then start one; counted (SH-1 Option C).
           const res = await this.replaceProcess(foundLabel, found, { count: true, stopTimeoutMs: this.stopTimeoutMs, why: `pipeline '${pipeline}' is broken` });
           if (!res.ok) console.error(`[SelfHeal] Watchdog restart of ${foundLabel} failed: ${res.reason}`);
        } else if (foundLabel) {
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
