/**
 * perception/readTools.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What the read tools answer when their source cannot be read (phase A5a,
 * audit TRA-07). They used to answer an empty list or "false" with success,
 * so "is youtube open?" said "No" while JARVIS's Chrome was not even running.
 * Now: a failure with the reason, and a short sentence to say. Empty means
 * really empty.
 *
 * Tab questions read JARVIS's own Chrome live (owner, Q2), never the 12 s
 * snapshot, and never start Chrome to look (owner, Q1).
 */

import { jarvisChrome, type JarvisChrome } from '../control/jarvisChrome.js';
import { readBrowserState, type BrowserTab } from './browserState.js';
import { CdpNoAnswerError, CdpUnavailableError, listPages } from './cdpClient.js';
import { chromeStartHint } from './chromeProfile.js';
import { redact } from '../security/redactor.js';

export const CHROME_NOT_RUNNING_SPOKEN = "My Chrome is not running, sir, so I can't see its tabs.";
export const CHROME_UNREADABLE_SPOKEN = "I could not read my Chrome's tabs, sir.";
export const WINDOWS_UNREADABLE_SPOKEN = "I can't read the open windows right now, sir.";

/** A read tool's failure: JSON with success false, read as a failure by the registry (reportedFailure). */
export function readFailure(error: string, spoken: string): string {
  return JSON.stringify({ success: false, error, spoken });
}

/** Why the window list is unknown, as a read tool's failure; undefined when it was read. */
export function windowsFailure(state: { windowsUnavailable?: unknown }): string | undefined {
  const why = typeof state.windowsUnavailable === 'string' ? state.windowsUnavailable : '';
  return why ? readFailure(`The open windows could not be read: ${why}`, WINDOWS_UNREADABLE_SPOKEN) : undefined;
}

export type LiveTabs = { tabs: BrowserTab[] } | { failure: string };
export type LiveTabList = { tabs: Array<{ id: string; title: string; url: string }> } | { failure: string };

/** The port of JARVIS's Chrome, or why it cannot be read. Starts nothing (owner, Q1). */
async function readablePort(chrome: JarvisChrome): Promise<{ port: number } | { failure: string }> {
  let running: Awaited<ReturnType<JarvisChrome['running']>>;
  try {
    running = await chrome.running();
  } catch (err) {
    // Chrome took the request and did not answer in time: busy, not "not running" (phase B2, review F1).
    if (err instanceof CdpNoAnswerError) return { failure: unreadable(err) };
    throw err;
  }
  if (running) return { port: running.port };
  // JARVIS_CDP_PORT set: the owner's Chrome on that port, and JARVIS starts none (review R6).
  const fixed = Number(process.env['JARVIS_CDP_PORT']);
  if (Number.isInteger(fixed) && fixed > 0 && fixed < 65536) {
    return { failure: readFailure(new CdpUnavailableError(fixed).message, CHROME_NOT_RUNNING_SPOKEN) };
  }
  return { failure: readFailure(
    `JARVIS's own Chrome is not running, so its tabs cannot be read (it starts when JARVIS opens a page). ${chromeStartHint()}`,
    CHROME_NOT_RUNNING_SPOKEN,
  ) };
}

const unreadable = (err: unknown) => readFailure(`JARVIS's Chrome did not list its tabs: ${err instanceof Error ? err.message : String(err)}`, CHROME_UNREADABLE_SPOKEN);

/**
 * Every tab of JARVIS's Chrome now, title and address only: one DevTools
 * call, no limit, no page touched (review R2, R3). Enough to answer "is X open?".
 */
export async function liveTabList(chrome: JarvisChrome = jarvisChrome): Promise<LiveTabList> {
  const at = await readablePort(chrome);
  if ('failure' in at) return at;
  try {
    return { tabs: (await listPages(at.port)).map((p) => ({ id: p.id, title: p.title ?? '', url: p.url ?? '' })) };
  } catch (err) {
    return { failure: unreadable(err) };
  }
}

/**
 * The tabs of JARVIS's Chrome now, with the one on screen: details for the
 * first 20 (most recently used), then the rest by title and address, so none
 * is left out (review R2). Starts nothing.
 */
export async function liveTabs(chrome: JarvisChrome = jarvisChrome): Promise<LiveTabs> {
  const at = await readablePort(chrome);
  if ('failure' in at) return at;
  try {
    const { tabs } = await readBrowserState(at.port);
    const seen = new Set(tabs.map((t) => t.id));
    const rest = (await listPages(at.port)).filter((p) => !seen.has(p.id))
      // Redacted like the first 20 (browserState's tabDetails): an address can carry a token.
      .map((p): BrowserTab => ({ id: p.id, title: redact(p.title ?? '').slice(0, 200), url: redact(p.url ?? '').slice(0, 500), visible: false }));
    return { tabs: [...tabs, ...rest] };
  } catch (err) {
    return { failure: unreadable(err) };
  }
}
