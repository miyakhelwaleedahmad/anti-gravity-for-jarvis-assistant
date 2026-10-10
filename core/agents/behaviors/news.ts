/**
 * core/agents/behaviors/news.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The Research agent's path for current events ("the latest AI news", "what
 * is trending on YouTube", "recent developments in X"). The rest of the
 * Research agent is built for software projects (GitHub, docs); news needs
 * dated sources instead.
 *
 *   1. collect: news_search (last week), or youtube_trending for "trending /
 *      popular on YouTube"; web_search when news search gives nothing
 *   2. compare: themes that several independent sources share
 *   3. summarise: the model writes the summary only from the items found,
 *      citing them by number; without the model, the headlines themselves
 *   4. report: every item keeps its source, date and link; the retrieval time
 *      and what was not checked are stated
 *
 * Nothing is opened on screen. Nothing the sources did not say is added.
 */

import type { AgentContext } from '../agentContextApi.js';
import type { AgentOutcome } from '../types.js';
import { agentModel, keywords, untrusted, UNTRUSTED_RULE } from './common.js';

const CURRENT = /\b(latest|recent(?:ly)?|current(?:ly)?|today|this week|news|headlines?|trending|popular right now|developments?|what'?s new|announcements?|breaking)\b/i;
const SOFTWARE_PROJECTS = /\b(git ?hub|repositor(?:y|ies)|repos|librar(?:y|ies)|frameworks?|sdks?|open[- ]source|npm|packages?)\b/i;
const YT_TRENDING = /\byou ?tube\b[\s\S]*\b(trending|popular|top videos?)\b|\b(trending|popular|top)\b[\s\S]*\byou ?tube\b/i;

/** A question about current events (not about software projects). */
export function isCurrentEvents(question: string): boolean {
  return (CURRENT.test(question) || YT_TRENDING.test(question)) && !SOFTWARE_PROJECTS.test(question);
}

/** The search words: the request without the instructions around it. */
export function newsQuery(question: string): string {
  return question
    .replace(/\b(please|jarvis|research|find(?: out)?|look up|search(?: for)?|tell me|give me|summari[sz]e(?: (?:your|the) findings)?|report back|what is|what are|what's)\b/gi, ' ')
    .replace(/\b(in the background|while i work|for me)\b/gi, ' ')
    .replace(/[?.!,;:]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:and|then|also)\s+|\s+(?:and|then|also)$/gi, '').trim() || question.trim();
}

interface Item { n: number; title: string; url: string; meta: string; snippet: string; domain: string }

/** "n. title\nurl\nmeta\nsnippet" blocks (news_search, youtube_trending, web_search). */
export function parseItems(text: string): Item[] {
  const items: Item[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const at = lines.findIndex((l) => /^https?:\/\//.test(l));
    if (at < 1) continue;
    const title = lines[at - 1]!.replace(/^\d+\.\s*/, '');
    const url = lines[at]!;
    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
    items.push({ n: items.length + 1, title, url, meta: lines[at + 1] ?? '', snippet: lines.slice(at + 2).join(' '), domain });
  }
  return items;
}

/** Words several different sources put in their titles: what the coverage agrees on. */
export function sharedThemes(items: Item[], min = 2): string[] {
  const byWord = new Map<string, Set<string>>();
  for (const it of items) {
    for (const w of keywords(it.title, 12)) {
      if (w.length < 4) continue;
      const set = byWord.get(w) ?? new Set<string>();
      set.add(it.domain || it.url);
      byWord.set(w, set);
    }
  }
  return [...byWord.entries()].filter(([, s]) => s.size >= min).sort((a, b) => b[1].size - a[1].size).slice(0, 6).map(([w]) => w);
}

export async function currentEventsResearch(ctx: AgentContext, question: string): Promise<AgentOutcome> {
  const query = newsQuery(question);
  const retrievedAt = new Date().toISOString();
  const limitations: string[] = [];
  let label = 'news';
  let raw = '';

  if (YT_TRENDING.test(question)) {
    ctx.progress('reading what is popular on YouTube');
    const r = await ctx.callTool('youtube_trending', {});
    if (r.success && !/^\s*Error/i.test(r.output)) { raw = r.output; label = 'YouTube'; }
    else limitations.push(`youtube_trending: ${(r.error ?? r.output).slice(0, 200)}`);
  }
  if (!raw) {
    ctx.progress(`searching news: ${query}`);
    const r = await ctx.callTool('news_search', { query, period: 'week' });
    if (r.success && !/^\s*(Error|No news results)/i.test(r.output)) raw = r.output;
    else limitations.push(`news_search: ${(r.error ?? r.output).slice(0, 200)}`);
  }
  if (!raw) {
    ctx.progress(`searching the web: ${query}`);
    const r = await ctx.callTool('web_search', { query: `${query} latest` });
    if (r.success && !/^\s*(Error|No results)/i.test(r.output)) { raw = r.output; label = 'web'; limitations.push('No news results; these are general web results and may not be recent.'); }
    else limitations.push(`web_search: ${(r.error ?? r.output).slice(0, 200)}`);
  }

  const items = parseItems(raw).slice(0, 12);
  if (!items.length) {
    return {
      summary: `I could not find current information about "${query}": no search source returned results (retrieved ${retrievedAt}).`,
      confidence: 0.1, limitations, data: { query, retrievedAt, items: 0 },
    };
  }
  for (const it of items) {
    const source = ctx.addSource({ url: it.url, title: it.title, kind: label === 'YouTube' ? 'video' : 'news', quality: label === 'web' ? 0.45 : 0.6, metadata: { meta: it.meta } });
    ctx.addFinding({ text: `${it.title}${it.meta ? ` (${it.meta})` : ''}${it.snippet ? `: ${it.snippet}` : ''}`.slice(0, 400), sourceIds: [source.id], confidence: 0.55, tags: [label] });
  }
  const themes = sharedThemes(items);
  if (themes.length) ctx.addFinding({ text: `Several independent sources cover: ${themes.join(', ')}.`, confidence: 0.6, tags: ['comparison'] });
  const domains = new Set(items.map((i) => i.domain).filter(Boolean));

  // The summary is written only from the items; without the model, the items themselves.
  let summary = '';
  const header = raw.split('\n')[0] ?? '';
  try {
    const res = await ctx.llm({
      model: agentModel(),
      messages: [
        { role: 'system', content: `You summarise search results for JARVIS's user. Use only the numbered items; cite them as [n]; give dates where the items do; say where items disagree; do not add facts, numbers or rankings that are not in the items. ${UNTRUSTED_RULE}` },
        { role: 'user', content: `Question: ${question}\n\n${untrusted('search results', items.map((i) => `[${i.n}] ${i.title} — ${i.meta}${i.snippet ? ` — ${i.snippet}` : ''} (${i.url})`).join('\n'))}` },
      ],
      temperature: 0.2,
      max_tokens: 500,
    });
    summary = (res.content ?? '').trim();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    limitations.push('The model was not available; the summary lists the items as found.');
  }
  if (!summary) {
    summary = `${label === 'YouTube' ? 'On YouTube' : 'In the news'} (retrieved ${retrievedAt.slice(0, 16).replace('T', ' ')} UTC):\n`
      + items.slice(0, 6).map((i) => `${i.n}. ${i.title}${i.meta ? ` — ${i.meta}` : ''}`).join('\n')
      + (themes.length ? `\nShared themes: ${themes.join(', ')}.` : '');
  }
  limitations.push(`Source: ${header.slice(0, 200)}`);
  limitations.push('Built from headlines and snippets; the articles themselves were not opened, so details should be checked at the links.');
  return {
    summary,
    confidence: items.length >= 3 && domains.size >= 2 ? 0.65 : 0.45,
    limitations,
    data: { query, retrievedAt, items: items.length, domains: domains.size, themes, kind: label },
  };
}
