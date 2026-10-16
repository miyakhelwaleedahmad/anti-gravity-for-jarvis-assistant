/**
 * security/developerCommands.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The run_command allow-list: which developer commands JARVIS runs (read-only
 * git, named npm scripts, tsc --noEmit, tsx tests/<file>) and what it refuses
 * (shell characters, cmd.exe escapes and variables, dangerous commands).
 * tools/terminalTool.ts runs what this allows; the risk engine rates calls by
 * it. Moved here unchanged from tools/terminalTool.ts (ARCH-04), so the
 * security decision does not live in the tool it governs.
 */

const SHELL_METACHAR_PATTERN = /[&|;<>`$]|\|\||&&/;
const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  /^\s*(del|erase|rd|rmdir|format|shutdown)\b/i,
  /\brm\s+-[^\n]*r/i,
  /\bremove-item\b[\s\S]*\b-recurse\b[\s\S]*\b-force\b/i,
  /\bpowershell(?:\.exe)?\b[\s\S]*\s-(?:enc|encodedcommand)\b/i,
  /\bcurl\b[\s\S]*\|/i,
  /\bwget\b[\s\S]*\|/i,
  /\binvoke-expression\b|\biex\b/i,
  /\bstart-process\b/i,
];

const SAFE_NPM_SCRIPTS = new Set([
  'test',
  'test:voice-core',
  'test:pc-control',
  'test:all',
  'test:latency',
  'build',
]);

function tokenizeCommand(command: string): string[] | null {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!matches) return null;
  return matches.map((token) => token.replace(/^["']|["']$/g, ''));
}

/** True when `git branch <args>` only lists branches. */
function isBranchListing(args: string[]): boolean {
  const changes = args.some((a) =>
    /^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description|track|no-track|create-reflog)\b/i.test(a)
    || (/^-[a-z]+$/i.test(a) && /[dDmMcCfut]/.test(a.slice(1))));
  if (changes) return false;
  // A bare name creates a branch; with these flags names are patterns or commits.
  const names = args.filter((a) => !a.startsWith('-'));
  return names.length === 0
    || args.some((a) => /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)\b/i.test(a));
}

export function validateDeveloperCommand(command: string): { allowed: boolean; reason: string } {
  // The checks below read the command with its whitespace collapsed, but the
  // shell receives it as written, where a line break starts a second command.
  // Refuse line breaks and other control characters before collapsing (P15).
  if (/[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]/.test(command)) {
    return { allowed: false, reason: 'Line breaks and control characters are blocked for run_command.' };
  }
  const normalized = command.trim().replace(/\s+/g, ' ');

  if (SHELL_METACHAR_PATTERN.test(normalized)) {
    return { allowed: false, reason: 'Shell metacharacters are blocked for run_command.' };
  }

  // SEC-20: on Windows the command runs under cmd.exe, where ^ escapes the
  // next character (so the checks below read something other than what runs),
  // %NAME% and %NAME:~a,b% insert environment variables, and ! does the same
  // with delayed expansion. None of the allow-listed commands needs them.
  if (/[\^!]/.test(normalized) || /%[A-Za-z_][\w()]*(?:%|:~)/.test(normalized)) {
    return {
      allowed: false,
      reason: 'cmd.exe reads ^, ! and %NAME% as escapes and variables, so they are blocked for run_command (use HEAD~1 rather than HEAD^).',
    };
  }

  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(normalized)) {
      return { allowed: false, reason: `Command matches blocked pattern: ${pattern.toString()}` };
    }
  }

  const tokens = tokenizeCommand(normalized);
  if (!tokens || tokens.length === 0) {
    return { allowed: false, reason: 'Unable to parse command.' };
  }

  const exe = tokens[0].toLowerCase();
  const args = tokens.slice(1);
  const arg0 = args[0]?.toLowerCase();

  if (exe === 'git') {
    const safeGit = new Set(['status', 'diff', 'log', 'show', 'branch']);
    const rest = args.slice(1);
    // `--output=<file>` makes diff/log/show write a file; `git branch` also
    // deletes, renames, copies and creates branches.
    const writes = rest.some((a) => /^--output\b/i.test(a)) || (arg0 === 'branch' && !isBranchListing(rest));
    return {
      allowed: !!arg0 && safeGit.has(arg0) && !writes,
      reason: 'Only read-only git developer commands are allowed.',
    };
  }

  if (exe === 'npm') {
    if (arg0 !== 'run' || !args[1]) {
      return { allowed: false, reason: 'Only npm run <safe-script> is allowed.' };
    }
    return {
      allowed: SAFE_NPM_SCRIPTS.has(args[1].toLowerCase()),
      reason: `npm script "${args[1]}" is not on the safe script allowlist.`,
    };
  }

  if (exe === 'pnpm') {
    if (arg0 === 'install' || arg0 === 'add' || arg0 === 'remove' || arg0 === 'update' || arg0 === 'publish') {
      return { allowed: false, reason: 'Dependency mutation/publish commands are blocked.' };
    }
    if (arg0 === 'run' && args[1]) {
      return {
        allowed: SAFE_NPM_SCRIPTS.has(args[1].toLowerCase()),
        reason: `pnpm script "${args[1]}" is not on the safe script allowlist.`,
      };
    }
    const safePnpm = new Set(['test', 'build']);
    return {
      allowed: !!arg0 && safePnpm.has(arg0),
      reason: 'Only safe pnpm developer commands are allowed.',
    };
  }

  if (exe === 'npx') {
    const isTscNoEmit = arg0 === 'tsc' && args.slice(1).every((arg) => arg === '--noEmit');
    const isTsxSafeTest = arg0 === 'tsx' && /^tests[\\/][A-Za-z0-9_.-]+\.ts$/.test(args[1] ?? '') && args.length === 2;
    return {
      allowed: isTscNoEmit || isTsxSafeTest,
      reason: 'Only npx tsc --noEmit or npx tsx tests/<safe-test>.ts are allowed.',
    };
  }

  return { allowed: false, reason: `Command "${exe}" is not on the developer allowlist.` };
}

// ─── Structured execution result ──────────────────────────────────────────────
