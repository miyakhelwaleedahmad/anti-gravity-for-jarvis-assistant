/**
 * tests/modelRoleRoutingTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1A (MM-1A-01, -02, -06): a configured role chooses its model at the
 * real call sites; an unconfigured one changes nothing.
 *
 * Before Phase 1A, chat() and streamChat() recorded `category` but sent every
 * call to the default provider (only categoryChat() applied a route), agents
 * did not pass their role, and a named-provider route skipped the foreground
 * gate.
 *
 *   1. no setting: every category reaches the default provider with its own model
 *   2. a configured route: chat() and streamChat() reach its provider and model
 *   3. fallback: a non-strict route that fails is answered by the default;
 *      a strict one (review) fails as itself
 *   4. an explicit provider, an abort, a bare model name, explicit limits
 *   5. agents: coding_agent and qa_agent each reach their own route through
 *      the real AgentManager; independence is reported
 *   6. the real orchestrator's planning call follows JARVIS_MODEL_PLANNING
 *   7. a background call to a named provider that serves the conversation
 *      waits for it; one that does not, does not
 * Scripted providers; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-role-routing-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_')) delete process.env[k];

const { ModelRouter, modelRouter } = await import('../bridge/modelRouter.js');
const categories = await import('../bridge/modelCategories.js');
const { MODEL_CATEGORIES, usageLog, clearUsage } = categories;
const { conversationBus } = await import('../core/conversationBus.js');
const { runAsAgent } = await import('../core/agents/agentScope.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e: String((e as Error)?.message ?? e), name: (e as Error)?.name }));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Seen { who: string; model?: string; category?: string; agentRole?: string; max_tokens?: number; streamed: boolean }
function stub(who: string, log: Seen[], opts: { fail?: string; stream?: boolean } = {}) {
  const p: Record<string, unknown> = {
    isConfigured: () => true,
    async chat(req: any) {
      if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      log.push({ who, model: req.model, category: req.category, agentRole: req.agentRole, max_tokens: req.max_tokens, streamed: false });
      if (opts.fail) throw new Error(opts.fail);
      // D2 (owner, 2026-11-16): a stand-in reports the model it answers with, as real providers do.
      return { content: `${who} answered`, usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 }, model: req.model };
    },
  };
  if (opts.stream !== false) {
    p['streamChat'] = async function* (req: any) {
      log.push({ who, model: req.model, category: req.category, agentRole: req.agentRole, max_tokens: req.max_tokens, streamed: true });
      if (opts.fail) throw new Error(opts.fail);
      yield `${who} `; yield 'streamed';
    };
  }
  return p;
}
const msg = (t = 'hi') => [{ role: 'user' as const, content: t }];
async function streamAll(r: InstanceType<typeof ModelRouter>, req: any): Promise<string> {
  let text = '';
  for await (const piece of r.streamChat(req)) text += piece;
  return text;
}

function router(log: Seen[], extra: Record<string, Record<string, unknown>> = {}, named: Record<string, Record<string, unknown>> = {}) {
  const r = new ModelRouter('primary');
  r.registerProvider('primary', stub('primary', log) as never);
  (r as any).failoverOrder = (name?: string) => [name ?? 'primary'];   // no real fallback provider in this test
  for (const [n, p] of Object.entries(extra)) r.registerProvider(n, p as never);
  for (const [n, p] of Object.entries(named)) r.registerNamedProvider(n, p as never);
  return r;
}

console.log('\n=== A configured role chooses its model (Phase 1A) ===\n');

// ── 1. No setting: today's behaviour ────────────────────────────────────────
console.log('--- 1. No setting changes nothing ---');
{
  const log: Seen[] = [];
  const r = router(log, { alt: stub('alt', log) });
  for (const c of MODEL_CATEGORIES) await r.chat({ model: 'own-model', messages: msg(), category: c });
  ok('chat(): every category reaches the default provider', log.length === MODEL_CATEGORIES.length && log.every((s) => s.who === 'primary'), log.map((s) => s.who).join(','));
  ok('…with the request\'s own model and no token cap added', log.every((s) => s.model === 'own-model' && s.max_tokens === undefined));
  log.length = 0;
  const text = await streamAll(r, { model: 'own-model', messages: msg(), category: 'conversation' });
  ok('streamChat(): conversation streams from the default provider', text === 'primary streamed' && log[0]?.who === 'primary' && log[0]?.streamed === true, text);
}

// ── 2. A configured route ───────────────────────────────────────────────────
console.log('\n--- 2. A configured route ---');
{
  const log: Seen[] = [];
  const r = router(log, { alt: stub('alt', log) }, { named: stub('named', log) });
  clearUsage();
  process.env['JARVIS_MODEL_PLANNING'] = 'alt:m-plan';
  const res = await r.chat({ model: 'own-model', messages: msg(), category: 'planning' });
  ok('chat(planning) reaches the configured provider', log[0]?.who === 'alt' && res.content === 'alt answered', log.map((s) => s.who).join(','));
  ok('…with the configured model', log[0]?.model === 'm-plan', log[0]?.model);
  const rec = usageLog().at(-1);
  ok('…and the usage record says so', rec?.provider === 'alt' && rec?.model === 'm-plan' && rec?.category === 'planning', JSON.stringify(rec));
  delete process.env['JARVIS_MODEL_PLANNING'];

  log.length = 0;
  process.env['JARVIS_MODEL_CONVERSATION'] = 'named:m-talk';
  const text = await streamAll(r, { model: 'own-model', messages: msg(), category: 'conversation' });
  ok('streamChat(conversation) streams from a named provider', text === 'named streamed' && log[0]?.who === 'named' && log[0]?.model === 'm-talk', `${text} / ${log.map((s) => `${s.who}:${s.model}`).join(',')}`);
  ok('…recorded as streamed by that provider', usageLog().at(-1)?.provider === 'named' && usageLog().at(-1)?.streamed === true, JSON.stringify(usageLog().at(-1)));
  delete process.env['JARVIS_MODEL_CONVERSATION'];
}

// ── 3. Fallback rules ───────────────────────────────────────────────────────
console.log('\n--- 3. When the configured provider fails ---');
{
  const log: Seen[] = [];
  const r = router(log, {}, { broken: stub('broken', log, { fail: 'broken 503' }) });
  process.env['JARVIS_MODEL_CONVERSATION'] = 'broken:m';
  const res = await settle(r.chat({ model: 'own-model', messages: msg(), category: 'conversation' }));
  ok('a non-strict route that fails is answered by the default provider', res.ok && log.map((s) => s.who).join(',') === 'broken,primary', `${res.ok ? '' : res.e} / ${log.map((s) => s.who).join(',')}`);
  ok('…with the request\'s own model', log[1]?.model === 'own-model', log[1]?.model);
  ok('…recorded as a fallback', usageLog().at(-1)?.provider === 'primary' && usageLog().at(-1)?.fallbackUsed === true, JSON.stringify(usageLog().at(-1)));
  log.length = 0;
  const text = await streamAll(r, { model: 'own-model', messages: msg(), category: 'conversation' }).catch((e) => `ERR ${e.message}`);
  ok('…the same for a stream that fails before any text', text === 'primary streamed', text);
  delete process.env['JARVIS_MODEL_CONVERSATION'];

  log.length = 0;
  process.env['JARVIS_MODEL_REVIEW'] = 'broken:m';
  const strict = await settle(r.chat({ model: 'own-model', messages: msg(), category: 'review' }));
  ok('a strict route (review) fails as itself', !strict.ok && /broken 503/.test(strict.ok ? '' : strict.e), strict.ok ? 'answered' : strict.e);
  ok('…the default provider is never asked', !log.some((s) => s.who === 'primary'), log.map((s) => s.who).join(','));
  delete process.env['JARVIS_MODEL_REVIEW'];
}

// ── 4. Explicit provider, abort, bare model, explicit limits ────────────────
console.log('\n--- 4. Explicit provider, abort, bare model, limits ---');
{
  const log: Seen[] = [];
  const r = router(log, { alt: stub('alt', log), other: stub('other', log) });
  process.env['JARVIS_MODEL_PLANNING'] = 'alt:m-plan';
  await r.chat({ model: 'own-model', messages: msg(), category: 'planning' }, 'other');
  ok('an explicitly named provider is honoured exactly (no route)', log[0]?.who === 'other' && log[0]?.model === 'own-model', `${log[0]?.who}:${log[0]?.model}`);

  log.length = 0;
  const ac = new AbortController();
  ac.abort();
  const aborted = await settle(r.chat({ model: 'own-model', messages: msg(), category: 'planning', signal: ac.signal }));
  ok('an already-cancelled routed call rejects', !aborted.ok);
  ok('…and is not answered by the default provider', !log.some((s) => s.who === 'primary'), log.map((s) => s.who).join(','));

  // Cancelled while the routed call is pending at its provider (review gap 1).
  log.length = 0;
  const hanging = {
    isConfigured: () => true,
    async chat(req: any) {
      log.push({ who: 'hanging', model: req.model, category: req.category, streamed: false });
      return new Promise((_res, rej) => req.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    },
  };
  r.registerNamedProvider('hanging', hanging as never);
  process.env['JARVIS_MODEL_PLANNING'] = 'hanging:m-hang';
  const pendingAc = new AbortController();
  const pending = settle(r.chat({ model: 'own-model', messages: msg(), category: 'planning', signal: pendingAc.signal }));
  await tick(50);
  ok('the routed call is pending at its provider', log.length === 1 && log[0]?.who === 'hanging', log.map((s) => s.who).join(','));
  pendingAc.abort();
  const cancelled = await pending;
  ok('cancelling it during the call ends it as an AbortError', !cancelled.ok && (cancelled as any).name === 'AbortError', cancelled.ok ? 'answered' : `${(cancelled as any).name}: ${(cancelled as any).e}`);
  ok('…and no fallback model answers it', !log.some((s) => s.who === 'primary'), log.map((s) => s.who).join(','));
  delete process.env['JARVIS_MODEL_PLANNING'];

  log.length = 0;
  process.env['JARVIS_MODEL_PLANNING'] = 'other-model';
  await r.chat({ model: 'own-model', messages: msg(), category: 'planning' });
  ok('a bare model name keeps the default provider and sends that model', log[0]?.who === 'primary' && log[0]?.model === 'other-model', `${log[0]?.who}:${log[0]?.model}`);
  ok('…with no token cap unless one is set', log[0]?.max_tokens === undefined, String(log[0]?.max_tokens));
  log.length = 0;
  process.env['JARVIS_MODEL_PLANNING_MAX_TOKENS'] = '777';
  await r.chat({ model: 'own-model', messages: msg(), category: 'planning' });
  ok('an explicit token cap is applied', log[0]?.max_tokens === 777, String(log[0]?.max_tokens));
  log.length = 0;
  await r.chat({ model: 'own-model', messages: msg(), category: 'planning', max_tokens: 50 });
  ok('…but never over the caller\'s own', log[0]?.max_tokens === 50, String(log[0]?.max_tokens));
  delete process.env['JARVIS_MODEL_PLANNING'];
  delete process.env['JARVIS_MODEL_PLANNING_MAX_TOKENS'];
}

// ── 5. Agents through the real AgentManager ─────────────────────────────────
console.log('\n--- 5. coding_agent and qa_agent each have their own route ---');
{
  const { AgentManager } = await import('../core/agents/agentManager.js');
  const { agentEvents } = await import('../core/agents/events.js');
  const { loadAgentLimits } = await import('../core/agents/config.js');
  const log: Seen[] = [];
  modelRouter.registerProvider((modelRouter as any).primary, stub('default', log) as never);
  modelRouter.registerNamedProvider('codingstub', stub('codingstub', log) as never);
  modelRouter.registerNamedProvider('qastub', stub('qastub', log) as never);
  process.env['JARVIS_MODEL_AGENT_CODING_AGENT'] = 'codingstub:c-model';
  process.env['JARVIS_MODEL_AGENT_QA_AGENT'] = 'qastub:q-model';
  clearUsage();

  const m = new AgentManager(agentEvents, loadAgentLimits({}));
  for (const role of ['coding_agent', 'qa_agent']) {
    m.defineRole({
      role, name: role, description: `scripted ${role}`, capabilities: ['test'], supportedTaskTypes: [], tools: [], maxRisk: 0, allowedChildRoles: [], permanent: true, version: '1.0.0',
      behavior: { async run(ctx: any) { const r = await ctx.llm({ messages: msg(`${role} asks`) }); return { summary: r.content, confidence: 1 }; } },
    } as never);
  }
  const done = async (role: string) => {
    const h = await m.startRootTask({ request: `${role} task`, specialistRole: role, task: { description: `${role} task`, input: {} } } as never);
    for (let i = 0; i < 200; i++) {
      const t = m.tasks.get(h.taskId);
      if (t && ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(String(t.status))) break;
      await tick(20);
    }
  };
  await done('coding_agent');
  await done('qa_agent');
  ok('coding_agent\'s call reaches its own route', log.some((s) => s.who === 'codingstub' && s.model === 'c-model'), log.map((s) => `${s.who}:${s.model}:${s.agentRole}`).join(','));
  ok('qa_agent\'s call reaches its own route', log.some((s) => s.who === 'qastub' && s.model === 'q-model'), log.map((s) => `${s.who}:${s.model}:${s.agentRole}`).join(','));
  ok('neither reaches the default provider', !log.some((s) => s.who === 'default'), log.map((s) => s.who).join(','));
  ok('the usage records carry the agent\'s role', usageLog().some((u: any) => u.agentRole === 'coding_agent') && usageLog().some((u: any) => u.agentRole === 'qa_agent'), JSON.stringify(usageLog().map((u: any) => u.agentRole)));

  const independence = (categories as any).agentIndependence as undefined | ((env?: Record<string, string | undefined>) => { independent: boolean });
  ok('agentIndependence() exists', typeof independence === 'function');
  if (typeof independence === 'function') {
    ok('different coding and QA models: independent', independence({ JARVIS_MODEL_AGENT_CODING_AGENT: 'a:x', JARVIS_MODEL_AGENT_QA_AGENT: 'b:y' }).independent === true);
    ok('the same model for both: not independent', independence({ JARVIS_MODEL_AGENT_CODING_AGENT: 'a:x', JARVIS_MODEL_AGENT_QA_AGENT: 'a:x' }).independent === false);
    ok('neither configured: not independent (both on the planning model)', independence({}).independent === false);
  }
  delete process.env['JARVIS_MODEL_AGENT_CODING_AGENT'];
  delete process.env['JARVIS_MODEL_AGENT_QA_AGENT'];
}

// ── 6. The real orchestrator's planning call ────────────────────────────────
console.log('\n--- 6. The orchestrator\'s planning call follows JARVIS_MODEL_PLANNING ---');
{
  const { orchestrator } = await import('../core/orchestrator.js');
  const { goalManager } = await import('../core/goalManager.js');
  await goalManager.init();
  const log: Seen[] = [];
  const answer = (who: string) => ({
    isConfigured: () => true,
    async chat(req: any) { log.push({ who, model: req.model, category: req.category, streamed: false }); return { content: 'The printing press spread printed books across Europe, sir.' }; },
    async *streamChat(req: any) { log.push({ who, model: req.model, category: req.category, streamed: true }); yield 'Fine, sir.'; },
  });
  modelRouter.registerProvider((modelRouter as any).primary, answer('default') as never);
  modelRouter.registerProvider('openai', answer('default') as never);
  modelRouter.registerNamedProvider('planstub', answer('planstub') as never);
  process.env['JARVIS_MODEL_PLANNING'] = 'planstub:p-model';
  const run = orchestrator.process('figure out why my printing press project keeps failing and plan the next three steps', 'cli');
  await Promise.race([run, tick(20_000)]);
  const planning = log.filter((s) => s.category === 'planning');
  ok('the orchestrator made a planning call', planning.length > 0, log.map((s) => `${s.who}:${s.category}`).join(','));
  ok('…and it reached the configured planning provider and model', planning.length > 0 && planning.every((s) => s.who === 'planstub' && s.model === 'p-model'), planning.map((s) => `${s.who}:${s.model}`).join(','));
  delete process.env['JARVIS_MODEL_PLANNING'];
  try { await (goalManager as any).flush?.(); } catch { /* best effort */ }
}

