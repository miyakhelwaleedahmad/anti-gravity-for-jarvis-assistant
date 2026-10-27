/**
 * control/jarvisChrome.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS's own Chrome (owner decisions D1 and D3; audit TRA-03, TRA-17).
 *
 * JARVIS starts Chrome when it needs one, with a profile of its own and
 * --remote-debugging-port=0. Chrome then picks a free port and writes it to
 * <profile>/DevToolsActivePort with its browser path, which is new for every
 * run: a Chrome answering on that port with that path is JARVIS's, and a file
 * left by a closed Chrome never counts (perception/chromeProfile.ts). The
 * everyday Chrome cannot be reached this way: since Chrome 136 its default
 * profile does not open a debugging port at all.
 *
 * When the owner sets JARVIS_CDP_PORT, JARVIS uses the Chrome the owner
 * starts on that port, as before, and starts none itself. Chrome stays open
 * when JARVIS exits; the next start finds it again through the profile.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CdpSession, activateTab, cdpVersion, closeTabById, listPages, openTab } from '../perception/cdpClient.js';
import { chromeProfileDir, chromeStartHint, readActivePort } from '../perception/chromeProfile.js';
import { childEnv } from '../system/childEnv.js';

/**
 * JARVIS's Chrome is not there and could not be started. The message says why
 * and what to do; `spoken` is the short form JARVIS says (cause and fix).
 */
export class ChromeNotAvailableError extends Error {
  constructor(message: string, readonly spoken: string) {
    super(message);
    this.name = 'ChromeNotAvailableError';
  }
}

export interface RunningChrome {
  port: number;
  /** /devtools/browser/<id> as that port reports it. */
  browserPath: string;
}

export interface LaunchedChrome {
  /** null while it runs; a number once it has exited (-1: it could not be run). */
  exitCode(): number | null | undefined;
}

export interface JarvisChromeDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  findBinary(): string | undefined;
  launch(binary: string, args: string[]): LaunchedChrome;
  /** Added before the start page (tests: --headless=new). */
  extraArgs: string[];
  startTimeoutMs: number;
}

/**
 * The Chrome program: JARVIS_CHROME_PATH when it is set (and nothing else if
 * that path does not exist), else where Chrome is installed by default.
 */
