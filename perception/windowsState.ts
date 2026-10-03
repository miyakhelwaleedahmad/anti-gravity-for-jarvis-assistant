/**
 * perception/windowsState.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OPT-PS-1: Persistent PowerShell Session Manager
 *
 * BEFORE: A new powershell.exe process was spawned on EVERY poll (every 4s).
 *         Each spawn cost 200–800ms of process startup + profile load.
 *
 * AFTER:  A single persistent PowerShell process is kept alive.
 *         Commands are sent via stdin and results read from stdout.
 *         This eliminates spawn overhead — queries now cost ~5–30ms instead
 *         of 200–800ms.
 *
 * Savings: ~170–770ms per poll cycle, running every 4 seconds.
 *
 * Safety:
 *   - If the persistent process crashes, falls back to one-shot spawn.
 *   - Restart guard prevents infinite restart loops.
 *   - Process is unref()'d so it does not block graceful shutdown.
 *   - Demarcation tokens (END_OF_OUTPUT) separate responses in the stream.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ActiveWindowInfo {
  title: string;
  processName: string;
  pid: number;
  hwnd?: string;
}

export interface OpenAppInfo {
  name: string;
  pid: number;
  windowTitle: string;
  hwnd?: string;
}

export interface WindowsStateResult {
  activeWindow: ActiveWindowInfo;
  openApps: OpenAppInfo[];
}

const EMPTY_RESULT: WindowsStateResult = {
  activeWindow: { title: '', processName: '', pid: 0 },
  openApps: [],
};

// ── Persistent Session Manager ────────────────────────────────────────────────

const END_TOKEN = '__JARVIS_END__';

/**
 * PowerShell that prints the window state as JSON. The session appends its own
 * end-of-response line, tagged with the query's id.
 *
 * Two fixes here:
 *   - The process-id variable was `$pid`, which is PowerShell's read-only
 *     automatic variable `$PID`. Assigning it throws "Cannot overwrite variable
 *     PID because it is read-only or constant", the catch below swallowed it,
 *     and every poll returned an empty active window and no open apps.
 *   - Add-Type compiled the C# helper on every poll; it now compiles once per
 *     session.
 */
const INLINE_SCRIPT = `
try {
  if (-not ('FastWinAPI' -as [type])) {
    Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FastWinAPI {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
}
"@ -ErrorAction SilentlyContinue
  }

  $hwnd = [FastWinAPI]::GetForegroundWindow()
  $procId = 0; [FastWinAPI]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
  $sb = New-Object System.Text.StringBuilder 512
  [FastWinAPI]::GetWindowText($hwnd, $sb, 512) | Out-Null
  $title = $sb.ToString()
  $proc = if ($procId -gt 0) { Get-Process -Id $procId -ErrorAction SilentlyContinue } else { $null }
  $activeWindow = @{ title=$title; processName=if($proc){$proc.Name}else{''}; pid=$procId; hwnd=$hwnd.ToString() }

  $openApps = @([System.Diagnostics.Process]::GetProcesses() | Where-Object { $_.MainWindowTitle } | Select-Object -First 20 | ForEach-Object {
    @{ name=$_.ProcessName; pid=$_.Id; windowTitle=$_.MainWindowTitle; hwnd=$_.MainWindowHandle.ToString() }
  })

  @{ activeWindow=$activeWindow; openApps=$openApps } | ConvertTo-Json -Depth 3 -Compress
} catch {
  '{"activeWindow":{"title":"","processName":"","pid":0},"openApps":[]}'
}`;

/** The session is still finishing a query that timed out; skip this poll. */
export class PSBusyError extends Error {}

