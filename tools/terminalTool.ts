/**
 * tools/terminalTool.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shell execution and system info AgentTools.
 * All commands are validated through CommandValidator before execution.
 * Commands that fail validation are blocked and never reach the shell.
 *
 * Features:
 *   - CommandValidator integration (risk assessment + approval gate)
 *   - Working-directory restriction (prefers project folder)
 *   - Execution timeout (default 30s) — prevents infinite hangs
 *   - Structured result object with success/stdout/stderr/exitCode/riskLevel
 *   - Blocks execution in system directories without approval
 */

import type { AgentTool } from '../core/toolRegistryV2.js';
import { terminalTools } from '../core/terminalTools.js';
import { commandValidator } from '../security/commandValidator.js';
import { securityAuditLogger } from '../security/securityAuditLogger.js';
import * as path from 'path';
import {
  getWorkspaceRoot,
  isForeignWindowsAbsolute,
  isPathInside,
  isProtectedSystemPath,
} from '../core/workspaceRoot.js';

// ─── Project root (safe working directory) ────────────────────────────────────
// Single authority — see core/workspaceRoot.ts (JARVIS-001).
const PROJECT_ROOT = getWorkspaceRoot();

/** Directories that require approval to run commands within */
const SYSTEM_DIRECTORY_PATTERNS: readonly RegExp[] = [
  /^[Cc]:[\\\/]Windows[\\\/]/i,
  /^[Cc]:[\\\/]System32[\\\/]/i,
  /^[Cc]:[\\\/]Program Files[\\\/]/i,
  /^[Cc]:[\\\/]Program Files \(x86\)[\\\/]/i,
  /^[Cc]:[\\\/]Users[\\\/][^\\\/]+[\\\/]AppData[\\\/]/i,
];

/** Default timeout for command execution in milliseconds */
const COMMAND_TIMEOUT_MS = 30_000;

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

