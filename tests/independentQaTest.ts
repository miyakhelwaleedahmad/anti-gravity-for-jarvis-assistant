/**
 * tests/independentQaTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Gap closure P4 + N2 (GAP_CLOSURE_PLAN.md §5; owner approval 2026-11-16, D1).
 *
 *   JARVIS_QA_REQUIRE_INDEPENDENT: true = independent QA mandatory; false =
 *   non-independent QA allowed but labelled; unset = mandatory when QA has its
 *   own model setting.
 *
 *   P4  required, and no distinct model is available (same model, alias,
 *       case): QA ends FAILED "independent QA unavailable … human review
 *       required" before any model is asked; required, and a reply reports
 *       coding's model or no model: FAILED; distinct and confirmed: COMPLETED
 *       and labelled independent; not required: QA runs, never labelled
 *       independent; QA's role text does not claim independence
 *   N2  the configuration check counts every model an agent can be answered
 *       by, failover included; two different models on one Gemini/Groq client
 *       are independent only when both are exact (strict) routes
 * Stand-in providers and tools; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-independent-qa-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];
delete process.env['JARVIS_AGENT_MODEL'];
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { ModelRouter, modelRouter } = await import('../bridge/modelRouter.js');
const { llmConfig } = await import('../config/llmconfig.js');
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

registerAllTools();
const executor = {
  names: () => toolRegistryV2.names(),
  riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
  getMeta: (n: string) => toolRegistryV2.getMeta(n),
  async execute(name: string) { return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 }; },
};

// The default provider reports the model it answered with: by default the model asked for;
// `defaultServes` makes it report another model (an adapter that swapped), or none.
const modelCalls: string[] = [];
let defaultServes: ((req: any) => string | undefined) = (req) => req.model;
const defaultProvider = { isConfigured: () => true, async chat(req: any) { modelCalls.push(`default:${req.agentRole}`); const served = defaultServes(req); return { content: `${req.agentRole} checked`, ...(served ? { model: served } : {}) }; } };
modelRouter.registerProvider((modelRouter as any).primary, defaultProvider as never);
(modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
const reporting = (who: string) => ({ isConfigured: () => true, async chat(req: any) { modelCalls.push(`${who}:${req.agentRole}`); return { content: `${req.agentRole} answered by ${who}`, model: req.model }; } });
modelRouter.registerNamedProvider('codeok', reporting('codeok') as never);
modelRouter.registerNamedProvider('qastrong', reporting('qastrong') as never);

const m = new AgentManager(agentEvents, loadAgentLimits({}));
m.useToolExecutor(executor as never);
registerAgentRoles(m);
async function qa(description = 'Review the change summary') {
  modelCalls.length = 0;
  const h = await m.startRootTask({ request: description, specialistRole: 'qa_agent', task: { description } });
  return (await h.result) as any;
}
const errorOf = (r: any) => String(r.specialist?.error?.message ?? '');
const ind = (r: any) => r.specialist?.data?.['independence'] as { status?: string; required?: boolean; qaModels?: string[]; reason?: string } | undefined;

console.log('\n=== Independent QA (P4) and what each agent can be answered by (N2) ===\n');

console.log('--- Required, no distinct model available: fail closed before any model call ---');
{
  const restore = setEnv({ JARVIS_QA_REQUIRE_INDEPENDENT: 'true' });
  const r = await qa();
  ok('QA and coding both on the default model: QA is FAILED', r.specialist?.status === 'FAILED', `${r.specialist?.status} ${errorOf(r)}`);
  ok('…"independent QA unavailable … human review required"', /independent QA unavailable/i.test(errorOf(r)) && /human review required/i.test(errorOf(r)), errorOf(r));
  ok('…recorded as a model failure (MODEL_UNAVAILABLE)', r.specialist?.error?.code === 'MODEL_UNAVAILABLE', String(r.specialist?.error?.code));
  ok('…and no model was asked', modelCalls.length === 0, modelCalls.join(','));
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codeok:Model-X', JARVIS_MODEL_AGENT_QA_AGENT: 'qastrong:model-x' });
  const r = await qa();
  ok('QA has its own setting (so required) on the same model name, other case and provider: FAILED', r.specialist?.status === 'FAILED' && /independent QA unavailable/i.test(errorOf(r)), `${r.specialist?.status} ${errorOf(r)}`);
  ok('…and no model was asked', modelCalls.length === 0, modelCalls.join(','));
  restore();
}

console.log('\n--- Required, distinct and confirmed: completed and labelled ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codeok:code-model', JARVIS_MODEL_AGENT_QA_AGENT: 'qastrong:qa-model' });
  const r = await qa();
  ok('QA on a different model: COMPLETED', r.specialist?.status === 'COMPLETED', `${r.specialist?.status} ${errorOf(r)}`);
  ok('…labelled independent, with the model QA really used', ind(r)?.status === 'independent' && ind(r)?.required === true && (ind(r)?.qaModels ?? []).includes('qa-model'), JSON.stringify(ind(r)));
  restore();
}

console.log('\n--- Required, and the reply says otherwise: fail closed ---');
{
  const restore = setEnv({ JARVIS_QA_REQUIRE_INDEPENDENT: 'true', JARVIS_MODEL_AGENT_CODING_AGENT: 'codeok:code-model' });
  defaultServes = () => 'code-model';
  const r = await qa();
  ok('QA\'s reply reports coding\'s model: FAILED', r.specialist?.status === 'FAILED' && /independent QA unavailable/i.test(errorOf(r)) && /code-model/.test(errorOf(r)), `${r.specialist?.status} ${errorOf(r)}`);
  defaultServes = () => undefined;
  const r2 = await qa();
  ok('QA\'s reply reports no model: FAILED (unknown identity is not independence)', r2.specialist?.status === 'FAILED' && /independent QA unavailable/i.test(errorOf(r2)), `${r2.specialist?.status} ${errorOf(r2)}`);
  defaultServes = (req) => req.model;
  restore();
}

console.log('\n--- Not required: QA runs, never labelled independent ---');
{
  const restore = setEnv({ JARVIS_QA_REQUIRE_INDEPENDENT: 'false' });
  const r = await qa();
  ok('explicitly not required: QA COMPLETED on the shared model', r.specialist?.status === 'COMPLETED', `${r.specialist?.status} ${errorOf(r)}`);
  ok('…labelled, never "independent"', !!ind(r) && ind(r)?.status !== 'independent' && ind(r)?.required === false, JSON.stringify(ind(r)));
  restore();
}
{
  const r = await qa();
  ok('unset and QA without its own setting: QA runs as before', r.specialist?.status === 'COMPLETED', `${r.specialist?.status} ${errorOf(r)}`);
  ok('…and is not labelled independent', ind(r)?.status !== 'independent', JSON.stringify(ind(r)));
}
{
  const qaRole = (m as any).registry?.role?.('qa_agent');
  const text = `${qaRole?.description ?? ''}`;
  ok('QA\'s role text does not claim independence', text.length > 0 && !/independent/i.test(text), text);
}

console.log('\n--- N2. Every model an agent can be answered by ---');
{
  const primary = llmConfig.primary;
  const stub = (model?: string) => ({ isConfigured: () => true, ...(model ? { model } : {}), async chat(req: any) { return { content: 'x', model: req.model }; } });
  const r = new ModelRouter(primary);
  r.registerProvider(primary, stub() as never);
  r.registerProvider('openai', stub('gpt-4o-mini') as never);
  (r as any).failoverOrder = (name?: string) => (name ? [name] : [primary, 'openai']);
  const a = await r.qaIndependence({ JARVIS_MODEL_AGENT_QA_AGENT: 'openai:gpt-4o-mini' });
  ok('coding unset can fail over to the OpenAI-compatible model QA uses: not independent', a.independent === false, a.reason);
  ok('…coding\'s possible models include that failover model', (a.codingTargets ?? []).some((t: any) => t.provider === 'openai' && t.model === 'gpt-4o-mini'), JSON.stringify(a.codingTargets));
  if (primary === 'gemini' || primary === 'groq') {
    const b = await r.qaIndependence({ JARVIS_MODEL_AGENT_CODING_AGENT: `${primary}:model-a`, JARVIS_MODEL_AGENT_QA_AGENT: `${primary}:model-b` });
    ok('two different exact (strict) models on one Gemini/Groq client: independent', b.independent === true, b.reason);
    const c = await r.qaIndependence({ JARVIS_AGENT_MODEL: 'model-a', JARVIS_MODEL_AGENT_QA_AGENT: `${primary}:model-b` });
    ok('…but not when coding is not strict (its client may still swap)', c.independent === false, c.reason);
  } else {
    ok('(the primary is not the Gemini/Groq client here; that case is not checked)', true);
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
