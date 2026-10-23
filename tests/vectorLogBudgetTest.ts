/**
 * tests/vectorLogBudgetTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-16: during the 184 s model load and the rebuild that followed,
 *   - "[VectorAPI:ERR] Stored: 'Failed task: …'" lines: a normal INFO line
 *     quoting a fact was shown as an error because it contains "Failed";
 *   - one retrieveForPlanning took 4419 ms, waiting behind three rebuild
 *     writers on a service that encodes one text at a time.
 *
 *   1. Lines that name an INFO/WARNING level are not errors; real errors are.
 *   2. A slow vector search falls back to keywords within the budget
 *      (JARVIS_VECTOR_SEARCH_BUDGET_MS, default 1500).
 *   3. The rebuild sends one write at a time.
 *
 * The Python side (level in each line, no /health access lines) is
 * tests/python/test_vector_logs.py. The vector service is a stand-in.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-vecbudget-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_VECTOR_SEARCH_BUDGET_MS'] = '300';
process.chdir(workspace);

const { isVectorErrorLine } = await import('../memory/vectorMemorySupervisor.js');
const { memoryManager, vectorSearchBudgetMs } = await import('../memory/memoryManager.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log('\n=== Vector log lines and search budget (BUG-16) ===\n');

console.log('--- 1. Which lines are errors ---');
for (const [line, error] of [
  ["[VectorMemory] INFO Stored: 'Failed task: \"open youtube\" — tool_error' — total: 3", false],
  ['[VectorMemory] WARNING Persist failed (continuing in memory): disk full', false],
  ['INFO:     127.0.0.1:51234 - "POST /embed HTTP/1.1" 200 OK', false],
  ['[VectorMemory] ERROR search error: shapes not aligned', true],
  ['ERROR:    Exception in ASGI application', true],
  ['Traceback (most recent call last):', true],
  ["ModuleNotFoundError: No module named 'fastapi'", true],
] as const) {
  ok(`${error ? 'error' : 'not an error'}: ${line.slice(0, 60)}`, isVectorErrorLine(line) === error);
}

console.log('\n--- 2. Search budget ---');
ok('the budget is 1500 ms unless set; nonsense keeps the default', vectorSearchBudgetMs({}) === 1500 && vectorSearchBudgetMs({ JARVIS_VECTOR_SEARCH_BUDGET_MS: 'x' }) === 1500 && vectorSearchBudgetMs({ JARVIS_VECTOR_SEARCH_BUDGET_MS: '5' }) === 1500 && vectorSearchBudgetMs() === 300);
await memoryManager.init();
let inFlight = 0;
let maxInFlight = 0;
let embeds = 0;
(memoryManager as any).vectorRequest = async (action: string) => {
  if (action === 'health') return { status: 'ready' };
  if (action === 'search') { await sleep(3000); return { results: [] }; }
  if (action === 'embed') {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); embeds++;
    await sleep(20);
    inFlight--;
    return { embedding: [0.1] };
  }
  if (action === 'stats') return { count: embeds };
  return {};
};
const db = (memoryManager as any).db.data;
const now = Date.now();
for (let i = 0; i < 8; i++) db.longTerm.push({ id: `f${i}`, fact: `The owner's project ${i} uses TypeScript`, source: 'conversation', timestamp: now, importance: 5, lastAccessed: now, accessCount: 0, confidence: 0.9, version: 1 });
const t0 = Date.now();
const ctx = await memoryManager.retrieveForPlanning('which project uses typescript', 3);
const ms = Date.now() - t0;
ok('a vector search slower than the budget does not hold up planning', ms < 1500, `${ms} ms with a 3000 ms search, budget 300 ms`);
ok('…and keyword search answers instead', ctx.includes('uses TypeScript'), ctx.slice(0, 120));

console.log('\n--- 3. Rebuild ---');
(memoryManager as any).rebuildVectorIndexInBackground();
for (let i = 0; i < 50 && embeds < 8; i++) await sleep(100);
await sleep(100);
ok('the rebuild sends one write at a time', embeds === 8 && maxInFlight === 1, `${embeds} writes, at most ${maxInFlight} at once`);

fs.rmSync(workspace, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
