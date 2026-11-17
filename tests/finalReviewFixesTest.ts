/**
 * tests/finalReviewFixesTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Findings of the final independent review
 * (ai_workflows/runs/2026-11-15_phase1a-model-gateway/INDEPENDENT_REVIEW_FINAL.md):
 *
 *   M2  the independence checks never say "independent" when the same model
 *       may answer both: an unconfigured agent sends agentModel()
 *       (JARVIS_AGENT_MODEL, else the fast model); two models on the
 *       Gemini/Groq client, which can move either to its fast model
 *   L1  a helper inherits a parent's route only as that parent's own helper:
 *       an inheritModelRoute value on any other task (a root task, another
 *       role) is ignored
 * Stand-in providers and tools; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-final-review-fixes-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];
delete process.env['JARVIS_AGENT_MODEL'];
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const categories = await import('../bridge/modelCategories.js') as Record<string, any>;
const { llmConfig } = await import('../config/llmconfig.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
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

console.log('\n=== Final review fixes ===\n');

console.log('--- M2. The independence checks and the model agents really send ---');
{
  const p: string = llmConfig.provider;
  const env = (vars: Record<string, string>) => ({ ...vars });
  const r1 = categories.agentIndependence(env({ JARVIS_AGENT_MODEL: 'model-x', JARVIS_MODEL_AGENT_QA_AGENT: `${p}:model-x` }));
  ok('an unconfigured coding agent is taken at the model agents send (JARVIS_AGENT_MODEL)', r1.codingTarget?.model === 'model-x', JSON.stringify(r1.codingTarget));
  ok('…so QA on that same model is not independent', r1.independent === false, r1.reason);
  const r2 = categories.agentIndependence(env({ JARVIS_MODEL_AGENT_QA_AGENT: `${p}:${llmConfig.fastModel}` }));
  ok('without JARVIS_AGENT_MODEL, agents send the fast model: QA on the fast model is not independent', r2.independent === false && r2.codingTarget?.model === llmConfig.fastModel.toLowerCase(), `${JSON.stringify(r2.codingTarget)} ${r2.reason}`);
  if (p === 'gemini' || p === 'groq') {
    const r3 = categories.agentIndependence(env({ JARVIS_MODEL_AGENT_CODING_AGENT: `${p}:model-a`, JARVIS_MODEL_AGENT_QA_AGENT: `${p}:model-b` }));
    ok('two models on the Gemini/Groq client are not independent (either can move to the fast model)', r3.independent === false, r3.reason);
    const rec = (agentRole: string, model: string) => ({ at: new Date().toISOString(), category: 'planning', provider: p, model, latencyMs: 1, ok: true, fallbackUsed: false, streamed: false, promptTokens: null, completionTokens: null, agentRole });
    const o = categories.observedAgentIndependence([rec('coding_agent', 'model-a'), rec('qa_agent', 'model-b')]);
    ok('…the same for the models really recorded', o.independent === false, o.reason);
  } else {
    ok('(the primary is not the Gemini/Groq client here; that case is not checked)', true);
  }
  const r4 = categories.agentIndependence(env({ JARVIS_MODEL_AGENT_CODING_AGENT: 'anthropic:claude-a', JARVIS_MODEL_AGENT_QA_AGENT: `${p === 'anthropic' ? 'groq' : p}:model-b` }));
  ok('different providers are still independent', r4.independent === true, r4.reason);
}

console.log('\n--- L1. Only a parent\'s own helper inherits its route ---');
registerAllTools();
const executor = {
  names: () => toolRegistryV2.names(),
  riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
  getMeta: (n: string) => toolRegistryV2.getMeta(n),
  async execute(name: string) { return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 }; },
};
const modelCalls: string[] = [];
const provider = (who: string) => ({ isConfigured: () => true, async chat(req: any) { modelCalls.push(`${who}:${req.agentRole}`); return { content: `${req.agentRole} answered by ${who}` }; } });
modelRouter.registerProvider((modelRouter as any).primary, provider('default') as never);
modelRouter.registerProvider('openai', provider('default') as never);
(modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
modelRouter.registerNamedProvider('coder', provider('coder') as never);
modelRouter.registerNamedProvider('checker', provider('checker') as never);
const m = new AgentManager(agentEvents, loadAgentLimits({}));
m.useToolExecutor(executor as never);
registerAgentRoles(m);
async function run(role: string, description: string, input: Record<string, unknown>) {
  modelCalls.length = 0;
  const h = await m.startRootTask({ request: description, specialistRole: role, task: { description, input } });
  return (await h.result) as any;
}
process.env['JARVIS_MODEL_AGENT_CODING_AGENT'] = 'coder:code-model';
process.env['JARVIS_MODEL_AGENT_QA_AGENT'] = 'checker:qa-model';
{
  await run('coding_agent', 'What changed in git recently?', { inheritModelRoute: 'qa_agent' });
  ok('a root coding task given inheritModelRoute=qa_agent stays on the coding model', modelCalls.length > 0 && modelCalls.every((c) => c.startsWith('coder:')), modelCalls.join(','));
}
{
  await run('qa_agent', 'Check the project status', { inheritModelRoute: 'coding_agent' });
  ok('a root QA task given inheritModelRoute=coding_agent stays on QA\'s model', modelCalls.length > 0 && modelCalls.every((c) => c.startsWith('checker:')), modelCalls.join(','));
}
{
  await run('pc_agent', 'Which apps are open?', { inheritModelRoute: 'coding_agent' });
  ok('a root PC task given inheritModelRoute=coding_agent is not moved onto the coding model', modelCalls.length > 0 && !modelCalls.some((c) => c.startsWith('coder:')), modelCalls.join(','));
}
{
  // The legitimate case still works: a coding split hands the route to its helpers.
  await run('coding_agent', 'Explain the router code; then explain the agent manager code', {});
  const helpers = modelCalls.filter((c) => c.endsWith(':code_analysis_worker'));
  ok('the coding agent\'s own helpers still inherit the coding model', helpers.length >= 2 && helpers.every((c) => c.startsWith('coder:')), modelCalls.join(','));
}
delete process.env['JARVIS_MODEL_AGENT_CODING_AGENT'];
delete process.env['JARVIS_MODEL_AGENT_QA_AGENT'];

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
