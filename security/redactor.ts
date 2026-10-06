/**
 * security/redactor.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Replaces credentials in text with a marker that keeps their kind, e.g.
 * `[REDACTED:github-token]` (docs/upgrade/SECURITY_MODEL.md).
 *
 * Used wherever text leaves JARVIS's hands: approval requests (P3), and tool
 * output on its way to the LLM, memory and logs (P4). The patterns match the
 * shapes of real credentials; nothing here knows any real value.
 */

export interface Redaction {
  text: string;
  /** How many values were replaced. */
  count: number;
  /** The kinds found, without repeats. */
  kinds: string[];
}

type Rule = readonly [kind: string, pattern: RegExp, keep?: string, quote?: string];

const SECRET_NAMES = '(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token)';

/**
 * Order matters: whole blocks and specific formats first, so that the generic
 * `name = value` rules below do not cut a key in half.
 * `keep` is the part of the match left in place (a `$1` prefix).
 */
const RULES: readonly Rule[] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{30,}/g],
  ['google-key', /\bAQ\.[0-9A-Za-z_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g],
  ['groq-key', /\bgsk_[A-Za-z0-9]{20,}/g],
  ['github-token', /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/g],
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer', /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, '$1'],
  ['cookie', /^(\s*(?:set-)?cookie\s*:\s*).+$/gim, '$1'],
  ['url-credentials', /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/gi, '$1'],
  // .env lines: NAME=value where the name says what it is.
  ['env-secret', /^(\s*(?:export\s+)?[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*\s*=\s*)\S.*$/gm, '$1'],
  // name: value / name=value pairs in prose, JSON or a command line. A quoted
  // value keeps its quotes, so JSON output stays valid JSON.
  ['secret', new RegExp(`\\b(${SECRET_NAMES}["']?\\s*[:=]\\s*)"(?:[^"\\\\\\n]|\\\\.){4,}"`, 'gi'), '$1', '"'],
  ['secret', new RegExp(`\\b(${SECRET_NAMES}["']?\\s*[:=]\\s*)'[^'\\n]{4,}'`, 'gi'), '$1', "'"],
  ['secret', new RegExp(`\\b(${SECRET_NAMES}["']?\\s*[:=]\\s*)[^\\s"',;{}]{4,}`, 'gi'), '$1'],
  // The way it is said: "my wifi password is …".
  ['secret', /\b((?:password|passwd|passphrase|passcode)\s+(?:is|was)\s+)["']?[^\s"',;]{4,}["']?/gi, '$1'],
  // A key cut short (text shortened before it reached here): the known prefix
  // and what is left of it, at the end of a line or before an ellipsis.
  ['truncated-key', /\b(?:AIza|AQ\.|sk-(?:proj-|ant-)?|gsk_|gh[posur]_|github_pat_|xox[abprs]-|AKIA|ASIA|eyJ)[A-Za-z0-9_.-]{4,}(?=…|\.\.\.|$)/gm],
];

export function redactSecrets(input: string): Redaction {
  if (!input) return { text: input ?? '', count: 0, kinds: [] };
  let text = input;
  let count = 0;
  const kinds = new Set<string>();
  for (const [kind, pattern, keep, quote = ''] of RULES) {
    text = text.replace(pattern, (...m: unknown[]) => {
      const match = m[0] as string;
      // Already replaced by an earlier rule.
      if (match.includes('[REDACTED:')) return match;
      count++;
      kinds.add(kind);
      const prefix = keep ? (m[1] as string) : '';
      return `${prefix}${quote}[REDACTED:${kind}]${quote}`;
    });
  }
  return { text, count, kinds: [...kinds] };
}

/** The text with credentials replaced. If redaction itself fails, nothing of the text is kept. */
export function redact(input: string): string {
  try {
    return redactSecrets(input).text;
  } catch {
    return '[REDACTED]';
  }
}

/** True when the text holds something shaped like a credential. */
export function hasSecret(input: string): boolean {
  try {
    return redactSecrets(input).count > 0;
  } catch {
    return true;
  }
}

const MAX_DEPTH = 12;

/**
 * Every string in a plain object or array, redacted — for log entries and
 * memory records, which are serialised afterwards (redacting the JSON text
 * could cut through its quotes). Other objects are returned as they are.
 */
export function redactDeep<T>(value: T, depth = 0, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === 'string') return redact(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[REDACTED]' as T;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1, seen)) as T;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactDeep(v, depth + 1, seen);
  }
  return out as T;
}
