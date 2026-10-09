/**
 * tests/agentRuntimeTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The multi-agent core (core/agents): the Agent Factory's checks, the child
 * lifecycle, limits, permissions, dependencies, cancellation, timeouts,
 * retries, the shared workspace, events, messages, cleanup and the archive.
 *
 * Roles and behaviours here are stand-ins written for the test; tools are
 * stand-ins registered in the real toolRegistryV2, so tool calls go through
 * the real registry pipeline. Nothing on the PC is changed and no model is
 * called (modelRouter.chat is replaced).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agents-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspaceDir, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspaceDir;
process.env['JARVIS_DATA_ROOT'] = workspaceDir;

const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { isSubsetScope, covers } = await import('../core/agents/permissions.js');
const { SpawnRejectedError } = await import('../core/agents/agentContextApi.js');
const { AgentTaskManager } = await import('../core/agents/taskManager.js');
const { runAsAgent } = await import('../core/agents/agentScope.js');
const { getRequestText, getAgentPath, beginTrace, endTrace } = await import('../core/traceContext.js');
const { buildApprovalRequest, formatApprovalRequest, spokenApprovalRequest } = await import('../security/approvalRequest.js');
type AgentContext = import('../core/agents/agentContextApi.js').AgentContext;
type AgentOutcome = import('../core/agents/types.js').AgentOutcome;
type AgentEvent = import('../core/agents/types.js').AgentEvent;
type ChildHandle = import('../core/agents/agentContextApi.js').ChildHandle;
type AgentManagerT = InstanceType<typeof AgentManager>;

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Stand-in tools ───────────────────────────────────────────────────────────

const toolCalls: string[] = [];
toolRegistryV2.register({
  name: 'test_lookup',
  description: 'Stand-in read-only lookup.',
  riskLevel: 'low',
  meta: { category: 'OBSERVATION', risk: 0, reversible: 'yes', external: 'none', effect: 'Reads test data.', output: { format: 'text', description: 'Text' } },
  inputSchema: { q: { type: 'string', description: 'query', required: false } },
  fallbacks: [],
  async execute(args) {
    toolCalls.push(String(args['q'] ?? ''));
    return `result for ${String(args['q'] ?? '')}`;
  },
});
let writeRan = false;
toolRegistryV2.register({
  name: 'test_write',
  description: 'Stand-in risk-2 write.',
  riskLevel: 'medium',
  meta: { category: 'FILESYSTEM', risk: 2, reversible: 'yes', external: 'none', effect: 'Writes test data.', output: { format: 'text', description: 'Text' } },
  inputSchema: {},
  fallbacks: [],
  async execute() { writeRan = true; return 'written'; },
});

// ── Stand-in model ───────────────────────────────────────────────────────────

let llmActive = 0;
let llmMax = 0;
let llmCalls = 0;
modelRouter.chat = (async () => {
  llmCalls++;
  llmActive++;
  llmMax = Math.max(llmMax, llmActive);
  await sleep(40);
  llmActive--;
  return { content: 'stub answer', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
}) as typeof modelRouter.chat;

// ── Scripted roles ───────────────────────────────────────────────────────────

type Scenario = (ctx: AgentContext) => Promise<AgentOutcome>;
const scenarios = new Map<string, Scenario>();
const scripted = { run: (ctx: AgentContext) => {
  const name = String(ctx.input['scenario'] ?? 'noop');
  const fn = scenarios.get(name);
  if (!fn) throw new Error(`no scenario ${name}`);
  return fn(ctx);
} };
scenarios.set('noop', async () => ({ summary: 'done', confidence: 1 }));

function defineRoles(m: AgentManagerT): void {
  m.defineRole({
    role: 'test_specialist', name: 'Test Specialist', description: 'Permanent stand-in specialist.',
    capabilities: ['research', 'synthesis'], supportedTaskTypes: [], tools: ['test_lookup', 'test_write', 'get_system_info'],
    maxRisk: 2, canSpawn: true, allowedChildRoles: ['test_worker', 'test_mid'], permanent: true, version: '1.0.0',
    behavior: scripted,
  });
  m.defineRole({
    role: 'test_mid', name: 'Mid Worker', description: 'Worker that may spawn.',
    capabilities: ['research'], supportedTaskTypes: [], tools: ['test_lookup', 'test_write'],
    maxRisk: 2, canSpawn: true, allowedChildRoles: ['test_worker', 'test_mid'], version: '1.0.0', behavior: scripted,
  });
  m.defineRole({
    role: 'test_worker', name: 'Worker', description: 'Leaf-ish worker.',
    capabilities: ['research'], supportedTaskTypes: ['lookup'], tools: ['test_lookup'],
    maxRisk: 1, canSpawn: true, allowedChildRoles: ['test_worker'], version: '1.0.0', behavior: scripted,
  });
}

function newManager(changes: Partial<ReturnType<typeof loadAgentLimits>> = {}): AgentManagerT {
  const m = new AgentManager(agentEvents, { ...loadAgentLimits({}), ...changes });
  defineRoles(m);
  return m;
}

function record(rootFilter: () => string | undefined): AgentEvent[] {
  const list: AgentEvent[] = [];
  agentEvents.subscribe({}, (e) => { if (e.rootTaskId === rootFilter()) list.push(e); });
  return list;
}

/** A worker that does `units` lookups, shares a finding and returns. */
let running = 0;
let maxRunning = 0;
scenarios.set('work', async (ctx) => {
  running++;
  maxRunning = Math.max(maxRunning, running);
  try {
    ctx.progress('looking up', 10);
    const r = await ctx.callTool('test_lookup', { q: String(ctx.input['q'] ?? ctx.task.description) });
    const src = ctx.addSource({ url: String(ctx.input['url'] ?? 'https://example.com/x'), title: 'Example', kind: 'web', quality: 0.8 });
    ctx.addFinding({ text: String(ctx.input['finding'] ?? r.output), sourceIds: [src.id], confidence: 0.7 });
    await sleep(Number(ctx.input['delayMs'] ?? 60));
    return { summary: `found ${r.output}`, confidence: 0.7, data: { q: ctx.input['q'] } };
  } finally {
    running--;
  }
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n=== Multi-agent runtime ===\n');

console.log('--- 1. JARVIS delegates to a specialist; it creates concurrent workers; results flow up ---');
{
  const m = newManager();
  let rootId: string | undefined;
  const events = record(() => rootId);
  scenarios.set('fanout', async (ctx) => {
    const decision = ctx.decideSpawn({
      subtasks: ['alpha', 'beta', 'gamma'].map((n) => ({ description: `Look up project ${n}`, role: 'test_worker', estimatedUnits: 2 })),
    });
    const handles: ChildHandle[] = [];
    for (const p of decision.plan.filter((x) => x.action === 'SPAWN')) {
      const n = ['alpha', 'beta', 'gamma'][p.index];
      handles.push(await ctx.spawn({
        childRole: 'test_worker', childTask: { description: `Look up project ${n}`, input: { scenario: 'work', q: n, url: `https://example.com/${n}`, finding: `Project ${n} exists`, delayMs: 120 } },
        reason: `project ${n} is independent`,
      }));
    }
    const results = await ctx.wait(handles);
    ctx.workspace.setFinalSynthesis(`Three projects: ${results.map((r) => r.data?.['q']).join(', ')}`, 0.8, ctx.agent.agentId);
    return { summary: 'synthesised', confidence: 0.8, data: { decision: decision.decision, childStatuses: results.map((r) => r.status), recommendedNextActions: ['compare them'] } };
  });
  maxRunning = 0;
  const handle = await m.startRootTask({ request: 'Find three projects', specialistRole: 'test_specialist', task: { description: 'Find three projects', input: { scenario: 'fanout' } } });
  rootId = handle.rootTaskId;
  ok('startRootTask returns at once with ids', !!handle.rootTaskId && !!handle.taskId && handle.agentId === 'test_specialist');
  const res = await handle.result;
  ok('the root task completed', res.status === 'COMPLETED', res.status);
  ok('the specialist decided to spawn', res.specialist.data?.['decision'] === 'SPAWN');
  ok('all three workers completed', JSON.stringify(res.specialist.data?.['childStatuses']) === JSON.stringify(['COMPLETED', 'COMPLETED', 'COMPLETED']));
  ok('workers ran at the same time', maxRunning >= 2, `max ${maxRunning} at once`);
  ok('JARVIS gets the final answer', res.answer.startsWith('Three projects'), res.answer);
  ok('JARVIS gets findings and their sources', res.findings.length === 3 && res.sources.length === 3, `${res.findings.length} findings, ${res.sources.length} sources`);
  ok('JARVIS gets confidence, limitations and next actions', res.confidence === 0.8 && Array.isArray(res.limitations) && res.recommendedNextActions[0] === 'compare them');
  const types = new Set(events.map((e) => e.type));
  for (const t of ['TASK_CREATED', 'TASK_ASSIGNED', 'TASK_STARTED', 'PROGRESS_UPDATE', 'FINDING_DISCOVERED', 'RESULT_AVAILABLE', 'TASK_COMPLETED', 'AGENT_CREATED', 'AGENT_STOPPED', 'SPAWN_DECISION'] as const) {
    ok(`event ${t} was emitted`, types.has(t));
  }
  const seqs = events.map((e) => e.seq);
  ok('event sequence numbers increase', seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
  const started = events.filter((e) => e.type === 'AGENT_STATE_CHANGED' && e.agentId?.startsWith('test_worker')).map((e) => `${e.data['from']}>${e.data['to']}`);
  ok('a worker went CREATED > VALIDATING > STARTING > RUNNING > COMPLETED',
    ['CREATED>VALIDATING', 'VALIDATING>STARTING', 'STARTING>RUNNING', 'RUNNING>COMPLETED'].every((s) => started.includes(s)));
  ok('the tool calls went through the registry', toolCalls.filter((q) => ['alpha', 'beta', 'gamma'].includes(q)).length === 3);
  const tree = m.renderTaskTree(handle.rootTaskId);
  ok('the task tree shows JARVIS, the specialist and three workers', tree.split('\n').length === 5 && tree.includes('Test Specialist') && tree.includes('Worker'), `\n${tree}`);
  ok('after the root ends, its temporary agents are gone from the registry', m.registry.all().every((a) => a.permanent));
  ok('the specialist is READY again', m.registry.get('test_specialist')?.status === 'READY');
  const archive = path.join(workspaceDir, 'data', 'agents', `${handle.rootTaskId}.json`);
  ok('the root task is archived', fs.existsSync(archive) && JSON.parse(fs.readFileSync(archive, 'utf8')).status === 'COMPLETED');
  ok('ended roots are still visible to status questions', m.tasksOfRoot(handle.rootTaskId).length === 5 && Object.keys(m.findingsByAgent(handle.rootTaskId)).length === 3);
}

console.log('\n--- 2. Global concurrency limit and the model-call limit ---');
{
  const m = newManager({ maxConcurrentAgents: 2, maxConcurrentLlmCalls: 1 });
  scenarios.set('fan4', async (ctx) => {
    const hs: ChildHandle[] = [];
    for (const n of [1, 2, 3, 4]) hs.push(await ctx.spawn({ childRole: 'test_worker', childTask: { description: `part ${n}`, input: { scenario: 'llmwork', n } } }));
    const rs = await ctx.wait(hs);
    return { summary: 'ok', confidence: 1, data: { statuses: rs.map((r) => r.status) } };
  });
  scenarios.set('llmwork', async (ctx) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      await ctx.llm({ messages: [{ role: 'user', content: 'hi' }] });
      await sleep(60);
      return { summary: 'ok', confidence: 1 };
    } finally { running--; }
  });
  maxRunning = 0; llmMax = 0;
  const h = await m.startRootTask({ request: 'four parts', specialistRole: 'test_specialist', task: { description: 'four parts', input: { scenario: 'fan4' } } });
  const r = await h.result;
  ok('all four children completed', JSON.stringify(r.specialist.data?.['statuses']) === JSON.stringify(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED']));
  ok('never more agents at work than the limit (2)', maxRunning <= 2 && maxRunning >= 1, `max ${maxRunning}`);
  ok('never more model calls at once than the limit (1)', llmMax === 1, `max ${llmMax}`);
  ok('children\'s model calls and tokens are charged to the parent too', r.specialist.usage.llmCalls === 4 && r.specialist.usage.tokens === 60,
    `${r.specialist.usage.llmCalls} calls, ${r.specialist.usage.tokens} tokens`);
}

console.log('\n--- 3. Dependencies: B waits for A and receives its result; a failed dependency fails B; cycles are refused ---');
{
  const m = newManager();
  scenarios.set('produce', async () => { await sleep(80); return { summary: 'items', confidence: 0.9, data: { items: ['A', 'B', 'C'] } }; });
  scenarios.set('consume', async (ctx) => {
    const got = Object.values(ctx.dependencyResults).flatMap((r) => (r.data?.['items'] as string[]) ?? []);
    return { summary: `analysed ${got.join('')}`, confidence: 0.9, data: { got } };
  });
  scenarios.set('boom', async () => { throw new Error('discovery failed'); });
  scenarios.set('deps', async (ctx) => {
    const a = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'discover', input: { scenario: 'produce' } } });
    const b = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'analyse', input: { scenario: 'consume' } }, dependencies: [a.taskId] });
    const a2 = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'discover again', input: { scenario: 'boom' } } });
    const b2 = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'analyse again', input: { scenario: 'consume' } }, dependencies: [a2.taskId] });
    const [ra, rb, , rb2] = await ctx.wait([a, b, a2, b2]);
    const ta = m.tasks.get(a.taskId)!;
    const tb = m.tasks.get(b.taskId)!;
    return { summary: 'ok', confidence: 1, data: { rb: rb.data?.['got'], ra: ra.status, rb2: rb2.status, rb2err: rb2.error?.code, order: (tb.startedAt ?? 0) >= (ta.completedAt ?? Infinity) } };
  });
  let rootId: string | undefined;
  const events = record(() => rootId);
  const h = await m.startRootTask({ request: 'deps', specialistRole: 'test_specialist', task: { description: 'deps', input: { scenario: 'deps' } } });
  rootId = h.rootTaskId;
  const r = await h.result;
  const d = r.specialist.data ?? {};
  ok('B received A\'s result', JSON.stringify(d['rb']) === JSON.stringify(['A', 'B', 'C']));
  ok('B started only after A completed', d['order'] === true);
  ok('B reported TASK_BLOCKED while waiting', events.some((e) => e.type === 'TASK_BLOCKED'));
  ok('a failed dependency fails the dependent task with DEPENDENCY_FAILED', d['rb2'] === 'FAILED' && d['rb2err'] === 'DEPENDENCY_FAILED', `${d['rb2']} ${d['rb2err']}`);
  ok('the parent still completed', r.status === 'COMPLETED');

  const tm = new AgentTaskManager(agentEvents);
  const root = tm.create({ agentId: 'x', role: 'x', description: 'root', deadline: Date.now() + 10_000 });
  const t1 = tm.create({ parentTaskId: root.taskId, agentId: 'y', role: 'y', description: 't1', deadline: Date.now() + 10_000 });
  const t2 = tm.create({ parentTaskId: root.taskId, agentId: 'z', role: 'z', description: 't2', deadline: Date.now() + 10_000, dependencies: [t1.taskId] });
  let cycle = '';
  try { tm.addDependency(t1.taskId, t2.taskId); } catch (e) { cycle = (e as Error).message; }
  ok('a dependency that closes a cycle is refused when added', /cycle/.test(cycle), cycle);
  let self = '';
  try { tm.addDependency(t1.taskId, t1.taskId); } catch (e) { self = (e as Error).message; }
  ok('a task cannot depend on itself', /cycle/.test(self));
  tm.cancel(root.taskId, 'cleanup', 'user');
}

