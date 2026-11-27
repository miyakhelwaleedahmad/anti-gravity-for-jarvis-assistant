/**
 * core/tools/webResearchTools.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Background web research that never touches the user's screen:
 *
 *   news_search       recent news articles for a query (Serper's Google News
 *                     endpoint, SERPER_API_KEY): title, source, date, link
 *   youtube_trending  what is popular on YouTube now:
 *                       - with YOUTUBE_API_KEY: YouTube Data API v3
 *                         videos.list chart=mostPopular for a region (and
 *                         category) — YouTube's own chart, with the view counts
 *                         the API reports at retrieval time;
 *                       - without it but with SERPER_API_KEY: video search
 *                         results from the last week, labelled as search
 *                         results and NOT YouTube's ranking;
 *                       - with neither: says which key is needed.
 *                     YouTube retired its Trending page in July 2025, so there
 *                     is no page to read instead.
 *
 * Both say where the data came from and when it was fetched, and never fill
 * in a number the source did not give.
 */

import type { AgentTool } from '../toolRegistryV2.js';

const TIMEOUT_MS = 10_000;

async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const PERIOD: Record<string, string> = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m' };

export const newsSearchTool: AgentTool = {
  name: 'news_search',
  description:
    'Use for current news and recent developments ("latest AI news", "what happened with X this week"). Searches news articles and returns '
    + 'title, source, date and link for each, with the time it was retrieved. Parameters: query, period (day, week or month; default week), limit (default 8). '
    + 'Runs in the background; does not open anything on screen.',
  riskLevel: 'low',
  cacheable: true,
  inputSchema: {
    query: { type: 'string', description: 'What to find news about', required: true },
    period: { type: 'string', description: 'day, week or month', required: false, enum: ['day', 'week', 'month'] },
    limit: { type: 'number', description: 'How many articles (1–15)', required: false },
  },
  fallbacks: [],
  async execute(args, signal) {
    const query = String(args['query'] ?? '').trim();
    if (!query) return 'Error: news_search needs a query.';
    const key = process.env['SERPER_API_KEY'];
    if (!key) return 'Error: SERPER_API_KEY is not set, so news cannot be searched.';
    const period = PERIOD[String(args['period'] ?? 'week')] ?? PERIOD['week'];
    const limit = Math.max(1, Math.min(15, Number(args['limit']) || 8));
    const retrieved = new Date().toISOString();
    let data: { news?: { title?: string; link?: string; snippet?: string; date?: string; source?: string }[] };
    try {
      data = await fetchJson('https://google.serper.dev/news', {
        method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, tbs: period, num: limit }),
      }, signal) as typeof data;
    } catch (err) {
      return `Error: news search failed (${(err as Error).message}).`;
    }
    const items = (data.news ?? []).filter((n) => n.title && n.link).slice(0, limit);
    if (!items.length) return `No news results for "${query}" (period: ${String(args['period'] ?? 'week')}; retrieved ${retrieved}).`;
    return [
      `News results for "${query}" (Google News via Serper, last ${String(args['period'] ?? 'week')}), retrieved ${retrieved}:`,
      '',
      ...items.map((n, i) => `${i + 1}. ${n.title}\n${n.link}\n${[n.source, n.date].filter(Boolean).join(' · ')}${n.snippet ? `\n${n.snippet}` : ''}`),
    ].join('\n\n').replace(/\n\n\n/g, '\n\n');
  },
};

/** YouTube Data API video category ids (they apply to most regions). */
const CATEGORY_IDS: Record<string, string> = {
  film: '1', autos: '2', music: '10', pets: '15', sports: '17', travel: '19', gaming: '20', people: '22', comedy: '23',
  entertainment: '24', news: '25', howto: '26', education: '27', science: '28', technology: '28',
};

function formatCount(n: string | undefined): string {
  if (!n || !/^\d+$/.test(n)) return '';
  return `${Number(n).toLocaleString('en-US')} views`;
}

