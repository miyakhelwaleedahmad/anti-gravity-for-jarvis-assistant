/**
 * failureDetector.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Watches Python child processes and WebSocket events in real-time.
 * Emits structured FailureEvent objects to whoever is listening (selfHealingManager).
 */

import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { classifyFailure, type ClassifiedFailure } from "./failureClassifier.js";
import { recordFailure } from "../core/issueStore.js";

/** The effect pipeline a Python service serves: its issues resolve when that effect works again. */
const SERVICE_PIPELINE: Record<string, string> = { tts: "brain_to_tts", stt: "stt_to_brain", wakeword: "wake_to_stt" };

// ─── Public event shape ───────────────────────────────────────────────────────

export interface FailureEvent {
  failure: ClassifiedFailure;
  /** PID of crashed process, if applicable */
  pid?: number;
}

// ─── FailureDetector ──────────────────────────────────────────────────────────

export class FailureDetector extends EventEmitter {
  private static instance: FailureDetector;

  private constructor() {
    super();
    // Prevent Node from throwing on unhandled 'failure' listeners
    this.setMaxListeners(20);
  }

  static getInstance(): FailureDetector {
    if (!FailureDetector.instance) {
      FailureDetector.instance = new FailureDetector();
    }
    return FailureDetector.instance;
  }

  // ── Watch a Python child process for crashes ──────────────────────────────

  watchProcess(proc: ChildProcess, moduleName: string): void {
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      // ✅ FIXED: Robust error detection avoiding false positives
      const isRealError = /(traceback \(most recent call last\)|exception:|critical:|oserror|valueerror|runtimeerror)/i.test(text);
      const isFalsePositive = /(without error|0 errors|no errors|info:)/i.test(text);
      
      if (isRealError && !isFalsePositive) {
        this.report(text, moduleName, proc.pid);
      }
    });

    proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        this.report(
          `Process exited with code ${code}`,
          moduleName,
          proc.pid
        );
      }
    });

    proc.on("error", (err) => {
      this.report(err, moduleName, proc.pid);
    });
  }

  // ── Report a WebSocket failure ────────────────────────────────────────────

  reportWebSocketFailure(err: unknown, context: string): void {
    this.report(err, `websocket:${context}`);
  }

  // ── Report any arbitrary error ────────────────────────────────────────────

  reportError(err: unknown, moduleName: string): void {
    this.report(err, moduleName);
  }

  // ── Internal emit ─────────────────────────────────────────────────────────

  private report(raw: unknown, module: string, pid?: number): void {
    const failure = classifyFailure(raw, module);

    const event: FailureEvent = { failure, pid };
    this.emit("failure", event);

    // The persistent record: one occurrence, deduplicated into one issue per signature.
    const pipeline = SERVICE_PIPELINE[module];
    recordFailure({
      component: failure.signature.component,
      message: failure.message,
      error: raw,
      ...(pipeline ? { pipeline } : {}),
      severity: failure.severity === "critical" ? "high" : failure.severity,
    });

    // Always log so we have a record
    console.error(
      `[FailureDetector] [${failure.severity.toUpperCase()}] [${failure.type}] in ${module}: ${failure.message.slice(0, 200)}`
    );
  }
}

export const failureDetector = FailureDetector.getInstance();
