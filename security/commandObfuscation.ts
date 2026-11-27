/**
 * security/commandObfuscation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shell commands written to hide what they run (SEC-10).
 *
 * The command checks (adminController's blocklist, the risk engine's critical
 * commands, permissionManager's classes) match text. cmd.exe and PowerShell
 * accept the same command in forms that text does not match: `shut^down`,
 * `Stop-Comp`uter`, `sh""utdown`, `'Stop-'+'Computer'`, an -EncodedCommand,
 * `iex`, `%COMSPEC:~0,1%`. Such a command was rated like `echo`.
 *
 *   obfuscationReason(): why a command hides what it runs, or null. JARVIS
 *     refuses these: a plainly written command does the same.
 *   readableCommand(): the command with escapes and quote splicing removed,
 *     lower-cased, for the checks to read in addition to the original.
 */

/** Characters a word is made of. */
const WORD = /[A-Za-z0-9_\-.]/;

/** Dynamic or encoded execution: what runs is not in the text. */
const HIDDEN_EXECUTION: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:iex|invoke-expression)\b/i, 'it runs text built at run time (Invoke-Expression)'],
  [/\bfrombase64string\b/i, 'it decodes hidden text (FromBase64String)'],
  [/\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-e(?:c|nc|ncodedcommand)?\s+[A-Za-z0-9+/]{16,}={0,2}(?=\s|$)/i, 'it runs an encoded command (-EncodedCommand)'],
  [/\[char\]\s*\d|\[char\[\]\]/i, 'it builds the command from character codes'],
  [/['"]\s*\+\s*['"]/, 'it joins pieces of text into a command'],
  [/%[A-Za-z0-9_]+:~/, 'it builds the command from parts of environment variables'],
  [/\.invoke(?:command|script)?\s*\(|&\s*\(\s*['"(]/i, 'it calls a command whose name is computed'],
];

/**
 * Escapes and quotes inside a bare word: `shut^down` (cmd), `Stop-Comp`uter`
 * (PowerShell), `sh""utdown`, `sh"ut"down`. Escapes inside quoted strings
 * (PowerShell's "`n") and a PowerShell single-quoted 'it''s' are not.
 */
function splicedWord(command: string): string | null {
  let quote: '"' | "'" | null = null;
  let quoteStart = -1;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const prev = command[i - 1] ?? '';
    const next = command[i + 1] ?? '';
    if (quote) {
      if (c === quote) {
        // A quoted part glued to word characters on both sides splits a word.
        const before = command[quoteStart - 1] ?? '';
        if (WORD.test(before) && WORD.test(next) && !(quote === "'" && next === "'")) {
          return 'a word is split by quotes';
        }
        quote = null;
      }
      continue;
    }
    if ((c === '^' || c === '`') && WORD.test(prev) && WORD.test(next)) {
      return c === '^' ? 'a word is split by ^ escapes' : 'a word is split by ` escapes';
    }
    if (c === '"' || c === "'") { quote = c; quoteStart = i; }
  }
  return null;
}

/** Why `command` hides what it runs, or null when it is written plainly. */
export function obfuscationReason(command: string): string | null {
  const text = String(command ?? '');
  const spliced = splicedWord(text);
  if (spliced) return spliced;
  for (const [pattern, reason] of HIDDEN_EXECUTION) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

/** The command as the shell reads it, roughly: escapes and quotes removed, lower case. */
export function readableCommand(command: string): string {
  return String(command ?? '')
    .replace(/[\^`"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The message JARVIS gives when it refuses one. */
export function obfuscationRefusal(command: string, reason: string): string {
  return `Blocked: this command hides what it runs (${reason}). Ask for it written plainly; read plainly it is: ${readableCommand(command).slice(0, 160)}`;
}