export const youtubeTrendingTool: AgentTool = {
  name: 'youtube_trending',
  description:
    'Use to find out what is popular on YouTube right now, without opening anything on screen. Parameters: region (two-letter country code, '
    + 'default from JARVIS_REGION or US), category (music, gaming, news, sports, film, entertainment, education, science; optional), limit (default 10). '
    + 'Returns YouTube\'s most-popular chart when a YouTube API key is configured; otherwise recent video search results, clearly labelled as not a ranking.',
  riskLevel: 'low',
  cacheable: true,
  inputSchema: {
    region: { type: 'string', description: 'Two-letter country code, e.g. US, PK, GB', required: false },
    category: { type: 'string', description: 'Optional category', required: false },
    limit: { type: 'number', description: 'How many videos (1–25)', required: false },
  },
  fallbacks: [],
  async execute(args, signal) {
    const region = String(args['region'] ?? process.env['JARVIS_REGION'] ?? 'US').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(region)) return `Error: "${region}" is not a two-letter country code.`;
    const category = String(args['category'] ?? '').trim().toLowerCase();
    const categoryId = category ? CATEGORY_IDS[category] : undefined;
    if (category && !categoryId) return `Error: unknown category "${category}". Use one of: ${Object.keys(CATEGORY_IDS).join(', ')}.`;
    const limit = Math.max(1, Math.min(25, Number(args['limit']) || 10));
    const retrieved = new Date().toISOString();

    const ytKey = process.env['YOUTUBE_API_KEY'];
    if (ytKey) {
      const params = new URLSearchParams({ part: 'snippet,statistics', chart: 'mostPopular', regionCode: region, maxResults: String(limit), key: ytKey });
      if (categoryId) params.set('videoCategoryId', categoryId);
      let data: { items?: { id: string; snippet?: { title?: string; channelTitle?: string; publishedAt?: string }; statistics?: { viewCount?: string } }[] };
      try {
        data = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?${params}`, { method: 'GET' }, signal) as typeof data;
      } catch (err) {
        return `Error: the YouTube Data API request failed (${(err as Error).message.replace(ytKey, '***')}).`;
      }
      const items = data.items ?? [];
      if (!items.length) return `YouTube returned no most-popular videos for region ${region}${category ? ` in ${category}` : ''} (retrieved ${retrieved}).`;
      return [
        `YouTube's most-popular chart (YouTube Data API v3, chart=mostPopular) for region ${region}${category ? `, category ${category}` : ''}, retrieved ${retrieved}. View counts are as the API reported them then.`,
        '',
        ...items.map((v, i) => `${i + 1}. ${v.snippet?.title ?? '(no title)'}\nhttps://www.youtube.com/watch?v=${v.id}\n${[v.snippet?.channelTitle, formatCount(v.statistics?.viewCount), v.snippet?.publishedAt ? `published ${v.snippet.publishedAt.slice(0, 10)}` : ''].filter(Boolean).join(' · ')}`),
      ].join('\n\n').replace(/\n\n\n/g, '\n\n');
    }

    const serper = process.env['SERPER_API_KEY'];
    if (serper) {
      let data: { videos?: { title?: string; link?: string; channel?: string; date?: string; duration?: string }[] };
      const q = `${category ? `${category} ` : ''}popular YouTube videos this week`;
      try {
        data = await fetchJson('https://google.serper.dev/videos', {
          method: 'POST', headers: { 'X-API-KEY': serper, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, gl: region.toLowerCase(), tbs: 'qdr:w', num: limit }),
        }, signal) as typeof data;
      } catch (err) {
        return `Error: video search failed (${(err as Error).message}). For YouTube's own chart, set YOUTUBE_API_KEY.`;
      }
      const items = (data.videos ?? []).filter((v) => v.title && v.link && /youtube\.com|youtu\.be/.test(v.link)).slice(0, limit);
      if (!items.length) return `No recent YouTube videos were found by search for region ${region} (retrieved ${retrieved}). For YouTube's own chart, set YOUTUBE_API_KEY.`;
      return [
        `NOT YouTube's ranking: no YOUTUBE_API_KEY is set, so these are web search results for recently popular YouTube videos (region ${region}, last week), retrieved ${retrieved}. `
          + 'The order is the search engine\'s, and no view counts are given. (YouTube retired its Trending page in July 2025; its most-popular chart needs the YouTube Data API.)',
        '',
        ...items.map((v, i) => `${i + 1}. ${v.title}\n${v.link}\n${[v.channel, v.date, v.duration].filter(Boolean).join(' · ')}`),
      ].join('\n\n').replace(/\n\n\n/g, '\n\n');
    }
    return 'Error: no source is configured for trending videos. Set YOUTUBE_API_KEY (YouTube Data API v3, for YouTube\'s most-popular chart) or SERPER_API_KEY (for search results).';
  },
};

export const webResearchTools: AgentTool[] = [newsSearchTool, youtubeTrendingTool];
