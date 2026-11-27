/**
 * tests/modelRouteRound3Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner's decisions of 2026-11-15 after the second independent review
 * (INDEPENDENT_REVIEW_CORRECTIONS.md, REVIEW_HANDOVER.md):
 *
 *   M-3  every background attempt, a fallback attempt too, yields to the
 *        owner's conversation (the reviewer's scenario: a named route the
 *        conversation does not use fails, and the fallback went to the
 *        primary at once)
 *   M-2  conversation and planning: one fallback attempt with the default
 *        model on the same provider when the configured model itself failed;
 *        attempts are told apart by provider and model; never after a
 *        provider-wide failure (sign-in, network, rate limit or open breaker,
 *        server error); strict routes never fall back
 *   lease  one half-open trial at a time; a cancelled or failed trial frees
 *        it; an unrelated failure does not; a stalled trial expires
 *   independence  the same effective model is never "independent"
 * Scripted providers; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-route-round3-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];

const { ModelRouter } = await import('../bridge/modelRouter.js');
const categories = await import('../bridge/modelCategories.js') as Record<string, any>;
const { ProviderGuard } = await import('../bridge/providerGuard.js');
const { llmConfig } = await import('../config/llmconfig.js');
const { conversationBus } = await import('../core/conversationBus.js');
const { runAsAgent } = await import('../core/agents/agentScope.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
type Settled<T> = { ok: true; v: T; ms: number } | { ok: false; e: string; name: string; ms: number };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> => {
  const t0 = Date.now();
  return p.then((v) => ({ ok: true as const, v, ms: Date.now() - t0 }), (e) => ({ ok: false as const, e: String((e as Error)?.message ?? e), name: String((e as Error)?.name ?? ''), ms: Date.now() - t0 }));
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = () => [{ role: 'user' as const, content: 'hi' }];
const agent = { rootTaskId: 'r1', taskId: 't1', agentId: 'bg-1', agentPath: 'JARVIS › Background', request: 'background', source: 'cli' as const };
const inBackground = <T>(fn: () => Promise<T>) => runAsAgent(agent, fn);
function setEnv(vars: Record<string, string | undefined>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

interface Call { who: string; model?: string; kind: 'chat' | 'stream' }
/** `fail(model)`: the error for that model, or undefined to answer. */
function stub(who: string, log: Call[], fail: (model: string | undefined) => Error | undefined = () => undefined, opts: { stream?: boolean; hangUntilAbort?: boolean } = {}) {
  const p: Record<string, unknown> = {
    isConfigured: () => true,
    async chat(req: any) {
      log.push({ who, model: req.model, kind: 'chat' });
      if (opts.hangUntilAbort) return new Promise((_res, rej) => req.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      const e = fail(req.model);
      if (e) throw e;
      return { content: `${who}:${req.model} answered` };
    },
  };
  if (opts.stream) {
    p['streamChat'] = async function* (req: any) {
      log.push({ who, model: req.model, kind: 'stream' });
      const e = fail(req.model);
      if (e) throw e;
      yield `${who}:${req.model} streamed`;
    };
  }
  return p;
}
function router(order: string[], providers: Record<string, Record<string, unknown>>, named: Record<string, Record<string, unknown>> = {}) {
  const r = new ModelRouter(order[0]!);
  for (const [n, p] of Object.entries(providers)) r.registerProvider(n, p as never);
  for (const [n, p] of Object.entries(named)) r.registerNamedProvider(n, p as never);
  (r as any).failoverOrder = (name?: string) => (name ? [name] : order);
  return r;
}
const who = (log: Call[]) => log.map((c) => `${c.who}:${c.model ?? '-'}:${c.kind}`).join(',');
const modelError = (m: string) => Object.assign(new Error(`The model "${m}" is not available to this key (404)`), { status: 404 });
const httpError = (status: number, text: string) => Object.assign(new Error(`${text} (${status})`), { status });
async function streamAll(r: any, req: any): Promise<string> {
  let text = '';
  for await (const piece of r.streamChat(req)) text += piece;
  return text;
}

console.log('\n=== Round 3: background fallbacks, same-provider fallback, trial lease, independence ===\n');

// ── M-3: the reviewer's scenario ─────────────────────────────────────────────
console.log('--- M-3. A background fallback waits for the owner\'s conversation ---');
{
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log) }, { elsewhere: stub('elsewhere', log, () => httpError(500, 'elsewhere is down')) });
  const restore = setEnv({ JARVIS_BACKGROUND_YIELD_MS: '5000', JARVIS_MODEL_PLANNING: 'elsewhere:m' });
  conversationBus.conversationStarted();
  const call = settle(inBackground(() => r.chat({ model: 'own', messages: msg(), category: 'planning' })));
  await tick(400);
  ok('the named route (not used by the conversation) was tried at once', log[0]?.who === 'elsewhere', who(log));
  ok('…but its fallback to the primary waits while the conversation goes on', !log.some((c) => c.who === 'a'), who(log));
  conversationBus.conversationEnded();
  const res = await call;
  ok('…and the primary answers once the conversation ends', res.ok && res.v.content === 'a:own answered', res.ok ? res.v.content : res.e);
  restore();
}
{
  // The same for a routed stream.
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log, () => undefined, { stream: true }) }, { elsewhere: stub('elsewhere', log, () => httpError(500, 'elsewhere is down'), { stream: true }) });
  const restore = setEnv({ JARVIS_BACKGROUND_YIELD_MS: '5000', JARVIS_MODEL_CONVERSATION: 'elsewhere:m' });
  conversationBus.conversationStarted();
  const call = settle(inBackground(() => streamAll(r, { model: 'own', messages: msg(), category: 'conversation' })));
  await tick(400);
  ok('a background routed stream: the fallback waits for the conversation too', !log.some((c) => c.who === 'a'), who(log));
  conversationBus.conversationEnded();
  const res = await call;
  ok('…and is answered after it', res.ok && /^a:own/.test(res.v), res.ok ? res.v : res.e);
  restore();
}
{
  // Cancelling while the fallback waits; the queue-wait limit on a fallback attempt.
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log) }, { elsewhere: stub('elsewhere', log, () => httpError(500, 'elsewhere is down')) });
  const restore = setEnv({ JARVIS_BACKGROUND_YIELD_MS: '5000', JARVIS_MODEL_PLANNING: 'elsewhere:m' });
  conversationBus.conversationStarted();
  const ac = new AbortController();
  const call = settle(inBackground(() => r.chat({ model: 'own', messages: msg(), category: 'planning', signal: ac.signal })));
  await tick(200);
  ac.abort();
  const res = await call;
  ok('cancelling while the fallback waits ends the call as an AbortError, the primary not asked', !res.ok && res.name === 'AbortError' && !log.some((c) => c.who === 'a'), res.ok ? 'answered' : `${res.name}; ${who(log)}`);
  log.length = 0;
  process.env['JARVIS_MODEL_QUEUE_WAIT_MS'] = '200';
  const res2 = await settle(inBackground(() => r.chat({ model: 'own', messages: msg(), category: 'planning' })));
  conversationBus.conversationEnded();
  ok('a fallback that waits past JARVIS_MODEL_QUEUE_WAIT_MS fails clearly and is not sent', !res2.ok && res2.name === 'QueueWaitTimeoutError' && !log.some((c) => c.who === 'a') && res2.ms < 1500, res2.ok ? 'answered' : `${res2.name}, ${res2.ms} ms; ${who(log)}`);
  restore();
}
{
  // The owner's own call is never held, its fallback included.
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log) }, { elsewhere: stub('elsewhere', log, () => httpError(500, 'elsewhere is down')) });
  const restore = setEnv({ JARVIS_BACKGROUND_YIELD_MS: '5000', JARVIS_MODEL_PLANNING: 'elsewhere:m' });
  conversationBus.conversationStarted();
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'planning' }));
  conversationBus.conversationEnded();
  ok('a foreground call\'s fallback is answered at once', res.ok && res.v.content === 'a:own answered' && res.ms < 300, res.ok ? `${res.ms} ms` : res.e);
  restore();
}

