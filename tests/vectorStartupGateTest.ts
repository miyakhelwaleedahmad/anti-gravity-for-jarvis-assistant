/**
 * tests/vectorStartupGateTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The Node side of a slow vector-service start (seen on Windows: 3.5 minutes
 * to load the embedding model).
 *
 *   - After the 25 s startup window, MemoryManager called the service while it
 *     was still loading: "fetch failed", "circuit breaker opened!" every 30 s.
 *     While the supervisor runs the service but has not seen it healthy, calls
 *     now fail fast, with no request and no failure counted.
 *   - The startup re-sync of long-term facts ran once; if the service was not
 *     up it was skipped for good, so the vector store stayed empty. It is now
 *     deferred and run on the supervisor's first healthy check.
 *
 * A separate MemoryManager instance with a fake supervisor and fake fetch:
 * no files, no network.
 */

import { MemoryManager } from '../memory/memoryManager.js';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

let fetchCalls: string[] = [];
let healthStatus = 503;
globalThis.fetch = (async (url: any) => {
  fetchCalls.push(String(url));
  if (String(url).endsWith('/health')) {
    return new Response(JSON.stringify(healthStatus === 200 ? { status: 'ready' } : { detail: 'Model not ready' }), { status: healthStatus });
  }
  return new Response(JSON.stringify({ results: [] }), { status: 200 });
}) as typeof fetch;

function managerAfterStartupWindow(supervisor: Record<string, () => boolean>) {
  const mm = new MemoryManager() as any;
  mm._initTime = Date.now() - 60_000; // past the 25 s grace window
  mm._supervisorRef = { isStartupReady: () => true, waitUntilReady: async () => true, ...supervisor };
  return mm;
}

console.log('\n=== Vector Startup Gate Test ===\n');

console.log('--- Supervisor running, service still loading ---');
{
  const mm = managerAfterStartupWindow({ isRunning: () => true, isHealthy: () => false });
  fetchCalls = [];
  let err: any = null;
  try { await mm.vectorRequest('search', { query: 'x', top_k: 1 }); } catch (e) { err = e; }
  ok('the call fails fast', err?.notReady === true, err?.message);
  ok('without sending a request', fetchCalls.length === 0, `${fetchCalls.length} request(s)`);
  ok('without counting a failure', mm.vectorApiFails === 0 && mm.vectorApiCircuitOpen === false);

  for (let i = 0; i < 5; i++) { try { await mm.vectorRequest('embed', { text: 't' }); } catch { /* expected */ } }
  ok('repeated calls never open the circuit breaker', mm.vectorApiCircuitOpen === false);

  const hits = await mm.searchVector('anything', 3);
  ok('memory search still returns (falls back) instead of throwing', Array.isArray(hits) && hits.length === 0);

  fetchCalls = [];
  try { await mm.vectorRequest('health', {}); } catch { /* 503 expected */ }
  ok('readiness probes still go through', fetchCalls.length === 1 && fetchCalls[0]!.endsWith('/health'));
}

console.log('\n--- Supervisor healthy, or not managing the service ---');
{
  const healthy = managerAfterStartupWindow({ isRunning: () => true, isHealthy: () => true });
  fetchCalls = [];
  await healthy.vectorRequest('search', { query: 'x', top_k: 1 });
  ok('a healthy service is called normally', fetchCalls.length === 1);

  const unmanaged = managerAfterStartupWindow({ isRunning: () => false, isHealthy: () => false });
  fetchCalls = [];
  await unmanaged.vectorRequest('search', { query: 'x', top_k: 1 });
  ok('a service the supervisor does not run (started by hand) is still called', fetchCalls.length === 1);
}

console.log('\n--- A skipped re-sync runs once the service is up ---');
{
  const mm = managerAfterStartupWindow({ isRunning: () => true, isHealthy: () => false });
  mm.initialized = true;
  mm.db = { data: { longTerm: [
    { id: 'a', fact: 'favourite food is biryani', importance: 5, timestamp: 1 },
    { id: 'b', fact: 'favourite colour is blue', importance: 4, timestamp: 2 },
  ] } };
  const embedded: string[] = [];
  mm.embed = async (_text: string, id: string) => { embedded.push(id); };

  healthStatus = 503;
  mm.rebuildVectorIndexInBackground();
  await new Promise((r) => setTimeout(r, 800));
  ok('while loading: deferred, nothing embedded', embedded.length === 0 && mm.vectorRebuildPending === true);

  healthStatus = 200;
  mm.onVectorServiceHealthy();
  await new Promise((r) => setTimeout(r, 800));
  ok('on the first healthy check: every fact is embedded', embedded.sort().join(',') === 'a,b', embedded.join(','));
  ok('and the re-sync is no longer pending', mm.vectorRebuildPending === false);

  mm.onVectorServiceHealthy();
  await new Promise((r) => setTimeout(r, 800));
  ok('later healthy checks do not repeat it', embedded.length === 2, `${embedded.length}`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
