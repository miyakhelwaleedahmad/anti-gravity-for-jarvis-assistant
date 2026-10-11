/**
 * system/processRunner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One way to run a child process that can be stopped (REL-01).
 *
 * The tool sandbox and the action queue gave tools an AbortSignal when their
 * time budget ran out, but the shell, PowerShell and service commands never
 * passed it to execa: a command that did not end kept the registry's queue and
 * every later risky action waiting (39.8 s behind a 40 s command, with a 15 s
 * budget).
 *
 * runProcess():
 *   - arguments are passed separately (no shell unless the caller runs one);
 *   - on abort or on `timeoutMs` the whole process tree is stopped: on Windows
 *     `taskkill /T /F` (cmd.exe /c and powershell start children of their
 *     own), elsewhere the process group (the child is started detached, as a
 *     group leader);
 *   - it resolves once the process has exited, with `cancelled` / `timedOut`
 *     set, so the caller's lock is released only when nothing is left running.
 */

import { execa } from 'execa';

export interface RunOptions {
  signal?: AbortSignal;
  /** Stop the process after this long (in addition to `signal`). */
  timeoutMs?: number;
  cwd?: string;
  /** The child's whole environment (no JARVIS secrets are added to it). */
  env?: Record<string, string | undefined>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  /** Stopped because `signal` was aborted. */
  cancelled: boolean;
  /** Stopped because `timeoutMs` ran out. */
  timedOut: boolean;
}

const isWindows = process.platform === 'win32';

/** Stops `pid` and every process it started. Never throws. */
export async function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (isWindows) {
    await execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false, windowsHide: true }).catch(() => undefined);
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

export async function runProcess(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  if (opts.signal?.aborted) {
    return { stdout: '', stderr: '', exitCode: undefined, cancelled: true, timedOut: false };
  }
  const child = execa(file, args, {
    reject: false,
    windowsHide: true,
    // A group of its own, so the whole tree can be stopped (POSIX).
    detached: !isWindows,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env, extendEnv: false } : {}),
  });

  let cancelled = false;
  let timedOut = false;
  const stop = () => { void killTree(child.pid); };
  const onAbort = () => { cancelled = true; stop(); };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = opts.timeoutMs && opts.timeoutMs > 0
    ? setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs)
    : undefined;

  try {
    const r = await child;
    return {
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? ''),
      exitCode: r.exitCode,
      cancelled,
      timedOut,
    };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** A short, plain sentence for a stopped run, or '' if it ran to the end. */
export function stoppedReason(r: RunResult, what: string): string {
  if (r.timedOut) return `${what} took too long and was stopped (with everything it started).`;
  if (r.cancelled) return `${what} was cancelled and stopped (with everything it started).`;
  return '';
}
