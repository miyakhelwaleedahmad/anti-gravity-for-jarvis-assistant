/**
 * tests/chromeHelper.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Not a test: finds a Chromium or Chrome on this machine and starts it headless
 * with a debugging port and a throwaway profile, for the browser tests. Also
 * finds a PowerShell 7 (pwsh) for the script checks (windowsScriptsTest).
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const CANDIDATES = [
  process.env['JARVIS_TEST_CHROME'] ?? '',
  '/opt/pw-browsers/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findChromium(): string | undefined {
  return CANDIDATES.find((p) => p && fs.existsSync(p));
}

/**
 * PowerShell 7: JARVIS_TEST_PWSH, else pwsh on the PATH, else (Windows) where
 * its installer puts it, else whatever the system starts as `pwsh`. A CMD
 * window opened before the install does not have the new PATH yet.
 *
 * The last step is for app execution aliases (%LOCALAPPDATA%\Microsoft\
 * WindowsApps\pwsh.exe, how some installs provide pwsh): CMD runs them, but
 * fs.existsSync says they do not exist. On the owner's PC `pwsh -v` answered
 * "PowerShell 7.6.7" in the same window where the tests reported none; such
 * an alias is the likely reason (not confirmed).
 */
let pwshLookup: { path: string | undefined } | undefined;

export function findPwsh(): string | undefined {
  const named = process.env['JARVIS_TEST_PWSH'];
  if (named) return fs.existsSync(named) ? named : undefined;
  if (pwshLookup) return pwshLookup.path;
  pwshLookup = { path: lookUpPwsh() };
  return pwshLookup.path;
}

function lookUpPwsh(): string | undefined {
  const exe = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  if (process.platform === 'win32') {
    const installed = path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
    if (fs.existsSync(installed)) return installed;
  }
  // Let the system find and start it, and count it only if it says it is 7 or later.
  const r = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  if (r.status === 0 && Number(String(r.stdout).trim()) >= 7) return exe;
  return undefined;
}

/** Why findPwsh() found nothing, and what to do. */
export function pwshMissingReason(): string {
  const named = process.env['JARVIS_TEST_PWSH'];
  if (named) return `JARVIS_TEST_PWSH names "${named}", which does not exist.`;
  return 'No PowerShell 7 (pwsh) found. Install it (CMD: winget install --id Microsoft.PowerShell --source winget), '
    + 'open a new CMD window and check with: pwsh -v. Or set JARVIS_TEST_PWSH to the full path of pwsh.exe.';
}

export async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export interface RunningChrome {
  port: number;
  process: ChildProcess;
  stop(): Promise<void>;
}

/**
 * The user's own folders as they were when the tests started. A scenario test
 * points HOME and USERPROFILE at a stand-in home for JARVIS; Chrome, a
 * separate program, inherited it and on Windows refused remote debugging
 * ("requires a non-default data directory"). Chrome keeps the real ones.
 */
const REAL_USER_ENV = Object.fromEntries(['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH']
  .map((k) => [k, process.env[k]] as const).filter(([, v]) => v !== undefined));

/** Headless, a free debugging port, a throwaway profile; resolves once DevTools answers. */
export async function startChromium(url = 'about:blank', extraArgs: string[] = []): Promise<RunningChrome> {
  const binary = findChromium();
  if (!binary) throw new Error('No Chromium or Chrome found (set JARVIS_TEST_CHROME).');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-chrome-'));
  const proc = spawn(binary, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-gpu', ...extraArgs, url,
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...REAL_USER_ENV } });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
  let exited: number | null | undefined;
  proc.on('exit', (code) => { exited = code; });
  // A first start on a fresh Windows runner took longer than the 10 s this
  // waited, and the helper then returned as if Chrome were up: the failure
  // surfaced later as "Chrome is not reachable". Wait longer, and say so.
  const waitMs = Number(process.env['JARVIS_TEST_CHROME_WAIT_MS'] ?? 45_000);
  const started = Date.now();
  let up = false;
  while (!up && exited === undefined && Date.now() - started < waitMs) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      up = res.ok;
    } catch { /* not up yet */ }
  }
  if (!up) {
    proc.kill();
    throw new Error(`Chrome did not open DevTools on port ${port} within ${Date.now() - started} ms`
      + `${exited !== undefined ? ` (it exited with code ${exited})` : ''}. Chrome said: ${stderr.trim().slice(-600) || '(nothing)'}`);
  }
  return {
    port,
    process: proc,
    async stop() {
      proc.kill();
      await new Promise((r) => setTimeout(r, 500));
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still in use */ }
    },
  };
}
