/**
 * tests/youtubePlayIntentTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-8: "open YouTube and play song of Sanam" opened a results page
 * (youtube_search with its default open=results) and was reported done.
 *
 *   1. Routes: "play song of Sanam", "play the song Sanam Re", "play Sanam Re
 *      song" play the best match; the existing routes keep their meaning.
 *   2. Reflection's pre-check: a planned youtube_search for a request that
 *      says play / watch / listen to is made to play (open=best); a search
 *      request is left alone.
 */

const { matchDeterministicCommand } = await import('../core/deterministicRoutes.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { reflectionEngine } = await import('../core/reflectionEngine.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}
const target = (p: string) => { const r = matchDeterministicCommand(p); return r ? { type: r.type, ...(r.target ? JSON.parse(r.target) : {}) } : null; };

console.log('\n--- 1. Routes ---');
for (const [p, q] of [['play song of Sanam', 'sanam'], ['play the song Sanam Re', 'sanam re'], ['play Sanam Re song', 'sanam re'], ['Play songs by Atif Aslam', 'atif aslam'], ['open YouTube and play song of Sanam', 'song of sanam']] as const) {
  const t = target(p);
  ok(`"${p}" → youtube_search "${q}", open=best`, t?.type === 'youtube_search' && t.query === q && t.open === 'best', JSON.stringify(t));
}
for (const [p, type] of [['play the video', 'youtube_play'], ['play it', 'youtube_play'], ['search youtube for lofi', 'youtube_search']] as const) {
  ok(`"${p}" keeps ${type}`, target(p)?.type === type, JSON.stringify(target(p)));
}
ok('"search youtube for lofi" still only shows results', target('search youtube for lofi')?.open === 'results');
ok('"play music" (nothing named) is not guessed', target('play music') === null);

console.log('\n--- 2. Reflection pre-check ---');
registerAllTools();
function graph(goal: string, open?: string) {
  const node = { id: 'n1', tool: 'youtube_search', args: { query: 'sanam re', ...(open ? { open } : {}) }, dependencies: [] as string[], status: 'pending' };
  return { id: 'g', goal, nodes: new Map([['n1', node]]), status: 'pending' } as any;
}
let g = graph('open YouTube and play song of Sanam');
let r = await reflectionEngine.preExecutionCheck(g);
ok('a play request planned with the default open: patched to open=best', g.nodes.get('n1').args.open === 'best' && r.patchedNodes?.includes('n1') === true && r.verdict === 'modified', JSON.stringify(r));
g = graph('put on some lofi music for me', 'results');
await reflectionEngine.preExecutionCheck(g);
ok('"put on …" with open=results: patched too', g.nodes.get('n1').args.open === 'best');
g = graph('play the first lofi video', 'first');
await reflectionEngine.preExecutionCheck(g);
ok('open=first is kept', g.nodes.get('n1').args.open === 'first');
g = graph('search YouTube for lofi music');
r = await reflectionEngine.preExecutionCheck(g);
ok('a search request is left showing results', g.nodes.get('n1').args.open === undefined && r.verdict === 'approved', JSON.stringify(r));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
