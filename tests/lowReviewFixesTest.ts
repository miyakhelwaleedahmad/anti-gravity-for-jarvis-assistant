/**
 * tests/lowReviewFixesTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Findings of the Low-closure review (INDEPENDENT_REVIEW_LOW_CLOSURE.md):
 *
 *   M1   a request split into parts keeps the helpers' own failure condition:
 *        a helper's tool budget → TOOL_BUDGET_EXHAUSTED (goal waits for
 *        budget), a helper's unconfirmed identity → MODEL_IDENTITY_UNCONFIRMED
 *        (goal blocked), for QA and for a strict coding agent
 *   L-1  a Bedrock id ("anthropic.…-5-5-v1:0"), a "-vN@date" form after a
 *        version number ("…-5-5-v2@date") and a dotted version ("5.5" /
 *        "5-5") are one model (a "-vN" after a word is not folded)
 *   L-2  an Ollama-style ":latest" tag is a floating alias
 *   L-4  several failed workers: the most specific condition is kept
 *        (identity, then budget, then unavailable)
 * Stand-in providers and tools; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-low-review-fixes-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];
delete process.env['JARVIS_AGENT_MODEL'];
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const categories = await import('../bridge/modelCategories.js') as Record<string, any>;
const common = await import('../core/agents/behaviors/common.js') as Record<string, any>;
const { modelRouter } = await import('../bridge/modelRouter.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { registerAgentRoles } = await import('../core/agents/specialists.js');
const { AgentGoalExecutor } = await import('../core/goalExecutor.js');
const { classifyFailure, decideRecovery } = await import('../core/goalRecovery.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
const tools = {
  names: () => toolRegistryV2.names(),
  riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
  getMeta: (n: string) => toolRegistryV2.getMeta(n),
  async execute(name: string) { return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 }; },
};
let toolMode = false;
const toolFirst = (req: any, content: string, model: string | undefined, tool: string) =>
  toolMode && !req.messages.some((m: any) => m.role === 'tool')
    ? { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: tool, arguments: '{}' } }], ...(model ? { model } : {}) }
    : { content, ...(model ? { model } : {}) };
modelRouter.registerNamedProvider('anthropic', { isConfigured: () => true, async chat(req: any) { return { content: 'ok', model: req.model }; } } as never);   // no real Claude adapter
modelRouter.registerProvider((modelRouter as any).primary, { isConfigured: () => true, async chat(req: any) { return toolFirst(req, 'All checks passed.', req.model, 'dev_status'); } } as never);
(modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
modelRouter.registerNamedProvider('swapper', { isConfigured: () => true, async chat() { return { content: 'All checks passed.', model: 'other-model' }; } } as never);
modelRouter.registerNamedProvider('coder', { isConfigured: () => true, async chat(req: any) { return toolFirst(req, 'done', req.model, 'read_file'); } } as never);

async function goalRun(role: string, description: string, env: Record<string, string>, limits: Record<string, string>) {
  for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_AGENT_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
  Object.assign(process.env, env);
  const m = new AgentManager(agentEvents, loadAgentLimits(limits));
  m.useToolExecutor(tools as never);
  registerAgentRoles(m);
  const exec = new AgentGoalExecutor({ manager: m, verify: false });
  const task = { id: 't', title: 'step', description, specialist: role, attempts: 1, maxAttempts: 3, sideEffects: 'none', failures: [] };
  const out = await exec.run({ goal: { id: 'g', description: 'goal', objective: 'goal', source: 'cli', priority: 5 }, task, signal: new AbortController().signal, onStarted: () => {} } as never);
  const f = (out as any).failure;
  const cls = f ? classifyFailure(f) : undefined;
  const d = f && cls ? decideRecovery({ task: task as never, failure: f, cls, toolCalls: 0, now: Date.now() }) : undefined;
  for (const k of Object.keys(env)) delete process.env[k];
  return { f, cls, d };
}

console.log('\n=== Low-closure review fixes ===\n');

console.log('--- M1. A split request keeps its helpers\' failure condition ---');
{
  toolMode = true;
  const a = await goalRun('qa_agent', 'Run the type check; then review the diff', {}, { JARVIS_AGENT_BUDGET_TOOL_CALLS: '0' });
  ok('QA split, helpers out of tool calls: TOOL_BUDGET_EXHAUSTED, the goal waits for budget', a.f?.code === 'TOOL_BUDGET_EXHAUSTED' && a.cls === 'budget' && a.d?.goalWaitingFor === 'budget', `${a.f?.code} → ${a.cls} → ${a.d?.taskStatus}/${a.d?.goal}`);
  toolMode = false;
  const b = await goalRun('qa_agent', 'Run the type check; then review the diff', { JARVIS_MODEL_AGENT_QA_AGENT: 'swapper:qa-model' }, {});
  ok('QA split, helpers answered by another model: MODEL_IDENTITY_UNCONFIRMED, blocked', b.f?.code === 'MODEL_IDENTITY_UNCONFIRMED' && b.cls === 'configuration' && b.d?.taskStatus === 'blocked', `${b.f?.code} → ${b.cls} → ${b.d?.taskStatus}/${b.d?.goal}`);
  toolMode = true;
  const c = await goalRun('coding_agent', 'Explain core/orchestrator.ts; then explain core/goalRuntime.ts', { JARVIS_MODEL_AGENT_CODING_AGENT: 'coder:code-model' }, { JARVIS_AGENT_BUDGET_TOOL_CALLS: '0' });
  ok('strict coding split, helpers out of tool calls: TOOL_BUDGET_EXHAUSTED, never a model failure', c.f?.code === 'TOOL_BUDGET_EXHAUSTED' && c.cls === 'budget', `${c.f?.code} → ${c.cls}`);
  toolMode = false;
}

console.log('\n--- L-1, L-2. More forms of one model ---');
{
  const key = categories['identityKey'] as (m: string) => string;
  const floating = categories['isFloatingAlias'] as (m: string) => boolean;
  ok('a Bedrock id is the same model as its plain name', key('anthropic.claude-opus-5-5-v1:0') === key('claude-opus-5-5'), `${key('anthropic.claude-opus-5-5-v1:0')} vs ${key('claude-opus-5-5')}`);
  ok('a Vertex id with a version and date is the same model', key('claude-opus-5-5-v2@20261101') === key('claude-opus-5-5'), `${key('claude-opus-5-5-v2@20261101')}`);
  ok('a dotted version is the same model as the dashed one', key('claude-opus-5.5') === key('claude-opus-5-5'), `${key('claude-opus-5.5')} vs ${key('claude-opus-5-5')}`);
  ok('an Ollama ":latest" tag is a floating alias', floating('llama3:latest') === true);
  ok('…and a plain model name is not', floating('llama3') === false && floating('gemini-2.5-flash') === false);
  ok('two genuinely different models keep different keys', key('claude-opus-5-5') !== key('claude-sonnet-5-5') && key('gpt-4.1') !== key('gpt-4o'), `${key('gpt-4.1')} vs ${key('gpt-4o')}`);
}

console.log('\n--- L-4. Several failed workers: the most specific condition ---');
{
  const pick = common['mostSpecificFailure'] as ((errors: unknown[]) => { code: string; budget?: string } | undefined) | undefined;
  ok('mostSpecificFailure exists', typeof pick === 'function');
  if (pick) {
    ok('unavailable then identity: identity is kept', pick([{ code: 'MODEL_UNAVAILABLE', message: 'a' }, { code: 'MODEL_IDENTITY_UNCONFIRMED', message: 'b' }])?.code === 'MODEL_IDENTITY_UNCONFIRMED');
    ok('unavailable then budget: budget is kept, with its kind', pick([{ code: 'MODEL_UNAVAILABLE', message: 'a' }, { code: 'BUDGET_EXCEEDED', message: 'b', budget: 'llmCalls' }])?.budget === 'llmCalls');
    ok('no known code: none', pick([{ code: 'AGENT_ERROR', message: 'x' }, undefined]) === undefined);
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
