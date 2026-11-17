/**
 * tests/modelRouteCorrectionsTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1A corrections M1–M4 (ai_workflows/runs/2026-11-15_phase1a-model-gateway/
 * INDEPENDENT_REVIEW.md; the owner's decisions of 2026-11-15).
 *
 *   M1  waiting for the owner's conversation does not use up a route's time
 *       limit; the configured provider gets the call once the conversation
 *       ends; cancelling while waiting works; a separate queue-wait limit
 *       (JARVIS_MODEL_QUEUE_WAIT_MS) ends the wait with a clear error, never
 *       with another model's answer; the owner's own calls never wait
 *   M2  a configured coding/review route (code repair, goalVerifier) and a
 *       configured coding_agent / qa_agent route are strict, even as a bare
 *       model name: a failure is a clear error, no other provider answers
 *   M3  one routed call never asks the same provider twice, even under two
 *       names; after every eligible provider failed, the error says so
 *   M4  a failing QA route is never answered by the coding model; the
 *       independence check compares the models really used
 *   and the gaps the review listed: an abort during a pending routed call,
 *   capability refusals on the stream paths.
 * Scripted providers; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-route-corrections-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';

const { ModelRouter, modelRouter } = await import('../bridge/modelRouter.js');
const categories = await import('../bridge/modelCategories.js') as Record<string, any>;
const { llmConfig } = await import('../config/llmconfig.js');
const { conversationBus } = await import('../core/conversationBus.js');
const { runAsAgent } = await import('../core/agents/agentScope.js');
const { modelJudge } = await import('../core/goalVerifier.js');

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
const msg = (t = 'hi') => [{ role: 'user' as const, content: t }];
const agent = { rootTaskId: 'r1', taskId: 't1', agentId: 'bg-1', agentPath: 'JARVIS › Background', request: 'background', source: 'cli' as const };
const inBackground = <T>(fn: () => Promise<T>) => runAsAgent(agent, fn);
function setEnv(vars: Record<string, string | undefined>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

interface Call { who: string; model?: string; kind: 'chat' | 'stream' }
type Behaviour = 'ok' | 'fail' | 'hang';
function stub(who: string, log: Call[], behaviour: Behaviour | (() => Behaviour) = 'ok', opts: { stream?: boolean; caps?: Record<string, boolean> } = {}) {
  const how = () => (typeof behaviour === 'function' ? behaviour() : behaviour);
  const pending = (req: any) => new Promise<never>((_res, rej) => {
    const stop = () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (req.signal?.aborted) stop(); else req.signal?.addEventListener('abort', stop, { once: true });
  });
  const p: Record<string, unknown> = {
    isConfigured: () => true,
    async chat(req: any) {
      log.push({ who, model: req.model, kind: 'chat' });
      const b = how();
      if (b === 'hang') return pending(req);
      if (b === 'fail') throw new Error(`${who} is down (503)`);
      // D2 (owner, 2026-11-16): a stand-in reports the model it answers with, as real providers do.
      return { content: `${who} answered`, model: req.model };
    },
  };
  if (opts.stream) {
    p['streamChat'] = async function* (req: any) {
      log.push({ who, model: req.model, kind: 'stream' });
      if (how() === 'fail') throw new Error(`${who} stream is down (503)`);
      yield `${who} streamed`;
    };
  }
  if (opts.caps) {
    const full = { streaming: !!opts.stream, toolCalling: true, structuredOutput: false, imageInput: false, audioInput: false, audioOutput: false, webSearch: false, reportsUsage: true, reportsStreamUsage: false, cancellation: true, ownBreaker: false, ...opts.caps };
    p['capabilities'] = () => full;
  }
  return p;
}
/** A router whose failover order is exactly `order` (no real fallback provider). */
function router(order: string[], providers: Record<string, Record<string, unknown>>, named: Record<string, Record<string, unknown>> = {}) {
  const r = new ModelRouter(order[0]!);
  for (const [n, p] of Object.entries(providers)) r.registerProvider(n, p as never);
  for (const [n, p] of Object.entries(named)) r.registerNamedProvider(n, p as never);
  (r as any).failoverOrder = (name?: string) => (name ? [name] : order);
  return r;
}
const who = (log: Call[]) => log.map((c) => `${c.who}:${c.kind}`).join(',');
async function streamAll(r: any, req: any): Promise<string> {
  let text = '';
  for await (const piece of r.streamChat(req)) text += piece;
  return text;
}

