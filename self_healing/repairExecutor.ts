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
import * as fs from "fs";
import * as path from "path";
import type { RecoveryAction } from "./recoveryPlanner.js";
import { fallbackRouter } from "./fallbackRouter.js";
import { approvalGate } from "../security/approvalGate.js";
import { childEnv } from "../system/childEnv.js";
import { getWorkspaceRoot } from "../core/workspaceRoot.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  action: RecoveryAction;
  success: boolean;
  output: string;
  error?: string;
}

// ─── Safety allowlist for pip packages ────────────────────────────────────────

// SEC-15: difflib was listed, but it is part of Python: "pip install difflib"
// fetches whatever a stranger publishes under that name on PyPI.
const SAFE_PACKAGES = new Set([
  "SpeechRecognition",
  "pyaudio",
  "faster-whisper",
  "edge-tts",
  "pygame",
  "numpy",
  "websockets",
  "pyttsx3",
]);

/**
 * The version rule requirements.txt gives a package ("edge-tts>=7.2.7,<8"), or
 * null when it has none. Installs follow the project's file, not "latest".
 */
export function requirementFor(pkg: string, requirementsText: string): string | null {
  const wanted = pkg.toLowerCase().replace(/_/g, "-");
  for (const raw of requirementsText.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z0-9_.-]+)\s*((?:==|>=|~=|<=|>|<)[^;\s]+(?:\s*,\s*(?:==|>=|~=|<=|>|<)[^;\s]+)*)\s*$/.exec(line);
    if (m && m[1]!.toLowerCase().replace(/_/g, "-") === wanted) return `${m[1]}${m[2]!.replace(/\s+/g, "")}`;
  }
  return null;
}

/** JARVIS's own Python (the .venv its voice and memory services run in), or null. */
export function venvPython(root = getWorkspaceRoot()): string | null {
  const p = process.platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python3");
  return fs.existsSync(p) ? p : null;
}

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

    // SEC-15: only the versions requirements.txt names, only into JARVIS's
    // .venv (REL-08: the system Python is not where the services run), and
    // only with the owner's yes — this downloads and runs code from PyPI.
    const root = getWorkspaceRoot();
    let requirements = "";
    try { requirements = fs.readFileSync(path.join(root, "requirements.txt"), "utf8"); } catch { /* none */ }
    const specs = packages.map((p) => requirementFor(p, requirements));
    const unpinned = packages.filter((_, i) => !specs[i]);
    if (unpinned.length > 0) {
      return this.result(action, false, "", `BLOCKED: no version in requirements.txt for: ${unpinned.join(", ")}`);
    }
    const python = venvPython(root);
    if (!python) {
      return this.result(action, false, "", "BLOCKED: JARVIS's .venv was not found; install the Python packages with the setup steps (pip install -r requirements.txt inside .venv).");
    }
    // Quoted: in CMD and PowerShell the > and < of a version range are redirections.
    const command = `${path.relative(root, python)} -m pip install ${specs.map((s) => `"${s}"`).join(" ")}`;
    const approved = await approvalGate.requestApproval(
      "Install Python package",
      `Install: ${specs.join(" ")}`,
      "HIGH_RISK",
      `A JARVIS module failed because ${packages.join(", ")} is missing. Installing downloads it from PyPI: ${command}`,
    );
    if (!approved) {
      return this.result(action, false, "", `Not installed: the owner did not approve. To install it yourself: ${command}`);
    }

    console.log(`[RepairExecutor] ${command}…`);
    try {
      const result = await execa(python, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...specs!.map(String)], {
        timeout: 120_000,
        reject: false,
        cwd: root,
        env: childEnv(),
        extendEnv: false,
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
    // It used to move fallbackRouter's label and report "TTS switched to
    // fallback", although tts.py never read the label (VOICE-003). Nothing is
    // switched from here; the voice that played is on speaking_end (engine).
    return this.result(action, true, "No switch needed: tts.py picks an offline voice per phrase when edge-tts gives no audio.");
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