interface PendingQuery {
  id: string;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PersistentPSSession {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private current: PendingQuery | null = null;
  /**
   * Queries that timed out but are still running inside PowerShell (it runs
   * stdin commands one after another). Their output is discarded when it
   * arrives. Before, the late output was handed to the NEXT query, and new
   * queries queued up behind the slow one, so one slow poll became a run of
   * timeouts.
   */
  private stale = new Map<string, number>();
  private seq = 0;
  private restarting = false;
  private restartCount = 0;
  private readonly MAX_RESTARTS = 5;
  // The first query compiles the C# helper; on a busy PC (models loading at
  // startup) that took longer than the old 6 s allowance.
  private _firstQueryDone = false;

  constructor(
    private readonly exe = 'powershell',
    private readonly args: string[] = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    private readonly firstQueryTimeoutMs = 15_000,
    private readonly queryTimeoutMs = 4_000,
    /** A slow query still unfinished after this long means PowerShell is stuck. */
    private readonly staleLimitMs = 30_000,
  ) {}

  start(): void {
    if (this.proc) return;
    this.restarting = false; // a fresh start re-enables crash recovery after stop()
    if (this.restartCount >= this.MAX_RESTARTS) {
      console.warn('[windowsState] Max PS restarts reached — falling back to one-shot mode.');
      return;
    }

    try {
      this.proc = spawn(this.exe, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });

      this.proc.unref();   // don't block Node.js exit
      this.buffer = '';
      this.stale.clear();
      this._firstQueryDone = false;

      this.proc.stdout?.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString();
        const token = new RegExp(`${END_TOKEN}:(\\d+)`);
        let m: RegExpExecArray | null;
        while ((m = token.exec(this.buffer)) !== null) {
          const text = this.buffer.substring(0, m.index).trim();
          this.buffer = this.buffer.substring(m.index + m[0].length);
          const id = m[1]!;
          if (this.current && this.current.id === id) {
            const { resolve, timer } = this.current;
            clearTimeout(timer);
            this.current = null;
            resolve(text);
          } else {
            this.stale.delete(id); // late output of a query that timed out
          }
        }
      });

      this.proc.stderr?.on('data', (d: Buffer) => {
        const msg = d.toString().trim();
        // Ignore PS startup noise; only warn on actual errors
        if (msg && !msg.includes('WARNING') && !msg.includes('PSReadLine')) {
          console.warn('[windowsState] PS stderr:', msg.substring(0, 120));
        }
      });

      this.proc.on('exit', () => {
        this.proc = null;
        this.buffer = '';
        this.stale.clear();
        if (this.current) {
          const { reject, timer } = this.current;
          clearTimeout(timer);
          this.current = null;
          reject(new Error('PowerShell session exited unexpectedly.'));
        }
        if (!this.restarting) {
          this.restarting = true;
          this.restartCount++;
          setTimeout(() => {
            this.restarting = false;
            console.warn(`[windowsState] PS session restarting (attempt ${this.restartCount}/${this.MAX_RESTARTS})...`);
            this.start();
          }, 2000).unref?.();
        }
      });

      this.proc.on('error', (err) => {
        console.warn('[windowsState] PS spawn error:', err.message);
        this.proc = null;
        this.buffer = '';
        // Fail a query already sent rather than letting it wait out its timeout.
        if (this.current) {
          const { reject, timer } = this.current;
          clearTimeout(timer);
          this.current = null;
          reject(new Error(`PowerShell could not be started: ${err.message}`));
        }
      });

