/**
 * self_healing/repairExecutor.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Executes recovery actions produced by RecoveryPlanner.
 * Every command is safety-checked before execution.
 * Shell injection and destructive commands are explicitly blocked.
 *
 * HIGH-4: restartCounts removed — SelfHealingManager is the sole authority
 * on restart counts. This class executes actions only; it does not track state.
 */

import { execa } from "execa";
import type { RecoveryAction } from "./recoveryPlanner.js";
import { fallbackRouter } from "./fallbackRouter.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  action: RecoveryAction;
  success: boolean;
  output: string;
  error?: string;
}

// ─── Safety allowlist for pip packages ────────────────────────────────────────

const SAFE_PACKAGES = new Set([
  "SpeechRecognition",
  "pyaudio",
  "faster-whisper",
  "edge-tts",
  "pygame",
  "numpy",
  "websockets",
  "pyttsx3",
  "difflib",
]);

// ─── RepairExecutor ───────────────────────────────────────────────────────────

export class RepairExecutor {
  private static instance: RepairExecutor;

  /** Modules that have been permanently disabled via circuit-breaker */
  private disabledModules = new Set<string>();

  private constructor() {}

  static getInstance(): RepairExecutor {
    if (!RepairExecutor.instance) {
      RepairExecutor.instance = new RepairExecutor();
    }
    return RepairExecutor.instance;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async execute(action: RecoveryAction): Promise<ExecutionResult> {
    if (this.disabledModules.has(action.target)) {
      return this.result(action, false, "", `Module "${action.target}" is circuit-broken — skipped.`);
    }

    switch (action.kind) {
      case "pip_install":         return this.runPipInstall(action);
      case "restart_process":     return this.restartProcess(action);
      case "disable_module":      return this.disableModule(action);
      case "fallback_tts":        return this.activateFallbackTTS(action);
      case "fallback_stt":        return this.activateFallbackSTT(action);
      case "reconnect_websocket": return this.reconnectWS(action);
      case "log_only":            return this.logOnly(action);
    }
  }

  isDisabled(module: string): boolean {
    return this.disabledModules.has(module);
  }

  /** Called by SelfHealingManager when it circuit-breaks a module */
  circuitBreak(module: string): void {
    this.disabledModules.add(module);
    console.error(`[RepairExecutor] Circuit breaker engaged for "${module}".`);
  }

  resetCircuitBreaker(module: string): void {
    this.disabledModules.delete(module);
    console.log(`[RepairExecutor] Circuit breaker reset for "${module}".`);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private async runPipInstall(action: RecoveryAction): Promise<ExecutionResult> {
    const packages = action.target.trim().split(/\s+/);

    const blocked = packages.filter((p) => !SAFE_PACKAGES.has(p));
    if (blocked.length > 0) {
      return this.result(
        action, false, "",
        `BLOCKED: Package(s) not on allowlist: ${blocked.join(", ")}`
      );
    }

    console.log(`[RepairExecutor] pip install ${packages.join(" ")}…`);
    try {
      const pythonExe = process.platform === "win32" ? "python" : "python3";
      const result = await execa(pythonExe, ["-m", "pip", "install", ...packages], {
        timeout: 120_000,
        reject: false,
      });

      const success = result.exitCode === 0;
      return this.result(action, success, result.stdout, success ? undefined : result.stderr);
    } catch (err) {
      return this.result(action, false, "", String(err));
    }
  }

  private restartProcess(action: RecoveryAction): ExecutionResult {
    // HIGH-4: Restart count is tracked in SelfHealingManager only.
    // meta.attempt is passed in by the manager for logging purposes.
    const attempt = action.meta?.["attempt"] ?? "?";
    const maxRestarts = action.meta?.["maxRestarts"] ?? "?";
    console.warn(`[RepairExecutor] Restart intent logged for "${action.target}" (attempt ${attempt}/${maxRestarts}).`);
    return this.result(action, true, `Restart requested (${attempt}/${maxRestarts})`);
  }

  private disableModule(action: RecoveryAction): ExecutionResult {
    this.disabledModules.add(action.target);
    console.warn(`[RepairExecutor] Module "${action.target}" permanently disabled.`);
    return this.result(action, true, `"${action.target}" disabled.`);
  }

  private activateFallbackTTS(action: RecoveryAction): ExecutionResult {
    const next = fallbackRouter.markTTSFailed(fallbackRouter.getTTSEngine());
    const msg = next ? `TTS switched to fallback: ${next}` : "All TTS engines exhausted.";
    return this.result(action, !!next, msg);
  }

  private activateFallbackSTT(action: RecoveryAction): ExecutionResult {
    const next = fallbackRouter.markSTTFailed(fallbackRouter.getSTTEngine());
    const msg = next ? `STT switched to fallback: ${next}` : "All STT engines exhausted.";
    return this.result(action, !!next, msg);
  }

  private reconnectWS(action: RecoveryAction): ExecutionResult {
    console.log(`[RepairExecutor] WebSocket reconnect signalled for "${action.target}".`);
    return this.result(action, true, "WebSocket reconnect noted. Client will retry automatically.");
  }

  private logOnly(action: RecoveryAction): ExecutionResult {
    console.log(`[RepairExecutor] Log-only action for "${action.target}".`);
    return this.result(action, true, "Logged.");
  }

  // ── Helper ────────────────────────────────────────────────────────────────

  private result(
    action: RecoveryAction,
    success: boolean,
    output: string,
    error?: string
  ): ExecutionResult {
    if (!success) {
      console.error(`[RepairExecutor] Action "${action.kind}" FAILED for "${action.target}": ${error}`);
    } else {
      console.log(`[RepairExecutor] Action "${action.kind}" OK for "${action.target}": ${output}`);
    }
    return { action, success, output, error };
  }
}

export const repairExecutor = RepairExecutor.getInstance();