console.log('\n--- 4. Recursion: child and grandchild; the depth limit and the leaf rule ---');
{
  const m = newManager({ maxDepth: 3 });
  scenarios.set('deep', async (ctx) => {
    const depth = ctx.agent.depth;
    if (depth >= 3) {
      let code = '';
      try { await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'go deeper still', input: { scenario: 'noop' } } }); } catch (e) { code = (e as InstanceType<typeof SpawnRejectedError>).code; }
      const decision = ctx.decideSpawn({ subtasks: [{ description: 'x1', role: 'test_worker', estimatedUnits: 3 }, { description: 'x2', role: 'test_worker', estimatedUnits: 3 }] });
      return { summary: 'leaf did it itself', confidence: 1, data: { code, canSpawn: ctx.agent.permissions.canSpawn, decision: decision.decision, reason: decision.reasons[0] } };
    }
    const child = await ctx.spawn({ childRole: depth === 1 ? 'test_mid' : 'test_worker', childTask: { description: depth === 1 ? 'organise the middle layer' : 'do the leaf work', input: { scenario: 'deep' } } });
    const [r] = await ctx.wait([child]);
    return { summary: `depth ${depth}`, confidence: 1, data: { below: r.data } };
  });
  const h = await m.startRootTask({ request: 'deep', specialistRole: 'test_specialist', task: { description: 'deep', input: { scenario: 'deep' } } });
  const r = await h.result;
  const leaf = (r.specialist.data?.['below'] as Record<string, unknown>)?.['below'] as Record<string, unknown>;
  ok('a child (depth 2) and a grandchild (depth 3) were created', !!leaf && r.status === 'COMPLETED');
  ok('the agent at the depth limit has no spawn right (leaf rule)', leaf?.['canSpawn'] === false);
  ok('its spawn attempt is rejected with DEPTH_LIMIT', leaf?.['code'] === 'DEPTH_LIMIT', String(leaf?.['code']));
  ok('the spawn policy tells it to do the work itself', leaf?.['decision'] === 'SELF' && /depth limit/.test(String(leaf?.['reason'])), String(leaf?.['reason']));
}

