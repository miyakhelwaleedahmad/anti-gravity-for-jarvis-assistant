/**
 * tests/vectorRebuildStoreTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-14: "Vector rebuild summary: embedded 45/45" while the store held 3
 * vectors, and the next start said no_store_on_disk.
 *
 * memoryManager.embed returned a Redis-cached embedding without sending the
 * text to the vector service, and the POST is what stores it. From the second
 * run on, almost every fact was a cache hit, so almost nothing was stored;
 * the 3 that were stayed under the 10-write persist threshold.
 *
 *   1. With every fact already in the Redis cache, the rebuild still stores
 *      each one: store count = facts embedded.
 *   2. The store is saved to disk when the rebuild ends.
 *   3. The summary says how many vectors the store holds.
 *
 * The vector service is a stand-in. Redis is a real redis-server on a spare
 * port when one is installed (that is how the bug shows); without it, part 1
 * runs with no cache and parts 2 and 3 still hold.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-vecrebuild-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let redis: ChildProcess | null = null;
if (spawnSync('redis-server', ['--version']).status === 0) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  redis = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  process.env['REDIS_HOST'] = '127.0.0.1';
  process.env['REDIS_PORT'] = String(port);
  await sleep(400);
}

const { memoryManager } = await import('../memory/memoryManager.js');
const { cacheEmbedding, getCachedEmbedding } = await import('../memory/redisCache.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

await memoryManager.init();

// The vector service: /embed stores the text once (exact duplicates are kept once).
const store = new Set<string>();
let persisted = 0;
(memoryManager as any).vectorRequest = async (action: string, payload: any) => {
  if (action === 'health') return { status: 'ready' };
  if (action === 'embed') { store.add(payload.text); return { embedding: [0.1, 0.2, 0.3], stored: store.size }; }
  if (action === 'persist') { persisted++; return { saved: store.size }; }
  if (action === 'stats') return { count: store.size };
  return {};
};

const logs: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); realLog(...a); };

console.log('\n=== Vector rebuild stores what it embeds (BUG-14) ===\n');

const texts = Array.from({ length: 12 }, (_, i) => `Fact number ${i + 1} about the owner's projects`);
const db = (memoryManager as any).db.data;
for (const [i, fact] of texts.entries()) {
  db.longTerm.push({ id: `f${i}`, fact, source: 'conversation', timestamp: Date.now() - i, importance: 5, lastAccessed: Date.now(), accessCount: 0, confidence: 0.8, version: 1 });
}

// A second run: every fact's embedding is already in the Redis cache.
await sleep(300);
for (const t of texts) await cacheEmbedding(t, [0.1, 0.2, 0.3]);
const cacheWorks = (await getCachedEmbedding(texts[0])) !== null;
console.log(cacheWorks ? '  (Redis is up: every fact is a cache hit)' : '  SKIP: no Redis here, so part 1 runs without cache hits');

(memoryManager as any).rebuildVectorIndexInBackground();
for (let i = 0; i < 40 && !logs.some((l) => l.includes('Vector rebuild summary')); i++) await sleep(100);
console.log = realLog;

const summary = logs.find((l) => l.includes('Vector rebuild summary')) ?? '';
ok('every fact the rebuild embedded is in the store', store.size === texts.length, `store ${store.size}, facts ${texts.length}${cacheWorks ? ', all cache hits' : ''}`);
ok('the store is saved to disk when the rebuild ends', persisted === 1, `persist calls: ${persisted}`);
ok('the summary says how many vectors the store holds', summary.includes(`embedded ${texts.length}/${texts.length}`) && summary.includes(`store holds ${texts.length} vectors`), summary);

redis?.kill();
fs.rmSync(workspace, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
