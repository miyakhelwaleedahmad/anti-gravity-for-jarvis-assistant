/**
 * perception/chromeProfile.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Where JARVIS's own Chrome keeps its profile, the debugging port that Chrome
 * wrote there, and what to tell the owner when it cannot be started (owner
 * decision D1, audit TRA-03 and TRA-16).
 *
 * Started with --remote-debugging-port=0, Chrome picks a free port and writes
 * <profile>/DevToolsActivePort: the port, then the browser's DevTools path
 * (/devtools/browser/<id>, new for every run). With a fixed port it writes no
 * such file (Chromium remote_debugging_server.cc; checked on Chromium 141).
 * control/jarvisChrome.ts starts and closes that Chrome.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** JARVIS_CHROME_PROFILE, else the folder the earlier start instructions named. */
export function chromeProfileDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const named = env['JARVIS_CHROME_PROFILE']?.trim();
  if (named) return named;
  return platform === 'win32'
    ? path.win32.join(env['USERPROFILE'] || os.homedir(), 'jarvis-chrome-profile')
    : path.posix.join(env['HOME'] || os.homedir(), '.jarvis-chrome-profile');
}

export interface ActivePort {
  port: number;
  /** /devtools/browser/<id>: names one run of one browser. */
  browserPath: string;
}

/** The port and browser path Chrome wrote into the profile, or nothing (no file, or not in that form). */
export function readActivePort(profileDir: string): ActivePort | undefined {
  let text: string;
  try { text = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8'); } catch { return undefined; }
  const [first, second] = text.split(/\r?\n/);
  const port = Number(first);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  if (!second?.startsWith('/devtools/browser/')) return undefined;
  return { port, browserPath: second.trim() };
}

/** What the owner can do when JARVIS cannot start its Chrome, for this platform (TRA-16). */
export function chromeStartHint(platform: NodeJS.Platform = process.platform): string {
  const intro = 'JARVIS opens pages in a Chrome of its own (a separate profile, not your everyday Chrome).';
  if (platform === 'win32') {
    return `${intro} If it cannot start it, install Google Chrome, or set JARVIS_CHROME_PATH in .env to the full path of chrome.exe `
      + '(usually C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe).';
  }
  if (platform === 'darwin') {
    return `${intro} If it cannot start it, install Google Chrome in Applications, or set JARVIS_CHROME_PATH in .env to `
      + '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome.';
  }
  return `${intro} If it cannot start it, install google-chrome or chromium, or set JARVIS_CHROME_PATH in .env to its program `
    + '(for example /usr/bin/chromium).';
}