      console.log('[windowsState] OPT-PS-1: Persistent PowerShell session started.');
    } catch (err: any) {
      console.warn('[windowsState] Could not start persistent PS session:', err.message);
      this.proc = null;
      this.buffer = '';
    }
  }

  stop(): void {
    if (this.proc) {
      this.restarting = true; // a deliberate stop is not a crash to recover from
      this.proc.stdin?.end();
      this.proc.kill('SIGTERM');
      this.proc = null;
      this.buffer = '';
    }
  }

  isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  /**
   * Run a query in the persistent session and return its stdout.
   * Rejects after the timeout if the query's end line has not arrived, and with
   * PSBusyError while an earlier query that timed out is still running.
   */
  query(command: string, timeoutMs?: number): Promise<string> {
    if (!this.isAlive()) {
      return Promise.reject(new Error('PS session not alive'));
    }
    if (this.current) {
      return Promise.reject(new PSBusyError('PS session busy'));
    }
    if (this.stale.size > 0) {
      const oldest = Math.min(...this.stale.values());
      if (Date.now() - oldest > this.staleLimitMs) {
        console.warn(`[windowsState] PowerShell has not finished a query in ${this.staleLimitMs / 1000}s — restarting the session.`);
        this.proc?.kill('SIGTERM'); // the exit handler restarts it
      }
      return Promise.reject(new PSBusyError('PS session still finishing a slow query'));
    }

    const id = String(++this.seq);
    const effectiveTimeout = timeoutMs ?? (this._firstQueryDone ? this.queryTimeoutMs : this.firstQueryTimeoutMs);
    this._firstQueryDone = true;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.current?.id !== id) return;
        this.current = null;
        this.stale.set(id, Date.now());
        reject(new Error(`PS query timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      this.current = { id, resolve, reject, timer };
      this.proc!.stdin!.write(`${command}\nWrite-Output '${END_TOKEN}:${id}'\n`, 'utf8');
    });
  }
}

// Singleton persistent session
export const psSession = new PersistentPSSession();

// Auto-start on module load
psSession.start();

// ── Public API ────────────────────────────────────────────────────────────────

/** Last successful result, returned while the session finishes a slow query. */
let lastGood: WindowsStateResult = EMPTY_RESULT;
let lastLoggedError = '';
let lastLoggedAt = 0;
let suppressedErrors = 0;

/** One line per distinct failure, then at most once a minute — not every poll. */
function logPollFailure(message: string): void {
  const now = Date.now();
  if (message !== lastLoggedError || now - lastLoggedAt > 60_000) {
    const repeats = suppressedErrors > 0 ? ` (${suppressedErrors} more since the last report)` : '';
    console.warn(`[windowsState] Poll failed (non-fatal): ${message}${repeats}`);
    lastLoggedError = message;
    lastLoggedAt = now;
    suppressedErrors = 0;
  } else {
    suppressedErrors++;
  }
}

export async function getWindowsState(): Promise<WindowsStateResult> {
  try {
    let stdout: string;

    if (psSession.isAlive()) {
      // OPT-PS-1: Use persistent session — no new process spawn
      // PHASE3-PS-1: timeout handled by psSession.query() adaptive logic
      stdout = await psSession.query(INLINE_SCRIPT);
    } else {
      // Fallback: one-shot spawn (original behaviour)
      const scriptPath = path.join(__dirname, 'get_windows_state.ps1');
      const { execa } = await import('execa');
      const result = await execa('powershell', [
        '-NonInteractive',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
      ], { reject: false, timeout: 2000 }); // PHASE3-PS-1: 3000→2000ms one-shot fallback

      const code = result.exitCode ?? 'null/undefined';
      if (result.exitCode !== 0 || !result.stdout) {
        throw new Error(result.stderr?.trim() || `PowerShell exited with code ${code}`);
      }
      stdout = result.stdout.trim();
    }

    if (!stdout) return EMPTY_RESULT;

    const parsed = JSON.parse(stdout);

    const openApps = Array.isArray(parsed.openApps)
      ? parsed.openApps
      : parsed.openApps
        ? [parsed.openApps]
        : [];

    lastGood = {
      activeWindow: {
        title:       parsed.activeWindow?.title       || '',
        processName: parsed.activeWindow?.processName || '',
        pid:         Number(parsed.activeWindow?.pid  || 0),
        hwnd:        parsed.activeWindow?.hwnd        || '',
      },
      openApps: openApps.map((app: any) => ({
        name:        app.name        || '',
        pid:         Number(app.pid  || 0),
        windowTitle: app.windowTitle || '',
        hwnd:        app.hwnd        || '',
      })),
    };
    return lastGood;

  } catch (err: any) {
    // A busy session is expected right after a slow query; keep the last state.
    if (err instanceof PSBusyError) return lastGood;
    logPollFailure(err.message);
    return EMPTY_RESULT;
  }
}
