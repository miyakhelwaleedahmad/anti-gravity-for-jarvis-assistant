/**
 * tests/sevenAgentTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The seven-agent realignment (docs/agents/CHECKLIST.md):
 *
 *   Phase 1  the seven requested roles; no duplicates when roles are
 *            registered again or the manager is recreated; data_tools is
 *            exact and runs no code; the Data agent answers calculations
 *            directly and splits independent parts across parallel workers.
 *   Phase 2  assignment/acceptance/request-reply/failure/delegation messages,
 *            duplicate and stale messages dropped, messages cannot grant
 *            tools, versioned artifacts, approvals bound to agent and task.
 *   Phase 4  Memory (consistency check before storing), Desktop (diagnostics
 *            workers) and Verification (evidence re-read) workers.
 *   Phase 5  the verification pass: rules, verdicts, the evidence worker,
 *            JARVIS's pass over a real result, and the pass failing safely.
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
// Offline: one stand-in GitHub repository for the Evidence Check Worker; everything else fails.
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith('https://api.github.com/repos/acme/fast-tool')) {
    if (url.endsWith('/readme')) return new Response('# fast-tool', { status: 200 });
    if (url.endsWith('/contents/')) return json([{ name: 'LICENSE', type: 'file' }]);
    return json({ full_name: 'acme/fast-tool', html_url: 'https://github.com/acme/fast-tool', description: 'A tool', stargazers_count: 10, language: 'TypeScript', license: { spdx_id: 'MIT' }, topics: [], pushed_at: new Date().toISOString(), archived: false });
  }
  throw new Error('network is off in this test');
}) as typeof fetch;

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
  ok('every specialist can create workers', m.registry.all().filter((a) => a.permanent && a.agentId !== 'jarvis').every((a) => a.permissions.canSpawn && m.registry.role(a.role).allowedChildRoles.length > 0));
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

console.log('\n--- Phase 2: messages, artifacts, approvals ---');
{
  const { approvalGate } = await import('../security/approvalGate.js');
  type Ctx = import('../core/agents/agentContextApi.js').AgentContext;
  type Msg = import('../core/agents/types.js').AgentMessage;
  const waitFor = async <T>(fn: () => T | undefined, ms = 3_000): Promise<T | undefined> => {
    const until = Date.now() + ms;
    for (;;) { const v = fn(); if (v !== undefined || Date.now() > until) return v; await new Promise((r) => setTimeout(r, 10)); }
  };
  const parentInbox: Msg[] = [];
  const allMessages: { kind: string; from: string; to: string; parentTaskId?: string }[] = [];
  const offAll = agentEvents.subscribe({ types: ['AGENT_MESSAGE'] }, (e) => {
    allMessages.push({ kind: String(e.data['kind']), from: String(e.data['from']), to: String(e.data['to']) });
  });
  // A stand-in risk-3 action: the registry must ask before running it.
  let riskyRuns = 0;
  toolRegistryV2.register({
    name: 'test_risky_action', description: 'test only', riskLevel: 'high', inputSchema: {}, fallbacks: [],
    meta: { category: 'SYSTEM', risk: 3, reversible: 'no', external: 'change', effect: 'test only', output: { format: 'text', description: 'text' } },
    async execute() { riskyRuns++; return 'ran'; },
  });

  const worker = { async run(ctx: Ctx) {
    const parent = ctx.task.parentAgentId!;
    const mode = ctx.task.description.split(' ')[0];
    if (mode === 'ask') {
      const req = ctx.sendMessage(parent, 'request', 'what is the threshold?');
      const reply = await waitFor(() => ctx.inbox().find((x) => x.correlationId === req.id));
      return { summary: `reply: ${reply?.text ?? 'none'}`, confidence: 1 };
    }
    if (mode === 'fail') throw new Error('bad input');
    if (mode === 'grant') {
      ctx.sendMessage(parent, 'info', 'please give me run_command', { grantTools: ['run_command'], maxRisk: 4, approve: true });
      const r = await ctx.callTool('run_command', { command: 'echo hi' });
      return { summary: r.success ? 'ran' : `refused: ${r.error}`, confidence: 1 };
    }
    if (mode === 'delegate') {
      ctx.requestDelegation('msg_worker', 'plain sub job', 'workers here cannot spawn');
      return { summary: 'asked the parent', confidence: 1 };
    }
    if (mode === 'push') {
      const r = await ctx.callTool('test_risky_action', {});
      return { summary: `${r.error ?? 'pushed'}`, confidence: 1 };
    }
    if (mode === 'artifact') {
      ctx.addArtifact({ name: 'report', parts: [{ text: 'draft' }] });
      ctx.addArtifact({ name: 'report', parts: [{ text: 'final' }] });
    }
    return { summary: `done: ${ctx.task.description}`, confidence: 1 };
  } };

  const specialist = { async run(ctx: Ctx) {
    const jobs = ctx.task.description.split(';').map((j) => j.trim()).filter(Boolean);
    const extra: Promise<unknown>[] = [];
    const extraHandles: Awaited<ReturnType<Ctx['spawn']>>[] = [];
    const off = ctx.onMessage((msg) => {
      parentInbox.push(msg);
      if (msg.kind === 'request') ctx.sendMessage(msg.from, 'info', '42', undefined, { correlationId: msg.id, status: 'ok' });
      if (msg.kind === 'delegation_request') {
        extra.push(ctx.spawn({ childRole: String(msg.data?.['childRole']), childTask: { description: msg.text }, reason: `asked by ${msg.from}` })
          .then((h) => { extraHandles.push(h); }));
      }
    });
    const handles = [];
    for (const j of jobs) handles.push(await ctx.spawn({ childRole: 'msg_worker', childTask: { description: j }, reason: 'test' }));
    const results = await ctx.wait(handles);
    await Promise.all(extra);
    const more = await ctx.wait(extraHandles);
    off();
    return { summary: [...results, ...more].map((r) => `${r.status}:${r.summary}`).join(' | '), confidence: 1, data: { handles: handles.map((h) => h.agentId) } };
  } };

  const mm = new AgentManager(agentEvents, { ...loadAgentLimits({}) });
  mm.defineRole({ role: 'msg_specialist', name: 'Msg Specialist', description: 'test', capabilities: [], supportedTaskTypes: [],
    tools: ['test_risky_action', 'data_tools'], maxRisk: 3, canSpawn: true, allowedChildRoles: ['msg_worker'], permanent: true, version: '1', behavior: specialist });
  mm.defineRole({ role: 'msg_worker', name: 'Msg Worker', description: 'test', capabilities: [], supportedTaskTypes: [],
    tools: ['test_risky_action', 'data_tools'], maxRisk: 3, canSpawn: false, allowedChildRoles: [], version: '1', behavior: worker });

  // 1. assignment, acceptance, request/reply, completion, failure
  const h = await mm.startRootTask({ request: 'msgs', specialistRole: 'msg_specialist', task: { description: 'ask; fail now' } });
  const r = await h.result;
  const kinds = parentInbox.filter((x) => x.rootTaskId === h.rootTaskId).map((x) => x.kind);
  ok('the parent got acceptance, request, completion and failure messages', ['acceptance', 'request', 'completion', 'failure'].every((k) => kinds.includes(k as Msg['kind'])), kinds.join(','));
  const [askId, failId] = (r.specialist.data?.['handles'] as string[]);
  ok('each child got an assignment message from its parent', [askId, failId].every((id) => allMessages.some((x) => x.kind === 'assignment' && x.from === 'msg_specialist' && x.to === id)),
    allMessages.map((x) => `${x.kind}>${x.to}`).join(','));
  ok('the reply carried the request\'s correlationId and reached the asker', /fail|COMPLETED:reply: 42/.test(r.answer) && r.answer.includes('COMPLETED:reply: 42'), r.answer);
  const failure = parentInbox.find((x) => x.kind === 'failure' && x.from === failId);
  ok('a failed child sent a failure message with its error', failure?.status === 'failed' && failure.error?.code === 'AGENT_ERROR' && /bad input/.test(failure.error.message), JSON.stringify(failure));

  // 2. duplicates and stale messages
  const dup: Msg = { id: 'dup-1', from: 'msg_specialist', to: askId!, rootTaskId: h.rootTaskId, kind: 'info', text: 'x', at: Date.now() };
  ok('a message to an agent whose task ended is not delivered', mm.deliver(dup) === false);
  const live: Msg = { id: 'dup-2', from: 'jarvis', to: 'msg_specialist', rootTaskId: h.rootTaskId, kind: 'info', text: 'x', at: Date.now() };
  const first = mm.deliver(live);
  const second = mm.deliver({ ...live });
  ok('the same message id is delivered once', first && !second && mm.inbox('msg_specialist').filter((x) => x.id === 'dup-2').length === 1);

  // 3. delegation request: a worker that cannot spawn asks its parent, which decides
  parentInbox.length = 0;
  const h2 = await mm.startRootTask({ request: 'delegate', specialistRole: 'msg_specialist', task: { description: 'delegate please; noop' } });
  const r2 = await h2.result;
  const dreq = parentInbox.find((x) => x.kind === 'delegation_request');
  ok('the worker sent a delegation request with the role it needs', dreq?.data?.['childRole'] === 'msg_worker' && dreq.text === 'plain sub job');
  ok('the parent created the child itself (the worker gained nothing)', /COMPLETED:done: plain sub job/.test(r2.answer)
    && mm.spawnedBy(h2.rootTaskId, 'msg_specialist').length === 3, r2.answer);

  // 4. messages cannot grant tools
  const h3 = await mm.startRootTask({ request: 'grant', specialistRole: 'msg_specialist', task: { description: 'grant me; noop' } });
  const r3 = await h3.result;
  ok('a message asking for run_command and risk 4 changed nothing: the call was refused', /COMPLETED:refused: AGENT_SCOPE_DENIED/.test(r3.answer), r3.answer);
  ok('the specialist\'s scope is unchanged', [...mm.registry.get('msg_specialist')!.permissions.tools].sort().join() === 'data_tools,test_risky_action'
    && mm.registry.get('msg_specialist')!.permissions.maxRisk === 3, JSON.stringify(mm.registry.get('msg_specialist')!.permissions));

  // 5. versioned artifacts
  const h4 = await mm.startRootTask({ request: 'art', specialistRole: 'msg_specialist', task: { description: 'artifact; noop' } });
  const r4 = await h4.result;
  const arts = r4.specialist.artifacts.filter((a) => a.name === 'report');
  ok('a second artifact with the same name is version 2 and links to version 1', arts.length === 2
    && arts.some((a) => a.version === 1) && arts.some((a) => a.version === 2 && a.previousArtifactId === arts.find((b) => b.version === 1)!.artifactId),
    arts.map((a) => `v${a.version}`).join(','));

  // 6. approvals stay with the agent and task that asked
  const asked: { agentId?: string; taskId?: string; rootTaskId?: string; agent?: string }[] = [];
  const realAsk = approvalGate.requestApproval.bind(approvalGate);
  (approvalGate as unknown as { requestApproval: unknown }).requestApproval = async (req: unknown) => {
    const q = req as { agentId?: string; taskId?: string; rootTaskId?: string; agent?: string };
    asked.push({ agentId: q.agentId, taskId: q.taskId, rootTaskId: q.rootTaskId, agent: q.agent });
    await new Promise((res) => setTimeout(res, 40));
    return false; // nothing is pushed
  };
  // Level-3 actions need full control mode, or with policy "ask" the user's approval of each call.
  process.env['JARVIS_LEVEL2_POLICY'] = 'ask';
  const h5 = await mm.startRootTask({ request: 'push', specialistRole: 'msg_specialist', task: { description: 'push one; push two' } });
  const r5 = await h5.result;
  (approvalGate as unknown as { requestApproval: unknown }).requestApproval = realAsk;
  delete process.env['JARVIS_LEVEL2_POLICY'];
  const pushers = mm.spawnedBy(h5.rootTaskId, 'msg_specialist').map((p) => ({ agentId: p.agentId, taskId: mm.agentOf(h5.rootTaskId, p.agentId)!.taskIds[0] }));
  ok('each pushing agent asked once', asked.length === 2, JSON.stringify(asked));
  ok('each request names the agent, task and root task that asked', pushers.every((p) => asked.some((a) => a.agentId === p.agentId && a.taskId === p.taskId && a.rootTaskId === h5.rootTaskId)),
    `${JSON.stringify(asked)} vs ${pushers.map((p) => `${p.agentId}/${p.taskId}`).join(',')}`);
  ok('a denial reaches only the call that asked; nothing ran', (r5.answer.match(/APPROVAL_DENIED/g) ?? []).length === 2 && riskyRuns === 0, r5.answer);
  offAll();
}

console.log('\n--- Phase 4: Memory, Desktop and Verification workers ---');
{
  const { proposeMemoryOperation, parseFacts, factToRemember } = await import('../core/agents/behaviors/memory.js');
  const { memoryManager } = await import('../memory/memoryManager.js');
  const stored = ['my exam is on Friday at nine', 'my sister lives in Lahore'];
  (memoryManager as unknown as { searchFacts: unknown }).searchFacts = async () => stored.map((fact, i) => ({ id: `f${i}`, fact, importance: 5 }));

  ok('mem0-style proposal: same fact → NONE, related → UPDATE, new → ADD',
    proposeMemoryOperation('my exam is on Friday at nine', stored).operation === 'NONE'
    && proposeMemoryOperation('my exam is on Monday at nine', stored).operation === 'UPDATE'
    && proposeMemoryOperation('I prefer dark mode in VS Code', stored).operation === 'ADD',
    JSON.stringify(['my exam is on Monday at nine', 'I prefer dark mode in VS Code'].map((f) => proposeMemoryOperation(f, stored))));
  ok('search_memory lines are read back as facts', JSON.stringify(parseFacts('1. [importance: 5] a fact\n2. [importance: 3] another')) === '["a fact","another"]'
    && parseFacts('No relevant facts found in memory.').length === 0);
  ok('"remember that …" is recognised', factToRemember('Please remember that my exam is on Friday.') === 'my exam is on Friday');

  calls.length = 0;
  const h = await m.startRootTask({ request: 'remember', specialistRole: 'memory_agent', task: { description: 'Remember that my exam is on Friday at nine' } });
  const r = await h.result;
  const kids = m.spawnedBy(h.rootTaskId, 'memory_agent');
  ok('the Memory agent asked a Consistency Worker before storing', kids.length === 1 && kids[0]!.role === 'memory_consistency_worker', kids.map((k) => k.role).join(','));
  ok('an already-known fact is not stored again', /already remember/.test(r.answer) && !calls.includes('save_relation'), r.answer);
  const consistency = m.agentOf(h.rootTaskId, kids[0]!.agentId)!;
  ok('the Consistency Worker can only read memory', consistency.permissions.tools.join() === 'search_memory' && consistency.permissions.maxRisk === 0);

  const h2 = await m.startRootTask({ request: 'remember', specialistRole: 'memory_agent', task: { description: 'Remember that I prefer dark mode in VS Code' } });
  const r2 = await h2.result;
  ok('a new fact is proposed as ADD (stored only through save_relation and the registry)', (r2.specialist.data?.['proposal'] as { operation?: string })?.operation === 'ADD', JSON.stringify(r2.specialist.data));

  modelDown = false;
  const h3 = await m.startRootTask({ request: 'diagnose', specialistRole: 'pc_agent', task: { description: 'why is the local server not working; why is Chrome so slow' } });
  const r3 = await h3.result;
  modelDown = true;
  const dkids = m.spawnedBy(h3.rootTaskId, 'pc_agent');
  ok('the Desktop agent sent "why … not working" parts to System Diagnostics Workers', dkids.length === 2 && dkids.every((k) => k.role === 'system_diagnostics_worker'), dkids.map((k) => k.role).join(',') + ' ' + r3.status);
  ok('diagnostics workers are read-only (risk 0)', dkids.every((k) => m.agentOf(h3.rootTaskId, k.agentId)!.permissions.maxRisk === 0));
}

console.log('\n--- Phase 5: independent verification ---');
{
  const { checkResult, verdictOf, repoOf } = await import('../core/agents/behaviors/verify.js');
  const { shouldVerify, verifyRootResult, verificationReport, completionSpeech, verificationInput } = await import('../core/agents/jarvisAgents.js');
  const base = { specialistRole: 'research_agent', status: 'COMPLETED', answer: 'fast-tool is the best fit.', confidence: 0.7, conflicts: [], limitations: [] };

  const good = checkResult({ ...base, findings: [{ text: 'fast-tool is MIT', sourceIds: ['s1'], confidence: 0.8 }], sources: [{ id: 's1', title: 'fast-tool', url: 'https://github.com/acme/fast-tool' }] });
  ok('a sourced, settled result is verified', verdictOf(good) === 'verified', JSON.stringify(good.filter((c) => !c.ok)));
  const unsourced = checkResult({ ...base, findings: [{ text: 'X is fastest', sourceIds: [], confidence: 0.9 }], sources: [] });
  ok('a research claim with high confidence and no source is an issue', verdictOf(unsourced) === 'issues' && unsourced.some((c) => c.name === 'sourced' && !c.ok));
  const dangling = checkResult({ ...base, findings: [{ text: 'Y', sourceIds: ['gone'], confidence: 0.5 }], sources: [] });
  ok('a finding citing a missing source is an issue', dangling.some((c) => c.name === 'citations' && !c.ok));
  const conflicted = checkResult({ ...base, findings: [], sources: [], conflicts: [{ subject: 'fast-tool', attribute: 'licence', status: 'unresolved' }] });
  ok('an unsettled conflict is an issue', conflicted.some((c) => c.name === 'conflicts' && !c.ok));
  const overconfident = checkResult({ ...base, specialistRole: 'data_agent', confidence: 0.9, findings: [], sources: [] });
  ok('high confidence with no evidence is an issue', overconfident.some((c) => c.name === 'confidence' && !c.ok));
  const hidden = checkResult({ ...base, confidence: 0.9, findings: [{ text: 'a', sourceIds: [], confidence: 0.5 }], sources: [], limitations: ['Tool refused or failed: web_search'] });
  ok('high confidence despite a failed tool is an issue', hidden.some((c) => c.name === 'failures weighed' && !c.ok));
  const fallback = checkResult({ ...base, confidence: 0.9, findings: [{ text: 'a', sourceIds: [], confidence: 0.5 }], sources: [], limitations: ['Planning: the model was not available (503); rules were used instead.'] });
  ok('a model falling back to rules is not counted as a tool failure', fallback.every((c) => c.name !== 'failures weighed' || c.ok));
  ok('an unfinished task is "unverified"', verdictOf(checkResult({ ...base, status: 'TIMED_OUT', findings: [], sources: [] })) === 'unverified');
  ok('GitHub URLs are read as owner/name', repoOf('https://github.com/acme/fast-tool/tree/main') === 'acme/fast-tool' && repoOf('https://example.com/x') === undefined);

  // The Verification agent re-reads a cited GitHub source with an Evidence Check Worker.
  const claim = { ...base, answer: 'fast-tool (GPL-3.0) is the best fit.', findings: [{ text: 'fast-tool fits', sourceIds: ['s1'], confidence: 0.8 }], sources: [{ id: 's1', title: 'fast-tool', url: 'https://github.com/acme/fast-tool' }] };
  const hv = await m.startRootTask({ request: 'verify', specialistRole: 'qa_agent', task: { description: 'Verify the research result', input: { verify: claim } } });
  const rv = await hv.result;
  const v = rv.specialist.data?.['verification'] as { verdict: string; checks: { name: string; ok: boolean; note: string }[] } | undefined;
  const vk = m.spawnedBy(hv.rootTaskId, 'qa_agent');
  ok('the Verification agent created an Evidence Check Worker', vk.length === 1 && vk[0]!.role === 'evidence_check_worker', vk.map((k) => k.role).join(','));
  ok('it caught the wrong licence in the answer (MIT on GitHub, GPL-3.0 in the answer)', v?.verdict === 'issues' && v.checks.some((c) => c.name === 'source re-read' && !c.ok && /MIT/.test(c.note)), JSON.stringify(v?.checks.find((c) => c.name === 'source re-read')));
  ok('the worker held only github_repo', m.agentOf(hv.rootTaskId, vk[0]!.agentId)!.permissions.tools.join() === 'github_repo');

  // JARVIS's verification pass over a real Data agent result.
  const hd = await m.startRootTask({ request: 'average', specialistRole: 'data_agent', task: { description: 'What is the average of 4, 8 and 12?' } });
  const rd = await hd.result;
  ok('data, research and engineering results are verified; others are not', shouldVerify(rd)
    && !shouldVerify({ ...rd, specialist: { ...rd.specialist, role: 'browser_agent' } })
    && !shouldVerify({ ...rd, specialist: { ...rd.specialist, role: 'qa_agent' } })
    && !shouldVerify({ ...rd, status: 'FAILED' }));
  process.env['JARVIS_AGENT_VERIFY'] = '0';
  ok('JARVIS_AGENT_VERIFY=0 turns the pass off', !shouldVerify(rd));
  delete process.env['JARVIS_AGENT_VERIFY'];
  const vd = await verifyRootResult(rd, 'average', m);
  ok('the Data agent\'s exact result is verified', vd?.verdict === 'verified', JSON.stringify(vd?.checks.filter((c) => !c.ok)));
  ok('the report shows the verdict', verificationReport(vd, true).some((l) => /^Verification: verified \(\d+\/\d+ checks passed/.test(l)));
  ok('the verifier saw only the result, not the workspace', Object.keys(verificationInput(rd)).sort().join() === 'answer,confidence,conflicts,findings,limitations,sources,specialistRole,status');

  // The verifier is not a single point of failure.
  const broken = new AgentManager(agentEvents, { ...loadAgentLimits({}) }); // no roles: the check cannot start
  const none = await verifyRootResult(rd, 'average', broken);
  ok('when the check cannot run, the result is still reported, marked not verified', none === undefined
    && verificationReport(none, true).join(' ').includes('not verified')
    && completionSpeech(rd, none).startsWith('Sir, the Data Agent has finished.'));
  ok('a result with issues says so when spoken', /found problems/.test(completionSpeech(rd, { verdict: 'issues', checks: [], issues: ['x'], checkedBy: 'qa_agent', at: 0 })));
}

globalThis.fetch = realFetch;
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