console.log('\n--- 5. Children per agent and total active agents ---');
{
  const m = newManager({ maxChildrenPerAgent: 2 });
  scenarios.set('many', async (ctx) => {
    const hs = [];
    for (const n of [1, 2]) hs.push(await ctx.spawn({ childRole: 'test_worker', childTask: { description: `slow ${n}`, input: { scenario: 'work', delayMs: 100 } } }));
    let code = '';
    try { await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'slow 3', input: { scenario: 'work' } } }); } catch (e) { code = (e as InstanceType<typeof SpawnRejectedError>).code; }
    await ctx.wait(hs);
    const after = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'slow 4', input: { scenario: 'noop' } } });
    await ctx.wait([after]);
    return { summary: 'ok', confidence: 1, data: { code } };
  });
  const r = await (await m.startRootTask({ request: 'many', specialistRole: 'test_specialist', task: { description: 'many', input: { scenario: 'many' } } })).result;
  ok('a third active child is rejected with CHILD_LIMIT', r.specialist.data?.['code'] === 'CHILD_LIMIT');
  ok('once children finish, new ones are allowed', r.status === 'COMPLETED');

  const m2 = newManager({ maxActiveAgents: 2 });
  scenarios.set('global', async (ctx) => {
    const hs = [];
    for (const n of [1, 2]) hs.push(await ctx.spawn({ childRole: 'test_worker', childTask: { description: `g ${n}`, input: { scenario: 'work', delayMs: 100 } } }));
    let code = '';
    try { await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'g 3', input: { scenario: 'noop' } } }); } catch (e) { code = (e as InstanceType<typeof SpawnRejectedError>).code; }
    await ctx.wait(hs);
    return { summary: 'ok', confidence: 1, data: { code } };
  });
  const r2 = await (await m2.startRootTask({ request: 'global', specialistRole: 'test_specialist', task: { description: 'global', input: { scenario: 'global' } } })).result;
  ok('a third agent system-wide is rejected with ACTIVE_LIMIT', r2.specialist.data?.['code'] === 'ACTIVE_LIMIT', String(r2.specialist.data?.['code']));
}

