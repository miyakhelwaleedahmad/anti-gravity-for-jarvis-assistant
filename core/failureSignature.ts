/**
 * core/failureSignature.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One identity and one category for a failure, shared by every layer that
 * sees failures (self-healing architecture, Phase 2).
 *
 * Three classifiers existed, each with its own taxonomy: self_healing/
 * failureClassifier.ts (service crashes), core/reflectionEngine.ts (failed
 * steps) and core/goalRecovery.ts (goal tasks). The same failure seen by two
 * of them had nothing in common, so a returning failure was never recognised.
 * They keep their own classes for their own decisions (retry, re-plan,
 * restart); this module gives all of them the same signature and category.
 *
 * The signature is a hash of the component, the tool (if any) and the message
 * with volatile parts replaced (numbers, ids, paths, quoted values, URLs), so
 * "timed out after 5012 ms" and "timed out after 4987 ms" are one failure,
 * while "cannot read 'x'" and "connection refused" stay two.
 */

import { createHash } from 'crypto';

/**
 * runtime     a service crashed, disconnected or timed out locally: often a restart fixes it
 * code_defect an exception that points at JARVIS's own code (TypeError, AttributeError, …)
 * external    a provider, the network, a rate limit or a rejected key
 * permission  refused by policy or by the owner (not a fault to repair)
 * environment something missing on this machine: a program, a module, a device
 * unknown     none of the above can be said
 */
export type FailureCategory = 'runtime' | 'code_defect' | 'external' | 'permission' | 'environment' | 'unknown';

export interface FailureSignature {
  /** Stable id: "sig-" + 12 hex characters. */
  id: string;
  component: string;
  tool?: string;
  category: FailureCategory;
  /** The message with volatile parts replaced, as hashed. */
  normalized: string;
}

export interface FailureInput {
  /** Which part of JARVIS: "tool:open_app", "service:tts", "brain_to_llm", "orchestrator", … */
  component: string;
  message: string;
  tool?: string;
  /** A machine code when the caller has one (APPROVAL_DENIED, RATE_LIMITED, …). */
  code?: string;
}

/**
 * The line that names the failure: the exception line of a Python traceback
 * (its last line), otherwise the first non-empty line. A stack trace below it
 * is location, not identity (core/sourceLocation.ts reads it).
 */
export function headline(message: string): string {
  const lines = String(message).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  if (/Traceback \(most recent call last\)/.test(lines[0]!)) {
    const exc = [...lines].reverse().find((l) => !/^(File "|Traceback )/.test(l) && /^[A-Za-z_.]+(Error|Exception|Exit|Interrupt|Warning)\b/.test(l));
    return exc ?? lines[lines.length - 1]!;
  }
  return lines[0]!;
}

/**
 * The message with the error's class in front ("TypeError: …") when the
 * caller kept only `err.message`: the class is part of what failed, and every
 * layer then names the same thrown error the same way.
 */
export function withErrorName(message: string, error?: unknown): string {
  if (!(error instanceof Error) || !error.name || error.name === 'Error') return message;
  return message.startsWith(error.name) ? message : `${error.name}: ${message}`;
}

/** Replaces the parts of a message that change between occurrences of the same failure. */
export function normalizeMessage(message: string): string {
  return String(message)
    .replace(/\u001b\[[0-9;]*m/g, '')                                        // terminal colours
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/(?:[A-Za-z]:\\|\\\\|\/)(?:[^\s'"():,]+[\\/])+[^\s'"():,]*/g, '<path>') // file paths
    .replace(/"[^"\n]{0,200}"|'[^'\n]{0,200}'|`[^`\n]{0,200}`/g, '<q>')          // quoted values
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b(?:tts|req|call|goal|task|graph|node|ep|trace)[-_][0-9a-z_-]+/gi, '<id>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 240);
}

const CATEGORY_RULES: [RegExp, FailureCategory][] = [
  [/\b(permission|denied|not approved|did not approve|approval|refused by|risk_refused|not_allowed|full control|policy)\b/i, 'permission'],
  [/\b(401|403|unauthori[sz]ed|forbidden|api.?key|rate.?limit|429|50[0234]|overloaded|econnrefused|enotfound|eai_again|econnreset|fetch failed|socket hang up|network|dns|provider|quota|service unavailable)\b/i, 'external'],
  [/\b(no module named|module not found|cannot find module|enoent|not installed|command not found|is not recognized|no (?:audio|output) device|microphone|no default (?:input|output)|requires windows|needs windows|\.venv|pwsh)\b/i, 'environment'],
  [/\b(typeerror|referenceerror|syntaxerror|rangeerror|cannot read propert(?:y|ies)|is not a function|is not defined|undefined is not|attributeerror|keyerror|indexerror|nameerror|assertion|unexpected token)\b/i, 'code_defect'],
  [/\b(crash|exited with code|exit code|killed|sigkill|sigterm|disconnected|websocket|epipe|timed? ?out|timeout|stalled|not ready|hung)\b/i, 'runtime'],
];

/** The shared category of a failure message (one taxonomy for all layers). */
export function categorize(message: string, code?: string): FailureCategory {
  const text = `${code ?? ''} ${message}`;
  for (const [re, cat] of CATEGORY_RULES) if (re.test(text)) return cat;
  return 'unknown';
}

export function failureSignature(input: FailureInput): FailureSignature {
  const normalized = normalizeMessage(headline(input.message));
  const id = 'sig-' + createHash('sha256')
    .update(`${input.component}\n${input.tool ?? ''}\n${normalized}`)
    .digest('hex')
    .slice(0, 12);
  return {
    id,
    component: input.component,
    ...(input.tool ? { tool: input.tool } : {}),
    category: categorize(headline(input.message), input.code),
    normalized,
  };
}
