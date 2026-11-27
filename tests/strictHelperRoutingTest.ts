/**
 * tests/strictHelperRoutingTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner's decision 2026-11-15 (FINAL_HANDOVER_ROUND3.md §5, MM-1A-P8): when
 * coding_agent or qa_agent has its own (strict) model setting, the helpers it
 * splits a request into use that same model and that same strict routing.
 *
 *   1. configured coding agent, split request: every helper asks the
 *      configured coding model; the planning/default model is never asked
 *   2. that model fails: helpers end FAILED (no keyword rules); the parent
 *      ends FAILED and names them
 *   3. that model answers with empty text: the parent ends FAILED
 *   4. unconfigured coding agent: split behaviour unchanged (helpers on the
 *      default model; keyword fallback when it is down; parent COMPLETED)
 *   5. configured QA: helpers use QA's model; when it fails, QA ends FAILED
 *      with no keyword rules
 *   6. the router honours an inherited route only when it is a configured
 *      strict one
 * Stand-in providers and a stand-in tool executor; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-strict-helpers-'));
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
const toolCalls: string[] = [];
const executor = {
  names: () => toolRegistryV2.names(),
  riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
  getMeta: (n: string) => toolRegistryV2.getMeta(n),
  async execute(name: string) { toolCalls.push(name); return { success: true, output: `${name}: stand-in output`, tool: name, durationMs: 1 }; },
};

// Models: the real router singleton; every provider is a stand-in that records who asked.
const modelCalls: string[] = [];
let defaultDown = false;
const defaultProvider = {
  isConfigured: () => true,
  async chat(req: any) {
    modelCalls.push(`default:${req.agentRole}`);
    if (defaultDown) throw new Error('default model is down (503)');
    return { content: `${req.agentRole} answered by the default model` };
  },
};
modelRouter.registerProvider((modelRouter as any).primary, defaultProvider as never);
modelRouter.registerProvider('openai', defaultProvider as never);
(modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
const named = (who: string, behaviour: 'ok' | 'fail' | 'blank') => ({
  isConfigured: () => true,
  async chat(req: any) {
    modelCalls.push(`${who}:${req.agentRole}`);
    if (behaviour === 'fail') throw new Error(`${who} is down (500)`);
    // D2 (owner, 2026-11-16): a stand-in reports the model it answers with, as real providers do.
    return { content: behaviour === 'blank' ? '' : `${req.agentRole} answered by ${who}`, model: req.model };
  },
});
modelRouter.registerNamedProvider('codeok', named('codeok', 'ok') as never);
modelRouter.registerNamedProvider('codefail', named('codefail', 'fail') as never);
modelRouter.registerNamedProvider('codeblank', named('codeblank', 'blank') as never);
modelRouter.registerNamedProvider('qaok', named('qaok', 'ok') as never);
modelRouter.registerNamedProvider('qafail', named('qafail', 'fail') as never);

const m = new AgentManager(agentEvents, loadAgentLimits({}));
m.useToolExecutor(executor as never);
registerAgentRoles(m);
async function run(role: string, description: string) {
  toolCalls.length = 0;
  modelCalls.length = 0;
  const h = await m.startRootTask({ request: description, specialistRole: role, task: { description } });
  return (await h.result) as any;
}
const helperCalls = (worker: string) => modelCalls.filter((c) => c.endsWith(`:${worker}`));
const statusOf = (r: any) => `${r.specialist?.status} ${String(r.specialist?.error?.message ?? '').slice(0, 300)}`;
const CODING_SPLIT = 'Explain the router code; then explain the agent manager code';
const QA_SPLIT = 'Run the type check; then run the unit tests';

console.log('\n=== Helpers inherit a configured coding or QA model (owner, 2026-11-15) ===\n');

console.log('--- 1. Configured coding agent, split request ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codeok:code-model' });
  const r = await run('coding_agent', CODING_SPLIT);
  const helpers = helperCalls('code_analysis_worker');
  ok('the request was split into helpers', helpers.length >= 2, modelCalls.join(','));
  ok('every helper asked the configured coding model', helpers.length >= 2 && helpers.every((c) => c.startsWith('codeok:')), helpers.join(','));
  ok('…and never the planning/default model', !modelCalls.some((c) => c.startsWith('default:')), modelCalls.join(','));
  ok('the parent is COMPLETED, answered by the model', r.specialist?.status === 'COMPLETED' && r.specialist?.data?.['answeredBy'] === 'model', `${statusOf(r)} ${JSON.stringify(r.specialist?.data)}`);
  restore();
}

console.log('\n--- 2. Configured coding model fails ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codefail:code-model' });
  const r = await run('coding_agent', CODING_SPLIT);
  ok('the parent coding task is FAILED, not COMPLETED', r.specialist?.status === 'FAILED', statusOf(r));
  ok('…no keyword-rule tool ran in any helper', toolCalls.length === 0, toolCalls.join(','));
  ok('…the default/planning model was never asked', !modelCalls.some((c) => c.startsWith('default:')), modelCalls.join(','));
  ok('…and the error names the failed helpers', /code_analysis_worker|part/i.test(String(r.specialist?.error?.message ?? '')) && /codefail is down/.test(String(r.specialist?.error?.message ?? '')), String(r.specialist?.error?.message ?? ''));
  restore();
}

console.log('\n--- 3. Configured coding model answers with empty text ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codeblank:code-model' });
  const r = await run('coding_agent', CODING_SPLIT);
  ok('the parent coding task is FAILED', r.specialist?.status === 'FAILED', statusOf(r));
  ok('…no keyword-rule tool ran', toolCalls.length === 0, toolCalls.join(','));
  restore();
}

console.log('\n--- 4. Unconfigured coding agent: split behaviour unchanged ---');
{
  const r = await run('coding_agent', CODING_SPLIT);
  const helpers = helperCalls('code_analysis_worker');
  ok('helpers use the default model, as before', helpers.length >= 2 && helpers.every((c) => c.startsWith('default:')), helpers.join(','));
  ok('the parent is COMPLETED', r.specialist?.status === 'COMPLETED', statusOf(r));
  defaultDown = true;
  const down = await run('coding_agent', CODING_SPLIT);
  ok('with the default model down, the unconfigured parent still ends COMPLETED (keyword fallback, unchanged)', down.specialist?.status === 'COMPLETED', statusOf(down));
  defaultDown = false;
}

console.log('\n--- 5. Configured QA, split request ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_QA_AGENT: 'qaok:qa-model' });
  const r = await run('qa_agent', QA_SPLIT);
  const helpers = helperCalls('test_runner_worker');
  ok('QA helpers asked QA\'s configured model', helpers.length >= 2 && helpers.every((c) => c.startsWith('qaok:')), modelCalls.join(','));
  ok('…never the default model', !modelCalls.some((c) => c.startsWith('default:')), modelCalls.join(','));
  ok('QA is COMPLETED, answered by its model', r.specialist?.status === 'COMPLETED' && r.specialist?.data?.['answeredBy'] === 'model', statusOf(r));
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_QA_AGENT: 'qafail:qa-model' });
  const r = await run('qa_agent', QA_SPLIT);
  ok('QA with a failing configured model and helpers is FAILED', r.specialist?.status === 'FAILED', statusOf(r));
  ok('…no keyword-rule tool ran', toolCalls.length === 0, toolCalls.join(','));
  ok('…the default model was never asked', !modelCalls.some((c) => c.startsWith('default:')), modelCalls.join(','));
  restore();
}

console.log('\n--- 6. The router honours an inherited route only when it is configured and strict ---');
{
  const log: string[] = [];
  // D2 (owner, 2026-11-16): a stand-in reports the model it answers with, as real providers do.
  const stub = (who: string) => ({ isConfigured: () => true, async chat(req: any) { log.push(`${who}:${req.model}`); return { content: `${who} answered`, model: req.model }; } });
  const r = new ModelRouter('a');
  r.registerProvider('a', stub('a') as never);
  r.registerNamedProvider('coder', stub('coder') as never);
  r.registerNamedProvider('browser', stub('browser') as never);
  (r as any).failoverOrder = (name?: string) => (name ? [name] : ['a']);
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'coder:code-model', JARVIS_MODEL_AGENT_BROWSER_AGENT: 'browser:b-model' });
  await r.chat({ model: 'own', messages: [{ role: 'user', content: 'hi' }], category: 'planning', agentRole: 'code_analysis_worker', routeAs: 'coding_agent' } as any);
  ok('a helper call that inherits a configured coding route goes to the coding model', log[0] === 'coder:code-model', log.join(','));
  log.length = 0;
  await r.chat({ model: 'own', messages: [{ role: 'user', content: 'hi' }], category: 'planning', agentRole: 'pc_inspect_worker', routeAs: 'browser_agent' } as any);
  ok('an inherited route that is not strict is ignored (the helper\'s own route)', log[0] === 'a:own', log.join(','));
  log.length = 0;
  restore();
  await r.chat({ model: 'own', messages: [{ role: 'user', content: 'hi' }], category: 'planning', agentRole: 'code_analysis_worker', routeAs: 'coding_agent' } as any);
  ok('with nothing configured, the inherited name changes nothing', log[0] === 'a:own', log.join(','));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