console.log('\n--- 6. Permissions: inherited, never wider than the parent, enforced on every call ---');
{
  const m = newManager();
  const scopes: { child: any; parent: any }[] = [];
  scenarios.set('perm-child', async (ctx) => {
    const lookup = await ctx.callTool('test_lookup', { q: 'ok' });
    const write = await ctx.callTool('test_write', {});
    const fullControl = await ctx.callTool('enable_full_control_session', {});
    return { summary: 'ok', confidence: 1, data: { lookup: lookup.success, write: write.error, full: fullControl.error, scope: ctx.agent.permissions } };
  });
  scenarios.set('perm', async (ctx) => {
    const tryCode = async (req: any) => {
      try { await ctx.spawn(req); return 'created'; } catch (e) { return (e as InstanceType<typeof SpawnRejectedError>).code; }
    };
    const notInParent = await tryCode({ childRole: 'test_worker', childTask: { description: 'kill things' }, allowedTools: ['control_process'] });
    const notInRole = await tryCode({ childRole: 'test_worker', childTask: { description: 'write things' }, allowedTools: ['test_write'] });
    const riskUp = await tryCode({ childRole: 'test_mid', childTask: { description: 'risky things' }, permissionScope: { maxRisk: 3 } });
    const denied = await tryCode({ childRole: 'test_mid', childTask: { description: 'session things' }, allowedTools: ['enable_full_control_session'] });
    const worker = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'look and try to write', input: { scenario: 'perm-child' } } });
    const lowMid = await ctx.spawn({ childRole: 'test_mid', childTask: { description: 'low-risk mid', input: { scenario: 'perm-child' } }, permissionScope: { maxRisk: 1 } });
    const [rw, rm] = await ctx.wait([worker, lowMid]);
    scopes.push({ child: rw.data?.['scope'], parent: ctx.agent.permissions }, { child: rm.data?.['scope'], parent: ctx.agent.permissions });
    return { summary: 'ok', confidence: 1, data: { notInParent, notInRole, riskUp, denied, worker: rw.data, mid: rm.data } };
  });
  writeRan = false;
  const r = await (await m.startRootTask({ request: 'perm', specialistRole: 'test_specialist', task: { description: 'perm', input: { scenario: 'perm' } } })).result;
  const d = r.specialist.data ?? {};
  ok('asking for a tool the parent lacks is PERMISSION_ESCALATION', d['notInParent'] === 'PERMISSION_ESCALATION', String(d['notInParent']));
  ok('asking for a tool the role lacks is refused', d['notInRole'] === 'PERMISSION_ESCALATION', String(d['notInRole']));
  ok('asking for a higher maxRisk than the parent is refused', d['riskUp'] === 'PERMISSION_ESCALATION', String(d['riskUp']));
  ok('session-control tools are never given to agents', d['denied'] === 'PERMISSION_ESCALATION', String(d['denied']));
  const w = d['worker'] as Record<string, unknown>;
  const mid = d['mid'] as Record<string, unknown>;
  ok('a worker may call the tools in its scope', w?.['lookup'] === true);
  ok('a call outside the scope is refused before the registry runs it', w?.['write'] === 'AGENT_SCOPE_DENIED', String(w?.['write']));
  ok('enable_full_control_session is refused for agents', w?.['full'] === 'AGENT_TOOL_DENIED', String(w?.['full']));
  ok('a tool in scope but above the agent\'s maxRisk is refused', mid?.['write'] === 'AGENT_RISK_DENIED', String(mid?.['write']));
  ok('no refused write ever ran', writeRan === false);
  ok('every child scope is a subset of its parent\'s', scopes.every((s) => isSubsetScope(s.child, s.parent).ok));
  ok('scope entries cover tool:action but not the reverse', covers(['git'], 'git:status') && !covers(['git:status'], 'git'));
}

