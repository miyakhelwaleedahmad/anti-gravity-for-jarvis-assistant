/**
 * tests/sevenAgentTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The seven-agent realignment (docs/agents/CHECKLIST.md):
 *
 *   Phase 1  the seven requested roles; no duplicates when roles are
 *            registered again or the manager is recreated; data_tools is
 *            exact and runs no code; the Data agent answers calculations
 *            directly and splits independent parts across parallel workers.
 *
 * The model is scripted (or down) and nothing reaches the network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-seven-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspaceDir, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspaceDir;
process.env['JARVIS_DATA_ROOT'] = workspaceDir;
process.chdir(workspaceDir);

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('network is off in this test'); }) as typeof fetch;

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { registerAgentRoles, SPECIALIST_ROLES } = await import('../core/agents/specialists.js');
const { calculate, stats, compare, logSummary, dataTool } = await import('../core/tools/dataTools.js');
const { extractExpression, extractNumbers, aggregateResults } = await import('../core/agents/behaviors/data.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const throws = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (e) { return (e as Error).message; } };

registerAllTools();

const calls: string[] = [];
const realExecute = toolRegistryV2.execute.bind(toolRegistryV2);
toolRegistryV2.execute = (async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
  calls.push(name);
  return realExecute(name, args, signal);
}) as typeof toolRegistryV2.execute;

let modelDown = true;
let inFlight = 0;
let maxInFlight = 0;
modelRouter.chat = (async (req: { messages: { role: string; content: unknown }[] }) => {
  if (modelDown) throw new Error('503 (test)');
  const user = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, 150));
  inFlight--;
  return { content: `answer for: ${user.split('\n')[0]}` };
}) as typeof modelRouter.chat;

const m = new AgentManager(agentEvents, { ...loadAgentLimits({}) });
registerAgentRoles(m);

console.log('\n=== Seven agents ===\n');

console.log('--- Phase 1: the seven roles, registered once ---');
{
  const ids = () => m.registry.all().filter((a) => a.permanent && a.agentId !== 'jarvis').map((a) => a.agentId).sort().join();
  const expected = 'browser_agent,coding_agent,data_agent,memory_agent,pc_agent,qa_agent,research_agent';
  ok('exactly the seven requested specialists', ids() === expected && SPECIALIST_ROLES.length === 7, ids());
  ok('there is no separate GitHub agent any more', !m.registry.get('github_agent'));
  registerAgentRoles(m);
  registerAgentRoles(m);
  ok('registering the roles again adds no agent', ids() === expected && m.registry.all().filter((a) => a.permanent).length === 8);
  const m2 = new AgentManager(agentEvents, { ...loadAgentLimits({}) });
  registerAgentRoles(m2);
  ok('a fresh manager (a restart) has the same seven, once each',
    m2.registry.all().filter((a) => a.permanent && a.agentId !== 'jarvis').map((a) => a.agentId).sort().join() === expected);
  ok('every specialist can create workers', m.registry.all().filter((a) => a.permanent && a.agentId !== 'jarvis').every((a) => a.permissions.canSpawn || a.agentId === 'memory_agent'));
  ok('data_tools is registered with risk 0', toolRegistryV2.has('data_tools') && toolRegistryV2.riskOf('data_tools', { action: 'calculate' }) === 0);
}

console.log('\n--- Phase 1: data_tools is exact and runs no code ---');
{
  ok('precedence and parentheses', calculate('2 + 3 * 4') === 14 && calculate('(2 + 3) * 4') === 20);
  ok('power is right-associative, unary minus', calculate('2 ^ 3 ^ 2') === 512 && calculate('-2 ^ 2') === -4 && calculate('--3') === 3);
  ok('functions and constants', calculate('sqrt(16) + round(2.345, 2) + max(1, 7, 3)') === 4 + 2.35 + 7 && Math.abs(calculate('2 * pi') - 2 * Math.PI) < 1e-12);
  ok('1,000 is a thousand', calculate('1,000 + 1') === 1001);
  ok('division by zero is refused', throws(() => calculate('1 / 0')) === 'division by zero');
  for (const evil of ['process.exit(1)', 'constructor', 'require("fs")', 'this', 'globalThis', '1; 2', '`x`', 'a=1']) {
    ok(`refused: ${evil}`, throws(() => calculate(evil)) !== undefined);
  }
  ok('a very long expression is refused', /longer than/.test(throws(() => calculate('1+'.repeat(400) + '1')) ?? ''));
  ok('deep nesting is refused, not a crash', /nested too deeply/.test(throws(() => calculate('('.repeat(150) + '1' + ')'.repeat(150))) ?? ''));
  const s = stats([3, 5, 10]);
  ok('stats: mean, median, sum, sample standard deviation', s['mean'] === 6 && s['median'] === 5 && s['sum'] === 18 && s['stdDev'] === 3.605551, JSON.stringify(s));
  const c = compare([{ name: 'A', ms: 120 }, { name: 'B', ms: 80 }, { name: 'C', ms: 'n/a' }], 'ms', false);
  ok('compare: lower-is-better ranks B first and skips non-numbers', c.length === 2 && c[0]!.name === 'B' && c[1]!.diffFromBest === 40, JSON.stringify(c));
  const log = logSummary('2026-10-09T10:00:00Z ERROR db timeout after 30 s\n2026-10-09T10:01:00Z ERROR db timeout after 31 s\nWARN slow\ninfo ok');
  ok('log_summary groups the same error with different numbers', log.byLevel['error'] === 2 && log.byLevel['warn'] === 1 && log.topErrors[0]?.count === 2, JSON.stringify(log));
  const bad = JSON.parse(await dataTool.execute({ action: 'calculate', expression: 'process.exit(1)' }, undefined as never) as string);
  ok('the tool reports a refused expression as a failure', bad.success === false && /unexpected|unknown/.test(bad.error));
  const viaRegistry = await toolRegistryV2.execute('data_tools', { action: 'calculate', expression: '15/100*240' });
  ok('through the registry: 15% of 240 is 36', viaRegistry.success && JSON.parse(viaRegistry.output).result === 36, viaRegistry.output);
  const failVia = await toolRegistryV2.execute('data_tools', { action: 'calculate', expression: '1/0' });
  ok('through the registry a {success:false} result counts as failed', !failVia.success, failVia.output);
}

console.log('\n--- Phase 1: reading requests ---');
{
  ok('"what is 15% of 240?" → 15/100*240', extractExpression('What is 15% of 240?') === '15/100*240', String(extractExpression('What is 15% of 240?')));
  ok('"calculate (2+3) times 4" → arithmetic', extractExpression('calculate (2+3) times 4') === '(2+3) * 4', String(extractExpression('calculate (2+3) times 4')));
  ok('words that are not arithmetic are not an expression', extractExpression('summarise the errors in yesterday\'s log') === undefined
    && extractExpression('what is 2 + 2 and also delete my files') === undefined);
  ok('"average of 3, 5 and 10" → numbers', JSON.stringify(extractNumbers('average of 3, 5 and 10')) === '[3,5,10]');
  ok('numbers without a statistic word are not a stats request', extractNumbers('open 3 tabs and 5 windows') === undefined);
}

console.log('\n--- Phase 1: the Data agent ---');
{
  calls.length = 0;
  const h = await m.startRootTask({ request: 'average', specialistRole: 'data_agent', task: { description: 'What is the average of 3, 5 and 10?' } });
  const r = await h.result;
  ok('the Data agent answered without the model', r.status === 'COMPLETED' && /mean 6\b/.test(r.answer), r.answer);
  ok('it used data_tools through the registry', calls.includes('data_tools'), calls.join(','));
  ok('the result is a high-confidence finding', r.findings.some((f) => f.tags?.includes('calculation') && f.confidence >= 0.9));

  calls.length = 0;
  const h2 = await m.startRootTask({ request: 'two sums', specialistRole: 'data_agent', task: { description: 'calculate 2 + 3 * 4; then what is 15% of 240' } });
  const r2 = await h2.result;
  ok('two small calculations are not worth workers: the specialist did both', m.spawnedBy(h2.rootTaskId, 'data_agent').length === 0
    && r2.specialist.data?.['doneHere'] === 2, JSON.stringify(r2.specialist.data));
  ok('the combined answer has both exact results in order', /1\. .*= 14/.test(r2.answer) && /2\. .*= 36/.test(r2.answer), r2.answer);

  modelDown = false;
  maxInFlight = 0;
  const h3 = await m.startRootTask({ request: 'two analyses', specialistRole: 'data_agent', task: {
    description: 'estimate the monthly growth rate from the sales notes; then rank the three suppliers by delivery delays; then what is 2 + 2' } });
  const r3 = await h3.result;
  modelDown = true;
  const kids = m.spawnedBy(h3.rootTaskId, 'data_agent');
  ok('the two analyses went to two Data Analysis Workers', kids.length === 2 && kids.every((k) => k.role === 'data_analysis_worker' && k.status === 'COMPLETED'), kids.map((k) => `${k.role}/${k.status}`).join(', '));
  ok('the workers ran at the same time', maxInFlight >= 2, `max ${maxInFlight} model calls at once`);
  ok('the small calculation was done by the specialist while they worked', r3.specialist.data?.['doneHere'] === 1 && /3\. what is 2 \+ 2: 2 \+ 2 = 4/.test(r3.answer), r3.answer);
  ok('the answer keeps the request\'s order', /1\. estimate the monthly growth[\s\S]*2\. rank the three suppliers[\s\S]*3\. /.test(r3.answer));
  ok('workers have only data_tools at risk 0', kids.every((k) => {
    const a = m.agentOf(h3.rootTaskId, k.agentId)!;
    return a.permissions.maxRisk === 0 && a.permissions.tools.join() === 'data_tools';
  }));
  ok('no temporary agent is left after the root ended', !m.registry.all().some((a) => a.role === 'data_analysis_worker'));

  const agg = aggregateResults([
    { taskId: 't1', agentId: 'w1', role: 'x', status: 'COMPLETED', summary: 'a', findings: [], sources: [], artifacts: [], confidence: 0.9, limitations: [], usage: { llmCalls: 0, toolCalls: 0, tokens: 0 }, durationMs: 1 },
    { taskId: 't2', agentId: 'w2', role: 'x', status: 'FAILED', summary: '', findings: [], sources: [], artifacts: [], confidence: 0, limitations: ['boom'], error: { code: 'AGENT_ERROR', message: 'bad input' }, usage: { llmCalls: 0, toolCalls: 0, tokens: 0 }, durationMs: 1 },
  ], ['p1', 'p2']);
  ok('aggregation keeps a failed part visible and lowers confidence', /2\. p2: not done \(failed: bad input\)/.test(agg.summary) && agg.confidence === 0.45 && agg.limitations!.includes('w2 failed'), `${agg.summary} ${agg.confidence}`);
}

globalThis.fetch = realFetch;
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
