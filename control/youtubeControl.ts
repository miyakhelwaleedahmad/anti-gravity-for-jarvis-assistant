/**
 * control/youtubeControl.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * YouTube on the user's own Chrome (the JARVIS debugging profile, through the
 * DevTools Protocol), built on control/browserAgent.ts:
 *
 *   searchYouTube   opens the results for a query in a NEW tab (the user's
 *                   other tabs are left alone), reads the results from the
 *                   page, and, when asked, opens the first or best-matching
 *                   video in that tab and checks that it plays
 *   playback        plays or pauses the video in the YouTube tab
 *
 * Every step is checked on the page afterwards and reported as verified,
 * failed or unverifiable — a tab that opened is not reported as a video that
 * plays. "Best match" is word overlap between the query and the titles, with
 * a small preference for higher-ranked results; it is said to be that.
 */

import { CdpSession, cdpPort, evaluateFixed, listPages, withPage, type CdpTarget } from '../perception/cdpClient.js';
import { readBrowserState } from '../perception/browserState.js';
import { VIDEO_PAUSE_SCRIPT, VIDEO_PLAY_SCRIPT, VIDEO_STATE_SCRIPT, YOUTUBE_RESULTS_SCRIPT } from '../perception/cdpScripts.js';
import { similarity } from '../core/agents/similarity.js';
import { redact } from '../security/redactor.js';
import * as agent from './browserAgent.js';

export interface VideoResult { title: string; url: string; channel: string; meta: string }
export interface VideoState { hasVideo: boolean; paused: boolean; ended: boolean; currentTime: number; title: string; url: string }

export interface YouTubeReport {
  success: boolean;
  action: string;
  query?: string;
  did?: string;
  check?: { status: 'verified' | 'failed' | 'unverifiable'; evidence: string };
  results?: VideoResult[];
  chosen?: VideoResult & { rank: number; why: string };
  page?: { url: string; title: string };
  error?: string;
  /** The address to open another way when Chrome's debugging port is not reachable. */
  url?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (t: unknown, max = 200) => redact(String(t ?? '')).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** YouTube's address (JARVIS_YOUTUBE_URL changes it, for the tests' local stand-in page). */
export function youtubeBase(): string {
  return (process.env['JARVIS_YOUTUBE_URL'] ?? 'https://www.youtube.com').replace(/\/+$/, '');
}

export function youtubeSearchUrl(query: string): string {
  return `${youtubeBase()}/results?search_query=${encodeURIComponent(query.trim()).replace(/%20/g, '+')}`;
}

function isWatchPage(url: string): boolean {
  return url.startsWith(`${youtubeBase()}/watch`);
}

/** The result that fits the query best: word overlap with the title, plus a little for rank. */
export function bestMatch(query: string, results: VideoResult[]): { index: number; why: string } {
  let best = 0;
  let bestScore = -1;
  results.forEach((r, i) => {
    const score = similarity(query, `${r.title} ${r.channel}`) + 0.1 * (1 - i / Math.max(1, results.length));
    if (score > bestScore + 1e-9) { best = i; bestScore = score; }
  });
  return { index: best, why: `closest words to "${clean(query, 60)}" among the first ${results.length} results (rank ${best + 1})` };
}

// Each call passes one of the fixed scripts in perception/cdpScripts.ts, by name.
const T = 4_000;
const readResultsOnce = (t: CdpTarget) => withPage(t, (s: CdpSession) => evaluateFixed<VideoResult[]>(s, YOUTUBE_RESULTS_SCRIPT, T));
const videoState = (t: CdpTarget) => withPage(t, (s: CdpSession) => evaluateFixed<VideoState>(s, VIDEO_STATE_SCRIPT, T));
/** play() with a user gesture, as a click would give it (Chrome's autoplay rules). */
const playVideo = (t: CdpTarget) => withPage(t, (s: CdpSession) => evaluateFixed<string>(s, VIDEO_PLAY_SCRIPT, T, { userGesture: true, awaitPromise: true }));
const pauseVideo = (t: CdpTarget) => withPage(t, (s: CdpSession) => evaluateFixed<string>(s, VIDEO_PAUSE_SCRIPT, T));

async function pageById(id: string): Promise<CdpTarget | undefined> {
  return (await listPages(cdpPort())).find((p) => p.id === id);
}

/** Waits for the results to render (YouTube fills the page after it loads). */
async function readResults(target: CdpTarget, timeoutMs = 8_000): Promise<VideoResult[]> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const results = await readResultsOnce(target);
      if (results?.length) return results;
    } catch { /* between documents */ }
    await sleep(300);
  }
  return [];
}

/** Checks that the video plays; asks it to play once (as a click would) if it has not started. */
export async function ensurePlaying(tabId: string, timeoutMs = 10_000): Promise<{ status: 'verified' | 'failed'; evidence: string; state?: VideoState }> {
  const end = Date.now() + timeoutMs;
  let tried = false;
  let last: VideoState | undefined;
  while (Date.now() < end) {
    const target = await pageById(tabId);
    if (!target) return { status: 'failed', evidence: 'the tab was closed' };
    try {
      last = await videoState(target);
      if (last.hasVideo && !last.paused && !last.ended) {
        const t0 = last.currentTime;
        await sleep(700);
        const again = await videoState(target);
        if (again.currentTime > t0) return { status: 'verified', evidence: `the video is playing (${again.currentTime.toFixed(1)} s in): ${clean(again.title, 120)}`, state: again };
      } else if (last.hasVideo && !tried && Date.now() > end - timeoutMs + 2_500) {
        tried = true;
        await playVideo(target);
      }
    } catch { /* the page is still loading */ }
    await sleep(400);
  }
  if (!last?.hasVideo) return { status: 'failed', evidence: 'no video player was found on the page' };
  return { status: 'failed', evidence: 'the video is open but did not start (Chrome may be blocking autoplay); press play or say "play the video"', state: last };
}