console.log('\n=== Phase 1A corrections (M1–M4) ===\n');

// ── M1. Waiting for the conversation ────────────────────────────────────────
console.log('--- M1. Waiting for the conversation does not use up the time limit ---');
{
  // a) The configured provider answers once the conversation ends, although
  //    the wait was longer than the route's time limit.
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log), alt: stub('alt', log) });
  const restore = setEnv({ JARVIS_BACKGROUND_YIELD_MS: '5000', JARVIS_MODEL_PLANNING: 'alt:m-alt', JARVIS_MODEL_PLANNING_TIMEOUT_MS: '1000' });
  conversationBus.conversationStarted();
  const call = settle(inBackground(() => r.chat({ model: 'own', messages: msg(), category: 'planning' })));
  await tick(1500);
  ok('while the conversation goes on, nothing has been sent', log.length === 0, who(log));
  conversationBus.conversationEnded();
  const res = await call;
  ok('after the conversation, the configured provider answers (its time limit did not run during the wait)', res.ok && res.v.content === 'alt answered', res.ok ? res.v.content : res.e);
  ok('…and the default provider was not asked', !log.some((c) => c.who === 'a'), who(log));
  restore();
}
{
  // b) The time limit still applies to the provider's own work.
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log) }, { slow: stub('slow', log, 'hang') });
  const restore = setEnv({ JARVIS_MODEL_REVIEW: 'slow:m', JARVIS_MODEL_REVIEW_TIMEOUT_MS: '1000' });
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'review' }));
  ok('a provider that does not answer in time is stopped at the limit', !res.ok && res.ms >= 900 && res.ms < 3000, `${res.ms} ms`);
  ok('…with a clear strict-route error that says it timed out', !res.ok && res.name === 'StrictRouteError' && /timed out/.test(res.e), res.ok ? 'answered' : `${res.name}: ${res.e}`);
  ok('…and no other provider answers', !log.some((c) => c.who === 'a'), who(log));
  restore();
}
{
  // c) Cancelling while waiting.
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log), alt: stub('alt', log) });
  const restore = setEnv({ JARVIS_BACKGROUND_YIELD_MS: '5000', JARVIS_MODEL_PLANNING: 'alt:m-alt' });
  conversationBus.conversationStarted();
  const ac = new AbortController();
  const call = settle(inBackground(() => r.chat({ model: 'own', messages: msg(), category: 'planning', signal: ac.signal })));
  await tick(100);
  ac.abort();
  const res = await call;
  conversationBus.conversationEnded();
  ok('a call cancelled while it waits ends as cancelled', !res.ok && res.name === 'AbortError' && res.ms < 1000, res.ok ? 'answered' : `${res.name}, ${res.ms} ms`);
  ok('…and is sent to no provider', log.length === 0, who(log));
  restore();
}
{
  // d) The separate queue-wait limit.
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log), alt: stub('alt', log) });
  const restore = setEnv({ JARVIS_BACKGROUND_YIELD_MS: '3000', JARVIS_MODEL_PLANNING: 'alt:m-alt', JARVIS_MODEL_QUEUE_WAIT_MS: '300' });
  conversationBus.conversationStarted();
  const res = await settle(inBackground(() => r.chat({ model: 'own', messages: msg(), category: 'planning' })));
  conversationBus.conversationEnded();
  ok('a wait longer than JARVIS_MODEL_QUEUE_WAIT_MS ends with a clear error', !res.ok && res.name === 'QueueWaitTimeoutError' && /JARVIS_MODEL_QUEUE_WAIT_MS/.test(res.e), res.ok ? `answered by ${res.v.content}` : `${res.name}: ${res.e}`);
  ok('…soon after the limit, not after the full yield', res.ms >= 250 && res.ms < 1500, `${res.ms} ms`);
  ok('…sent to no provider, and not answered by the default model', log.length === 0, who(log));
  restore();
}
{
  // e) Without a queue-wait limit, the existing yield limit still lets the call go ahead.
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log), alt: stub('alt', log) });
  const restore = setEnv({ JARVIS_BACKGROUND_YIELD_MS: '300', JARVIS_MODEL_PLANNING: 'alt:m-alt', JARVIS_MODEL_QUEUE_WAIT_MS: undefined });
  conversationBus.conversationStarted();
  const res = await settle(inBackground(() => r.chat({ model: 'own', messages: msg(), category: 'planning' })));
  conversationBus.conversationEnded();
  ok('after the yield limit the configured provider gets the call (PERF-02 unchanged)', res.ok && res.v.content === 'alt answered' && res.ms >= 250, res.ok ? `${res.v.content}, ${res.ms} ms` : res.e);
  restore();
}
{
  // f) The owner's own call never waits.
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log), alt: stub('alt', log) });
  const restore = setEnv({ JARVIS_BACKGROUND_YIELD_MS: '5000', JARVIS_MODEL_PLANNING: 'alt:m-alt', JARVIS_MODEL_QUEUE_WAIT_MS: '300' });
  conversationBus.conversationStarted();
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'planning' }));
  conversationBus.conversationEnded();
  ok('a foreground call during a conversation is answered at once by its route', res.ok && res.v.content === 'alt answered' && res.ms < 200, res.ok ? `${res.ms} ms` : res.e);
  restore();
}
{
  // g) The same for code repair's categoryChat (time limit set, named provider the conversation uses).
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log) }, { shared: stub('shared', log) });
  const restore = setEnv({ JARVIS_BACKGROUND_YIELD_MS: '5000', JARVIS_MODEL_CONVERSATION: 'shared:talk', JARVIS_MODEL_CODING: 'shared:code', JARVIS_MODEL_CODING_TIMEOUT_MS: '1000' });
  conversationBus.conversationStarted();
  const call = settle(inBackground(() => r.categoryChat('coding', { messages: msg('fix it') })));
  await tick(1500);
  conversationBus.conversationEnded();
  const res = await call;
  ok('categoryChat: the wait does not use up the coding time limit either', res.ok && res.v.content === 'shared answered', res.ok ? res.v.content : `${res.name}: ${res.e}`);
  restore();
}