console.log('\n--- 7. Cancellation propagates through the whole tree; no orphans ---');
{
  const m = newManager();
  let rootId: string | undefined;
  const events = record(() => rootId);
  scenarios.set('longleaf', async (ctx) => { ctx.addFinding({ text: `partial from ${ctx.agent.agentId}`, confidence: 0.5 }); await sleep(5_000); return { summary: 'never', confidence: 1 }; });
  scenarios.set('longmid', async (ctx) => {
    const hs = [];
    for (const n of [1, 2]) hs.push(await ctx.spawn({ childRole: 'test_worker', childTask: { description: `long leaf ${n}`, input: { scenario: 'longleaf' } } }));
    await ctx.wait(hs);
    return { summary: 'never', confidence: 1 };
  });
  scenarios.set('longroot', async (ctx) => {
    const mid = await ctx.spawn({ childRole: 'test_mid', childTask: { description: 'long mid', input: { scenario: 'longmid' } } });
    await ctx.wait([mid]);
    return { summary: 'never', confidence: 1 };
  });
  const h = await m.startRootTask({ request: 'Research something slow', specialistRole: 'test_specialist', task: { description: 'slow', input: { scenario: 'longroot' } } });
  rootId = h.rootTaskId;
  await sleep(200);
  ok('four agents are active before the stop', m.status().activeAgents === 4, String(m.status().activeAgents));
  const t0 = Date.now();
  m.cancelRoot(h.rootTaskId, 'Stop this research');
  const r = await h.result;
  ok('the root ends CANCELLED quickly', r.status === 'CANCELLED' && Date.now() - t0 < 2_000, `${r.status} in ${Date.now() - t0} ms`);
  const tasks = m.tasksOfRoot(h.rootTaskId);
  ok('every task in the tree ended', tasks.every((t) => ['CANCELLED', 'COMPLETED', 'FAILED', 'TIMED_OUT'].includes(t.status)), tasks.map((t) => t.status).join(','));
  ok('every worker was CANCELLED', tasks.filter((t) => t.role === 'test_worker').every((t) => t.status === 'CANCELLED'));
  ok('no agent is left active', m.status().activeAgents === 0);
  ok('each temporary agent reported AGENT_STOPPED', events.filter((e) => e.type === 'AGENT_STOPPED').length === 3);
  ok('partial findings survive the stop', r.findings.length === 2, `${r.findings.length}`);
  ok('the stop reason is reported as a limitation', r.limitations.some((l) => /Stop this research/.test(l)));
}

console.log('\n--- 8. A failing child does not crash its parent; retry; retry limit ---');
{
  const m = newManager({ maxRetries: 1 });
  scenarios.set('flaky', async (ctx) => {
    if (ctx.task.attempt === 1) throw new Error('network glitch');
    return { summary: 'second try worked', confidence: 0.9 };
  });
  scenarios.set('always-fails', async () => { throw new Error('always'); });
  scenarios.set('retrying', async (ctx) => {
    const a = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'flaky job', input: { scenario: 'flaky' } } });
    const [ra] = await ctx.wait([a]);
    const a2 = await ctx.retry(a);
    const [ra2] = await ctx.wait([a2]);
    const b = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'hopeless job', input: { scenario: 'always-fails' } } });
    await ctx.wait([b]);
    const b2 = await ctx.retry(b);
    await ctx.wait([b2]);
    let limit = '';
    try { await ctx.retry(b2); } catch (e) { limit = (e as InstanceType<typeof SpawnRejectedError>).code; }
    return { summary: 'parent carried on', confidence: 0.6, data: { first: ra.status, firstErr: ra.error?.code, second: ra2.status, attempt: m.tasks.get(a2.taskId)?.attempt, limit } };
  });
  const r = await (await m.startRootTask({ request: 'retry', specialistRole: 'test_specialist', task: { description: 'retry', input: { scenario: 'retrying' } } })).result;
  const d = r.specialist.data ?? {};
  ok('the failed child returned FAILED with AGENT_ERROR, not an exception', d['first'] === 'FAILED' && d['firstErr'] === 'AGENT_ERROR');
  ok('the retry is attempt 2 and completed', d['second'] === 'COMPLETED' && d['attempt'] === 2);
  ok('a retry beyond JARVIS_AGENT_MAX_RETRIES is rejected', d['limit'] === 'RETRY_LIMIT', String(d['limit']));
  ok('the parent completed', r.status === 'COMPLETED');
}

