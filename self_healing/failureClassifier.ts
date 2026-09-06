/**
 * failureClassifier.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Categorises raw errors into typed, actionable failure records.
 * Everything flowing into the self-healing system passes through here first.
 */

// ─── Failure Types ────────────────────────────────────────────────────────────

export type FailureType =
  | "MissingDependency"
  | "RuntimeCrash"
  | "WebSocketFailure"
  | "PythonProcessCrash"
  | "UnknownError";

export type FailureSeverity = "low" | "medium" | "critical";

export interface ClassifiedFailure {
  type: FailureType;
  severity: FailureSeverity;
  module: string;           // which subsystem failed (tts, stt, wakeword, brain, …)
  message: string;
  raw: unknown;
  timestamp: Date;
}

// ─── Rules ────────────────────────────────────────────────────────────────────

const MISSING_DEP_PATTERNS = [
  /no module named/i,
  /modulenotfounderror/i,
  /cannot find module/i,
  /importerror/i,
  /nameerror.*is not defined/i,
  /\bpip\b.*not found/i,
];

const WEBSOCKET_PATTERNS = [
  /websocket/i,
  /econnrefused/i,
  /connection reset/i,
  /epipe/i,
  /connection closed/i,
  /clientconnection/i,
];

const PYTHON_CRASH_PATTERNS = [
  /traceback \(most recent call last\)/i,
  /exited with code [^0]/i,
  /syntaxerror/i,
  /attributeerror/i,
];

// ─── Classify ─────────────────────────────────────────────────────────────────

export function classifyFailure(
  raw: unknown,
  module: string = "unknown"
): ClassifiedFailure {
  const message = extractMessage(raw);

  const type = detectType(message);
  const severity = detectSeverity(type, message);

  return {
    type,
    severity,
    module,
    message,
    raw,
    timestamp: new Date(),
  };
}

function extractMessage(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) return raw.stack ?? raw.message;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function detectType(message: string): FailureType {
  if (MISSING_DEP_PATTERNS.some((p) => p.test(message))) return "MissingDependency";
  if (WEBSOCKET_PATTERNS.some((p) => p.test(message)))    return "WebSocketFailure";
  if (PYTHON_CRASH_PATTERNS.some((p) => p.test(message))) return "PythonProcessCrash";
  if (/error|exception|fatal/i.test(message))             return "RuntimeCrash";
  return "UnknownError";
}

function detectSeverity(type: FailureType, message: string): FailureSeverity {
  if (type === "MissingDependency") return "critical";
  if (type === "PythonProcessCrash") {
    // A permanent crash (exit code ≠ 0 in loop) is critical, a one-off is medium
    return /exited with code [^0]/.test(message) ? "critical" : "medium";
  }
  if (type === "WebSocketFailure") return "medium";
  if (type === "RuntimeCrash")     return "medium";
  return "low";
}
