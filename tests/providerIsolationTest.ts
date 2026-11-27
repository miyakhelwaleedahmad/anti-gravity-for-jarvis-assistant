/**
 * tests/providerIsolationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1A (MM-1A-03): one provider's rate limits never stop another's calls.
 *
 * Before Phase 1A the Gemini/Groq client kept its circuit breaker, model
 * cooldowns, response cache and in-flight calls as static fields (shared by
 * every instance), and Claude and the OpenAI-compatible fallback had no
 * breaker at all, so every call after a 429 storm still went out.
 *
 *   1. two isolated clients: one's breaker and cache do not touch the other's
 *   2. default clients still share state, and resetting it on the class still
 *      works (the path existing tests use)
 *   3. the router's breaker per provider: opens after two rate limits, lets
 *      one trial call through after its period, not on 5xx or an abort, not on
 *      top of a provider's own breaker
 *   4. an optional request limit per provider; its refusal reads as a rate limit
 *   5. guards belong to one router
 * Fake HTTP server and scripted providers; no network.
 */

const KEY = 'AQ.fake-key-for-tests-0123456789abcdef';
for (const name of ['GROQ_API_KEY', 'GROQ_API_URL', 'XAI_API_KEY', 'JARVIS_LLM_PROVIDER', 'JARVIS_LLM_REASONING_EFFORT',
  'JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'JARVIS_FALLBACK_MODEL', 'ANTHROPIC_API_KEY']) process.env[name] = '';
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_')) delete process.env[k];
process.env['GEMINI_API_KEY'] = KEY;
process.env['GEMINI_API_URL'] = 'https://generativelanguage.googleapis.com/v1beta';
process.env['JARVIS_BRAIN_MODEL'] = 'gemini-3.5-flash';
process.env['JARVIS_FAST_MODEL'] = 'gemini-3.5-flash-lite';

const { GroqProvider, groqProvider } = await import('../bridge/groqProvider.js');
const { ModelRouter } = await import('../bridge/modelRouter.js');
const { classifyLLMError } = await import('../bridge/llmStatus.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Fake HTTP server (as tests/llmClientBehaviourTest.ts) ────────────────────
let fetches = 0;
let replies: Array<() => Response> = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (content: string) => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
const quota = () => json(429, [{ error: { code: 429, message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' } }]);
globalThis.fetch = (async (_input: unknown, init: any = {}) => {
  if (init.signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  fetches++;
  const next = replies.shift();
  if (!next) throw new Error('fake server: no reply queued');
  return next();
}) as typeof fetch;
function resetShared(): void {
  const P = GroqProvider as any;
  P.isCircuitBroken = false;
  P.consecutive429s = 0;
  P.circuitBreakerResetTime = 0;
  P.modelCooldownUntil.clear();
}
let n = 0;
const msg = (text?: string) => [{ role: 'user' as const, content: text ?? `request ${++n}` }];

console.log('\n=== One provider\'s rate limits do not stop another (Phase 1A) ===\n');

// ── 1. Two isolated clients ──────────────────────────────────────────────────
console.log('--- 1. Isolated clients ---');
{
  resetShared();
  const A = new (GroqProvider as any)({ isolatedState: true }) as InstanceType<typeof GroqProvider>;
  const B = new (GroqProvider as any)({ isolatedState: true }) as InstanceType<typeof GroqProvider>;
  replies = [quota, quota];
  await settle(A.chat({ messages: msg() }));
  fetches = 0;
  replies = [() => completion('should not be sent')];
  const aAgain = await settle(A.chat({ messages: msg() }));
  ok('A\'s breaker opened after its two rate limits', !aAgain.ok && fetches === 0, `${fetches} request(s)`);
  replies = [() => completion('B answers')];
  fetches = 0;
  const b = await settle(B.chat({ messages: msg() }));
  ok('B still sends and is answered', b.ok && b.v.content === 'B answers' && fetches === 1, b.ok ? b.v.content : String((b.e as Error)?.message));
  replies = [() => completion('default answers')];
  fetches = 0;
  const d = await settle(groqProvider.chat({ messages: msg() }));
  ok('the default client is not affected by A', d.ok && fetches === 1, d.ok ? '' : String((d.e as Error)?.message));

  // Separate caches: the same question asked of B after A is sent again.
  const same = msg('the very same question');
  const C = new (GroqProvider as any)({ isolatedState: true }) as InstanceType<typeof GroqProvider>;
  const D = new (GroqProvider as any)({ isolatedState: true }) as InstanceType<typeof GroqProvider>;
  replies = [() => completion('C\'s answer'), () => completion('D\'s answer')];
  fetches = 0;
  await settle(C.chat({ messages: same }));
  const fromD = await settle(D.chat({ messages: same }));
  ok('isolated clients do not share a response cache', fromD.ok && fromD.v.content === 'D\'s answer' && fetches === 2, fromD.ok ? `${fromD.v.content}, ${fetches} request(s)` : String((fromD.e as Error)?.message));
}

// ── 2. Default clients share state; the class reset still works ─────────────
console.log('\n--- 2. Default clients (unchanged behaviour) ---');
{
  resetShared();
  const X = new GroqProvider();
  replies = [quota, quota];
  await settle(groqProvider.chat({ messages: msg() }));
  fetches = 0;
  replies = [() => completion('should not be sent')];
  const x = await settle(X.chat({ messages: msg() }));
  ok('a default client shares the default breaker, as before', !x.ok && fetches === 0, `${fetches} request(s)`);
  resetShared();
  replies = [() => completion('after reset')];
  fetches = 0;
  const after = await settle(X.chat({ messages: msg() }));
  ok('resetting the class fields resets it, as the existing tests do', after.ok && fetches === 1, after.ok ? '' : String((after.e as Error)?.message));
  replies = [];
}

// ── 3. The router's breaker per provider ─────────────────────────────────────
console.log('\n--- 3. Router breaker per provider ---');
function counted(name: string, behaviour: (i: number, req: any) => Promise<{ content: string }>, caps?: Record<string, unknown>) {
  const c = { name, calls: 0, provider: undefined as unknown as Record<string, unknown> };
  c.provider = {
    isConfigured: () => true,
    async chat(req: any) { c.calls++; return behaviour(c.calls, req); },
    ...(caps ? { capabilities: () => caps } : {}),
  };
  return c;
}
const rateLimited = async () => { throw new Error('API error 429: rate limit reached'); };
const answer = (who: string) => async () => ({ content: `${who} answered` });
const ownBreakerCaps = { streaming: false, toolCalling: true, structuredOutput: false, imageInput: false, audioInput: false, audioOutput: false, webSearch: false, reportsUsage: true, reportsStreamUsage: false, cancellation: true, ownBreaker: true };
function routerWith(order: string[], providers: Array<{ name: string; provider: Record<string, unknown> }>) {
  const r = new ModelRouter(order[0]!);
  for (const p of providers) r.registerProvider(p.name, p.provider as never);
  (r as any).failoverOrder = (name?: string) => (name ? [name] : order);
  return r;
}
{
  process.env['JARVIS_PROVIDER_LIMITED_BREAKER_MS'] = '80';
  const limited = counted('limited', rateLimited);
  const backup = counted('backup', answer('backup'));
  const r = routerWith(['limited', 'backup'], [limited, backup]);
  for (let i = 0; i < 3; i++) await settle(r.chat({ messages: msg() }));
  ok('after two rate limits the provider is skipped', limited.calls === 2, `${limited.calls} call(s) to it`);
  ok('…and failover answers every call', backup.calls === 3, `${backup.calls} call(s) to the backup`);
  await tick(120);
  await settle(r.chat({ messages: msg() }));
  ok('after the open period one trial call goes through', limited.calls === 3, `${limited.calls} call(s)`);
  await settle(r.chat({ messages: msg() }));
  ok('…and a rate limit on the trial opens it again', limited.calls === 3, `${limited.calls} call(s)`);
  delete process.env['JARVIS_PROVIDER_LIMITED_BREAKER_MS'];

  const fresh = routerWith(['limited', 'backup'], [limited, backup]);
  const before = limited.calls;
  await settle(fresh.chat({ messages: msg() }));
  ok('a new router has its own guards (starts closed)', limited.calls === before + 1);
}
{
  const flaky = counted('flaky', async () => { throw new Error('API error 503: server error'); });
  const backup = counted('backup', answer('backup'));
  const r = routerWith(['flaky', 'backup'], [flaky, backup]);
  for (let i = 0; i < 3; i++) await settle(r.chat({ messages: msg() }));
  ok('server errors do not open the breaker (not a quota problem)', flaky.calls === 3, `${flaky.calls} call(s)`);

  const slow = counted('slow', async (_i, req) => new Promise((_res, rej) => req.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })));
  const r2 = routerWith(['slow'], [slow]);
  for (let i = 0; i < 3; i++) {
    const ac = new AbortController();
    const p = settle(r2.chat({ messages: msg(), signal: ac.signal }));
    await tick(5);
    ac.abort();
    await p;
  }
  ok('aborted calls do not open the breaker', slow.calls === 3, `${slow.calls} call(s)`);

  const own = counted('own', rateLimited, ownBreakerCaps);
  const backup2 = counted('backup', answer('backup'));
  const r3 = routerWith(['own', 'backup'], [own, backup2]);
  for (let i = 0; i < 3; i++) await settle(r3.chat({ messages: msg() }));
  ok('a provider with its own breaker gets none added on top', own.calls === 3, `${own.calls} call(s)`);
}

// ── 4. Optional request limit ────────────────────────────────────────────────
console.log('\n--- 4. Requests per minute ---');
{
  process.env['JARVIS_PROVIDER_PACED_RPM'] = '2';
  const paced = counted('paced', answer('paced'));
  const backup = counted('backup', answer('backup'));
  const r = routerWith(['paced', 'backup'], [paced, backup]);
  for (let i = 0; i < 3; i++) await r.chat({ messages: msg() });
  ok('the third call within a minute is not sent to the limited provider', paced.calls === 2, `${paced.calls} call(s)`);
  ok('…and is answered by failover', backup.calls === 1, `${backup.calls} call(s)`);
  const direct = await settle(r.chat({ messages: msg() }, 'paced'));
  ok('asked for explicitly, it is refused rather than sent', !direct.ok && paced.calls === 2);
  ok('…and the refusal reads as a rate limit, not an outage', !direct.ok && classifyLLMError(direct.e).kind === 'rate_limit', direct.ok ? '' : String((direct.e as Error)?.message));
  delete process.env['JARVIS_PROVIDER_PACED_RPM'];
  const unlimited = counted('unlimited', answer('unlimited'));
  const r2 = routerWith(['unlimited'], [unlimited]);
  for (let i = 0; i < 5; i++) await r2.chat({ messages: msg() });
  ok('without a setting there is no limit', unlimited.calls === 5, `${unlimited.calls} call(s)`);
}

// ── 6. Network errors and the half-open trial (review gaps, L1) ─────────────
console.log('\n--- 6. Network errors; one trial call after the open period ---');
{
  const net = counted('net', async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); });
  const backup = counted('backup', answer('backup'));
  const r = routerWith(['net', 'backup'], [net, backup]);
  for (let i = 0; i < 3; i++) await settle(r.chat({ messages: msg() }));
  ok('network errors do not open the breaker (not a quota problem)', net.calls === 3, `${net.calls} call(s)`);
}
{
  process.env['JARVIS_PROVIDER_COOLED_BREAKER_MS'] = '80';
  let mode: 'limit' | 'slow' = 'limit';
  const cooled = counted('cooled', async () => {
    if (mode === 'limit') throw new Error('API error 429: rate limit reached');
    await tick(150);
    return { content: 'cooled answered' };
  });
  const backup = counted('backup', answer('backup'));
  const r = routerWith(['cooled', 'backup'], [cooled, backup]);
  await settle(r.chat({ messages: msg() }));
  await settle(r.chat({ messages: msg() }));
  ok('the breaker is open after two rate limits', cooled.calls === 2, `${cooled.calls} call(s)`);
  await tick(120);
  mode = 'slow';
  const before = cooled.calls;
  const together = await Promise.all([1, 2, 3, 4, 5].map(() => settle(r.chat({ messages: msg() }))));
  ok('after the open period, five calls at once send only one trial call', cooled.calls - before === 1, `${cooled.calls - before} trial call(s)`);
  ok('…the others are answered by failover', together.filter((t) => t.ok).length === 5 && backup.calls >= 4, `${backup.calls} to the backup`);
  const after = cooled.calls;
  await settle(r.chat({ messages: msg() }));
  ok('…and once the trial succeeded, the provider is used again', cooled.calls === after + 1, `${cooled.calls - after} call(s)`);
  delete process.env['JARVIS_PROVIDER_COOLED_BREAKER_MS'];
}
{
  // A trial call that never reports back (cancelled) does not block the provider for ever.
  const guardModule = await import('../bridge/providerGuard.js');
  let t = 0;
  const g = new guardModule.ProviderGuard('lease', { JARVIS_PROVIDER_LEASE_BREAKER_MS: '100' }, () => t);
  g.noteFailure(new Error('429 rate limit')); g.noteFailure(new Error('429 rate limit'));
  t = 150;
  let first = true; try { g.check(true); } catch { first = false; }
  let second = true; try { g.check(true); } catch { second = false; }
  ok('one trial passes, a second is held while it runs', first && !second);
  t = 300;
  let later = true; try { g.check(true); } catch { later = false; }
  ok('a trial that never reported back frees the provider after the open period', later);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
