/**
 * tests/mixedFailureCausesTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Review LR-2 (INDEPENDENT_REVIEW_LOW_CLOSURE_RECHECK.md; LR2_L5_PLAN.md,
 * owner approval 2026-11-17, option A). When the parts of a split request
 * fail for different reasons, every distinct cause is kept, and the cause
 * recovery acts on first leads:
 *
 *   - a used-up tool budget mixed with a model that did not answer is a
 *     model failure (dependency): recovery never waits for budget for it,
 *     and the record still names the budget
 *   - identity mixed with anything stays MODEL_IDENTITY_UNCONFIRMED (blocked)
 *   - pure cases are unchanged (tool budget waits for budget; model down
 *     is MODEL_UNAVAILABLE)
 *   - two budget kinds give the same code and signature in either order
 * Stand-in providers and tools; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mixed-causes-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];
delete process.env['JARVIS_AGENT_MODEL'];
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const common = await import('../core/agents/behaviors/common.js') as Record<string, any>;
const { modelRouter } = await import('../bridge/modelRouter.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
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

registerAllTools();
const tools = {
  names: () => toolRegistryV2.names(),
  riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
  getMeta: (n: string) => toolRegistryV2.getMeta(n),
  async execute(name: string) { return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 }; },
};

// Each part's helper behaves by the start of its request: 'tool' asks for one tool first,
// 'throw' is a model that is down, 'other' reports another model, 'ok' answers.
type Mode = 'ok' | 'tool' | 'throw' | 'other';
let plan: Array<[RegExp, Mode]> = [];
function behave(req: any, mode: Mode) {
  if (mode === 'throw') throw new Error('stand-in provider is down (500)');
  if (mode === 'other') return { content: 'All checks passed.', model: 'other-model' };
  if (mode === 'tool' && !req.messages.some((m: any) => m.role === 'tool')) return { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'dev_status', arguments: '{}' } }], model: req.model };
  return { content: 'All checks passed.', model: req.model };
}
const provider = { isConfigured: () => true, async chat(req: any) {
  const user = String(req.messages.find((m: any) => m.role === 'user')?.content ?? '');
  const mode = req.agentRole === 'qa_agent' || req.agentRole === 'coding_agent' ? 'ok' : (plan.find(([re]) => re.test(user))?.[1] ?? 'ok');
  return behave(req, mode);
} };
modelRouter.registerNamedProvider('anthropic', { isConfigured: () => true, async chat(req: any) { return { content: 'ok', model: req.model }; } } as never);   // no real Claude adapter
modelRouter.registerProvider((modelRouter as any).primary, provider as never);
(modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
modelRouter.registerNamedProvider('qaprov', provider as never);

const TWO = 'Run the type check; then describe the weather';
async function goalRun(env: Record<string, string>, limits: Record<string, string>, description = TWO) {
  for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_AGENT_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
  Object.assign(process.env, env);
  const m = new AgentManager(agentEvents, loadAgentLimits(limits));
  m.useToolExecutor(tools as never);
  registerAgentRoles(m);
  const exec = new AgentGoalExecutor({ manager: m, verify: false });
  const task = { id: 't', title: 'step', description, specialist: 'qa_agent', attempts: 1, maxAttempts: 3, sideEffects: 'none', failures: [] };
  const out = await exec.run({ goal: { id: 'g', description: 'goal', objective: 'goal', source: 'cli', priority: 5 }, task, signal: new AbortController().signal, onStarted: () => {} } as never) as any;
  const f = out.failure;
  const cls = f ? classifyFailure(f) : undefined;
  const d = f && cls ? decideRecovery({ task: task as never, failure: f, cls, toolCalls: 0, now: Date.now() }) : undefined;
  for (const k of Object.keys(env)) delete process.env[k];
  const root = m.rootRuns().at(-1)?.rootTaskId;
  const agentError = root ? m.rootResult(root)?.specialist?.error : undefined;
  return { f, cls, d, agentError };
}
const causesOf = (f: any): string[] => [...(f?.causes ?? [])].sort();
const show = (r: Awaited<ReturnType<typeof goalRun>>) => `${r.f?.code} [${causesOf(r.f).join(',')}] → ${r.cls} → ${r.d?.taskStatus}/${r.d?.goal}${r.d?.goalWaitingFor ? `/${r.d.goalWaitingFor}` : ''}: ${String(r.d?.action ?? '').slice(0, 140)}`;

console.log('\n=== Mixed failure causes in a split request (LR-2) ===\n');

console.log('--- Controls: one cause ---');
plan = [[/^Run the type check/i, 'tool'], [/^describe the weather/i, 'tool']];
const pureBudget = await goalRun({}, { JARVIS_AGENT_BUDGET_TOOL_CALLS: '0' });
ok('both parts out of tool calls: TOOL_BUDGET_EXHAUSTED, waits for budget', pureBudget.f?.code === 'TOOL_BUDGET_EXHAUSTED' && pureBudget.cls === 'budget' && pureBudget.d?.goalWaitingFor === 'budget', show(pureBudget));
plan = [[/^Run the type check/i, 'throw'], [/^describe the weather/i, 'throw']];
const pureDown = await goalRun({ JARVIS_MODEL_AGENT_QA_AGENT: 'qaprov:qa-model' }, {});
ok('both parts\' model down: MODEL_UNAVAILABLE, retried later', pureDown.f?.code === 'MODEL_UNAVAILABLE' && pureDown.cls === 'dependency' && pureDown.d?.goalWaitingFor !== 'budget', show(pureDown));

console.log('\n--- Tool budget mixed with a model that did not answer ---');
plan = [[/^Run the type check/i, 'tool'], [/^describe the weather/i, 'throw']];
const mixA = await goalRun({}, { JARVIS_AGENT_BUDGET_TOOL_CALLS: '0' });
ok('QA: one part out of tool calls, one answered by rules (model down): not TOOL_BUDGET_EXHAUSTED', mixA.f?.code !== 'TOOL_BUDGET_EXHAUSTED' && mixA.cls !== 'budget', show(mixA));
ok('…recorded as the model not answering (MODEL_UNAVAILABLE, dependency)', mixA.f?.code === 'MODEL_UNAVAILABLE' && mixA.cls === 'dependency', show(mixA));
// The action quotes each part's own error ("The toolCalls budget is used up"); recovery's own reason must not be the budget.
ok('…recovery does not wait for budget and does not give the budget as the reason', mixA.d?.goalWaitingFor !== 'budget' && !/^waiting/i.test(String(mixA.d?.action ?? '')) && !/the goal's budget is used up/i.test(String(mixA.d?.action ?? '')), show(mixA));
ok('…its reason is that something it needs is unavailable', /something it needs is unavailable/i.test(String(mixA.d?.action ?? '')), String(mixA.d?.action ?? '').slice(0, 120));
ok('…both causes are kept in the goal failure', causesOf(mixA.f).join(',') === 'MODEL_UNAVAILABLE,TOOL_BUDGET_EXHAUSTED', causesOf(mixA.f).join(','));
ok('…and in the agent task\'s error', (mixA.agentError as any)?.code === 'MODEL_UNAVAILABLE' && ((mixA.agentError as any)?.causes ?? []).some((c: any) => c.code === 'BUDGET_EXCEEDED' && c.budget === 'toolCalls'), JSON.stringify(mixA.agentError ? { code: (mixA.agentError as any).code, causes: (mixA.agentError as any).causes } : null));
ok('…the recovery action still names the tool budget', /tool/i.test(String(mixA.d?.action ?? '')) && /budget/i.test(String(mixA.d?.action ?? '')), String(mixA.d?.action ?? '').slice(0, 200));
const sig = (r: Awaited<ReturnType<typeof goalRun>>) => r.d?.signature?.id;
ok('…its signature differs from the pure tool-budget and the pure model-down signatures', !!sig(mixA) && sig(mixA) !== sig(pureBudget) && sig(mixA) !== sig(pureDown), `${sig(mixA)} / ${sig(pureBudget)} / ${sig(pureDown)}`);

// The parts in the other order. Each part keeps its behaviour: the weather part's rules need no tool;
// the type-check part's rules call one, so its model must be the one asking for the tool.
const mixA2 = await goalRun({}, { JARVIS_AGENT_BUDGET_TOOL_CALLS: '0' }, 'Describe the weather; then run the type check');
ok('the same mix in the other order: the same code and causes', mixA2.f?.code === mixA.f?.code && causesOf(mixA2.f).join(',') === causesOf(mixA.f).join(','), show(mixA2));

plan = [[/^Run the type check/i, 'tool'], [/^describe the weather/i, 'throw']];
const mixB = await goalRun({ JARVIS_MODEL_AGENT_QA_AGENT: 'qaprov:qa-model' }, { JARVIS_AGENT_BUDGET_TOOL_CALLS: '0' });
ok('strict QA: one helper out of tool calls, one helper\'s model down: MODEL_UNAVAILABLE, never waits for budget', mixB.f?.code === 'MODEL_UNAVAILABLE' && mixB.cls === 'dependency' && mixB.d?.goalWaitingFor !== 'budget', show(mixB));
ok('…both causes kept', causesOf(mixB.f).join(',') === 'MODEL_UNAVAILABLE,TOOL_BUDGET_EXHAUSTED', causesOf(mixB.f).join(','));

console.log('\n--- Identity mixed with anything: blocked ---');
plan = [[/^Run the type check/i, 'tool'], [/^describe the weather/i, 'other']];
const mixC = await goalRun({ JARVIS_MODEL_AGENT_QA_AGENT: 'qaprov:qa-model' }, { JARVIS_AGENT_BUDGET_TOOL_CALLS: '0' });
ok('strict QA: tool budget and identity: MODEL_IDENTITY_UNCONFIRMED, blocked', mixC.f?.code === 'MODEL_IDENTITY_UNCONFIRMED' && mixC.cls === 'configuration' && mixC.d?.taskStatus === 'blocked', show(mixC));
ok('…the tool budget is still recorded', causesOf(mixC.f).includes('TOOL_BUDGET_EXHAUSTED'), causesOf(mixC.f).join(','));

console.log('\n--- The cause rules themselves ---');
{
  const causes = common['failureCauses'] as ((parts: unknown[]) => { code: string; budget?: string }[]) | undefined;
  const lead = common['leadingCause'] as ((c: { code: string; budget?: string }[]) => { code: string; budget?: string }) | undefined;
  ok('failureCauses and leadingCause exist', typeof causes === 'function' && typeof lead === 'function');
  if (causes && lead) {
    const own = causes([{ code: 'BUDGET_EXCEEDED', budget: 'toolCalls' }, undefined]);
    ok('a part with no code (rules, unfinished, the parent\'s own part) counts as the model not answering', own.some((c) => c.code === 'MODEL_UNAVAILABLE') && lead(own).code === 'MODEL_UNAVAILABLE', JSON.stringify(own));
    const ab = causes([{ code: 'BUDGET_EXCEEDED', budget: 'toolCalls' }, { code: 'BUDGET_EXCEEDED', budget: 'llmCalls' }]);
    const ba = causes([{ code: 'BUDGET_EXCEEDED', budget: 'llmCalls' }, { code: 'BUDGET_EXCEEDED', budget: 'toolCalls' }]);
    ok('two budget kinds: the same lead in either order (the model budget)', lead(ab).budget === 'llmCalls' && lead(ba).budget === 'llmCalls', `${JSON.stringify(lead(ab))} ${JSON.stringify(lead(ba))}`);
    ok('…and the same causes in the same order', JSON.stringify(ab) === JSON.stringify(ba), `${JSON.stringify(ab)} ${JSON.stringify(ba)}`);
    ok('identity leads any mix', lead(causes([{ code: 'MODEL_UNAVAILABLE' }, { code: 'BUDGET_EXCEEDED', budget: 'toolCalls' }, { code: 'MODEL_IDENTITY_UNCONFIRMED' }])).code === 'MODEL_IDENTITY_UNCONFIRMED');
    ok('a single cause is that cause', lead(causes([{ code: 'BUDGET_EXCEEDED', budget: 'toolCalls' }])).budget === 'toolCalls');
  }
  // Goal recovery on its own: a budget code next to a model cause never waits for budget.
  const f = { code: 'TOOL_BUDGET_EXHAUSTED', causes: ['TOOL_BUDGET_EXHAUSTED', 'MODEL_UNAVAILABLE'], message: 'two parts failed' } as never;
  ok('classifyFailure never gives "budget" when a model cause is among the causes', classifyFailure(f) !== 'budget', String(classifyFailure(f)));
  const s1 = goalFailureSignature({ code: 'MODEL_UNAVAILABLE', causes: ['MODEL_UNAVAILABLE', 'TOOL_BUDGET_EXHAUSTED'], message: 'm' } as never).id;
  const s2 = goalFailureSignature({ code: 'MODEL_UNAVAILABLE', causes: ['TOOL_BUDGET_EXHAUSTED', 'MODEL_UNAVAILABLE'], message: 'm' } as never).id;
  const s3 = goalFailureSignature({ code: 'MODEL_UNAVAILABLE', message: 'm' } as never).id;
  ok('the signature includes the causes, in any order', s1 === s2 && s1 !== s3, `${s1} ${s2} ${s3}`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