console.log('\n--- 9. Parent failure and a parent that ends early: children are cancelled ---');
{
  const m = newManager();
  scenarios.set('crashing-parent', async (ctx) => {
    for (const n of [1, 2]) await ctx.spawn({ childRole: 'test_worker', childTask: { description: `orphan risk ${n}`, input: { scenario: 'longleaf' } } });
    await sleep(50);
    throw new Error('parent bug');
  });
  scenarios.set('hasty-parent', async (ctx) => {
    await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'left behind', input: { scenario: 'longleaf' } } });
    return { summary: 'done without waiting', confidence: 0.5 };
  });
  scenarios.set('parents', async (ctx) => {
    const p1 = await ctx.spawn({ childRole: 'test_mid', childTask: { description: 'crashing parent', input: { scenario: 'crashing-parent' } } });
    const p2 = await ctx.spawn({ childRole: 'test_mid', childTask: { description: 'hasty parent', input: { scenario: 'hasty-parent' } } });
    const [r1, r2] = await ctx.wait([p1, p2]);
    await sleep(50);
    const kids1 = m.tasks.children(p1.taskId);
    const kids2 = m.tasks.children(p2.taskId);
    return {
      summary: 'ok', confidence: 1,
      data: {
        r1: r1.status, r2: r2.status,
        kids1: kids1.map((k) => `${k.status}/${k.cancellation.by}`), kids2: kids2.map((k) => `${k.status}/${k.cancellation.by}`),
      },
    };
  });
  const r = await (await m.startRootTask({ request: 'parents', specialistRole: 'test_specialist', task: { description: 'parents', input: { scenario: 'parents' } } })).result;
  const d = r.specialist.data ?? {};
  ok('the crashing parent is FAILED and the specialist carried on', d['r1'] === 'FAILED' && r.status === 'COMPLETED');
  ok('its children were cancelled because the parent failed', JSON.stringify(d['kids1']) === JSON.stringify(['CANCELLED/parent_failed', 'CANCELLED/parent_failed']), JSON.stringify(d['kids1']));
  ok('a parent that ended without waiting left no running child', JSON.stringify(d['kids2']) === JSON.stringify(['CANCELLED/parent']), JSON.stringify(d['kids2']));
}

console.log('\n--- 10. Timeouts: deadline and stalled work ---');
{
  const m = newManager({ idleTimeoutMs: 300 });
  scenarios.set('slow-with-partial', async (ctx) => { ctx.addFinding({ text: 'half of the answer', confidence: 0.6 }); await sleep(3_000); return { summary: 'never', confidence: 1 }; });
  scenarios.set('stuck', async () => { await sleep(3_000); return { summary: 'never', confidence: 1 }; });
  scenarios.set('timeouts', async (ctx) => {
    const a = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'slow one', input: { scenario: 'slow-with-partial' } }, deadline: Date.now() + 200 });
    const b = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'stuck one', input: { scenario: 'stuck' } } });
    const [ra, rb] = await ctx.wait([a, b]);
    return { summary: 'ok', confidence: 1, data: { a: ra.status, aErr: ra.error?.code, aTrunc: ra.truncated, aFindings: ra.findings.length, b: rb.status, bErr: rb.error?.code } };
  });
  const t0 = Date.now();
  const r = await (await m.startRootTask({ request: 'timeouts', specialistRole: 'test_specialist', task: { description: 'timeouts', input: { scenario: 'timeouts' } } })).result;
  const d = r.specialist.data ?? {};
  ok('a child past its deadline is TIMED_OUT', d['a'] === 'TIMED_OUT' && d['aErr'] === 'TIMEOUT', `${d['a']} ${d['aErr']}`);
  ok('its partial finding is returned and marked truncated', d['aFindings'] === 1 && d['aTrunc'] === true);
  ok('a child with no activity is stopped as STALLED', d['b'] === 'TIMED_OUT' && d['bErr'] === 'STALLED', `${d['b']} ${d['bErr']}`);
  ok('the waiting parent was not treated as stalled', r.status === 'COMPLETED' && Date.now() - t0 < 2_500, `${r.status} after ${Date.now() - t0} ms`);
}

console.log('\n--- 11. Budgets: charged up the tree, stops labelled truncated ---');
{
  const m = newManager();
  scenarios.set('greedy', async (ctx) => {
    for (let i = 0; i < 5; i++) await ctx.callTool('test_lookup', { q: `g${i}` });
    return { summary: 'never', confidence: 1 };
  });
  scenarios.set('budget', async (ctx) => {
    const g = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'greedy job', input: { scenario: 'greedy' } }, resourceBudget: { toolCalls: 2 } });
    const [rg] = await ctx.wait([g]);
    return { summary: 'ok', confidence: 1, data: { status: rg.status, code: rg.error?.code, trunc: rg.truncated, used: rg.usage.toolCalls } };
  });
  const r = await (await m.startRootTask({ request: 'budget', specialistRole: 'test_specialist', task: { description: 'budget', input: { scenario: 'budget' } } })).result;
  const d = r.specialist.data ?? {};
  ok('a child over its tool budget stops with BUDGET_EXCEEDED', d['status'] === 'FAILED' && d['code'] === 'BUDGET_EXCEEDED', `${d['status']} ${d['code']}`);
  ok('the stop is labelled truncated and counted', d['trunc'] === true && d['used'] === 2);
}