export function findChrome(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync,
): string | undefined {
  const named = env['JARVIS_CHROME_PATH']?.trim();
  if (named) return exists(named) ? named : undefined;
  let candidates: string[];
  if (platform === 'win32') {
    const roots = [env['ProgramFiles'] || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', env['LOCALAPPDATA']];
    candidates = roots.filter((r): r is string => !!r).map((r) => path.win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (platform === 'darwin') {
    const app = 'Google Chrome.app/Contents/MacOS/Google Chrome';
    candidates = [`/Applications/${app}`, ...(env['HOME'] ? [path.posix.join(env['HOME'], 'Applications', app)] : [])];
  } else {
    const dirs = (env['PATH'] ?? '').split(':').filter(Boolean);
    candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].flatMap((name) => dirs.map((d) => path.posix.join(d, name)));
  }
  return candidates.find((p) => exists(p));
}

/** Detached, with the filtered environment (SEC-06): Chrome outlives JARVIS. */
function launchDetached(binary: string, args: string[]): LaunchedChrome {
  let couldNotRun = false;
  const child = spawn(binary, args, { detached: true, stdio: 'ignore', env: childEnv(), shell: false });
  child.on('error', () => { couldNotRun = true; });
  child.unref();
  return { exitCode: () => (couldNotRun ? -1 : child.exitCode) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The browser path a DevTools endpoint reports; '' when it answers without one; undefined when nothing answers. */
async function browserPathAt(port: number): Promise<string | undefined> {
  try {
    const version = await cdpVersion(port) as { webSocketDebuggerUrl?: string };
    try { return new URL(version.webSocketDebuggerUrl ?? '').pathname; } catch { return ''; }
  } catch {
    return undefined;
  }
}

export class JarvisChrome {
  /** One check-and-start at a time: requests that arrive meanwhile get its result. */
  private pending: Promise<number> | undefined;

  constructor(private readonly deps: Partial<JarvisChromeDeps> = {}) {}

  private get env(): Record<string, string | undefined> { return this.deps.env ?? process.env; }
  private get platform(): NodeJS.Platform { return this.deps.platform ?? process.platform; }

  /** The owner's JARVIS_CDP_PORT, when set. */
  private fixedPort(): number | undefined {
    const port = Number(this.env['JARVIS_CDP_PORT']);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  }

  profileDir(): string {
    return chromeProfileDir(this.env, this.platform);
  }

  /** JARVIS's Chrome when it is running (its port and browser path), else undefined. Starts nothing. */
  async running(): Promise<RunningChrome | undefined> {
    const fixed = this.fixedPort();
    if (fixed) {
      const browserPath = await browserPathAt(fixed);
      return browserPath !== undefined ? { port: fixed, browserPath } : undefined;
    }
    const active = readActivePort(this.profileDir());
    if (!active) return undefined;
    return (await browserPathAt(active.port)) === active.browserPath ? { port: active.port, browserPath: active.browserPath } : undefined;
  }

  async runningPort(): Promise<number | undefined> {
    return (await this.running())?.port;
  }

  /** The port of JARVIS's Chrome, started first when it is not running. */
  async ensure(): Promise<number> {
    const fixed = this.fixedPort();
    if (fixed) {
      if ((await browserPathAt(fixed)) !== undefined) return fixed;
      throw new ChromeNotAvailableError(
        `Nothing answers on Chrome's debugging port ${fixed}. JARVIS_CDP_PORT is set, so JARVIS uses only the Chrome you start on that port: `
        + 'start it, or remove JARVIS_CDP_PORT from .env so that JARVIS starts its own Chrome.',
        `Nothing answers on Chrome's debugging port ${fixed}: start your Chrome on that port, or remove JARVIS_CDP_PORT from the settings.`,
      );
    }
    // The check and the start are one step: a request arriving meanwhile waits for it.
    this.pending ??= this.findOrStart().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async findOrStart(): Promise<number> {
    const running = await this.runningPort();
    if (running) return running;
    if (/^(off|0|false|no)$/i.test(this.env['JARVIS_CHROME_AUTOSTART']?.trim() ?? '')) {
      throw new ChromeNotAvailableError(
        'JARVIS\'s Chrome is not running, and JARVIS_CHROME_AUTOSTART is off, so JARVIS does not start it. '
        + `Remove that line from .env, or start Chrome yourself with --remote-debugging-port=0 --user-data-dir="${this.profileDir()}".`,
        'My Chrome is not running, and JARVIS_CHROME_AUTOSTART is off, so I did not start it.',
      );
    }
    return this.start();
  }

  private async start(): Promise<number> {
    const binary = (this.deps.findBinary ?? (() => findChrome(this.env, this.platform)))();
    if (!binary) {
      throw new ChromeNotAvailableError(`Chrome was not found on this PC. ${chromeStartHint(this.platform)}`,
        'Chrome was not found on this PC: install Google Chrome, or set JARVIS_CHROME_PATH to its program.');
    }
    const profile = this.profileDir();
    fs.mkdirSync(profile, { recursive: true });
    const args = ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      ...(this.deps.extraArgs ?? []), 'about:blank'];
    console.log(`[JarvisChrome] Starting Chrome (${binary}) with JARVIS's own profile (${profile}).`);
    let child: LaunchedChrome;
    try {
      child = (this.deps.launch ?? launchDetached)(binary, args);
    } catch (err) {
      throw new ChromeNotAvailableError(`Chrome could not be run (${binary}): ${err instanceof Error ? err.message : String(err)}. Check JARVIS_CHROME_PATH.`,
        'Chrome could not be run: check JARVIS_CHROME_PATH.');
    }
    const timeoutMs = this.deps.startTimeoutMs ?? 20_000;
    const deadline = Date.now() + timeoutMs;
    let exitedAt: number | undefined;
    while (Date.now() < deadline) {
      await sleep(150);
      const port = await this.runningPort();
      if (port) {
        console.log(`[JarvisChrome] JARVIS's Chrome answers on 127.0.0.1:${port}.`);
        return port;
      }
      const code = child.exitCode();
      if (code === -1) {
        throw new ChromeNotAvailableError(`Chrome could not be run (${binary}). Check JARVIS_CHROME_PATH.`, 'Chrome could not be run: check JARVIS_CHROME_PATH.');
      }
      if (code !== null && code !== undefined) {
        exitedAt ??= Date.now();
        // A Chrome already open with this profile takes the request over and the new process exits (code 0).
        if (Date.now() - exitedAt > 1_000) {
          throw code === 0
            ? new ChromeNotAvailableError(
              'Chrome closed again without opening its debugging port. '
              + `Usually a Chrome window is already open with JARVIS's profile (${profile}) but without that port: close that window and ask again.`,
              'A Chrome window is already open with my profile but without my debugging port: close that window and ask again.')
            : new ChromeNotAvailableError(
              `Chrome exited with code ${code} without opening its debugging port (profile ${profile}).`,
              `Chrome exited with code ${code} before it was ready: the console has the details.`);
        }
      }
    }
    throw new ChromeNotAvailableError(
      `Chrome did not open its debugging port within ${Math.round(timeoutMs / 1000)} s. `
      + `Close any Chrome window that uses JARVIS's profile (${profile}) and ask again.`,
      `Chrome did not start within ${Math.round(timeoutMs / 1000)} seconds: close any Chrome window with my profile and ask again.`,
    );
  }

  /**
   * Closes `chrome` (from running()) through DevTools; true when its port stops
   * answering within 5 s. A different browser on that port is not closed.
   * Failures are worded so that the action queue does not retry them (a
   * retry would ask the owner again).
   */
  async close(chrome: RunningChrome): Promise<boolean> {
    const { port } = chrome;
    const now = await browserPathAt(port);
    if (now === undefined) return true;
    if (now !== chrome.browserPath) throw new Error(`JARVIS's Chrome is not open: port ${port} now answers for another browser, which was not closed.`);
    let session: CdpSession;
    try {
      session = await CdpSession.connectBrowser(port);
    } catch (err) {
      throw new Error(`JARVIS's Chrome is still open: it could not be reached to close it (${err instanceof Error ? err.message : String(err)}).`);
    }
    try {
      // Chrome may drop the connection before it answers: the port is the check.
      await session.send('Browser.close', {}, 3_000).catch(() => undefined);
    } finally {
      session.close();
    }
    for (let i = 0; i < 50; i++) {
      if ((await browserPathAt(port)) === undefined) return true;
      await sleep(100);
    }
    return false;
  }
}

export const jarvisChrome = new JarvisChrome();

export interface ShownTab {
  port: number;
  tabId: string;
  url: string;
}

/**
 * Brings a page forward in JARVIS's Chrome, started first if needed: `url` in
 * a new tab, or without one the tab Chrome used last (a blank one if none).
 */
export async function showInJarvisChrome(url: string | undefined, chrome: JarvisChrome = jarvisChrome): Promise<ShownTab> {
  const port = await chrome.ensure();
  const before = await listPages(port);
  let tab = url ? await openTab(url, port) : before[0];
  tab ??= await openTab('about:blank', port);
  await activateTab(tab.id, port);
  // A Chrome that just started shows one blank tab; it is not left behind.
  if (url && before.length === 1 && before[0]!.url === 'about:blank') await closeTabById(before[0]!.id, port).catch(() => undefined);
  return { port, tabId: tab.id, url: url ?? tab.url };
}