// ── 7. Background calls to a named provider ─────────────────────────────────
console.log('\n--- 7. A background call waits only for a provider the conversation uses ---');
{
  const prevYield = process.env['JARVIS_BACKGROUND_YIELD_MS'];
  process.env['JARVIS_BACKGROUND_YIELD_MS'] = '5000';
  const agent = { rootTaskId: 'r1', taskId: 't1', agentId: 'qa-1', agentPath: 'JARVIS › QA', request: 'check', source: 'cli' as const };

  // a) The named provider also serves the conversation: it waits.
  const log: Seen[] = [];
  const r = router(log, {}, { shared: stub('shared', log) });
  process.env['JARVIS_MODEL_CONVERSATION'] = 'shared:talk';
  process.env['JARVIS_MODEL_REVIEW'] = 'shared:check';
  conversationBus.conversationStarted();
  const bg = settle(runAsAgent(agent, () => r.categoryChat('review', { messages: msg('background review') })));
  await tick(80);
  ok('a background call to the provider the conversation uses has not been sent yet', !log.some((s) => s.who === 'shared'), log.map((s) => s.who).join(','));
  conversationBus.conversationEnded();
  const bgDone = await bg;
  ok('…and is sent once the conversation ends', bgDone.ok && log.some((s) => s.who === 'shared'), bgDone.ok ? '' : bgDone.e);

  // b) A different provider from the conversation's: no wait.
  log.length = 0;
  delete process.env['JARVIS_MODEL_CONVERSATION'];
  conversationBus.conversationStarted();
  const t0 = Date.now();
  const bg2 = await settle(runAsAgent(agent, () => r.categoryChat('review', { messages: msg('background review 2') })));
  const waited = Date.now() - t0;
  conversationBus.conversationEnded();
  ok('a background call to a provider the conversation does not use is not held', bg2.ok && waited < 1000, `${waited} ms`);

  // c) A foreground call never waits.
  log.length = 0;
  process.env['JARVIS_MODEL_CONVERSATION'] = 'shared:talk';
  conversationBus.conversationStarted();
  const t1 = Date.now();
  const fg = await settle(r.categoryChat('review', { messages: msg('foreground review') }));
  conversationBus.conversationEnded();
  ok('a foreground call is never held', fg.ok && Date.now() - t1 < 1000, `${Date.now() - t1} ms`);
  delete process.env['JARVIS_MODEL_CONVERSATION'];
  delete process.env['JARVIS_MODEL_REVIEW'];
  if (prevYield === undefined) delete process.env['JARVIS_BACKGROUND_YIELD_MS']; else process.env['JARVIS_BACKGROUND_YIELD_MS'] = prevYield;
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.chdir(os.tmpdir());
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* still in use on Windows */ }
process.exit(failed > 0 ? 1 : 0);
