/**
 * tests/reviewRound3FixesTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Findings of the independent review of round 3
 * (ai_workflows/runs/2026-11-15_phase1a-model-gateway/INDEPENDENT_REVIEW_ROUND3.md),
 * within the owner's round-3 approval:
 *
 *   M1  QA whose model answers with empty text is FAILED, never answered by
 *       keyword rules
 *   N1  the same for a configured (strict) coding agent (follow-up review)
 *   L1  a configured (strict) coding agent whose model-call budget is used up
 *       is FAILED, not answered by keyword rules; an unconfigured one keeps
 *       its keyword fallback (unchanged)
 *   M3  after a route's own time limit fires, that provider is not asked
 *       again in the same call
 *   L4  a stream its consumer stops early frees the trial lease at once
 *   L5  a fallback that cannot be sent (queue wait) keeps the route's own
 *       failure as its cause
 *   L6  "(provider default)" in the usage records is never counted as a
 *       model that makes QA independent
 * Stand-in providers and a stand-in tool executor; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-round3-fixes-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { ModelRouter, modelRouter } = await import('../bridge/modelRouter.js');
const categories = await import('../bridge/modelCategories.js') as Record<string, any>;
const { llmConfig } = await import('../config/llmconfig.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { registerAgentRoles } = await import('../core/agents/specialists.js');
const { conversationBus } = await import('../core/conversationBus.js');
const { runAsAgent } = await import('../core/agents/agentScope.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
type Settled<T> = { ok: true; v: T } | { ok: false; e: string; name: string; err: unknown };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e: String((e as Error)?.message ?? e), name: String((e as Error)?.name ?? ''), err: e }));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = () => [{ role: 'user' as const, content: 'hi' }];
const bgAgent = { rootTaskId: 'r1', taskId: 't1', agentId: 'bg-1', agentPath: 'JARVIS › Background', request: 'background', source: 'cli' as const };
function setEnv(vars: Record<string, string | undefined>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}
function router(order: string[], providers: Record<string, unknown>, named: Record<string, unknown> = {}) {
  const r = new ModelRouter(order[0]!);
  for (const [n, p] of Object.entries(providers)) r.registerProvider(n, p as never);
  for (const [n, p] of Object.entries(named)) r.registerNamedProvider(n, p as never);
  (r as any).failoverOrder = (name?: string) => (name ? [name] : order);
  return r;
}
const hangUntilAbort = (req: any) => new Promise<never>((_res, rej) => req.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));

console.log('\n=== Fixes for the independent review of round 3 ===\n');

// ── Agents: real specialists, real tool loop, real router singleton ─────────
registerAllTools();
const toolCalls: string[] = [];
const executor = {
  names: () => toolRegistryV2.names(),
  riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
  getMeta: (n: string) => toolRegistryV2.getMeta(n),
  async execute(name: string) { toolCalls.push(name); return { success: true, output: `${name}: stand-in output`, tool: name, durationMs: 1 }; },
};
const modelCalls: string[] = [];
const mode: Record<string, 'ok' | 'blank'> = {};
const defaultProvider = {
  isConfigured: () => true,
  async chat(req: any) {
    modelCalls.push(`default:${req.agentRole}`);
    if (mode[req.agentRole ?? ''] === 'blank') return { content: '   ' };
    return { content: `${req.agentRole} model answer` };
  },
};
modelRouter.registerProvider((modelRouter as any).primary, defaultProvider as never);
modelRouter.registerProvider('openai', defaultProvider as never);
(modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
modelRouter.registerNamedProvider('codingblank', { isConfigured: () => true, async chat(req: any) { modelCalls.push(`codingblank:${req.agentRole}`); return { content: '', model: req.model }; } } as never); // D2: reports its model
modelRouter.registerNamedProvider('codingok', { isConfigured: () => true, async chat(req: any) { modelCalls.push(`codingok:${req.agentRole}`); return { content: 'coding model answer', model: req.model }; } } as never); // D2: reports its model

function manager(limits: Record<string, string> = {}) {
  const m = new AgentManager(agentEvents, loadAgentLimits(limits));
  m.useToolExecutor(executor as never);
  registerAgentRoles(m);
  return m;
}
async function run(m: any, role: string, description: string) {
  toolCalls.length = 0;
  modelCalls.length = 0;
  const h = await m.startRootTask({ request: description, specialistRole: role, task: { description } });
  return (await h.result) as any;
}
const errorOf = (r: any) => String(r.specialist?.error?.message ?? '');

console.log('--- M1. QA whose model answers with empty text ---');
{
  mode['qa_agent'] = 'blank';
  const r = await run(manager(), 'qa_agent', 'Run the type check of the project and report what fails');
  ok('the QA task is FAILED, not COMPLETED by keyword rules', r.specialist?.status === 'FAILED', `${r.specialist?.status} ${errorOf(r)}`);
  ok('…no keyword-rule tool ran', toolCalls.length === 0, toolCalls.join(','));
  ok('…and the result says the model gave no answer', /empty answer|no answer/i.test(errorOf(r)), errorOf(r));
  delete mode['qa_agent'];
}
{
  // Not QA: an empty model answer still falls back to keyword rules (unchanged).
  mode['coding_agent'] = 'blank';
  const r = await run(manager(), 'coding_agent', 'What changed in git recently?');
  ok('an unconfigured coding agent with an empty model answer still uses keyword rules (unchanged)', r.specialist?.status === 'COMPLETED' && toolCalls.includes('git_overview') && r.specialist?.data?.['answeredBy'] === 'keyword_rules', `${r.specialist?.status} ${toolCalls.join(',')}`);
  delete mode['coding_agent'];
}

console.log('\n--- N1. A configured coding agent whose model answers with empty text ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codingblank:code-model' });
  const r = await run(manager(), 'coding_agent', 'What changed in git recently?');
  ok('the configured coding task is FAILED, not COMPLETED by keyword rules', r.specialist?.status === 'FAILED', `${r.specialist?.status} ${errorOf(r)}`);
  ok('…no keyword-rule tool ran', toolCalls.length === 0, toolCalls.join(','));
  ok('…and the result says the model gave an empty answer', /empty answer/i.test(errorOf(r)), errorOf(r));
  restore();
}

console.log('\n--- L1. A configured coding agent whose model-call budget is used up ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codingok:code-model' });
  const r = await run(manager({ JARVIS_AGENT_BUDGET_LLM_CALLS: '0' }), 'coding_agent', 'What changed in git recently?');
  ok('the configured coding task is FAILED', r.specialist?.status === 'FAILED', `${r.specialist?.status} ${errorOf(r)}`);
  ok('…with the budget reason', /budget/i.test(errorOf(r)), errorOf(r));
  ok('…and no keyword-rule tool ran', toolCalls.length === 0, toolCalls.join(','));
  restore();
}
{
  const r = await run(manager({ JARVIS_AGENT_BUDGET_LLM_CALLS: '0' }), 'coding_agent', 'What changed in git recently?');
  ok('an unconfigured coding agent out of budget keeps its keyword fallback (unchanged)', r.specialist?.status === 'COMPLETED' && toolCalls.includes('git_overview'), `${r.specialist?.status} ${toolCalls.join(',')}`);
}

console.log('\n--- M3. A route\'s own time limit is provider-wide ---');
{
  const log: string[] = [];
  const slowA = { isConfigured: () => true, async chat(req: any) { log.push(`a:${req.model}`); if (req.model === 'slow-model') return hangUntilAbort(req); return { content: `a:${req.model} answered` }; } };
  const b = { isConfigured: () => true, async chat(req: any) { log.push(`b:${req.model}`); return { content: `b:${req.model} answered` }; } };
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'slow-model', JARVIS_MODEL_PLANNING_TIMEOUT_MS: '1000' });
  const res = await settle(router(['a', 'b'], { a: slowA, b }).chat({ model: 'own', messages: msg(), category: 'planning' }));
  ok('after the time limit, the same provider is not asked again with another model', !log.includes('a:own'), log.join(','));
  ok('…the next provider in the order answers', res.ok && res.v.content === 'b:own answered', res.ok ? res.v.content : res.e);
  log.length = 0;
  const only = await settle(router(['a'], { a: slowA }).chat({ model: 'own', messages: msg(), category: 'planning' }));
  ok('with no other provider: a clear error, not a second request to the slow provider', !only.ok && !log.includes('a:own'), `${log.join(',')} → ${only.ok ? only.v.content : only.e}`);
  restore();
}

console.log('\n--- L4. A stream stopped early by its consumer frees the trial lease ---');
{
  const restore = setEnv({ JARVIS_PROVIDER_CAN_BREAKER_MS: '400' });
  let limit = true;
  let sent = 0;
  const can = {
    isConfigured: () => true,
    async chat() { sent++; if (limit) throw new Error('API error 429: rate limit reached'); return { content: 'can answered' }; },
    async *streamChat() { sent++; yield 'first '; yield 'second'; },
  };
  const b = { isConfigured: () => true, async chat() { return { content: 'b answered' }; } };
  const r = router(['can', 'b'], { can, b });
  await settle(r.chat({ messages: msg() }));
  await settle(r.chat({ messages: msg() }));   // two rate limits: the breaker opens for 400 ms
  await tick(450);
  limit = false;
  const before = sent;
  for await (const piece of r.streamChat({ messages: msg() })) { void piece; break; }   // the trial: stopped after the first piece
  ok('the trial stream reached the provider', sent === before + 1, `${sent - before}`);
  const next = await settle(r.chat({ messages: msg() }));
  ok('the next call is sent to the provider at once, not refused until the lease expires', sent === before + 2 && next.ok && next.v.content === 'can answered', `${sent - before} → ${next.ok ? next.v.content : next.e}`);
  restore();
}

console.log('\n--- L5. A fallback not sent keeps the route\'s failure ---');
{
  const elsewhere = { isConfigured: () => true, async chat() { throw Object.assign(new Error('elsewhere is down (500)'), { status: 500 }); } };
  const a = { isConfigured: () => true, async chat() { return { content: 'a answered' }; } };
  const restore = setEnv({ JARVIS_MODEL_PLANNING: 'elsewhere:m', JARVIS_MODEL_QUEUE_WAIT_MS: '100', JARVIS_BACKGROUND_YIELD_MS: '5000' });
  conversationBus.conversationStarted();
  const res = await settle(runAsAgent(bgAgent, () => router(['a'], { a }, { elsewhere }).chat({ model: 'own', messages: msg(), category: 'planning' })));
  conversationBus.conversationEnded();
  const cause = !res.ok ? String(((res.err as { cause?: Error })?.cause)?.message ?? '') : '';
  ok('the fallback ends with the queue-wait error', !res.ok && res.name === 'QueueWaitTimeoutError', res.ok ? res.v.content : `${res.name}: ${res.e}`);
  ok('…and keeps the route\'s own failure as its cause', /elsewhere is down/.test(cause), cause || '(no cause)');
  restore();
}

console.log('\n--- L6. "(provider default)" is not a model name ---');
{
  const p = llmConfig.primary;
  const rec = (agentRole: string, provider: string, model: string) => ({ at: new Date().toISOString(), category: 'planning', provider, model, latencyMs: 1, ok: true, fallbackUsed: false, streamed: false, promptTokens: null, completionTokens: null, agentRole });
  const res = categories.observedAgentIndependence([rec('coding_agent', p, '(provider default)'), rec('qa_agent', p, llmConfig.model)]);
  ok('an unknown model on either side is never reported as independent', res.independent !== true, JSON.stringify(res));
  ok('…it is reported as unknown (null)', res.independent === null, String(res.independent));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
