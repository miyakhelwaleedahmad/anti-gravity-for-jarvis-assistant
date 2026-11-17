/**
 * tests/errorClassificationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Low-finding closure L5 + R3 (LOW_CLOSURE_PLAN.md; owner approval 2026-11-16,
 * D-1 "pause for review"). Four conditions stay distinct from the agent task
 * to the goal's recovery decision:
 *
 *   MODEL_UNAVAILABLE           → goal class "dependency": retry later
 *   MODEL_IDENTITY_UNCONFIRMED  → class "configuration": blocked, not retried
 *   TOOL_BUDGET_EXHAUSTED       → class "budget" (the agent task keeps
 *                                 BUDGET_EXCEEDED, with budget "toolCalls")
 *   VERIFICATION_INCONCLUSIVE   → class "inconclusive": needs review, the goal waits
 *
 * and a strict research parent fails on a worker's model-call budget (keeping
 * its code) but not on a worker's tool budget.
 * Stand-in providers and tools; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-error-classes-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];
process.env['JARVIS_AGENT_ARCHIVE'] = '0';
process.env['JARVIS_AGENT_DEEP_ANALYSES'] = '1';

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { registerAgentRoles } = await import('../core/agents/specialists.js');
const { AgentGoalExecutor } = await import('../core/goalExecutor.js');
const { classifyFailure, decideRecovery, goalFailureSignature } = await import('../core/goalRecovery.js');

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
const REPO = { fullName: 'acme/cdp-kit', url: 'https://github.com/acme/cdp-kit', description: 'Chrome DevTools Protocol client for TypeScript', stars: 4200, language: 'TypeScript', license: 'MIT', topics: ['cdp'], pushedAt: new Date().toISOString(), archived: false };
let githubDown = false;
const executorTools = {
  names: () => toolRegistryV2.names(),
  riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
  getMeta: (n: string) => toolRegistryV2.getMeta(n),
  async execute(name: string) {
    if (name === 'github_search') return { success: true, output: JSON.stringify({ success: true, items: [REPO] }), tool: name, durationMs: 1 };
    if (name === 'github_repo') {
      if (githubDown) return { success: false, output: JSON.stringify({ success: false, error: 'GitHub API answered 503' }), error: 'GitHub API answered 503', tool: name, durationMs: 1 };
      return { success: true, output: JSON.stringify({ success: true, repository: { ...REPO }, readme: 'A CDP client.', files: ['package.json'], license: 'MIT', url: REPO.url }), tool: name, durationMs: 1 };
    }
    return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 };
  },
};
const GOOD = JSON.stringify({ queries: ['cdp typescript'], summary: 'A maintained CDP client.', integration: 'library', risks: [] });
let defaultMode: 'json' | 'tool' = 'json';
modelRouter.registerProvider((modelRouter as any).primary, {
  isConfigured: () => true,
  async chat(req: any) {
    if (defaultMode === 'tool' && !req.messages.some((m: any) => m.role === 'tool')) return { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'git_overview', arguments: '{}' } }], model: req.model };
    return { content: GOOD, model: req.model };
  },
} as never);
(modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
modelRouter.registerNamedProvider('silent', { isConfigured: () => true, async chat() { return { content: GOOD }; } } as never);
modelRouter.registerNamedProvider('codefail', { isConfigured: () => true, async chat() { throw new Error('codefail is down (500)'); } } as never);
modelRouter.registerNamedProvider('codeok', { isConfigured: () => true, async chat(req: any) { return { content: GOOD, model: req.model }; } } as never);

function manager(limits: Record<string, string> = {}) {
  const m = new AgentManager(agentEvents, loadAgentLimits(limits));
  m.useToolExecutor(executorTools as never);
  registerAgentRoles(m);
  return m;
}
async function runTask(m: any, role: string, description: string) {
  const h = await m.startRootTask({ request: description, specialistRole: role, task: { description } });
  return (await h.result) as any;
}
async function runGoalTask(m: any, specialist: string, description: string) {
  const exec = new AgentGoalExecutor({ manager: m });
  const goal = { id: 'goal-1', description: 'test goal', objective: 'test goal', source: 'cli', priority: 5 };
  const task = { id: 'gt-1', title: 'step', description, specialist, attempts: 1, maxAttempts: 3, sideEffects: 'none', failures: [] };
  const out = await exec.run({ goal, task, signal: new AbortController().signal, onStarted: () => {} } as never);
  return { out, task };
}
const RESEARCH = 'Find TypeScript libraries for Chrome DevTools Protocol';

console.log('\n=== Four failure conditions stay distinct ===\n');

console.log('--- MODEL_IDENTITY_UNCONFIRMED ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'silent:code-model' });
  const r = await runTask(manager(), 'coding_agent', 'What changed in git recently?');
  ok('a strict reply without a reported model: task code MODEL_IDENTITY_UNCONFIRMED', r.specialist?.error?.code === 'MODEL_IDENTITY_UNCONFIRMED', `${r.specialist?.status} ${r.specialist?.error?.code}`);
  const { out, task } = await runGoalTask(manager(), 'coding_agent', 'What changed in git recently?');
  const f = (out as any).failure;
  const cls = classifyFailure(f);
  ok('…the goal sees MODEL_IDENTITY_UNCONFIRMED, class "configuration"', f?.code === 'MODEL_IDENTITY_UNCONFIRMED' && cls === 'configuration', `${f?.code} → ${cls}`);
  const d = decideRecovery({ task: task as never, failure: f, cls, now: Date.now() });
  ok('…blocked, not retried', d.taskStatus === 'blocked' && d.goal === 'block' && !d.nextAttemptAt, `${d.taskStatus}/${d.goal}`);
  restore();
}

console.log('\n--- MODEL_UNAVAILABLE ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codefail:code-model' });
  const { out, task } = await runGoalTask(manager(), 'coding_agent', 'What changed in git recently?');
  const f = (out as any).failure;
  const cls = classifyFailure(f);
  ok('the strict model is down: code MODEL_UNAVAILABLE, class "dependency"', f?.code === 'MODEL_UNAVAILABLE' && cls === 'dependency', `${f?.code} → ${cls}`);
  const d = decideRecovery({ task: task as never, failure: f, cls, now: Date.now() });
  ok('…retried later, waiting for the service', d.taskStatus === 'retry' && d.waitingFor === 'service' && !!d.nextAttemptAt, `${d.taskStatus}/${d.waitingFor}`);
  restore();
}

console.log('\n--- TOOL_BUDGET_EXHAUSTED ---');
{
  defaultMode = 'tool';
  const r = await runTask(manager({ JARVIS_AGENT_BUDGET_TOOL_CALLS: '0' }), 'coding_agent', 'What changed in git recently?');
  ok('the agent task keeps BUDGET_EXCEEDED and says it was the tool budget', r.specialist?.error?.code === 'BUDGET_EXCEEDED' && r.specialist?.error?.budget === 'toolCalls', JSON.stringify(r.specialist?.error));
  const { out, task } = await runGoalTask(manager({ JARVIS_AGENT_BUDGET_TOOL_CALLS: '0' }), 'coding_agent', 'What changed in git recently?');
  const f = (out as any).failure;
  const cls = classifyFailure(f);
  ok('…the goal sees TOOL_BUDGET_EXHAUSTED, class "budget"', f?.code === 'TOOL_BUDGET_EXHAUSTED' && cls === 'budget', `${f?.code} → ${cls}`);
  const d = decideRecovery({ task: task as never, failure: f, cls, now: Date.now() });
  ok('…the goal waits for budget', d.goal === 'wait' && d.goalWaitingFor === 'budget', `${d.goal}/${d.goalWaitingFor}`);
  defaultMode = 'json';
}

console.log('\n--- VERIFICATION_INCONCLUSIVE ---');
{
  githubDown = true;
  const restore = setEnv({ JARVIS_AGENT_DEEP_ANALYSES: '0' });
  const { out, task } = await runGoalTask(manager(), 'coding_agent', RESEARCH);
  const f = (out as any).failure;
  ok('a goal task whose cited source could not be re-read is not ok', (out as any).ok === false, `ok=${(out as any).ok} ${JSON.stringify((out as any).result?.verification)}`);
  const cls = f ? classifyFailure(f) : undefined;
  ok('…code VERIFICATION_INCONCLUSIVE, class "inconclusive"', f?.code === 'VERIFICATION_INCONCLUSIVE' && cls === 'inconclusive', `${f?.code} → ${cls}`);
  if (f && cls) {
    const d = decideRecovery({ task: task as never, failure: f, cls, now: Date.now() });
    ok('…needs review, the goal waits for the owner, not retried', d.taskStatus === 'needs_review' && d.goal === 'block' && !d.nextAttemptAt, `${d.taskStatus}/${d.goal}`);
  } else ok('…needs review, the goal waits for the owner, not retried', false, 'no failure');
  restore();
  githubDown = false;
}

console.log('\n--- R3. Strict research: model budget vs tool budget ---');
{
  const restore = setEnv({ JARVIS_MODEL_AGENT_CODING_AGENT: 'codeok:code-model' });
  const tool = await runTask(manager({ JARVIS_AGENT_BUDGET_TOOL_CALLS: '1' }), 'coding_agent', RESEARCH);
  ok('a research worker ran out of TOOL calls: the strict coding task is not failed as a model failure', tool.specialist?.status === 'COMPLETED' || (tool.specialist?.error?.code !== 'MODEL_UNAVAILABLE' && tool.specialist?.error?.budget === 'toolCalls'), `${tool.specialist?.status} ${JSON.stringify(tool.specialist?.error)}`);
  const model = await runTask(manager({ JARVIS_AGENT_BUDGET_LLM_CALLS: '1' }), 'coding_agent', RESEARCH);
  ok('a research worker ran out of MODEL calls: the coding task fails with BUDGET_EXCEEDED (llmCalls), its code kept', model.specialist?.status === 'FAILED' && model.specialist?.error?.code === 'BUDGET_EXCEEDED' && model.specialist?.error?.budget === 'llmCalls', `${model.specialist?.status} ${JSON.stringify(model.specialist?.error)}`);
  restore();
}

console.log('\n--- Four distinct signatures ---');
{
  const codes = ['MODEL_UNAVAILABLE', 'MODEL_IDENTITY_UNCONFIRMED', 'TOOL_BUDGET_EXHAUSTED', 'VERIFICATION_INCONCLUSIVE'];
  const sigs = codes.map((code) => JSON.stringify(goalFailureSignature({ code, message: 'the same message' })));
  ok('the four codes give four different failure signatures', new Set(sigs).size === 4, String(new Set(sigs).size));
  ok('…and an existing code keeps its class (BUDGET_EXCEEDED → budget)', classifyFailure({ code: 'BUDGET_EXCEEDED', message: 'budget exceeded' }) === 'budget');
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