// ── M-2: same provider, different model ──────────────────────────────────────
console.log('\n--- M-2. One fallback with the default model on the same provider ---');
{
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log, (m) => (m === 'other-model' ? modelError('other-model') : undefined)) });
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'other-model' });
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'planning' }));
  ok('planning: the configured model itself failed → the default model on the same provider answers', res.ok && res.v.content === 'a:own answered', res.ok ? res.v.content : res.e);
  ok('…each provider/model pair asked once', who(log) === 'a:other-model:chat,a:own:chat', who(log));
  restore();
}
{
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log, (m) => (m === 'talk' ? modelError('talk') : undefined)) });
  const restore = setEnv({ JARVIS_MODEL_CONVERSATION: 'a:talk' });
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'conversation' }));
  ok('conversation on the primary\'s own provider: one fallback with the default model', res.ok && who(log) === 'a:talk:chat,a:own:chat', `${res.ok ? res.v.content : res.e} / ${who(log)}`);
  log.length = 0;
  const text = await streamAll(r, { model: 'own', messages: msg(), category: 'conversation' }).catch((e) => `ERR ${e.message}`);
  ok('…the same for a stream', /^a:own/.test(text) && log.filter((c) => c.who === 'a' && c.model === 'talk').length === 1, `${text} / ${who(log)}`);
  restore();
}
for (const [label, err] of [
  ['a sign-in failure (401)', httpError(401, 'unauthorized')],
  ['a network failure', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })],
  ['a rate limit (429)', httpError(429, 'rate limit reached')],
  ['a server error (503)', httpError(503, 'service unavailable')],
] as const) {
  const log: Call[] = [];
  const r = router(['a', 'b'], { a: stub('a', log, () => err), b: stub('b', log) });
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'other-model' });
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'planning' }));
  ok(`after ${label}, the same provider is not asked again with another model`, log.filter((c) => c.who === 'a').length === 1, who(log));
  ok('…the next provider answers, in order', res.ok && res.v.content === 'b:own answered', res.ok ? res.v.content : res.e);
  restore();
}
{
  // An open breaker counts as provider-wide.
  const log: Call[] = [];
  const r = router(['a', 'b'], { a: stub('a', log, () => httpError(429, 'rate limit reached')), b: stub('b', log) });
  await settle(r.chat({ model: 'own', messages: msg() }));
  await settle(r.chat({ model: 'own', messages: msg() }));   // a's breaker is now open
  log.length = 0;
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'other-model' });
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'planning' }));
  ok('with the primary\'s breaker open, neither model is sent to it', !log.some((c) => c.who === 'a') && res.ok && res.v.content === 'b:own answered', `${who(log)} → ${res.ok ? res.v.content : res.e}`);
  restore();
}
{
  // The same model twice is never sent.
  const log: Call[] = [];
  const a = stub('a', log, () => modelError('own'));
  const r = router(['a', 'alias', 'b'], { a, alias: a, b: stub('b', log) });
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'a:own' });
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'planning' }));
  ok('a configured model equal to the default is not retried, under any name', log.filter((c) => c.who === 'a').length === 1 && res.ok && res.v.content === 'b:own answered', who(log));
  restore();
}
{
  // Strict routes never fall back, not even to the default model on the same provider.
  for (const [setting, req] of [
    ['JARVIS_MODEL_REVIEW', { category: 'review' }],
    ['JARVIS_MODEL_AGENT_QA_AGENT', { category: 'planning', agentRole: 'qa_agent' }],
    ['JARVIS_MODEL_AGENT_CODING_AGENT', { category: 'planning', agentRole: 'coding_agent' }],
  ] as const) {
    const log: Call[] = [];
    const r = router(['a', 'b'], { a: stub('a', log, (m) => (m === 'strict-model' ? modelError('strict-model') : undefined)), b: stub('b', log) });
    const restore = setEnv({ [setting]: 'strict-model' });
    const res = await settle(r.chat({ model: 'own', messages: msg(), ...req } as any));
    ok(`${setting} (strict): fails as itself, no other model on any provider`, !res.ok && res.name === 'StrictRouteError' && who(log) === 'a:strict-model:chat', res.ok ? `answered: ${res.v.content}` : `${res.name}; ${who(log)}`);
    restore();
  }
}

