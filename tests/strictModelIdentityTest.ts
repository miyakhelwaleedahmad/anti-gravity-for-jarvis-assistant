/**
 * tests/strictModelIdentityTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Gap closure P3 (GAP_CLOSURE_PLAN.md §3; owner approval 2026-11-16, D4):
 * a strict route is answered by exactly its model, and the router accepts the
 * answer only when the provider reports that model. The requested model is
 * never taken as evidence of the served one; an unknown identity fails closed.
 *
 *   A  Gemini/Groq client: on a strict request, no fast model after a 429,
 *      no fast model during a cooldown, no cached reply from a non-strict
 *      call; the reported model is returned; non-strict behaviour unchanged
 *   B  Claude adapter: no server-side fallbacks on a strict request (still on
 *      otherwise); the reported model and the canonical id are returned
 *   C  router: strict reply without a reported model, or with another model →
 *      StrictRouteError, no other provider; a matching report is accepted
 *      (case, "models/" prefix, Claude's canonical id); the provider is told
 *      exactModel; openai:<x> that would send another model is refused before
 *      sending; a strict stream shows no text before the identity is
 *      confirmed; a non-strict route is unchanged
 * Fake HTTP server and stand-in clients; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-strict-identity-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_')) delete process.env[k];
const KEY = 'AQ.fake-key-for-tests-0123456789abcdef';
for (const name of ['GROQ_API_KEY', 'GROQ_API_URL', 'XAI_API_KEY', 'JARVIS_LLM_PROVIDER', 'JARVIS_LLM_REASONING_EFFORT',
  'JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'JARVIS_FALLBACK_MODEL', 'ANTHROPIC_API_KEY']) process.env[name] = '';
process.env['GEMINI_API_KEY'] = KEY;
process.env['GEMINI_API_URL'] = 'https://generativelanguage.googleapis.com/v1beta';
process.env['JARVIS_BRAIN_MODEL'] = 'gemini-3.5-flash';
process.env['JARVIS_FAST_MODEL'] = 'gemini-3.5-flash-lite';

const { GroqProvider } = await import('../bridge/groqProvider.js');
const { AnthropicProvider } = await import('../bridge/anthropicProvider.js');
const { ModelRouter } = await import('../bridge/modelRouter.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
type Settled<T> = { ok: true; v: T } | { ok: false; e: string; name: string };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> => p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e: String((e as Error)?.message ?? e), name: String((e as Error)?.name ?? '') }));
function setEnv(vars: Record<string, string | undefined>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

// ── Fake OpenAI-compatible server (Gemini) ───────────────────────────────────
interface Seen { body: any }
let seen: Seen[] = [];
type Reply = (req: Seen) => Response;
let replies: Reply[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (content: string, model?: string) => json(200, { ...(model ? { model } : {}), choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
const rateLimited = (message = 'quota exceeded') => json(429, [{ error: { code: 429, message, status: 'RESOURCE_EXHAUSTED' } }]);
globalThis.fetch = (async (_input: any, init: any = {}) => {
  const req: Seen = { body: init.body ? JSON.parse(init.body) : undefined };
  seen.push(req);
  const next = replies.shift();
  if (!next) throw new Error('fake server: no reply queued');
  return next(req);
}) as typeof fetch;
function reset(...queue: Reply[]): void {
  seen = [];
  replies = queue;
  const P = GroqProvider as any;
  P.isCircuitBroken = false;
  P.consecutive429s = 0;
}
let n = 0;
const msg = () => [{ role: 'user' as const, content: `identity request ${++n}` }];
const gemini = new GroqProvider();

console.log('\n=== Strict routes: exactly the configured model, identity reported ===\n');

console.log('--- A. Gemini/Groq client ---');
{
  reset(() => rateLimited(), () => completion('from lite', 'gemini-3.5-flash-lite'));
  const r = await settle(gemini.chat({ messages: msg(), model: 'gemini-3.5-flash', exactModel: true } as any));
  ok('strict: a 429 is not answered by the fast model', !r.ok && seen.length === 1 && !seen.some((s) => s.body?.model === 'gemini-3.5-flash-lite'), `${r.ok ? r.v.content : r.e.slice(0, 80)}; ${seen.map((s) => s.body?.model).join(',')}`);

  reset(() => rateLimited(), () => completion('from lite', 'gemini-3.5-flash-lite'));
  const loose = await gemini.chat({ messages: msg(), model: 'gemini-3.5-flash' });
  ok('non-strict: the fast-model retry is unchanged', loose.content === 'from lite' && seen[1]?.body.model === 'gemini-3.5-flash-lite', seen.map((s) => s.body?.model).join(','));

  const daily = 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash Please retry in 16h37m57.5s.';
  reset(() => rateLimited(daily), () => completion('from lite', 'gemini-3.5-flash-lite'));
  await settle(gemini.chat({ messages: msg(), model: 'gemini-3.5-flash' }));   // starts a cooldown on gemini-3.5-flash
  reset(() => completion('exact', 'gemini-3.5-flash'));
  const cooled = await settle(gemini.chat({ messages: msg(), model: 'gemini-3.5-flash', exactModel: true } as any));
  ok('strict during a cooldown: the requested model is sent, not the fast model', seen[0]?.body.model === 'gemini-3.5-flash', seen.map((s) => s.body?.model).join(','));
  ok('…and the reported model is returned', cooled.ok && (cooled.v as any).model === 'gemini-3.5-flash', cooled.ok ? String((cooled.v as any).model) : cooled.e);
  (GroqProvider as any).modelCooldownUntil?.clear?.();

  const same = msg();
  reset(() => rateLimited(), () => completion('cached from lite', 'gemini-3.5-flash-lite'));
  await gemini.chat({ messages: same, model: 'gemini-3.5-flash' });                // non-strict; cached under gemini-3.5-flash
  reset(() => completion('fresh exact', 'gemini-3.5-flash'));
  const fromCache = await settle(gemini.chat({ messages: same, model: 'gemini-3.5-flash', exactModel: true } as any));
  ok('strict: a cached reply of a non-strict call (made by the fast model) is not returned', fromCache.ok && fromCache.v.content === 'fresh exact' && seen.length === 1, fromCache.ok ? fromCache.v.content : fromCache.e);
}

console.log('\n--- B. Claude adapter ---');
{
  let body: any;
  const fakeClient = (served: string, canonical: string) => ({
    beta: { messages: { create: async (b: any) => { body = b; return { id: 'm', type: 'message', role: 'assistant', model: served, stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } }; } } },
    models: { retrieve: async () => ({ id: canonical }) },
  }) as never;
  const claude = new AnthropicProvider({}, () => fakeClient('claude-sonnet-5-5-20261001', 'claude-sonnet-5-5-20261001'));
  const strict = await claude.chat({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x' }], exactModel: true } as any);
  ok('strict: no server-side fallbacks requested', body && !('fallbacks' in body) && !(body.betas ?? []).includes('server-side-fallback-2026-07-01'), JSON.stringify({ f: body?.fallbacks, b: body?.betas }));
  ok('…the model the API reports is returned', (strict as any).model === 'claude-sonnet-5-5-20261001', String((strict as any).model));
  ok('…and the alias\'s canonical id is known', typeof (claude as any).modelIdentities === 'function' && (await (claude as any).modelIdentities('claude-sonnet-5-5')).includes('claude-sonnet-5-5-20261001'), String((claude as any).modelIdentities?.('claude-sonnet-5-5')));
  await claude.chat({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'y' }] });
  ok('non-strict: server-side fallbacks still on by default', body?.fallbacks === 'default', String(body?.fallbacks));
}

console.log('\n--- C. Router ---');
interface Asked { who: string; model?: string; exact?: boolean; kind: string }
const asked: Asked[] = [];
const stub = (who: string, reply: (req: any) => Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  isConfigured: () => true,
  async chat(req: any) { asked.push({ who, model: req.model, exact: req.exactModel, kind: 'chat' }); return { content: `${who} answered`, ...reply(req) }; },
  ...extra,
});
function router(named: Record<string, unknown>) {
  const r = new ModelRouter('primary');
  r.registerProvider('primary', stub('primary', (req) => ({ model: req.model })) as never);
  for (const [k, v] of Object.entries(named)) r.registerNamedProvider(k, v as never);
  (r as any).failoverOrder = (name?: string) => (name ? [name] : ['primary']);
  return r;
}
const ask = (r: any, extra: Record<string, unknown> = {}) => settle<any>(r.categoryChat('review', { messages: [{ role: 'user', content: 'check' }], ...extra }));
{
  asked.length = 0;
  const restore = setEnv({ JARVIS_MODEL_REVIEW: 'silent:model-x' });
  const r = await ask(router({ silent: stub('silent', () => ({})) }));
  ok('strict reply without a reported model: StrictRouteError (fails closed)', !r.ok && r.name === 'StrictRouteError' && /identity/i.test(r.e), r.ok ? 'answered' : r.e);
  ok('…asked once, no other provider asked', asked.length === 1 && asked[0]!.who === 'silent', asked.map((a) => a.who).join(','));
  ok('…and the provider was told to send exactly that model', asked[0]?.exact === true, String(asked[0]?.exact));
  restore();
}
{
  asked.length = 0;
  const restore = setEnv({ JARVIS_MODEL_REVIEW: 'swapper:model-x' });
  const r = await ask(router({ swapper: stub('swapper', () => ({ model: 'model-x-lite' })) }));
  ok('strict reply reporting another model: StrictRouteError naming both', !r.ok && r.name === 'StrictRouteError' && /model-x-lite/.test(r.e) && /model-x/.test(r.e), r.ok ? 'answered' : r.e);
  ok('…no other provider asked', asked.every((a) => a.who === 'swapper'), asked.map((a) => a.who).join(','));
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_REVIEW: 'exact:Model-X' });
  const r = await ask(router({ exact: stub('exact', () => ({ model: 'models/model-x' })) }));
  ok('a matching report (case, "models/" prefix) is accepted', r.ok && r.v.content === 'exact answered', r.ok ? r.v.content : r.e);
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_REVIEW: 'claude:claude-sonnet-5-5' });
  const claudeStub = stub('claude', () => ({ model: 'claude-sonnet-5-5-20261001' }), { modelIdentities: (m: string) => (m === 'claude-sonnet-5-5' ? ['claude-sonnet-5-5', 'claude-sonnet-5-5-20261001'] : [m]) });
  const r = await ask(router({ claude: claudeStub }));
  ok('Claude: the alias answered by its canonical dated id is accepted', r.ok, r.ok ? r.v.content : r.e);
  restore();
}
{
  asked.length = 0;
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'silent:code-model' });
  const r = await settle(router({ silent: stub('silent', () => ({})) }).chat({ model: 'own', messages: [{ role: 'user', content: 'x' }], category: 'planning', agentRole: 'coding_agent' } as any));
  ok('a strict agent route (coding_agent) without a reported model fails closed too', !r.ok && r.name === 'StrictRouteError' && /identity/i.test(r.e), r.ok ? 'answered' : r.e);
  ok('…no other provider asked', asked.every((a) => a.who === 'silent'), asked.map((a) => a.who).join(','));
  restore();
}
{
  asked.length = 0;
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'silent:plan-model' });
  const r = await settle(router({ silent: stub('silent', () => ({})) }).chat({ model: 'own', messages: [{ role: 'user', content: 'x' }], category: 'planning' } as any));
  ok('a non-strict route is unchanged: no identity needed', r.ok && r.v.content === 'silent answered', r.ok ? r.v.content : r.e);
  ok('…and its provider is not told exactModel', asked[0]?.exact !== true, String(asked[0]?.exact));
  restore();
}
{
  asked.length = 0;
  const restore = setEnv({ JARVIS_MODEL_REVIEW: 'openai:other-model', JARVIS_FALLBACK_MODEL: 'gpt-4o-mini' });
  const r0 = new ModelRouter('primary');
  r0.registerProvider('primary', stub('primary', (req) => ({ model: req.model })) as never);
  r0.registerProvider('openai', stub('openai', () => ({ model: 'gpt-4o-mini' })) as never);
  (r0 as any).failoverOrder = (name?: string) => (name ? [name] : ['primary']);
  const r = await ask(r0);
  ok('openai:<x> on a strict route, where openai would send another model: refused before sending', !r.ok && r.name === 'StrictRouteError' && /JARVIS_FALLBACK_MODEL/.test(r.e) && !asked.some((a) => a.who === 'openai'), r.ok ? r.v.content : `${r.e} | ${asked.map((a) => a.who).join(',')}`);
  restore();
}
{
  asked.length = 0;
  const restore = setEnv({ JARVIS_MODEL_REVIEW: 'streamer:model-x' });
  const streamer = stub('streamer', () => ({ model: 'model-x-lite' }), {
    async *streamChat() { asked.push({ who: 'streamer', kind: 'stream' }); yield 'unconfirmed text'; },
  });
  const r = router({ streamer });
  let text = '';
  let err = '';
  try { for await (const piece of r.streamChat({ messages: [{ role: 'user', content: 'x' }], category: 'review' } as any)) text += piece; } catch (e) { err = `${(e as Error).name}: ${(e as Error).message}`; }
  ok('strict routed stream: no text shown before the identity is confirmed', text === '', text);
  ok('…the wrong model ends it with StrictRouteError', /^StrictRouteError/.test(err), err || '(no error)');
  restore();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