console.log('\n--- 12. Duplicate work: reuse, subscribe, whole-task guard, merged findings ---');
{
  const m = newManager();
  scenarios.set('dups', async (ctx) => {
    const first = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'Analyze repository alpha', input: { scenario: 'work', finding: 'alpha is maintained', url: 'https://github.com/o/alpha' } } });
    await ctx.wait([first]);
    const running = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'Analyze repository beta', input: { scenario: 'work', delayMs: 300 } } });
    const decision = ctx.decideSpawn({
      subtasks: [
        { description: 'Analyze repository alpha', role: 'test_worker', estimatedUnits: 3 },
        { description: 'Analyze repository beta', role: 'test_worker', estimatedUnits: 3 },
        { description: 'dups', role: 'test_worker', estimatedUnits: 3 },
      ],
    });
    let whole = '';
    try { await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'dups' } }); } catch (e) { whole = (e as InstanceType<typeof SpawnRejectedError>).code; }
    // Two agents report the same thing from the same page.
    const again = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'Check alpha maintenance', input: { scenario: 'work', finding: 'Alpha is maintained.', url: 'https://www.github.com/o/alpha/' } } });
    await ctx.wait([running, again]);
    return { summary: 'ok', confidence: 1, data: { plan: decision.plan.map((p) => p.action), whole } };
  });
  const h = await m.startRootTask({ request: 'dups', specialistRole: 'test_specialist', task: { description: 'dups', input: { scenario: 'dups' } } });
  const r = await h.result;
  const d = r.specialist.data ?? {};
  ok('a finished task is reused, a running one subscribed to, the own task kept', JSON.stringify(d['plan']) === JSON.stringify(['REUSE', 'SUBSCRIBE', 'SELF']), JSON.stringify(d['plan']));
  ok('handing a child the parent\'s whole task is refused', d['whole'] === 'DELEGATES_WHOLE_TASK', String(d['whole']));
  const ws = m.workspace(h.rootTaskId)!;
  const alpha = ws.findings().filter((f) => /alpha is maintained/i.test(f.text));
  ok('the same finding from two agents is stored once, corroborated', alpha.length === 1 && alpha[0].corroboratedBy.length === 1, `${alpha.length} / ${alpha[0]?.corroboratedBy.length}`);
  ok('the same URL is one source', ws.sources().filter((s) => /alpha/.test(s.url ?? '')).length === 1);
}

console.log('\n--- 13. Conflicts: detected, resolved by source quality, or reported ---');
{
  const m = newManager();
  let rootId: string | undefined;
  const events = record(() => rootId);
  scenarios.set('claims', async (ctx) => {
    const good = ctx.addSource({ url: 'https://github.com/o/x', title: 'Repo page', kind: 'github', quality: 0.9 });
    const weak = ctx.addSource({ url: 'https://forum.example.com/x', title: 'Forum', kind: 'web', quality: 0.3 });
    ctx.addClaim({ subject: 'project X', attribute: 'stars', value: '1,200', sourceIds: [good.id], confidence: 0.9 });
    const { conflict } = ctx.addClaim({ subject: 'Project X', attribute: 'Stars', value: '1500', sourceIds: [weak.id], confidence: 0.6 });
    const resolved = ctx.workspace.resolveBySourceQuality(conflict!.id, { agentId: ctx.agent.agentId, taskId: ctx.task.taskId });
    ctx.addClaim({ subject: 'project Y', attribute: 'license', value: 'MIT', sourceIds: [good.id], confidence: 0.8 });
    const { conflict: c2 } = ctx.addClaim({ subject: 'project Y', attribute: 'license', value: 'Apache-2.0', sourceIds: [good.id], confidence: 0.8 });
    const unresolved = ctx.workspace.resolveBySourceQuality(c2!.id, { agentId: ctx.agent.agentId, taskId: ctx.task.taskId });
    return { summary: 'ok', confidence: 0.7, data: { status: resolved?.status, value: resolved?.resolution?.value, y: unresolved?.status } };
  });
  const h = await m.startRootTask({ request: 'claims', specialistRole: 'test_specialist', task: { description: 'claims', input: { scenario: 'claims' } } });
  rootId = h.rootTaskId;
  const r = await h.result;
  const d = r.specialist.data ?? {};
  ok('differing values for the same subject and attribute open a conflict', events.filter((e) => e.type === 'CONFLICT_DETECTED').length === 2);
  ok('the better-sourced value wins', d['status'] === 'resolved' && d['value'] === '1,200', `${d['status']} ${d['value']}`);
  ok('equally good sources leave it unresolved', d['y'] === 'unresolved');
  ok('JARVIS sees the conflicts and an unresolved-conflict limitation', r.conflicts.length === 2 && r.limitations.some((l) => /Unresolved/.test(l) && /project Y/.test(l)));
}

console.log('\n--- 14. Real-time sharing and controlled messages between agents ---');
{
  const m = newManager();
  let finderDoneAt = 0;
  let seenAt = 0;
  scenarios.set('finder', async (ctx) => {
    await sleep(50);
    ctx.addFinding({ text: 'the key fact', confidence: 0.8 });
    await sleep(200);
    finderDoneAt = Date.now();
    return { summary: 'found', confidence: 0.8 };
  });
  scenarios.set('listener', async (ctx) => {
    const seen = new Promise<void>((resolve) => {
      let off = () => {};
      off = ctx.onEvent({ types: ['FINDING_DISCOVERED'] }, (e) => {
        if (e.data['text'] === 'the key fact' && !seenAt) { seenAt = Date.now(); off(); resolve(); }
      }, { replay: true });
    });
    await ctx.idleWait(seen);
    const sibling = String(ctx.input['sibling']);
    ctx.sendMessage(sibling, 'info', 'I saw your fact');
    let cousin = '';
    try { ctx.sendMessage('test_worker-9999', 'info', 'hello stranger'); } catch (e) { cousin = (e as Error).message; }
    ctx.sendMessage(ctx.task.parentAgentId!, 'partial_result', 'fact relayed');
    return { summary: 'heard', confidence: 0.8, data: { cousin } };
  });
  scenarios.set('share', async (ctx) => {
    const finder = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'find the fact', input: { scenario: 'finder' } } });
    const listener = await ctx.spawn({ childRole: 'test_worker', childTask: { description: 'listen for facts', input: { scenario: 'listener', sibling: finder.agentId } } });
    const [, rl] = await ctx.wait([finder, listener]);
    const inbox = ctx.inbox();
    return { summary: 'ok', confidence: 1, data: { cousin: rl.data?.['cousin'], finderInbox: m.inbox(finder.agentId).map((x) => x.text), kinds: inbox.map((x) => x.kind) } };
  });
  const r = await (await m.startRootTask({ request: 'share', specialistRole: 'test_specialist', task: { description: 'share', input: { scenario: 'share' } } })).result;
  const d = r.specialist.data ?? {};
  ok('a sibling saw the finding while its finder was still working', seenAt > 0 && seenAt < finderDoneAt, `${finderDoneAt - seenAt} ms before the finder finished`);
  ok('a sibling message was delivered', JSON.stringify(d['finderInbox']) === JSON.stringify(['I saw your fact']));
  ok('a message to an agent outside parent/children/siblings is refused', /may message only/.test(String(d['cousin'])));
  ok('the parent got the partial result and both completions', ['partial_result', 'completion'].every((k) => (d['kinds'] as string[]).includes(k)) && (d['kinds'] as string[]).filter((k) => k === 'completion').length === 2, JSON.stringify(d['kinds']));
}