// ── M2 / M4. Strict routes ───────────────────────────────────────────────────
console.log('\n--- M2/M4. Strict routes: coding, review, coding_agent, qa_agent ---');
{
  const log: Call[] = [];
  const r = router(['a', 'b'], { a: stub('a', log, 'fail'), b: stub('b', log) });
  const restore = setEnv({ JARVIS_MODEL_REVIEW: 'review-model' });
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'review' }));
  ok('a bare-model review route fails as itself (StrictRouteError)', !res.ok && res.name === 'StrictRouteError', res.ok ? `answered by ${res.v.content}` : `${res.name}: ${res.e}`);
  ok('…the original reason is kept', !res.ok && /a is down \(503\)/.test(res.e), res.ok ? '' : res.e);
  ok('…no other provider is asked', !log.some((c) => c.who === 'b'), who(log));
  ok('…the primary was asked with the configured model', log[0]?.who === 'a' && log[0]?.model === 'review-model', `${log[0]?.who}:${log[0]?.model}`);
  restore();
}
{
  const log: Call[] = [];
  const r = router(['a', 'b'], { a: stub('a', log, 'fail'), b: stub('b', log) });
  const restore = setEnv({ JARVIS_MODEL_CODING: 'coding-model' });
  const res = await settle(r.categoryChat('coding', { messages: msg('fix') }));
  ok('code repair (categoryChat) with a bare coding model: no failover to another provider', !res.ok && !log.some((c) => c.who === 'b'), res.ok ? `answered by ${res.v.content}` : who(log));
  restore();
  log.length = 0;
  const unconfigured = await settle(r.categoryChat('coding', { messages: msg('fix') }));
  ok('…unconfigured code repair keeps its failover, as before', unconfigured.ok && unconfigured.v.content === 'b answered', unconfigured.ok ? unconfigured.v.content : unconfigured.e);
}
{
  for (const role of ['qa_agent', 'coding_agent']) {
    const log: Call[] = [];
    const r = router(['coding-default'], { 'coding-default': stub('coding-default', log) }, { [`${role}-stub`]: stub(`${role}-stub`, log, 'fail') });
    const restore = setEnv({ [`JARVIS_MODEL_AGENT_${role.toUpperCase()}`]: `${role}-stub:m` });
    const res = await settle(r.chat({ messages: msg(), category: 'planning', agentRole: role } as any));
    ok(`a failing configured ${role} route fails as itself`, !res.ok && res.name === 'StrictRouteError' && /is down/.test(res.e), res.ok ? `answered by ${res.v.content}` : `${res.name}: ${res.e}`);
    ok(`…and is never answered by the default (coding) model`, !log.some((c) => c.who === 'coding-default'), who(log));
    restore();
  }
}
{
  // An agent with no setting of its own follows the planning route, which stays non-strict.
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log) }, { broken: stub('broken', log, 'fail') });
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'broken:m' });
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'planning', agentRole: 'research_agent' } as any));
  ok('planning (no agent setting) still falls back to the default model', res.ok && res.v.content === 'a answered', res.ok ? res.v.content : res.e);
  restore();
}
{
  // goalVerifier through the real modelJudge and the shared router.
  const log: Call[] = [];
  modelRouter.registerProvider((modelRouter as any).primary, stub('primary', log, 'fail') as never);
  modelRouter.registerProvider('openai', { ...stub('openai', log), async chat(req: any) { log.push({ who: 'openai', model: req.model, kind: 'chat' }); return { content: '{"met": true, "reason": "looks fine"}' }; } } as never);
  const restore = setEnv({ JARVIS_MODEL_REVIEW: 'review-model' });
  const verdict = await modelJudge()({ objective: 'o', criterion: 'c', evidence: 'e' });
  ok('goalVerifier with a failing configured review model does not report the criterion met', verdict === undefined, JSON.stringify(verdict));
  ok('…and no other provider was asked', !log.some((c) => c.who === 'openai'), who(log));
  restore();
}

