/**
 * tests/backgroundResearchTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Background web research that does not touch the desktop
 * (core/tools/webResearchTools.ts, core/agents/behaviors/news.ts):
 *
 *   - news_search: dated articles with source, link and retrieval time
 *   - youtube_trending: YouTube's own chart with a YouTube API key (region,
 *     time, the API's view counts); without it, search results clearly
 *     labelled as not a ranking; with neither key, a plain explanation
 *   - the Research agent answers current-events questions from news (not
 *     GitHub), compares sources, summarises only from what it found, and
 *     never calls a browser, window or YouTube-on-screen tool
 *   - failures are reported, not filled in
 *
 * The network is a stand-in; the model is scripted.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bg-research-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_AGENT_LOG'] = '0';
process.chdir(workspace);

const calls: string[] = [];
let newsDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  calls.push(url.replace(/key=[^&]+/, 'key=***'));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url === 'https://google.serper.dev/news') {
    if (newsDown) return new Response('quota', { status: 429 });
    const q = JSON.parse(String(init?.body ?? '{}')).q as string;
    return json({ news: [
      { title: 'OpenAI ships new agent toolkit for developers', link: 'https://news.example.com/a', source: 'Example News', date: '2 days ago', snippet: `About ${q}: a toolkit for building agents.` },
      { title: 'Google expands agent features in Gemini', link: 'https://tech.example.org/b', source: 'Tech Daily', date: '3 days ago', snippet: 'Agent features roll out.' },
      { title: 'Startups race to build AI agent platforms', link: 'https://biz.example.net/c', source: 'Biz Wire', date: '5 days ago', snippet: 'Funding for agent platforms.' },
    ] });
  }
  if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
    return json({ items: [
      { id: 'vid00000001', snippet: { title: 'Music video one', channelTitle: 'Artist A', publishedAt: '2026-10-08T10:00:00Z' }, statistics: { viewCount: '1234567' } },
      { id: 'vid00000002', snippet: { title: 'Game trailer two', channelTitle: 'Studio B', publishedAt: '2026-10-09T10:00:00Z' }, statistics: { viewCount: '890' } },
    ] });
  }
  if (url === 'https://google.serper.dev/videos') {
    return json({ videos: [
      { title: 'Popular clip', link: 'https://www.youtube.com/watch?v=pop00000001', channel: 'Channel C', date: '1 day ago', duration: '3:10' },
      { title: 'Not YouTube', link: 'https://vimeo.com/1', channel: 'X' },
    ] });
  }
  if (url === 'https://google.serper.dev/search') return json({ organic: [{ title: 'Web page about agents', link: 'https://web.example.com/x', snippet: 'General web result.' }] });
  throw new Error(`network is off in this test (${url})`);
}) as typeof fetch;

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { registerAgentRoles } = await import('../core/agents/specialists.js');
const { isCurrentEvents, newsQuery, parseItems, sharedThemes } = await import('../core/agents/behaviors/news.js');
const { trendingReply } = await import('../core/orchestrator.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
const executed: string[] = [];
const realExecute = toolRegistryV2.execute.bind(toolRegistryV2);
toolRegistryV2.execute = (async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => { executed.push(name); return realExecute(name, args, signal); }) as typeof toolRegistryV2.execute;

let modelUp = true;
const prompts: string[] = [];
modelRouter.chat = (async (req: { messages: { role: string; content: unknown }[] }) => {
  if (!modelUp) throw new Error('503 (test)');
  const user = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
  prompts.push(user);
  return { content: 'Agent toolkits and platforms are the week\'s theme [1][2][3].' };
}) as typeof modelRouter.chat;

console.log('\n=== Background research ===\n');

console.log('--- news_search ---');
process.env['SERPER_API_KEY'] = 'test-serper-key';
{
  const r = await toolRegistryV2.execute('news_search', { query: 'AI agents', period: 'week' });
  ok('dated articles with source and link', r.success && /Example News · 2 days ago/.test(r.output) && /https:\/\/news\.example\.com\/a/.test(r.output));
  ok('the retrieval time is stated', /retrieved \d{4}-\d{2}-\d{2}T/.test(r.output));
  ok('the key is not in the output', !r.output.includes('test-serper-key'));
}

console.log('\n--- youtube_trending ---');
{
  process.env['YOUTUBE_API_KEY'] = 'test-yt-key';
  const r = await toolRegistryV2.execute('youtube_trending', { region: 'PK', category: 'music' });
  ok('with a YouTube key: YouTube\'s own chart, region and time stated', r.success && /chart=mostPopular\) for region PK, category music, retrieved/.test(r.output), r.output.split('\n')[0]);
  ok('the API\'s view counts are shown as the API gave them', /1,234,567 views/.test(r.output) && /890 views/.test(r.output));
  ok('the request asked YouTube for that region and category', calls.some((c) => /regionCode=PK/.test(c) && /videoCategoryId=10/.test(c) && /key=\*\*\*/.test(c)));
  ok('the spoken reply names the chart and the top videos', /most-popular chart for PK/.test(trendingReply(r)) && /Music video one by Artist A/.test(trendingReply(r)), trendingReply(r));
  delete process.env['YOUTUBE_API_KEY'];
  const s = await toolRegistryV2.execute('youtube_trending', {});
  ok('without a YouTube key: search results, labelled NOT a ranking', s.success && /^NOT YouTube's ranking/.test(s.output) && /Trending page in July 2025/.test(s.output));
  ok('… only YouTube links, and no invented view counts', /pop00000001/.test(s.output) && !/vimeo/.test(s.output) && !/views/.test(s.output));
  ok('… and the reply says it is search order', /not a ranking/.test(trendingReply(s)), trendingReply(s));
  delete process.env['SERPER_API_KEY'];
  // Other arguments than above: the registry keeps a result for 30 s per arguments.
  const n = await toolRegistryV2.execute('youtube_trending', { limit: 7 });
  ok('with neither key: it says which key is needed', /YOUTUBE_API_KEY/.test(n.output) && /SERPER_API_KEY/.test(n.output));
  ok('… and the reply says so plainly', /can't get trending videos/.test(trendingReply(n)));
  ok('a bad region is refused', /two-letter/.test((await toolRegistryV2.execute('youtube_trending', { region: 'Pakistan' })).output));
  process.env['SERPER_API_KEY'] = 'test-serper-key';
}

console.log('\n--- The Research agent on current events ---');
ok('news questions take the news path; GitHub questions do not', isCurrentEvents('research the latest developments in AI agents') && !isCurrentEvents('find the best GitHub libraries for CDP'));
ok('the search words drop the instructions', newsQuery('Research the latest developments in AI agents and summarize your findings') === 'the latest developments in AI agents');
const items = parseItems('h\n\n1. A agents launch\nhttps://a.com/1\nSrc · 1 day ago\nx\n\n2. B agents funding\nhttps://b.com/2\nSrc2 · 2 days ago\ny');
ok('items are read with their links and dates', items.length === 2 && items[1]!.meta === 'Src2 · 2 days ago');
ok('themes shared by different sources are found', sharedThemes(items).includes('agents'));
{
  const m = new AgentManager();
  registerAgentRoles(m);
  executed.length = 0;
  const h = await m.startRootTask({ request: 'research', specialistRole: 'research_agent', task: { description: 'Research the latest developments in AI agents and summarize your findings' } });
  const r = await h.result;
  ok('the research finished with a summary from the model, citing the items', r.status === 'COMPLETED' && /\[1\]/.test(r.answer), r.answer);
  ok('the model was given only the found items, marked as untrusted', prompts.some((p) => p.includes('[1] OpenAI ships new agent toolkit') && /untrusted/i.test(p)));
  ok('sources keep their links', r.sources.length >= 3 && r.sources.every((s) => !!s.url));
  ok('three sources from three sites: moderate confidence', r.confidence === 0.65, String(r.confidence));
  ok('it says what was not checked and when it was retrieved', r.limitations.some((l) => /not opened/.test(l)) && r.limitations.some((l) => /retrieved/.test(l)));
  const onScreen = executed.filter((t) => /^(browser_|youtube_search|youtube_play|site_search|control_browser|control_app|control_window|open_app|ui_action)/.test(t));
  ok('it never touched the screen: no browser, window or app tool ran', onScreen.length === 0, executed.join(','));

  modelUp = false;
  const h2 = await m.startRootTask({ request: 'trending', specialistRole: 'research_agent', task: { description: 'Find currently trending YouTube videos and tell me what is trending' } });
  const r2 = await h2.result;
  ok('trending questions use youtube_trending', executed.includes('youtube_trending'));
  ok('without the model, the summary lists what was found, with the retrieval time', r2.status === 'COMPLETED' && /On YouTube \(retrieved/.test(r2.answer) && /Popular clip/.test(r2.answer), r2.answer);

  newsDown = true;
  const h3 = await m.startRootTask({ request: 'news', specialistRole: 'research_agent', task: { description: 'What is the latest news about quantum chips?' } });
  const r3 = await h3.result;
  ok('when news search fails it falls back to web search, and says so', /general web results/.test(r3.limitations.join(' ')) && /Web page about agents/.test(r3.answer), r3.limitations.join(' | '));
  delete process.env['SERPER_API_KEY'];
  const h4 = await m.startRootTask({ request: 'news', specialistRole: 'research_agent', task: { description: 'What is the latest news about solid-state batteries?' } });
  const r4 = await h4.result;
  ok('with no search source at all, it says it found nothing (no invented news)', /could not find current information/.test(r4.answer) && r4.confidence <= 0.1, r4.answer);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
