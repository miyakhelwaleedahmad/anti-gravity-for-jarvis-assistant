/**
 * tests/memoryCacheTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A remembered fact must be findable at once, whatever was cached before.
 *
 * On the owner's PC (Redis running) a search right after remembering a fact
 * returned nothing: an answer cached by an earlier run for the same words was
 * served, its facts did not exist in this memory, and the empty remainder was
 * returned. "Invalidation" on a write did nothing (no query given), and the
 * cache was shared by every memory store using the same Redis.
 *
 *   1. remember → search → remember a second fact → search at once: both
 *      (this process's 30 s cache)
 *   2. vector service unavailable (model loading): the lexical fallback finds
 *      a fact remembered a moment ago
 *   3. with Redis: an answer cached for this store before a write is not
 *      served after it; an out-of-date cached answer (facts that are not
 *      here) is not served as an empty result; another store's answer is not
 *      served here. Checked only when Redis answers on this PC.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-cache-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.chdir(root);

const redisUp = await new Promise<boolean>((resolve) => {
  const s = net.connect({ host: process.env['REDIS_HOST'] ?? '127.0.0.1', port: Number(process.env['REDIS_PORT'] ?? 6379) });
  const done = (v: boolean) => { s.destroy(); resolve(v); };
  s.setTimeout(800, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

const { memoryManager } = await import('../memory/memoryManager.js');
const redis = await import('../memory/redisCache.js');
await memoryManager.init();
const mm = memoryManager as any;
// The vector service is unavailable (its model loading): searches use the lexical fallback.
mm.searchVector = async () => { throw new Error('Vector API not ready yet (model loading)'); };

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const texts = (r: Array<{ fact: { fact: string } }>) => r.map((x) => x.fact.fact);

console.log('\n=== A remembered fact is found at once ===\n');

console.log('--- 1. This process\'s cache ---');
await mm.rememberFact('The owner keeps the backup drive in the blue drawer', 'test', 7);
const first = await memoryManager.searchFactsWithScores('backup drive drawer', 5);
ok('the first fact is found', texts(first).some((t) => /blue drawer/.test(t)), texts(first).join(' | '));
await mm.rememberFact('The spare backup drive is in the red drawer', 'test', 7);
const second = await memoryManager.searchFactsWithScores('backup drive drawer', 5);
ok('a fact remembered after the same search is found at once', texts(second).some((t) => /red drawer/.test(t)), texts(second).join(' | '));

console.log('\n--- 2. Vector service unavailable ---');
ok('the lexical fallback found both', texts(second).filter((t) => /drawer/.test(t)).length === 2, String(second.length));
const none = await memoryManager.searchFactsWithScores('quantum aquarium volcano', 5);
ok('no match is an empty list, not an error', Array.isArray(none) && none.length === 0, String(none.length));

console.log('\n--- 3. Redis ---');
if (!redisUp) {
  console.log('  (Redis is not running here: these checks were not run)');
} else {
  // Wait for this test's Redis client to connect.
  for (let i = 0; i < 50 && !redis.isRedisAvailable(); i++) await new Promise((r) => setTimeout(r, 100));
  ok('(setup) JARVIS is connected to Redis', redis.isRedisAvailable());
  const q = 'favourite tea';
  await mm.rememberFact('The owner likes green tea in the morning', 'test', 7);
  const a = await memoryManager.searchFactsWithScores(q, 5);
  await new Promise((r) => setTimeout(r, 200)); // the answer is cached in the background
  mm.queryCache.clear(); // only Redis now
  await mm.rememberFact('The owner likes mint tea at night', 'test', 7);
  mm.queryCache.clear();
  const b = await memoryManager.searchFactsWithScores(q, 5);
  ok('(setup) the first search found the first fact', texts(a).some((t) => /green tea/.test(t)), texts(a).join(' | '));
  ok('after a write, the answer cached before it is not served', texts(b).some((t) => /mint tea/.test(t)), texts(b).join(' | '));

  // An out-of-date answer cached for this store (facts that are not here).
  const q2 = 'blue drawer backup';
  mm.queryCache.clear();
  await redis.cacheVectorResult(q2, 5, [{ fact: { id: 'gone-1', fact: 'a fact from an earlier run' }, score: 0.9 }], mm.cacheScope);
  const c = await memoryManager.searchFactsWithScores(q2, 5);
  ok('an out-of-date cached answer is not served as empty; the search runs', texts(c).some((t) => /blue drawer/.test(t)), texts(c).join(' | ') || '(empty)');

  // Another store's answer.
  await redis.cacheVectorResult('shared words', 5, [{ fact: { id: 'x', fact: 'other store' }, score: 1 }], '/elsewhere/memory.json');
  const other = await redis.getCachedVectorResult('shared words', 5, mm.cacheScope);
  ok('another memory store\'s cached answer is not served here', other === null, JSON.stringify(other));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { await redis.disconnectRedis(); } catch { /* best effort */ }
process.chdir(os.tmpdir());
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