// ── M3. One provider, one attempt ────────────────────────────────────────────
console.log('\n--- M3. A routed call never asks the same provider twice ---');
{
  const log: Call[] = [];
  const r = router(['a', 'b'], { a: stub('a', log, 'fail'), b: stub('b', log, 'fail') });
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'other-model' });
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'planning' }));
  const count = (n: string) => log.filter((c) => c.who === n).length;
  ok('every provider is asked at most once', count('a') === 1 && count('b') === 1, who(log));
  ok('…and the error says every eligible provider failed', !res.ok && /every eligible provider failed/.test(res.e) && /JARVIS_MODEL_PLANNING/.test(res.e), res.ok ? 'answered' : res.e);
  restore();
}
{
  // The same provider under two names (an alias) counts once.
  const log: Call[] = [];
  const a = stub('a', log, 'fail');
  const r = router(['a', 'alias', 'b'], { a, alias: a, b: stub('b', log) });
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'other-model' });
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'planning' }));
  ok('a provider registered under two names is asked once', log.filter((c) => c.who === 'a').length === 1 && res.ok && res.v.content === 'b answered', `${who(log)} → ${res.ok ? res.v.content : res.e}`);
  restore();
}
{
  // A named route that fails, then the default chain: each once.
  const log: Call[] = [];
  const r = router(['a', 'b'], { a: stub('a', log, 'fail'), b: stub('b', log) }, { named: stub('named', log, 'fail') });
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'named:m' });
  const res = await settle(r.chat({ model: 'own', messages: msg(), category: 'planning' }));
  ok('named route then default chain: each provider once, order kept', who(log) === 'named:chat,a:chat,b:chat' && res.ok, who(log));
  restore();
}
{
  // Streams: a bare-model conversation route whose stream fails.
  const log: Call[] = [];
  const r = router(['a', 'b'], { a: stub('a', log, 'fail', { stream: true }), b: stub('b', log, 'ok', { stream: true }) });
  const restore = setEnv({ JARVIS_MODEL_CONVERSATION: 'other-model' });
  const text = await streamAll(r, { model: 'own', messages: msg(), category: 'conversation' }).catch((e) => `ERR ${e.message}`);
  ok('a routed stream that fails does not ask the same provider again (stream or chat)', log.filter((c) => c.who === 'a').length === 1, who(log));
  ok('…and the next provider answers', /^b /.test(text), text);
  restore();
}
{
  // Unchanged default path: a stream that fails before any text is answered by chat() on the same provider (llmClientBehaviourTest).
  const log: Call[] = [];
  let streams = 0;
  const once = stub('a', log, () => (log.at(-1)?.kind === 'stream' && ++streams === 1 ? 'fail' : 'ok'), { stream: true });
  const r = router(['a'], { a: once });
  const text = await streamAll(r, { model: 'own', messages: msg() });
  ok('the unrouted stream retry through chat() is unchanged', text === 'a answered' && who(log) === 'a:stream,a:chat', `${text} / ${who(log)}`);
}