// ── The trial lease ──────────────────────────────────────────────────────────
console.log('\n--- Lease: one half-open trial; cancelled or failed trials free it; a stall expires ---');
{
  let t = 0;
  const env = { JARVIS_PROVIDER_LEASE_BREAKER_MS: '100' };
  const fresh = () => { const g = new ProviderGuard('lease', env, () => t); g.noteFailure(new Error('429 rate limit')); g.noteFailure(new Error('429 rate limit')); return g; };
  const tryCheck = (g: any) => { try { return { ticket: g.check(true) }; } catch { return undefined; } };

  t = 0; let g: any = fresh(); t = 150;
  const trial = tryCheck(g);
  ok('after the open period one call is let through as the trial', !!trial);
  ok('…a second, at the same time, is held', !tryCheck(g));
  g.noteCancelled?.(trial?.ticket);
  ok('a cancelled trial frees the lease at once (before it would expire)', !!tryCheck(g));

  t = 0; g = fresh(); t = 150;
  const trial2 = tryCheck(g);
  g.noteFailure(Object.assign(new Error('server error (503)'), { status: 503 }), trial2?.ticket);
  ok('a trial that failed without a rate limit frees the lease', !!tryCheck(g));

  t = 0; g = fresh(); t = 150;
  tryCheck(g);   // the trial, still running
  g.noteFailure(Object.assign(new Error('server error (503)'), { status: 503 }));   // an unrelated call, sent before the breaker opened
  ok('an unrelated call\'s failure does not end the running trial\'s lease', !tryCheck(g));

  t = 0; g = fresh(); t = 150;
  tryCheck(g);
  t = 260;
  ok('a stalled trial frees the provider after one open period', !!tryCheck(g));

  t = 0; g = fresh(); t = 150;
  const trial3 = tryCheck(g);
  g.noteSuccess(trial3?.ticket);
  ok('a successful trial closes the breaker: calls go through again', !!tryCheck(g) && !!tryCheck(g));
}
{
  // Through the router: a cancelled trial call frees the provider for the next call.
  const restore = setEnv({ JARVIS_PROVIDER_CAN_BREAKER_MS: '80' });
  let mode: 'limit' | 'hang' | 'ok' = 'limit';
  let calls = 0;
  const can = {
    isConfigured: () => true,
    async chat(req: any) {
      calls++;
      if (mode === 'limit') throw new Error('API error 429: rate limit reached');
      if (mode === 'hang') return new Promise((_res, rej) => req.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      return { content: 'can answered' };
    },
  };
  const logB: Call[] = [];
  const r = router(['can', 'b'], { can, b: stub('b', logB) });
  await settle(r.chat({ messages: msg() }));
  await settle(r.chat({ messages: msg() }));
  await tick(120);
  mode = 'hang';
  const ac = new AbortController();
  const trialCall = settle(r.chat({ messages: msg(), signal: ac.signal }));
  await tick(30);
  const before = calls;
  ac.abort();
  await trialCall;
  mode = 'ok';
  const next = await settle(r.chat({ messages: msg() }));
  ok('after the trial call was cancelled, the next call is sent to the provider at once', calls === before + 1 && next.ok && next.v.content === 'can answered', `${calls - before} call(s); ${next.ok ? next.v.content : next.e}`);
  restore();
}

// ── Independence ─────────────────────────────────────────────────────────────
console.log('\n--- Independence: the same effective model is never "independent" ---');
{
  const ai = categories['agentIndependence'];
  const observed = categories['observedAgentIndependence'];
  const primary = llmConfig.primary;
  ok('case does not make two models different',
    ai({ JARVIS_MODEL_AGENT_QA_AGENT: `${primary}:${llmConfig.model.toUpperCase()}` }).independent === false,
    JSON.stringify(ai({ JARVIS_MODEL_AGENT_QA_AGENT: `${primary}:${llmConfig.model.toUpperCase()}` }).qaTarget));
  ok('openai:<x> and openai:<y> are the same model (the fallback provider sends its own)',
    ai({ JARVIS_MODEL_AGENT_CODING_AGENT: 'openai:model-a', JARVIS_MODEL_AGENT_QA_AGENT: 'openai:model-b' }).independent === false);
  if (primary !== 'anthropic') {
    ok('the same provider whose client may move to its fast model is not counted as independent',
      ai({ JARVIS_MODEL_AGENT_CODING_AGENT: `${primary}:${llmConfig.model}`, JARVIS_MODEL_AGENT_QA_AGENT: `${primary}:${llmConfig.fastModel}` }).independent === false);
  }
  ok('two Claude models are not counted as independent (server-side fallbacks may answer with another Claude model)',
    ai({ JARVIS_MODEL_AGENT_CODING_AGENT: 'anthropic:claude-opus-5-5', JARVIS_MODEL_AGENT_QA_AGENT: 'anthropic:claude-sonnet-5-5' }).independent === false);
  ok('different providers are independent', ai({ JARVIS_MODEL_AGENT_QA_AGENT: 'anthropic:claude-sonnet-5-5' }).independent === (primary !== 'anthropic'));
  ok('the result reports why', typeof ai({}).reason === 'string' && ai({}).reason.length > 10, String(ai({}).reason));

  const rec = (agentRole: string, provider: string, model: string, correlationId: string, okFlag = true) => ({ at: new Date().toISOString(), category: 'planning', provider, model, correlationId, latencyMs: 1, ok: okFlag, fallbackUsed: false, streamed: false, promptTokens: null, completionTokens: null, agentRole });
  ok('observed: model names compared regardless of case', observed([rec('coding_agent', 'gemini', 'G1', 'x'), rec('qa_agent', 'gemini', 'g1', 'x')]).independent === false);
  ok('observed: two models through the OpenAI fallback are the same model', observed([rec('coding_agent', 'openai', 'model-a', 'x'), rec('qa_agent', 'openai', 'model-b', 'x')]).independent === false);
  ok('observed: calls of another task are not paired with this one',
    observed([rec('coding_agent', 'gemini', 'g1', 'task-A'), rec('qa_agent', 'anthropic', 'c1', 'task-B')], { correlationId: 'task-A' }).independent === null);
  ok('observed: a QA call that failed is not counted, so no claim is made', observed([rec('coding_agent', 'gemini', 'g1', 'x'), rec('qa_agent', 'anthropic', 'c1', 'x', false)]).independent === null);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* still in use on Windows */ }
process.exit(failed > 0 ? 1 : 0);
