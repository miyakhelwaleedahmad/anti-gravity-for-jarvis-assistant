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

type Rule = readonly [kind: string, pattern: RegExp, keep?: string];

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
  // name: value / name=value pairs in prose, JSON or a command line.
  ['secret', /\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token)["']?\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{4,})/gi, '$1'],
];

export function redactSecrets(input: string): Redaction {
  if (!input) return { text: input ?? '', count: 0, kinds: [] };
  let text = input;
  let count = 0;
  const kinds = new Set<string>();
  for (const [kind, pattern, keep] of RULES) {
    text = text.replace(pattern, (...m: unknown[]) => {
      const match = m[0] as string;
      // Already replaced by an earlier rule.
      if (match.includes('[REDACTED:')) return match;
      count++;
      kinds.add(kind);
      const prefix = keep ? (m[1] as string) : '';
      return `${prefix}[REDACTED:${kind}]`;
    });
  }
  return { text, count, kinds: [...kinds] };
}

/** The text with credentials replaced. */
export function redact(input: string): string {
  return redactSecrets(input).text;
}
