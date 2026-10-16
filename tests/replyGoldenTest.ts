/**
 * tests/replyGoldenTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCH-01 step 3: the spoken-reply formatters move out of core/orchestrator.ts
 * into core/replyText.ts, unchanged. This test records what each one says for
 * fixed inputs (tests/fixtures/reply-golden.json, taken from the code before
 * the move) and fails on any difference. The orchestrator still exports them,
 * so the calls below work before and after.
 *
 *   npx tsx tests/replyGoldenTest.ts --record   rewrite the fixture (only
 *                                               for an intended change)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-reply-golden-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'reply-golden.json');
const o = await import('../core/orchestrator.js');

const res = (output: string, extra: Record<string, unknown> = {}): any => ({ success: true, output, tool: 't', durationMs: 1, ...extra });
const desk = (r: Record<string, unknown>) => res(JSON.stringify(r));
const OFFICIAL = "YouTube's most-popular videos (chart=mostPopular) for region PK, category music, retrieved 2026-10-01T10:00:00Z\n\n" +
  '1. Music video one\nhttps://www.youtube.com/watch?v=aaaaaaaaaaa\nArtist A · 1,234,567 views\n\n' +
  '2. Song two\nhttps://www.youtube.com/watch?v=bbbbbbbbbbb\nArtist B · 890 views\n\n' +
  '3. Third\nhttps://www.youtube.com/watch?v=ccccccccccc\n\n' +
  '4. Fourth\nhttps://www.youtube.com/watch?v=ddddddddddd\nArtist D · 12 views';
const SEARCH = "NOT YouTube's ranking: video search results for popular videos\n\n" +
  '1. Pop one\nhttps://www.youtube.com/watch?v=pop00000001\nChannel X · 2 days ago\n';

const CASES: Record<string, () => string> = {
  'desktop: no result': () => o.desktopReply('youtube_search', { query: 'cats' }, undefined),
  'desktop: not approved': () => o.desktopReply('youtube_search', { query: 'cats' }, { success: false, output: '', error: 'APPROVAL_DENIED' } as any),
  'desktop: failed': () => o.desktopReply('youtube_search', { query: 'cats' }, desk({ success: false, error: 'Chrome is not running' })),
  'desktop: unverifiable': () => o.desktopReply('site_search', { site: 'Google', query: 'weather' }, desk({ success: true, check: { status: 'unverifiable', evidence: 'no page access.' } })),
  'desktop: playing, verified': () => o.desktopReply('youtube_search', { query: 'lofi', open: 'best' }, desk({ success: true, check: { status: 'verified', evidence: 'video playing' }, chosen: { title: 'Lofi hip hop radio', channel: 'Lofi Girl' } })),
  'desktop: chosen, not verified': () => o.desktopReply('youtube_search', { query: 'lofi' }, desk({ success: true, check: { status: 'failed', evidence: 'the video did not start.' }, chosen: { title: 'Lofi hip hop radio' } })),
  'desktop: results shown': () => o.desktopReply('youtube_search', { query: 'python' }, desk({ success: true, check: { status: 'verified', evidence: 'ok' }, results: [{ title: 'Python Tutorial for Beginners' }] })),
  'desktop: results not read': () => o.desktopReply('youtube_search', { query: 'python' }, desk({ success: true, check: { status: 'failed', evidence: '' } })),
  'desktop: pause': () => o.desktopReply('youtube_play', { action: 'pause' }, desk({ success: true, check: { status: 'verified', evidence: 'paused' } })),
  'desktop: play not verified': () => o.desktopReply('youtube_play', { action: 'play' }, desk({ success: true, check: { status: 'failed', evidence: 'no video on the page' } })),
  'desktop: site verified': () => o.desktopReply('site_search', { site: 'Amazon', query: 'usb hub' }, desk({ success: true, check: { status: 'verified', evidence: 'ok' } })),
  'desktop: site not checked': () => o.desktopReply('site_search', { site: 'Amazon', query: 'usb hub' }, desk({ success: true, check: { status: 'failed', evidence: '' } })),
  'trending: official chart': () => o.trendingReply(res(OFFICIAL)),
  'trending: search order': () => o.trendingReply(res(SEARCH)),
  'trending: error': () => o.trendingReply(res('Error: set YOUTUBE_API_KEY or SERPER_API_KEY', { success: false })),
  'trending: no items': () => o.trendingReply(res('Nothing found for that region.\nTry another.')),
  'trending: undefined': () => o.trendingReply(undefined),
  'system status: not JSON': () => o.systemStatusReply('not json'),
  'dev status: no servers': () => o.devStatusReply('{"ports":[]}'),
  'dev status: not JSON': () => o.devStatusReply('{'),
  'command: ok, short': () => o.describeCommandResult('Exit code: 0\nOutput: main\n'),
  'command: ok, empty': () => o.describeCommandResult('Exit code: 0\nOutput: (no output)'),
  'command: ok, long': () => o.describeCommandResult(`Exit code: 0\nOutput: ${'x'.repeat(200)}`),
  'command: failed': () => o.describeCommandResult('Exit code: 1\nOutput: error: pathspec did not match'),
  'command: failed, long line': () => o.describeCommandResult(`Exit code: 2\nOutput: ${'y'.repeat(130)}`),
  'command: did not finish': () => o.describeCommandResult('Exit code: null\nOutput: killed'),
  'command: other text, short': () => o.describeCommandResult('Opened notepad.'),
  'command: other text, long': () => o.describeCommandResult('z'.repeat(160)),
  'capabilities, with identity': () => o.capabilitiesReply(true),
};

const now: Record<string, string> = {};
for (const [name, run] of Object.entries(CASES)) {
  try { now[name] = run(); } catch (e) { now[name] = `THREW ${(e as Error).message}`; }
}

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Reply golden test (ARCH-01) ===\n');
if (process.argv.includes('--record')) {
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, JSON.stringify(now, null, 2) + '\n');
  console.log(`recorded ${Object.keys(now).length} replies to ${path.relative(process.cwd(), fixture)}`);
} else {
  const golden = JSON.parse(fs.readFileSync(fixture, 'utf8')) as Record<string, string>;
  ok('the fixture covers every case', Object.keys(CASES).every((k) => k in golden));
  for (const k of Object.keys(CASES)) ok(`reply for "${k}"`, golden[k] === now[k], `was ${golden[k]}, now ${now[k]}`);
  const src = (f: string) => { try { return fs.readFileSync(path.join(here, '..', f), 'utf8'); } catch { return ''; } };
  const replies = src('core/replyText.ts');
  const names = ['desktopReply', 'trendingReply', 'repairFailure', 'systemStatusReply', 'devStatusReply', 'capabilitiesReply', 'capabilityListReply', 'describeCommandResult'];
  ok('core/replyText.ts defines the reply formatters', names.every((n) => new RegExp(`export function ${n}\\(`).test(replies)), names.filter((n) => !new RegExp(`export function ${n}\\(`).test(replies)).join(', '));
  ok('the orchestrator no longer defines them', names.every((n) => !new RegExp(`function ${n}\\(`).test(src('core/orchestrator.ts'))));
  console.log(`  ${passed} checks passed`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