console.log('\n--- 15. Discovery, Agent Cards, unknown roles ---');
{
  const m = newManager();
  ok('roles are found by capability', m.registry.findRolesByCapability('synthesis').map((r) => r.role).join() === 'test_specialist');
  const card = m.registry.agentCard('test_specialist')!;
  ok('a specialist has an A2A Agent Card', card.name === 'Test Specialist' && card.skills[0].id === 'test_specialist' && card.supportedInterfaces[0].protocolVersion === '1.0' && card.capabilities.streaming === true);
  ok('permanent specialists are discoverable as agents', m.registry.findAgents({ capability: 'research' }).some((a) => a.agentId === 'test_specialist'));
  let rootId: string | undefined;
  const events = record(() => rootId);
  scenarios.set('unknown', async (ctx) => {
    let code = '';
    try { await ctx.spawn({ childRole: 'wizard', childTask: { description: 'magic' } }); } catch (e) { code = (e as InstanceType<typeof SpawnRejectedError>).code; }
    return { summary: 'ok', confidence: 1, data: { code } };
  });
  const h = await m.startRootTask({ request: 'unknown', specialistRole: 'test_specialist', task: { description: 'unknown', input: { scenario: 'unknown' } } });
  rootId = h.rootTaskId;
  const r = await h.result;
  const rej = events.find((e) => e.type === 'SPAWN_REJECTED');
  ok('an unknown role is rejected with the list of valid roles', r.specialist.data?.['code'] === 'UNKNOWN_ROLE' && Array.isArray(rej?.data['validRoles']) && (rej!.data['validRoles'] as string[]).includes('test_worker'));
  let notSpecialist = '';
  try { await m.startRootTask({ request: 'x', specialistRole: 'test_worker' }); } catch (e) { notSpecialist = (e as InstanceType<typeof SpawnRejectedError>).code; }
  ok('JARVIS delegates only to specialists', notSpecialist === 'NOT_A_SPECIALIST');
}

console.log('\n--- 16. Approvals inside an agent name the agent and the original request ---');
{
  beginTrace('voice', 'what time is it');
  const info = { rootTaskId: 'r', taskId: 't', agentId: 'browser_worker-1', agentPath: 'JARVIS › Research Agent › Browser Worker', request: 'Find the best GitHub projects', source: 'cli' as const };
  const seen = await runAsAgent(info, async () => ({ text: getRequestText(), agent: getAgentPath() }));
  ok('inside an agent the request is the root task\'s, not the current foreground one', seen.text === 'Find the best GitHub projects' && getRequestText() === 'what time is it');
  ok('the agent path is available to the approval gate', seen.agent === info.agentPath && getAgentPath() === undefined);
  endTrace();
  const req = buildApprovalRequest({ tool: 'browser_upload', target: 'report.pdf', request: seen.text, risk: 3, agent: seen.agent });
  ok('the console request shows ASKED BY AGENT', formatApprovalRequest(req, 20).includes('ASKED BY AGENT:   JARVIS › Research Agent › Browser Worker'));
  ok('the spoken question names the agent', spokenApprovalRequest(req).startsWith('Sir, the Browser Worker needs your approval'));
  const plain = buildApprovalRequest({ tool: 'browser_upload', target: 'report.pdf', risk: 3 });
  ok('requests from JARVIS itself are unchanged', spokenApprovalRequest(plain).startsWith('Sir, I need your approval') && !formatApprovalRequest(plain, 20).includes('ASKED BY AGENT'));
}

console.log('\n--- 17. Limits come from the environment; restarts mark running archives ---');
{
  const l = loadAgentLimits({ JARVIS_AGENT_MAX_DEPTH: '3', JARVIS_AGENT_MAX_CHILDREN: '99', JARVIS_AGENT_MAX_CONCURRENT: 'two' });
  ok('JARVIS_AGENT_MAX_DEPTH is read', l.maxDepth === 3);
  ok('out-of-range values are clamped', l.maxChildrenPerAgent === 20);
  ok('invalid values fall back to the default', l.maxConcurrentAgents === 4);
  const m = newManager();
  const dir = m.archiveDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task-stale.json'), JSON.stringify({ rootTaskId: 'task-stale', status: 'RUNNING' }));
  const marked = m.markInterruptedArchives();
  ok('an archive left RUNNING by a restart is marked INTERRUPTED', marked.includes('task-stale') && JSON.parse(fs.readFileSync(path.join(dir, 'task-stale.json'), 'utf8')).status === 'INTERRUPTED');
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
