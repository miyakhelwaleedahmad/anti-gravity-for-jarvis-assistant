/**
 * core/tools/youtubeTools.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Foreground browser actions the user asks for by name (control/youtubeControl.ts,
 * control/browserAgent.ts), each checked on the page afterwards:
 *
 *   youtube_search  YouTube results for a query in a new tab; optionally open
 *                   the first or best-matching video there and check it plays
 *   youtube_play    play or pause the video in the YouTube tab
 *   site_search     a site's own search results in a new tab (Google, Bing,
 *                   DuckDuckGo, Wikipedia, GitHub, Amazon, Reddit, Stack Overflow)
 *
 * New tabs, never the tab the user is on; nothing is closed. The tabs open in
 * JARVIS's own Chrome, started when needed (control/jarvisChrome.ts). When it
 * cannot be, the reply says why; nothing opens in the default browser, which
 * JARVIS could not read or check (owner decision D1, answer Q2).
 */

import type { AgentTool } from '../toolRegistryV2.js';
import type { Verifier } from '../verifiers.js';
import * as agent from '../../control/browserAgent.js';
import { playback, searchYouTube, youtubeSearchUrl, type YouTubeReport } from '../../control/youtubeControl.js';

/** The tool's own check, as the registry's verification. */
const ownCheck: Verifier = async (_args, output) => {
  try {
    const r = JSON.parse(output) as YouTubeReport;
    if (r.check && ['verified', 'failed', 'unverifiable'].includes(r.check.status)) return { status: r.check.status, evidence: r.check.evidence };
  } catch { /* not a report */ }
  return { status: 'unverifiable', evidence: 'the action reported no check' };
};

export const youtubeSearchTool: AgentTool = {
  name: 'youtube_search',
  description:
    'Use when the user wants YouTube on screen: search YouTube, show results, or open/play a video they describe. Opens the results in a new tab in Chrome '
    + '(the user\'s other tabs are left alone). Parameters: query (what to search for), open ("results" only shows the list; to PLAY a song or '
    + 'video the user asks for, set open to "best" (or "first"): that opens the video and plays it). JARVIS checks the page afterwards. Not for background research: use news_search or youtube_trending for that.',
  riskLevel: 'medium',
  inputSchema: {
    query: { type: 'string', description: 'What to search for on YouTube', required: true },
    open: { type: 'string', description: 'results, first or best', required: false, enum: ['results', 'first', 'best'] },
  },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    const query = String(args['query'] ?? '').trim();
    const open = (['results', 'first', 'best'].includes(String(args['open'])) ? args['open'] : 'results') as 'results' | 'first' | 'best';
    return JSON.stringify(await searchYouTube(query, open));
  },
};

export const youtubePlayTool: AgentTool = {
  name: 'youtube_play',
  description: 'Use for "play this video", "pause the video", "resume the video" on YouTube in Chrome. Parameter: action (play or pause). JARVIS checks that the video plays or is paused.',
  riskLevel: 'medium',
  inputSchema: {
    action: { type: 'string', description: 'play or pause', required: true, enum: ['play', 'pause'] },
    tab: { type: 'string', description: 'Which tab (optional): words from its title', required: false },
  },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    const action = String(args['action']) === 'pause' ? 'pause' : 'play';
    return JSON.stringify(await playback(action, typeof args['tab'] === 'string' ? args['tab'] : undefined));
  },
};

const SITES: Record<string, (q: string) => string> = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  wikipedia: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
  github: (q) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`,
  amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  reddit: (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
  stackoverflow: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
  youtube: (q) => youtubeSearchUrl(q),
};

export function siteSearchUrl(site: string, query: string): string | undefined {
  const key = site.toLowerCase().replace(/[\s._-]/g, '').replace(/^stackoverflowcom$/, 'stackoverflow');
  return SITES[key]?.(query.trim());
}

export const siteSearchTool: AgentTool = {
  name: 'site_search',
  description:
    'Use when the user wants a website\'s search results on screen ("open GitHub and search for X", "search Wikipedia for Y"). Opens the site\'s own results page in a new tab '
    + `and checks that it loaded. Parameters: site (${Object.keys(SITES).join(', ')}), query.`,
  riskLevel: 'medium',
  inputSchema: {
    site: { type: 'string', description: 'Which site', required: true, enum: Object.keys(SITES) },
    query: { type: 'string', description: 'What to search for', required: true },
  },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    const site = String(args['site'] ?? '');
    const query = String(args['query'] ?? '').trim();
    if (!query) return JSON.stringify({ success: false, action: 'search', error: 'Say what to search for.' });
    if (/^you ?tube$/i.test(site)) return JSON.stringify(await searchYouTube(query, 'results'));
    const url = siteSearchUrl(site, query);
    if (!url) return JSON.stringify({ success: false, action: 'search', error: `JARVIS has no search address for "${site}". Known sites: ${Object.keys(SITES).join(', ')}.` });
    const r = await agent.tab({ action: 'new', url });
    const report: YouTubeReport = {
      success: r.success, action: 'search', query, url,
      ...(r.did ? { did: `${r.did} (${site} search)` } : {}),
      ...(r.check ? { check: r.check } : {}),
      ...(r.page ? { page: r.page } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
    return JSON.stringify(report);
  },
};

export const youtubeTools: AgentTool[] = [youtubeSearchTool, youtubePlayTool, siteSearchTool];