function cdpDown(message: string): boolean {
  return /ECONNREFUSED|remote debugging|debugging port|CdpUnavailable|not reachable|connect/i.test(message);
}

/**
 * Opens YouTube results for `query` in a new tab; `open`: 'results' leaves
 * them on screen, 'first' or 'best' opens that video in the same tab and
 * checks that it plays.
 */
export async function searchYouTube(query: string, open: 'results' | 'first' | 'best' = 'results'): Promise<YouTubeReport> {
  const q = query.trim();
  const action = open === 'results' ? 'search' : `play ${open}`;
  if (!q) return { success: false, action, error: 'Say what to search for on YouTube.' };
  const url = youtubeSearchUrl(q);
  const opened = await agent.tab({ action: 'new', url });
  if (!opened.success) {
    return { success: false, action, query: q, url, error: cdpDown(opened.error ?? '') ? `Chrome's debugging port is not reachable, so JARVIS cannot open and read YouTube there (${clean(opened.error, 120)}).` : clean(opened.error, 200) };
  }
  if (opened.check?.status !== 'verified') {
    return { success: true, action, query: q, did: opened.did ?? 'opened a new tab', check: opened.check ?? { status: 'unverifiable', evidence: 'no check' }, ...(opened.page ? { page: opened.page } : {}) };
  }
  const pages = await listPages(cdpPort());
  const results = `${youtubeBase()}/results`;
  const target = [...pages].reverse().find((p) => p.url.startsWith(results) && decodeURIComponent(p.url.replace(/\+/g, ' ')).includes(q))
    ?? [...pages].reverse().find((p) => p.url.startsWith(results));
  if (!target) return { success: true, action, query: q, did: opened.did!, check: { status: 'unverifiable', evidence: 'the new tab could not be found again to read its results' } };
  const found = await readResults(target);
  if (open === 'results') {
    return {
      success: true, action, query: q, did: `opened YouTube results for "${clean(q, 80)}" in a new tab`, results: found,
      check: found.length
        ? { status: 'verified', evidence: `the tab shows ${found.length} videos; the first is "${clean(found[0]!.title, 100)}"` }
        : { status: 'failed', evidence: 'the results page opened but showed no videos within 8 seconds' },
      page: { url: target.url, title: target.title },
    };
  }
  if (!found.length) {
    return { success: true, action, query: q, did: `opened YouTube results for "${clean(q, 80)}"`, results: found, check: { status: 'failed', evidence: 'no videos were found on the results page, so none was opened' } };
  }
  const pick = open === 'first' ? { index: 0, why: 'the first result' } : bestMatch(q, found);
  const chosen = found[pick.index]!;
  const nav = await agent.navigate({ action: 'go', url: chosen.url, tab: target.id });
  if (!nav.success) return { success: false, action, query: q, results: found, error: clean(nav.error, 200) };
  const playing = await ensurePlaying(target.id);
  return {
    success: true, action, query: q, results: found,
    did: `opened "${clean(chosen.title, 100)}"${chosen.channel ? ` by ${clean(chosen.channel, 60)}` : ''}`,
    chosen: { ...chosen, rank: pick.index + 1, why: pick.why },
    check: { status: playing.status, evidence: playing.evidence },
    ...(nav.page ? { page: nav.page } : {}),
  };
}

/** Plays or pauses the video in the YouTube tab (the one on screen if it is YouTube, else the latest). */
export async function playback(action: 'play' | 'pause', tabQuery?: string): Promise<YouTubeReport> {
  let pages: CdpTarget[];
  try { pages = await listPages(cdpPort()); } catch (err) {
    return { success: false, action, error: `Chrome's debugging port is not reachable (${clean((err as Error).message, 120)}).` };
  }
  let target: CdpTarget | undefined;
  if (tabQuery) target = pages.find((p) => p.id === tabQuery || p.title.toLowerCase().includes(tabQuery.toLowerCase()) || p.url.includes(tabQuery));
  if (!target) {
    const visible = await readBrowserState(cdpPort()).then((s) => s.visibleTab?.id).catch(() => undefined);
    target = pages.find((p) => p.id === visible && isWatchPage(p.url))
      ?? [...pages].reverse().find((p) => isWatchPage(p.url));
  }
  if (!target) return { success: false, action, error: 'No YouTube video is open in Chrome.' };
  if (action === 'pause') {
    await pauseVideo(target);
    await sleep(300);
    const st = await videoState(target);
    return { success: true, action, did: `paused "${clean(st.title, 100)}"`, check: st.paused ? { status: 'verified', evidence: 'the video is paused' } : { status: 'failed', evidence: 'the video is still playing' }, page: { url: st.url, title: st.title } };
  }
  await playVideo(target);
  const playing = await ensurePlaying(target.id, 6_000);
  return { success: true, action, did: `asked "${clean(target.title, 100)}" to play`, check: { status: playing.status, evidence: playing.evidence }, page: { url: target.url, title: target.title } };
}
