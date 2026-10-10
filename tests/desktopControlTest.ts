/**
 * tests/desktopControlTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Desktop control on request (control/youtubeControl.ts, core/tools/youtubeTools.ts)
 * in a real Chromium through the DevTools Protocol, against a local stand-in
 * for YouTube (JARVIS_YOUTUBE_URL) that serves a results page and watch pages
 * with a real <video> element playing a generated WAV file:
 *
 *   - search opens the results in a NEW tab and reads them; the user's tab is
 *     not touched and no tab is closed
 *   - "best match" opens the matching video and checks that it really plays
 *     (a paused video is asked to play once, as a click would)
 *   - pause and play are checked on the video itself
 *   - site_search opens a site's results in a new tab
 *   - the routes and the spoken replies, and an honest failure without Chrome
 *
 * Needs Chromium or Chrome (JARVIS_TEST_CHROME); the suite skips it otherwise.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { startChromium } from './chromeHelper.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-desktop-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

/** Five seconds of quiet 8 kHz mono PCM: something a <video> element can really play. */
function wav(seconds = 5): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds, 128);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const VIDEOS: Record<string, { title: string; channel: string; autoplay: boolean }> = {
  aaaaaaaaaaa: { title: 'Python Tutorial for Beginners - Full Course', channel: 'Code Academy', autoplay: true },
  bbbbbbbbbbb: { title: 'Lofi hip hop radio - beats to relax/study to', channel: 'Lofi Girl', autoplay: false },
  ccccccccccc: { title: 'Funny cats compilation', channel: 'Cat Channel', autoplay: true },
};
const audio = wav();
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/results') {
    const ad = '<ytd-ad-slot-renderer><a href="/watch?v=zzzzzzzzzzz" title="An advert">ad</a></ytd-ad-slot-renderer>';
    const items = Object.entries(VIDEOS).map(([id, v]) => `<ytd-video-renderer><a id="video-title" href="/watch?v=${id}" title="${v.title}">${v.title}</a><ytd-channel-name><a>${v.channel}</a></ytd-channel-name><div id="metadata-line">1M views</div></ytd-video-renderer>`).join('');
    // The results appear a moment after the page loads, as on YouTube.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>${url.searchParams.get('search_query')} - YouTube</title><ytd-search id="s"></ytd-search><script>setTimeout(() => { document.getElementById('s').innerHTML = ${JSON.stringify(ad + items)}; }, 400);</script>`);
    return;
  }
  if (url.pathname === '/watch') {
    const v = VIDEOS[url.searchParams.get('v') ?? ''];
    res.writeHead(v ? 200 : 404, { 'Content-Type': 'text/html' });
    res.end(v ? `<!doctype html><title>${v.title} - YouTube</title><h1 class="title">${v.title}</h1><video src="/tone.wav" muted ${v.autoplay ? 'autoplay' : ''}></video>` : 'not found');
    return;
  }
  if (url.pathname === '/tone.wav') { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length }); res.end(audio); return; }
  if (url.pathname === '/mine') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>My work</title><p>the user\'s own tab</p>'); return; }
  if (url.pathname === '/w/index.php') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><title>Search results - Wikipedia</title><p>${url.searchParams.get('search')}</p>`); return; }
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env['JARVIS_YOUTUBE_URL'] = base;

const chrome = await startChromium(`${base}/mine`);
process.env['JARVIS_CDP_PORT'] = String(chrome.port);

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { listPages } = await import('../perception/cdpClient.js');
const { searchYouTube, playback, bestMatch } = await import('../control/youtubeControl.js');
const { siteSearchUrl } = await import('../core/tools/youtubeTools.js');
const { matchDesktopRoute } = await import('../core/desktopRouting.js');
const { desktopReply } = await import('../core/orchestrator.js');
registerAllTools();

console.log('\n=== Desktop control in a real browser ===\n');
const pagesBefore = await listPages(chrome.port);
const mine = pagesBefore.find((p) => p.url.endsWith('/mine'))!;

console.log('--- Search: a new tab, results read from the page ---');
{
  const r = await searchYouTube('python tutorial', 'results');
  ok('the search was done and checked', r.success && r.check?.status === 'verified', r.check?.evidence);
  ok('it read the three videos, not the advert', r.results?.length === 3 && !r.results.some((v) => /advert/.test(v.title)), r.results?.map((v) => v.title).join(' | '));
  ok('it read titles and channels', r.results?.[0]?.title.startsWith('Python Tutorial') === true && r.results[0]!.channel === 'Code Academy');
  const pages = await listPages(chrome.port);
  ok('it used a new tab', pages.length === pagesBefore.length + 1);
  ok('the user\'s own tab is untouched', pages.some((p) => p.id === mine.id && p.url.endsWith('/mine')));
  ok('the spoken reply names the first result', /first is "Python Tutorial/.test(desktopReply('youtube_search', { query: 'python tutorial', open: 'results' }, { success: true, output: JSON.stringify(r), tool: 'youtube_search', durationMs: 0 })));
}

console.log('\n--- Best match: opened, and checked to be playing ---');
{
  ok('best match is by the words, with a small rank preference', bestMatch('lofi beats to study', [
    { title: 'Python Tutorial', url: 'a', channel: '', meta: '' }, { title: 'Lofi hip hop radio - beats to relax/study to', url: 'b', channel: '', meta: '' },
  ]).index === 1);
  const r = await searchYouTube('lofi hip hop beats to study', 'best');
  ok('it chose the matching video, not the first', r.chosen?.title.startsWith('Lofi hip hop') === true && r.chosen.rank === 2, `${r.chosen?.title} (rank ${r.chosen?.rank})`);
  ok('the video really plays (it was paused; JARVIS pressed play once)', r.check?.status === 'verified' && /playing/.test(r.check.evidence), r.check?.evidence);
  ok('the reply says what is playing', /^Playing "Lofi hip hop/.test(desktopReply('youtube_search', { query: 'x', open: 'best' }, { success: true, output: JSON.stringify(r), tool: 'youtube_search', durationMs: 0 })));
}

console.log('\n--- Pause and play the video ---');
{
  const p = await playback('pause');
  ok('pause is checked on the video', p.success && p.check?.status === 'verified', p.check?.evidence);
  const q = await playback('play');
  ok('play is checked on the video', q.success && q.check?.status === 'verified', q.check?.evidence);
}

console.log('\n--- Through the registry, as the orchestrator calls it ---');
{
  const r = await toolRegistryV2.execute('youtube_search', { query: 'funny cats', open: 'first' });
  ok('youtube_search runs at risk level 1 without an approval prompt, and is verified', r.success && r.verification?.status === 'verified', r.verification?.evidence);
  const url = siteSearchUrl('wikipedia', 'Alan Turing')!;
  ok('site search addresses are the sites\' own search pages', url.startsWith('https://en.wikipedia.org/w/index.php?search=Alan%20Turing'));
  const pages = await listPages(chrome.port);
  ok('no tab was closed by any of this', pagesBefore.every((b) => pages.some((p) => p.id === b.id)));
}

console.log('\n--- Routes ---');
const cases: [string, string, string?][] = [
  ['Open YouTube and search for Python tutorials', 'youtube_search', 'results'],
  ['search youtube for lo-fi music', 'youtube_search', 'results'],
  ['find the latest AI news on YouTube', 'youtube_search', 'results'],
  ['search for lofi music on youtube and play the first one', 'youtube_search', 'first'],
  ['play relaxing piano music on YouTube', 'youtube_search', 'best'],
  ['play this video', 'youtube_play'],
  ['pause the video', 'youtube_play'],
  ['open wikipedia and search for alan turing', 'site_search'],
  ['what is trending on YouTube', 'youtube_trending'],
  ['find currently trending YouTube videos in Pakistan and tell me what is trending', 'youtube_trending'],
];
for (const [text, type, open] of cases) {
  const r = matchDesktopRoute(text);
  ok(`"${text}" → ${type}${open ? ` (${open})` : ''}`, r?.type === type && (!open || (r as { open?: string }).open === open), JSON.stringify(r));
}
ok('"search YouTube" alone is not a search', matchDesktopRoute('search YouTube') === undefined);
ok('"open youtube" is left to open_app', matchDesktopRoute('open youtube') === undefined);
ok('"search GitHub for …" stays with the Research agent', matchDesktopRoute('search github for cdp libraries') === undefined);
ok('background requests are not done on screen', matchDesktopRoute('search youtube for AI news in the background') === undefined);
ok('the region is read', (matchDesktopRoute('what is trending on youtube in pakistan') as { region?: string }).region === 'PK');

console.log('\n--- Without Chrome\'s debugging port ---');
{
  process.env['JARVIS_CDP_PORT'] = '1';
  const r = await searchYouTube('anything', 'results');
  ok('it says so, and gives the address to open another way', !r.success && /debugging port/.test(r.error ?? '') && r.url?.includes('/results?search_query=anything') === true, r.error);
  process.env['JARVIS_CDP_PORT'] = String(chrome.port);
}

await chrome.stop();
server.close();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
