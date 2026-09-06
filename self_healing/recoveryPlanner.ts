/**
 * recoveryPlanner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Decides WHAT to do for each classified failure.
 * Produces a RecoveryPlan — an ordered list of steps — without executing them.
 *
 * HIGH-4: RecoveryAction.meta now carries attempt + maxRestarts so RepairExecutor
 * can log them without maintaining its own counter.
 */

import type { ClassifiedFailure, FailureType } from "./failureClassifier.js";

// ─── Recovery Policies (Phase 8) ─────────────────────────────────────────

export interface RecoveryPolicy {
  /** Max number of restart/repair attempts before circuit-breaking */
  maxAttempts: number;
  /** Base delay in ms for the first backoff interval */
  baseDelayMs: number;
  /** Exponential backoff multiplier per attempt (e.g. 2 = double each time) */
  backoffMultiplier: number;
  /** Jitter factor 0.0–1.0: adds random ± jitter*delay to avoid thundering herd */
  jitterFactor: number;
  /** Circuit-breaker window ms: if maxAttempts fail within this window, break circuit */
  circuitWindowMs: number;
}

/** Policy overrides per failure type. Falls back to DEFAULT_POLICY. */
const POLICIES: Partial<Record<FailureType, RecoveryPolicy>> = {
  MissingDependency: {
    maxAttempts:       2,
    baseDelayMs:       5_000,
    backoffMultiplier: 1.5,
    jitterFactor:      0.1,
    circuitWindowMs:   60_000,
  },
  PythonProcessCrash: {
    maxAttempts:       3,
    baseDelayMs:       3_000,
    backoffMultiplier: 2,
    jitterFactor:      0.2,
    circuitWindowMs:   120_000,
  },
  WebSocketFailure: {
    maxAttempts:       5,
    baseDelayMs:       1_000,
    backoffMultiplier: 2,
    jitterFactor:      0.3,
    circuitWindowMs:   60_000,
  },
  RuntimeCrash: {
    maxAttempts:       3,
    baseDelayMs:       2_000,
    backoffMultiplier: 2,
    jitterFactor:      0.15,
    circuitWindowMs:   120_000,
  },
};

const DEFAULT_POLICY: RecoveryPolicy = {
  maxAttempts:       3,
  baseDelayMs:       3_000,
  backoffMultiplier: 2,
  jitterFactor:      0.2,
  circuitWindowMs:   120_000,
};

/**
 * Compute the recommended backoff delay for a given attempt number.
 * Includes exponential growth + bounded random jitter.
 */
export function computeBackoffMs(policy: RecoveryPolicy, attempt: number): number {
  const exp   = Math.min(attempt - 1, 8); // cap exponent to avoid huge numbers
  const base  = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, exp);
  const jitter = base * policy.jitterFactor * (Math.random() * 2 - 1); // ±jitter
  return Math.max(0, Math.round(base + jitter));
}

/** Get the recovery policy for a failure type. */
export function getRecoveryPolicy(type: FailureType): RecoveryPolicy {
  return POLICIES[type] ?? DEFAULT_POLICY;
}

// ─── Plan types ─────────────────────────────────────────────────────────────────────────

export type RecoveryActionKind =
  | "pip_install"
  | "restart_process"
  | "disable_module"
  | "fallback_tts"
  | "fallback_stt"
  | "reconnect_websocket"
  | "log_only";

export interface RecoveryAction {
  kind: RecoveryActionKind;
  target: string;
  /** HIGH-4: meta carries attempt/maxRestarts from SelfHealingManager */
  meta?: Record<string, string>;
}

export interface RecoveryPlan {
  failure: ClassifiedFailure;
  actions: RecoveryAction[];
  notify: boolean;
  /** Phase 8: The policy used for this recovery plan */
  policy: RecoveryPolicy;
  /** Phase 8: Recommended backoff delay before next attempt (ms) */
  recommendedDelayMs: number;
}

// ─── Module name → Python package mapping ────────────────────────────────────

const PYTHON_PACKAGE_MAP: Record<string, string> = {
  "speech_recognition": "SpeechRecognition pyaudio",
  "whisper":            "openai-whisper",
  "edge_tts":           "edge-tts",
  "pygame":             "pygame",
  "pyaudio":            "pyaudio",
  "numpy":              "numpy",
  "websockets":         "websockets",
};

// ─── Planner ──────────────────────────────────────────────────────────────────

export function planRecovery(
  failure: ClassifiedFailure,
  restartAttempt = 1,
  maxRestarts = 3
): RecoveryPlan {
  const actions: RecoveryAction[] = [];
  let notify = false;

  // Phase 8: Select and apply recovery policy
  const policy = getRecoveryPolicy(failure.type as FailureType);
  const effectiveMax = Math.min(maxRestarts, policy.maxAttempts);
  const recommendedDelayMs = computeBackoffMs(policy, restartAttempt);

  // Shared meta for restart actions
  const restartMeta: Record<string, string> = {
    attempt:            String(restartAttempt),
    maxRestarts:        String(effectiveMax),
    backoffMs:          String(recommendedDelayMs),
    circuitWindowMs:    String(policy.circuitWindowMs),
  };

  switch (failure.type as FailureType) {

    case "MissingDependency": {
      const pkg = detectMissingPythonPackage(failure.message);
      if (pkg) {
        actions.push({ kind: "pip_install", target: pkg, meta: restartMeta });
        actions.push({ kind: "restart_process", target: failure.module, meta: restartMeta });
      } else {
        actions.push({ kind: "disable_module", target: failure.module });
        notify = true;
      }
      break;
    }

    case "PythonProcessCrash": {
      actions.push({ kind: "restart_process", target: failure.module, meta: restartMeta });

      if (failure.module.includes("tts")) {
        actions.push({ kind: "fallback_tts", target: "pyttsx3" });
      }
      if (failure.module.includes("stt")) {
        actions.push({ kind: "fallback_stt", target: "speech_recognition" });
      }
      break;
    }

    case "WebSocketFailure": {
      actions.push({ kind: "reconnect_websocket", target: failure.module });
      break;
    }

    case "RuntimeCrash": {
      if (failure.severity === "critical") {
        actions.push({ kind: "restart_process", target: failure.module, meta: restartMeta });
        notify = true;
      } else {
        actions.push({ kind: "log_only", target: failure.module });
      }
      break;
    }

    default: {
      actions.push({ kind: "log_only", target: failure.module });
    }
  }

  return { failure, actions, notify, policy, recommendedDelayMs };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectMissingPythonPackage(message: string): string | null {
  const match = /no module named ['"]([\\w_]+)['"]/i.exec(message)
    ?? /name ['"]([\\w_]+)['"]/i.exec(message);

  if (!match) return null;
  const name = match[1] ?? "";

  const STDLIB = new Set(["os","sys","io","json","time","wave","asyncio","threading","queue","logging"]);
  if (STDLIB.has(name)) return null;

  return PYTHON_PACKAGE_MAP[name] ?? name;
}
