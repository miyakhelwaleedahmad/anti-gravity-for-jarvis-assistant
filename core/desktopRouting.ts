/**
 * core/desktopRouting.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Plain requests for things on screen, answered without the model:
 *
 *   "open YouTube and search for python tutorials"      youtube_search (results)
 *   "search for lo-fi music on YouTube and play the first one"   (first)
 *   "play the latest AI news on YouTube"                youtube_search (best match)
 *   "play this video" / "pause the video"               youtube_play
 *   "open Wikipedia and search for Alan Turing"         site_search
 *   "what's trending on YouTube", "find trending YouTube videos in Pakistan"
 *                                                       youtube_trending (background, read-only)
 *
 * Requests said to be background work go to the agents instead
 * (core/delegationRouting.ts); GitHub searches stay with the Research agent
 * unless the user asks to open GitHub.
 */

export type DesktopRoute =
  | { type: 'youtube_search'; query: string; open: 'results' | 'first' | 'best' }
  | { type: 'youtube_play'; action: 'play' | 'pause' }
  | { type: 'site_search'; site: string; query: string }
  | { type: 'youtube_trending'; region?: string; category?: string };

const REGIONS: Record<string, string> = {
  us: 'US', usa: 'US', 'united states': 'US', america: 'US', uk: 'GB', britain: 'GB', 'united kingdom': 'GB', england: 'GB',
  pakistan: 'PK', india: 'IN', canada: 'CA', australia: 'AU', germany: 'DE', france: 'FR', japan: 'JP', uae: 'AE',
  'saudi arabia': 'SA', turkey: 'TR', brazil: 'BR', spain: 'ES', italy: 'IT', mexico: 'MX', nigeria: 'NG', bangladesh: 'BD',
};
const CATEGORIES: Record<string, string> = {
  music: 'music', songs: 'music', gaming: 'gaming', games: 'gaming', news: 'news', sports: 'sports', movies: 'film', film: 'film',
  trailers: 'film', education: 'education', science: 'science', technology: 'technology', tech: 'technology', comedy: 'comedy',
};
const SITES = '(google|bing|duck ?duck ?go|wikipedia|amazon|reddit|stack ?overflow)';

function tidy(text: string): string {
  return text.toLowerCase()
    .replace(/[“”"]/g, '').replace(/[^a-z0-9\s'+#.-]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:hey|ok|okay) )?jarvis[\s,]+/, '').replace(/^(?:please |can you |could you |would you )+/, '')
    .replace(/(?: please| for me| now| right now)+[.!?]*$/, '').replace(/[.!?]+$/, '').trim();
}

function siteKey(site: string): string {
  return site.replace(/\s+/g, '');
}

export function matchDesktopRoute(text: string): DesktopRoute | undefined {
  const t = tidy(text);
  if (!t) return undefined;
  const background = /\b(in the background|while i (?:work|am working)|without (?:disturbing|interrupting) me)\b/.test(t);

  // What is trending: read-only and off-screen, so it never needs the desktop.
  if (/\b(trending|popular|top)\b/.test(t) && /\b(you ?tube|videos?)\b/.test(t) && !/^(?:open|play|watch)\b/.test(t) && !background) {
    const region = Object.entries(REGIONS).find(([name]) => new RegExp(`\\bin (?:the )?${name}\\b`).test(t))?.[1];
    const category = Object.entries(CATEGORIES).find(([name]) => new RegExp(`\\b${name}\\b`).test(t))?.[1];
    return { type: 'youtube_trending', ...(region ? { region } : {}), ...(category ? { category } : {}) };
  }
  if (background) return undefined;

  if (/^(?:play|resume|start|unpause|continue) (?:this|the|that) video$|^(?:play|resume) it$|^(?:continue|resume) playing$|^play the video again$/.test(t)) return { type: 'youtube_play', action: 'play' };
  if (/^(?:pause|stop|hold) (?:this|the|that) video$|^pause it$|^pause youtube$/.test(t)) return { type: 'youtube_play', action: 'pause' };

  let m = /^(?:search|look) (?:youtube |on youtube )?for (.+?)(?: on youtube)? and (?:play|open|watch) (?:the )?(first|best|top)(?: matching)?(?: result| video| one)?$/.exec(t)
    ?? /^(?:find|search for|look for) (.+?) on youtube and (?:play|open|watch) (?:the )?(first|best|top)(?: matching)?(?: result| video| one)?$/.exec(t)
    ?? /^(?:open|go to) youtube and (?:search|look) (?:for )?(.+?) and (?:play|open|watch) (?:the )?(first|best|top)(?: matching)?(?: result| video| one)?$/.exec(t);
  if (m) return { type: 'youtube_search', query: m[1]!.trim(), open: m[2] === 'best' ? 'best' : 'first' };
  m = /^(?:play|watch) (?!this\b|the video\b|it\b)(.+?) on youtube$/.exec(t) ?? /^(?:open|go to) youtube and play (.+)$/.exec(t);
  if (m) return { type: 'youtube_search', query: m[1]!.trim(), open: 'best' };
  m = /^(?:open |go to )?youtube and (?:search|look) (?:for )?(.+)$/.exec(t)
    ?? /^search (?:on )?youtube for (.+)$/.exec(t)
    ?? /^youtube search (?:for )?(.+)$/.exec(t)
    ?? /^(?:search|look) (?:for )?(.+?) on youtube$/.exec(t)
    ?? /^(?:find|show)(?: me)? (.+?) on youtube$/.exec(t);
  if (m) return { type: 'youtube_search', query: m[1]!.trim(), open: 'results' };

  m = new RegExp(`^(?:open |go to )?${SITES} and search (?:for )?(.+)$`).exec(t) ?? new RegExp(`^search ${SITES} for (.+)$`).exec(t);
  if (m) return { type: 'site_search', site: siteKey(m[1]!), query: m[2]!.trim() };
  m = new RegExp(`^(?:search|look up) (.+?) on ${SITES}$`).exec(t);
  if (m) return { type: 'site_search', site: siteKey(m[2]!), query: m[1]!.trim() };
  // GitHub: only when the user asks to open it; "search GitHub for …" stays with the Research agent.
  m = /^(?:open|go to) github and search (?:for )?(.+)$/.exec(t);
  if (m) return { type: 'site_search', site: 'github', query: m[1]!.trim() };
  return undefined;
}