function isSystemDirectory(dir: string): boolean {
  // The local patterns require a trailing separator, so a bare `C:\\Windows`
  // slips past them even on Windows; the shared predicate also normalises
  // separators and matches on any host (JARVIS-001b).
  return isProtectedSystemPath(dir) || SYSTEM_DIRECTORY_PATTERNS.some((p) => p.test(dir));
}

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
  const normalized = command.trim().replace(/\s+/g, ' ');

  if (SHELL_METACHAR_PATTERN.test(normalized)) {
    return { allowed: false, reason: 'Shell metacharacters are blocked for run_command.' };
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

export interface RunCommandResult {
  success: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  riskLevel: string;
  blockedReason?: string;
  timedOut?: boolean;
}

// ─── Run Command ──────────────────────────────────────────────────────────────

export const runCommandTool: AgentTool = {
  name: 'run_command',
  description:
    'Use to execute safe Windows shell/terminal commands (CMD or PowerShell). DO NOT use for opening desktop apps, searching the web, or reading files directly. Required parameter: command (string shell command). Optional parameter: workingDir (string). Returns string containing exit code and terminal output.',
  riskLevel: 'high',
  // No dispatch floor: allow-listed developer commands run at level 0, and
  // every command is checked by the allowlist and CommandValidator below.
  requiredLevel: 0,
  inputSchema: {
    command: {
      type: 'string',
      description: 'The shell command to execute (PowerShell or CMD syntax).',
      required: true,
    },
    workingDir: {
      type: 'string',
      description:
        'Optional working directory. Defaults to the project root. ' +
        'System directories require extra approval.',
      required: false,
    },
  },
  fallbacks: [],

  async execute(args, signal) {
    const command = String(args['command'] ?? '').trim();
    const requestedCwd = args['workingDir'] ? String(args['workingDir']).trim() : PROJECT_ROOT;

    if (!command) {
      return 'Error: run_command requires a non-empty command argument.';
    }

    // A cwd that is absolute for a different platform than the host cannot be
    // resolved meaningfully here — `path.resolve('C:\\Windows')` on POSIX yields
    // a path *inside* the project root, so the containment check below would
    // pass it. Reject it up front (JARVIS-001b). Checked before the system-path
    // guard so the outcome matches Windows, where containment fails first.
    if (isForeignWindowsAbsolute(requestedCwd)) {
      securityAuditLogger.denied(
        command,
        'HIGH_RISK',
        `Working directory outside project root blocked: ${requestedCwd}`,
        'run_command',
      );
      return `Error: Working directory "${requestedCwd}" is outside the project workspace.`;
    }

    const effectiveCwd = path.resolve(requestedCwd || PROJECT_ROOT);

    if (!isPathInside(PROJECT_ROOT, effectiveCwd)) {
      securityAuditLogger.denied(
        command,
        'HIGH_RISK',
        `Working directory outside project root blocked: ${effectiveCwd}`,
        'run_command',
      );
      return `Error: Working directory "${effectiveCwd}" is outside the project workspace.`;
    }

    // ── Working directory safety check ────────────────────────────────────────
    if (isSystemDirectory(effectiveCwd)) {
      const systemDirWarning =
        `[run_command] ⚠️  Requested working directory is a system path: "${effectiveCwd}". ` +
        'This is blocked for safety. Commands will run from project root instead.';
      console.warn(systemDirWarning);
      securityAuditLogger.denied(
        command,
        'HIGH_RISK',
        `System directory CWD blocked: ${effectiveCwd}`,
        'run_command',
      );
      return `Error: Working directory "${effectiveCwd}" is a protected system path. Use the project folder instead.`;
    }

    const devSafety = validateDeveloperCommand(command);
    if (!devSafety.allowed) {
      securityAuditLogger.denied(command, 'CRITICAL_RISK', devSafety.reason, 'run_command');
      return `Error: Command blocked by developer allowlist - ${devSafety.reason}`;
    }

    // ── Security gate: CommandValidator (new layer) ────────────────────────────
    const validation = await commandValidator.validate(command, 'run_command');

    if (!validation.allowed) {
      const reason = validation.blockedReason ?? validation.reason;
      return `Error: Command blocked [${validation.riskLevel}] — ${reason}`;
    }

    if (signal?.aborted) throw new Error('ABORTED');

    // ── Execute with timeout ──────────────────────────────────────────────────
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let timedOut = false;

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('COMMAND_TIMEOUT')), COMMAND_TIMEOUT_MS)
      );

      const runPromise = terminalTools.run(command, { cwd: effectiveCwd, shell: true });

      const result = await Promise.race([runPromise, timeoutPromise]);
      stdout = result.stdout?.trim() ?? '';
      stderr = result.stderr?.trim() ?? '';
      exitCode = result.exitCode ?? null;
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'COMMAND_TIMEOUT') {
        timedOut = true;
        console.error(`[run_command] ⏰ Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s: "${command}"`);
        securityAuditLogger.denied(
          command,
          validation.riskLevel,
          `Command execution timed out after ${COMMAND_TIMEOUT_MS / 1000}s`,
          'run_command',
        );
        return `Error: Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s. Use a shorter operation or increase timeout.`;
      }
      throw new Error(`run_command failed: ${String(err)}`);
    }

    // ── Format result ─────────────────────────────────────────────────────────
    const output = [stdout, stderr].filter(Boolean).join('\n') || '(no output)';
    return `Exit code: ${exitCode}\nOutput:\n${output}`;
  },
};

// ─── Get System Info ──────────────────────────────────────────────────────────

export const getSystemInfoTool: AgentTool = {
  name: 'get_system_info',
  description:
    'Use to retrieve low-level system diagnostic info (OS, CPU, RAM, uptime). DO NOT use for active desktop application state or web searching. Accepts no required parameters. Returns formatted text list of system specifications.',
  riskLevel: 'low',
  inputSchema: {},
  fallbacks: [],

  async execute(_args, signal) {
    if (signal?.aborted) throw new Error('ABORTED');

    try {
      const info = await terminalTools.getSystemInfo();
      return Object.entries(info)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
    } catch (err) {
      throw new Error(`get_system_info failed: ${String(err)}`);
    }
  },
};
