/**
 * tests/lineageInheritanceTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Gap closure P9 + N1 (GAP_CLOSURE_PLAN.md §4; owner approval 2026-11-16).
 *
 *   P9  a coding_agent with its own (strict) model setting keeps the GitHub
 *       research flow and its workers, but every model call in it, a
 *       grandchild worker's included, uses that model; a model failure or an
 *       unusable answer ends the task FAILED with the reason (no rules); a
 *       worker that failed on the model is not retried; the parent fails
 *   N1  inheritance follows who spawned whom: task input can never move an
 *       agent onto another agent's model (a forged inheritModelRoute on a
 *       root task, or on a helper of a parent without a strict setting)
 *   and agents without their own setting keep the research flow as before.
 * Stand-in providers and tools; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-lineage-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

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
function setEnv(vars: Record<string, string | undefined>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

registerAllTools();
const toolCalls: string[] = [];
const REPO = { fullName: 'acme/cdp-kit', url: 'https://github.com/acme/cdp-kit', description: 'Chrome DevTools Protocol client for TypeScript', stars: 4200, language: 'TypeScript', license: 'MIT', topics: ['cdp', 'devtools'], pushedAt: new Date().toISOString(), archived: false };
const executor = {
  names: () => toolRegistryV2.names(),
  riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
  getMeta: (n: string) => toolRegistryV2.getMeta(n),
  async execute(name: string) {
    toolCalls.push(name);
    if (name === 'github_search') return { success: true, output: JSON.stringify({ success: true, items: [REPO] }), tool: name, durationMs: 1 };
    if (name === 'github_repo') return { success: true, output: JSON.stringify({ success: true, repository: { ...REPO }, readme: 'A Chrome DevTools Protocol (CDP) client.', files: ['package.json'], license: 'MIT', url: REPO.url }), tool: name, durationMs: 1 };
    return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 };
  },
};

// Models. A JSON answer that both research prompts accept (queries; a deep-analysis judgement).
const GOOD = JSON.stringify({ queries: ['cdp typescript'], summary: 'A maintained CDP client.', integration: 'library', risks: [] });
const modelCalls: string[] = [];
let defaultDown = false;
const answer = (who: string, req: any, mode: 'ok' | 'fail' | 'bad' | 'faildeep') => {
  modelCalls.push(`${who}:${req.agentRole}`);
  if (mode === 'fail' || (mode === 'faildeep' && req.agentRole === 'project_deep_analysis_worker')) throw new Error(`${who} is down (500)`);
  if (mode === 'bad') return { content: 'not json at all', model: req.model };
  return { content: GOOD, model: req.model };
};
const defaultProvider = { isConfigured: () => true, async chat(req: any) { modelCalls.push(`default:${req.agentRole}`); if (defaultDown) throw new Error('default model is down (503)'); return { content: GOOD, model: req.model }; } };
modelRouter.registerProvider((modelRouter as any).primary, defaultProvider as never);
modelRouter.registerProvider('openai', defaultProvider as never);
(modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
for (const mode of ['ok', 'fail', 'bad', 'faildeep'] as const) {
  modelRouter.registerNamedProvider(`code${mode}`, { isConfigured: () => true, async chat(req: any) { return answer(`code${mode}`, req, mode); } } as never);
}
modelRouter.registerNamedProvider('checker', { isConfigured: () => true, async chat(req: any) { modelCalls.push(`checker:${req.agentRole}`); return { content: 'checked', model: req.model }; } } as never);

function manager() {
  const m = new AgentManager(agentEvents, loadAgentLimits({}));
  m.useToolExecutor(executor as never);
  registerAgentRoles(m);
  // A specialist without a strict setting whose helper is handed a forged key (N1, last review probe B8).
  m.defineRole({
    role: 'probe_agent', name: 'Probe Specialist', description: 'Test stand-in specialist.',
    capabilities: ['testing'], supportedTaskTypes: [], tools: ['dev_status', 'dev:run', 'dev:scripts'], maxRisk: 1,
    canSpawn: true, allowedChildRoles: ['test_runner_worker'], permanent: true, version: '1.0.0',
    behavior: {
      async run(ctx: any) {
        const h = await ctx.spawn({ childRole: 'test_runner_worker', childTask: { description: 'Run the type check', input: { inheritModelRoute: 'qa_agent' } }, reason: 'probe' });
        const [r] = await ctx.wait([h]);
        return { summary: r.summary, confidence: 0.5 };
      },
    },
  } as never);
  return m;
}
async function run(m: any, role: string, description: string, input: Record<string, unknown> = {}) {
  toolCalls.length = 0;
  modelCalls.length = 0;
  const h = await m.startRootTask({ request: description, specialistRole: role, task: { description, input } });
  return (await h.result) as any;
}
const errorOf = (r: any) => String(r.specialist?.error?.message ?? '');
const RESEARCH = 'Find TypeScript libraries for Chrome DevTools Protocol';

console.log('\n=== Strict model inheritance by lineage ===\n');

console.log('--- P9. Configured coding agent, GitHub research request ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codeok:code-model' });
  const r = await run(manager(), 'coding_agent', RESEARCH);
  ok('the research flow still runs (GitHub search and repository read)', toolCalls.includes('github_search') && toolCalls.includes('github_repo'), toolCalls.join(','));
  ok('the coding agent\'s own model call used the coding model', modelCalls.includes('codeok:coding_agent'), modelCalls.join(','));
  ok('the deep-analysis worker (a grandchild) used the coding model', modelCalls.includes('codeok:project_deep_analysis_worker'), modelCalls.join(','));
  ok('the default/planning model was never asked', !modelCalls.some((c) => c.startsWith('default:')), modelCalls.join(','));
  ok('the task is COMPLETED', r.specialist?.status === 'COMPLETED', `${r.specialist?.status} ${errorOf(r)}`);
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codefail:code-model' });
  const r = await run(manager(), 'coding_agent', RESEARCH);
  ok('the coding model fails: the task is FAILED, not answered by rules', r.specialist?.status === 'FAILED', `${r.specialist?.status} ${errorOf(r)}`);
  ok('…with the provider\'s reason', /codefail is down \(500\)/.test(errorOf(r)), errorOf(r));
  ok('…and the default model was never asked', !modelCalls.some((c) => c.startsWith('default:')), modelCalls.join(','));
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codefaildeep:code-model' });
  const r = await run(manager(), 'coding_agent', RESEARCH);
  ok('the deep-analysis worker\'s model fails: the coding task is FAILED', r.specialist?.status === 'FAILED', `${r.specialist?.status} ${errorOf(r)}`);
  ok('…naming the worker and the reason', /deep_analysis|Deep Analysis/i.test(errorOf(r)) && /codefaildeep is down/.test(errorOf(r)), errorOf(r));
  ok('…the failed worker was not retried (one model call)', modelCalls.filter((c) => c.endsWith(':project_deep_analysis_worker')).length === 1, modelCalls.join(','));
  ok('…and the default model was never asked', !modelCalls.some((c) => c.startsWith('default:')), modelCalls.join(','));
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codebad:code-model' });
  const r = await run(manager(), 'coding_agent', RESEARCH);
  ok('an unusable answer from the coding model: FAILED, not answered by rules', r.specialist?.status === 'FAILED' && /not usable/i.test(errorOf(r)), `${r.specialist?.status} ${errorOf(r)}`);
  restore();
}

console.log('\n--- Unchanged: a coding agent without its own setting ---');
{
  const r = await run(manager(), 'coding_agent', RESEARCH);
  ok('the research flow runs on the default model', r.specialist?.status === 'COMPLETED' && modelCalls.some((c) => c.startsWith('default:')) && toolCalls.includes('github_search'), `${r.specialist?.status} ${modelCalls.join(',')}`);
  defaultDown = true;
  const down = await run(manager(), 'coding_agent', RESEARCH);
  ok('with the default model down it still answers by rules (unchanged)', down.specialist?.status === 'COMPLETED' && toolCalls.includes('github_search'), `${down.specialist?.status} ${errorOf(down)}`);
  defaultDown = false;
}

console.log('\n--- N1. Task input never moves an agent onto another agent\'s model ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_QA_AGENT: 'checker:qa-model' });
  const pr = await run(manager(), 'probe_agent', 'Check the project health');
  const helper = modelCalls.filter((c) => c.endsWith(':test_runner_worker'));
  ok('a helper of a specialist without a strict setting, given inheritModelRoute=qa_agent, is not moved onto QA\'s model', helper.length > 0 && !helper.some((c) => c.startsWith('checker:')), `${pr.specialist?.status} ${errorOf(pr)} calls=${modelCalls.join(',')}`);
  restore();
}
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codeok:code-model' });
  await run(manager(), 'pc_agent', 'Which apps are open?', { inheritModelRoute: 'coding_agent' });
  ok('a root task given inheritModelRoute=coding_agent is not moved onto the coding model', modelCalls.length > 0 && !modelCalls.some((c) => c.startsWith('codeok:')), modelCalls.join(','));
  restore();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
