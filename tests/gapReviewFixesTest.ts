/**
 * tests/gapReviewFixesTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Findings of the gap-closure review (INDEPENDENT_REVIEW_GAP_CLOSURE.md):
 *
 *   M-A  an undated Claude alias and its dated id are one model: QA on one
 *        and coding on the other is not independent (identities compared,
 *        not names); two different Claude models whose ids are known stay
 *        independent; an identity that cannot be looked up is not
 *   L3   on a strict coding lineage, a research worker that ran out of its
 *        model-call budget fails the coding task too
 *   L4   usage records keep the model the provider reported (servedModel),
 *        never the requested model copied over
 *   L6   the Gemini/Groq client returns the reported model on a tool-call
 *        reply; a strict stream is not moved to the fast model on a 429
 * Stand-in providers, a fake HTTP server and stand-in tools; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gap-review-fixes-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
for (const name of ['GROQ_API_KEY', 'GROQ_API_URL', 'XAI_API_KEY', 'JARVIS_LLM_PROVIDER', 'JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'JARVIS_FALLBACK_MODEL', 'ANTHROPIC_API_KEY']) process.env[name] = '';
process.env['GEMINI_API_KEY'] = 'AQ.fake-key-for-tests-0123456789abcdef';
process.env['GEMINI_API_URL'] = 'https://generativelanguage.googleapis.com/v1beta';
process.env['JARVIS_BRAIN_MODEL'] = 'gemini-3.5-flash';
process.env['JARVIS_FAST_MODEL'] = 'gemini-3.5-flash-lite';
delete process.env['JARVIS_AGENT_MODEL'];
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const { GroqProvider } = await import('../bridge/groqProvider.js');
const { ModelRouter, modelRouter } = await import('../bridge/modelRouter.js');
const { usageLog } = await import('../bridge/modelCategories.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { registerAgentRoles } = await import('../core/agents/specialists.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
function setEnv(vars: Record<string, string | undefined>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

// A stand-in Claude: its model list maps an alias to a dated id; it reports the dated id it answered with.
const CANONICAL: Record<string, string> = { 'claude-opus-5-5': 'claude-opus-5-5-20261101', 'claude-opus-5-5-20261101': 'claude-opus-5-5-20261101', 'claude-sonnet-5-5': 'claude-sonnet-5-5-20261001' };
const claudeCalls: string[] = [];
function standInClaude() {
  const seen = new Map<string, string>();
  return {
    isConfigured: () => true,
    async validateModel(model: string) { if (!CANONICAL[model]) throw new Error(`The model "${model}" is not available to this Anthropic key`); seen.set(model, CANONICAL[model]!); },
    modelIdentities(requested: string) { const c = seen.get(requested); return c && c !== requested ? [requested, c] : [requested]; },
    async chat(req: any) { claudeCalls.push(`${req.agentRole}:${req.model}`); await this.validateModel(req.model); return { content: 'checked', model: CANONICAL[req.model] }; },
  };
}

console.log('\n=== Gap-closure review fixes ===\n');

console.log('--- M-A. Model identities, not names ---');
{
  const r = new ModelRouter('primary');
  r.registerProvider('primary', { isConfigured: () => true, async chat(req: any) { return { content: 'x', model: req.model }; } } as never);
  r.registerNamedProvider('anthropic', standInClaude() as never);
  (r as any).failoverOrder = (name?: string) => (name ? [name] : ['primary']);
  const same = await r.qaIndependence({ JARVIS_MODEL_AGENT_CODING_AGENT: 'anthropic:claude-opus-5-5', JARVIS_MODEL_AGENT_QA_AGENT: 'anthropic:claude-opus-5-5-20261101' });
  ok('an alias and its dated id are one model: not independent', same.independent === false, same.reason);
  const different = await r.qaIndependence({ JARVIS_MODEL_AGENT_CODING_AGENT: 'anthropic:claude-opus-5-5', JARVIS_MODEL_AGENT_QA_AGENT: 'anthropic:claude-sonnet-5-5' });
  ok('two different Claude models whose ids were looked up: independent', different.independent === true, different.reason);
  const unknown = await r.qaIndependence({ JARVIS_MODEL_AGENT_CODING_AGENT: 'anthropic:claude-opus-5-5', JARVIS_MODEL_AGENT_QA_AGENT: 'anthropic:claude-unknown-9' });
  ok('a model whose identity cannot be looked up: not independent', unknown.independent === false, unknown.reason);
}

registerAllTools();
const toolCalls: string[] = [];
const REPO = { fullName: 'acme/cdp-kit', url: 'https://github.com/acme/cdp-kit', description: 'Chrome DevTools Protocol client for TypeScript', stars: 4200, language: 'TypeScript', license: 'MIT', topics: ['cdp'], pushedAt: new Date().toISOString(), archived: false };
const executor = {
  names: () => toolRegistryV2.names(),
  riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
  getMeta: (n: string) => toolRegistryV2.getMeta(n),
  async execute(name: string) {
    toolCalls.push(name);
    if (name === 'github_search') return { success: true, output: JSON.stringify({ success: true, items: [REPO] }), tool: name, durationMs: 1 };
    if (name === 'github_repo') return { success: true, output: JSON.stringify({ success: true, repository: { ...REPO }, readme: 'A CDP client.', files: ['package.json'], license: 'MIT', url: REPO.url }), tool: name, durationMs: 1 };
    return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 };
  },
};
const GOOD = JSON.stringify({ queries: ['cdp typescript'], summary: 'A maintained CDP client.', integration: 'library', risks: [] });
const modelCalls: string[] = [];
modelRouter.registerProvider((modelRouter as any).primary, { isConfigured: () => true, async chat(req: any) { modelCalls.push(`default:${req.agentRole}`); return { content: GOOD, model: req.model }; } } as never);
(modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
modelRouter.registerNamedProvider('anthropic', standInClaude() as never);
modelRouter.registerNamedProvider('codeok', { isConfigured: () => true, async chat(req: any) { modelCalls.push(`codeok:${req.agentRole}`); return { content: GOOD, model: req.model }; } } as never);
function manager(limits: Record<string, string> = {}) {
  const m = new AgentManager(agentEvents, loadAgentLimits(limits));
  m.useToolExecutor(executor as never);
  registerAgentRoles(m);
  return m;
}
async function run(m: any, role: string, description: string) {
  toolCalls.length = 0; modelCalls.length = 0; claudeCalls.length = 0;
  const h = await m.startRootTask({ request: description, specialistRole: role, task: { description } });
  return (await h.result) as any;
}
const errorOf = (r: any) => String(r.specialist?.error?.message ?? '');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'anthropic:claude-opus-5-5', JARVIS_MODEL_AGENT_QA_AGENT: 'anthropic:claude-opus-5-5-20261101' });
  const r = await run(manager(), 'qa_agent', 'Review the change summary');
  ok('QA on the dated id of coding\'s Claude model: FAILED "independent QA unavailable"', r.specialist?.status === 'FAILED' && /independent QA unavailable/i.test(errorOf(r)), `${r.specialist?.status} ${errorOf(r)} ${JSON.stringify(r.specialist?.data?.['independence'])}`);
  ok('…before QA asked any model', !claudeCalls.some((c) => c.startsWith('qa_agent')), claudeCalls.join(','));
  restore();
}

console.log('\n--- L3. A used-up budget on a strict coding lineage fails the coding task ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codeok:code-model' });
  const r = await run(manager({ JARVIS_AGENT_BUDGET_LLM_CALLS: '1' }), 'coding_agent', 'Find TypeScript libraries for Chrome DevTools Protocol');
  ok('the research worker ran out of model calls: the coding task is FAILED', r.specialist?.status === 'FAILED', `${r.specialist?.status} ${errorOf(r)}`);
  ok('…naming the budget', /budget/i.test(errorOf(r)), errorOf(r));
  restore();
}

console.log('\n--- L4. Usage records keep the reported model ---');
{
  const r = new ModelRouter('primary');
  r.registerProvider('primary', { isConfigured: () => true, async chat() { return { content: 'x' }; } } as never);
  r.registerNamedProvider('reports', { isConfigured: () => true, async chat() { return { content: 'x', model: 'served-model-1' }; } } as never);
  r.registerNamedProvider('silent', { isConfigured: () => true, async chat() { return { content: 'x' }; } } as never);
  (r as any).failoverOrder = (name?: string) => (name ? [name] : ['primary']);
  let restore = setEnv({ JARVIS_MODEL_PLANNING: 'reports:asked-model' });
  await r.chat({ messages: [{ role: 'user', content: 'a' }], category: 'planning' } as never);
  const rec = usageLog().at(-1) as any;
  ok('the reported model is recorded as servedModel', rec?.servedModel === 'served-model-1' && rec?.model === 'asked-model', JSON.stringify({ model: rec?.model, served: rec?.servedModel }));
  restore();
  restore = setEnv({ JARVIS_MODEL_PLANNING: 'silent:asked-model' });
  await r.chat({ messages: [{ role: 'user', content: 'b' }], category: 'planning' } as never);
  const rec2 = usageLog().at(-1) as any;
  ok('…and nothing when the provider reports none (the requested model is not copied over)', rec2?.servedModel === undefined, JSON.stringify({ model: rec2?.model, served: rec2?.servedModel }));
  restore();
}

console.log('\n--- L6. Gemini/Groq client: tool-call replies and strict streams ---');
{
  let replies: (() => Response)[] = [];
  const seenModels: string[] = [];
  globalThis.fetch = (async (_i: any, init: any = {}) => {
    seenModels.push(init.body ? JSON.parse(init.body).model : '');
    const next = replies.shift();
    if (!next) throw new Error('fake server: no reply queued');
    return next();
  }) as typeof fetch;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const P = GroqProvider as any;
  P.isCircuitBroken = false; P.consecutive429s = 0;
  const g = new GroqProvider();
  replies = [() => json(200, { model: 'gemini-3.5-flash', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'dev_status', arguments: '{}' } }] } }] })];
  const res = await g.chat({ messages: [{ role: 'user', content: 'tool please' }], model: 'gemini-3.5-flash', tools: [{ type: 'function', function: { name: 'dev_status', parameters: { type: 'object', properties: {} } } }] } as any);
  ok('a tool-call reply carries the model the server reported', res.tool_calls?.length === 1 && (res as any).model === 'gemini-3.5-flash', String((res as any).model));
  P.isCircuitBroken = false; P.consecutive429s = 0;
  seenModels.length = 0;
  replies = [() => json(429, [{ error: { code: 429, message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' } }]), () => new Response('data: [DONE]\n\n', { status: 200 })];
  let streamErr = '';
  try { for await (const _p of g.streamChat({ messages: [{ role: 'user', content: 'stream please' }], model: 'gemini-3.5-flash', exactModel: true } as any)) { /* none */ } } catch (e) { streamErr = (e as Error).message; }
  ok('a strict stream is not moved to the fast model after a 429', !seenModels.includes('gemini-3.5-flash-lite') && /429/.test(streamErr), `${seenModels.join(',')} | ${streamErr.slice(0, 80)}`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
