/**
 * tests/llmCancellationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * REL-05 at the provider: cancelling one model request must not cancel
 * another, and a cancelled request must not be retried or leave listeners
 * behind. A stand-in fetch (no network) answers after a delay and honours its
 * abort signal like the real one.
 *
 *   1. two different requests: aborting one leaves the other to finish
 *   2. two identical requests in flight (they share one call): aborting the
 *      first caller does not fail the second; when both cancel, the shared
 *      call stops
 *   3. an aborted request is not retried
 *   4. after success, failure and abort, no abort listener is left on the
 *      caller's signal
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getEventListeners } from 'events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-llm-cancel-'));
process.env['JARVIS_DATA_ROOT'] = root;
process.env['GROQ_API_KEY'] = 'test-not-a-real-key';

let fetches = 0;
let failNext = 0;
(globalThis as any).fetch = (_url: string, init: { signal?: AbortSignal; body?: string }) => new Promise((resolve, reject) => {
  fetches++;
  const signal = init.signal;
  if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  const t = setTimeout(() => {
    if (failNext > 0) { failNext--; resolve(new Response('server error', { status: 500 })); return; }
    const content = `answer to ${JSON.parse(init.body ?? '{}').messages?.at(-1)?.content ?? '?'}`;
    resolve(new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }, 150);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

const { GroqProvider } = await import('../bridge/groqProvider.js');
const provider = new GroqProvider();

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const req = (text: string, signal?: AbortSignal) => ({ model: 'test-model', messages: [{ role: 'user' as const, content: text }], signal });
const settle = (p: Promise<any>) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e?.message ?? e) }));

console.log('\n=== Cancelling model requests (REL-05) ===\n');

console.log('--- 1. Two different requests ---');
const a1 = new AbortController();
const b1 = new AbortController();
const pa = settle(provider.chat(req('first question', a1.signal)));
const pb = settle(provider.chat(req('second question', b1.signal)));
setTimeout(() => a1.abort(), 30);
const [ra, rb] = await Promise.all([pa, pb]);
ok('the aborted one is cancelled', !ra.ok, ra.ok ? 'it finished' : (ra as any).e);
ok('the other one finishes', rb.ok && /second question/.test((rb as any).v?.content ?? ''), rb.ok ? (rb as any).v.content : (rb as any).e);

console.log('\n--- 2. Two identical requests in flight ---');
const a2 = new AbortController();
const b2 = new AbortController();
const p1 = settle(provider.chat(req('same words', a2.signal)));
const p2 = settle(provider.chat(req('same words', b2.signal)));
setTimeout(() => a2.abort(), 30);
const [r1, r2] = await Promise.all([p1, p2]);
ok('the first caller, aborted, is cancelled', !r1.ok, r1.ok ? 'it finished' : (r1 as any).e);
ok('the second caller still gets its answer', r2.ok && /same words/.test((r2 as any).v?.content ?? ''), r2.ok ? (r2 as any).v.content : (r2 as any).e);

let sharedCallAborted = false;
const realFetch = (globalThis as any).fetch;
(globalThis as any).fetch = (url: string, init: { signal?: AbortSignal }) => {
  init.signal?.addEventListener('abort', () => { sharedCallAborted = true; }, { once: true });
  return realFetch(url, init);
};
const a5 = new AbortController();
const b5 = new AbortController();
const q1 = settle(provider.chat(req('both leave', a5.signal)));
const q2 = settle(provider.chat(req('both leave', b5.signal)));
setTimeout(() => a5.abort(), 20);
await new Promise((r) => setTimeout(r, 40));
ok('one caller left: the shared call keeps running', !sharedCallAborted);
b5.abort();
await Promise.all([q1, q2]);
ok('both left: the shared call is stopped (no request runs for nobody)', sharedCallAborted);
(globalThis as any).fetch = realFetch;

console.log('\n--- 3. An aborted request is not retried ---');
fetches = 0;
const a3 = new AbortController();
const p3 = settle(provider.chat(req('retry check', a3.signal)));
setTimeout(() => a3.abort(), 30);
await p3;
await new Promise((r) => setTimeout(r, 400));
ok('one attempt only', fetches === 1, `${fetches} fetch(es)`);

console.log('\n--- 4. No listeners left behind ---');
const okSignal = new AbortController();
await settle(provider.chat(req('clean success', okSignal.signal)));
ok('after success', getEventListeners(okSignal.signal, 'abort').length === 0, String(getEventListeners(okSignal.signal, 'abort').length));
failNext = 3;
const failSignal = new AbortController();
await settle(provider.chat(req('clean failure', failSignal.signal)));
ok('after failure (all attempts)', getEventListeners(failSignal.signal, 'abort').length === 0, String(getEventListeners(failSignal.signal, 'abort').length));
const abortSignal = new AbortController();
const p4 = settle(provider.chat(req('clean abort', abortSignal.signal)));
setTimeout(() => abortSignal.abort(), 30);
await p4;
ok('after abort', getEventListeners(abortSignal.signal, 'abort').length === 0, String(getEventListeners(abortSignal.signal, 'abort').length));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
