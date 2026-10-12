/**
 * scripts/benchMemoryLookup.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PERF-07: how long a memory lookup takes when the vector service is down and
 * the lexical fallback scans every fact. Uses the real memoryManager on a
 * temporary data folder (your memory files are not touched) with synthetic
 * facts; the vector search is stubbed to return nothing.
 *
 *   npx tsx scripts/benchMemoryLookup.ts            1k, 5k, 20k, 50k facts
 *   npx tsx scripts/benchMemoryLookup.ts 2000        one size
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bench-memory-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;

const { memoryManager } = await import('../memory/memoryManager.js');
await memoryManager.init();
const mm = memoryManager as any;
mm.searchVector = async () => [];

const WORDS = ['python', 'project', 'meeting', 'monday', 'coffee', 'github', 'invoice', 'client', 'deadline', 'laptop',
  'music', 'youtube', 'report', 'server', 'backup', 'family', 'travel', 'budget', 'recipe', 'garden', 'friday', 'notes'];
const word = (i: number) => WORDS[i % WORDS.length]!;
const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const now = Date.now();

console.log('facts   lookups   median ms   p95 ms   max ms');
for (const n of sizes.length ? sizes : [1_000, 5_000, 20_000, 50_000]) {
  mm.db.data.longTerm = Array.from({ length: n }, (_, i) => ({
    id: `f${i}`, fact: `The owner ${word(i)} ${word(i * 7 + 3)} ${word(i * 13 + 5)} item number ${i}`, source: 'bench',
    timestamp: now, importance: 5, lastAccessed: now, accessCount: 0, confidence: 0.8, version: 1, origin: 'user',
  }));
  mm.scheduledWrite = async () => {};
  const times: number[] = [];
  for (let q = 0; q < 40; q++) {
    mm.queryCache?.clear?.();
    const t0 = performance.now();
    await memoryManager.searchFactsWithScores(`${word(q)} ${word(q + 5)} lookup ${q}`, 5);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const at = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))]!.toFixed(2);
  console.log(`${String(n).padEnd(8)}${String(times.length).padEnd(10)}${at(0.5).padEnd(12)}${at(0.95).padEnd(9)}${times.at(-1)!.toFixed(2)}`);
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(0);