// ── Abort during a pending routed call ──────────────────────────────────────
console.log('\n--- Abort during a pending routed call ---');
{
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log), alt: stub('alt', log, 'hang') });
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'alt:m' });
  const ac = new AbortController();
  const call = settle(r.chat({ model: 'own', messages: msg(), category: 'planning', signal: ac.signal }));
  await tick(50);
  ok('the routed call is pending at its provider', log.length === 1 && log[0]?.who === 'alt', who(log));
  ac.abort();
  const res = await call;
  ok('cancelling it ends the call as an AbortError', !res.ok && res.name === 'AbortError', res.ok ? `answered by ${res.v.content}` : `${res.name}: ${res.e}`);
  ok('…and no fallback model answers it', !log.some((c) => c.who === 'a'), who(log));
  restore();
}

// ── Capability refusals on the stream paths ─────────────────────────────────
console.log('\n--- Capability refusals on the stream paths ---');
const imageRequest = (extra: Record<string, unknown> = {}) => ({
  messages: [{ role: 'user' as const, content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }], ...extra,
});
{
  const log: Call[] = [];
  const r = router(['textOnly', 'seeing'], { textOnly: stub('textOnly', log, 'ok', { stream: true, caps: { imageInput: false } }), seeing: stub('seeing', log, 'ok', { caps: { imageInput: true } }) });
  const text = await streamAll(r, imageRequest()).catch((e) => `ERR ${e.message}`);
  ok('default stream: a provider without image input is not asked to stream an image', !log.some((c) => c.who === 'textOnly'), who(log));
  ok('…the image request is answered by a provider that takes images', text === 'seeing answered', text);
}
{
  const log: Call[] = [];
  const r = router(['a'], { a: stub('a', log, 'ok', { stream: true }) }, { blind: stub('blind', log, 'ok', { stream: true, caps: { imageInput: false } }) });
  const restore = setEnv({ JARVIS_MODEL_CONVERSATION: 'blind:m' });
  const text = await streamAll(r, imageRequest({ category: 'conversation' })).catch((e) => `ERR ${e.message}`);
  ok('routed stream: the configured provider without image input is not asked', !log.some((c) => c.who === 'blind'), who(log));
  ok('…the non-strict conversation route falls back to a provider that may take it', text === 'a streamed', text);
  restore();
}

// ── M4. Independence: the models really used ─────────────────────────────────
console.log('\n--- M4. Independence compares the models really used ---');
{
  const agentIndependence = categories['agentIndependence'];
  const observed = categories['observedAgentIndependence'];
  const sameAsDefault = `${llmConfig.primary}:${llmConfig.model}`;
  ok('agentIndependence: QA set to the default provider and model that coding uses is not independent',
    typeof agentIndependence === 'function' && agentIndependence({ JARVIS_MODEL_AGENT_QA_AGENT: sameAsDefault }).independent === false,
    typeof agentIndependence === 'function' ? JSON.stringify({ qa: sameAsDefault, ...agentIndependence({ JARVIS_MODEL_AGENT_QA_AGENT: sameAsDefault }) }.independent) : 'missing');
  ok('…a different provider is independent',
    typeof agentIndependence === 'function' && agentIndependence({ JARVIS_MODEL_AGENT_QA_AGENT: 'anthropic:claude-sonnet-5-5' }).independent === true);
  ok('observedAgentIndependence() exists', typeof observed === 'function');
  if (typeof observed === 'function') {
    const rec = (agentRole: string, provider: string, model: string, okFlag = true) => ({ at: new Date().toISOString(), category: 'planning', provider, model, latencyMs: 1, ok: okFlag, fallbackUsed: false, streamed: false, promptTokens: null, completionTokens: null, agentRole });
    ok('the same model really used by both: not independent', observed([rec('coding_agent', 'gemini', 'g1'), rec('qa_agent', 'gemini', 'g1')]).independent === false);
    ok('different models really used: independent', observed([rec('coding_agent', 'gemini', 'g1'), rec('qa_agent', 'anthropic', 'c1')]).independent === true);
    ok('QA has not run successfully: unknown, never "independent"', observed([rec('coding_agent', 'gemini', 'g1'), rec('qa_agent', 'anthropic', 'c1', false)]).independent === null);
    ok('the latest successful calls are compared', observed([rec('coding_agent', 'gemini', 'g1'), rec('qa_agent', 'anthropic', 'c1'), rec('qa_agent', 'gemini', 'g1')]).independent === false);
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* still in use on Windows */ }
process.exit(failed > 0 ? 1 : 0);
