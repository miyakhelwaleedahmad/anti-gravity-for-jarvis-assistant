/**
 * tests/saveRelationProvenanceTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The save_relation path into long-term memory (LR2_L5_PLAN.md §10; review
 * INDEPENDENT_REVIEW_LR2_L5.md L-C, L-B). Unverified information never enters
 * trusted long-term memory through it:
 *
 *   - inside a goal, save_relation stores nothing: a goal's facts come from
 *     other agents' results, which are not verified (through the real Memory
 *     agent in a real goal, and directly in a goal's agent scope)
 *   - with a request in flight, a fact is stored only when it is in that
 *     request's own words; one taken from elsewhere (an agent's result read
 *     with goal_status, a document) is refused
 *   - controls: the owner's own "remember …" is stored; a call with no
 *     request in flight is unchanged; a credential is still refused
 *   - L-B: every "not verified" label reaches the Memory agent's model, even
 *     when the context is cut
 * Stand-in memory store, providers and tools; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-save-relation-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_MODEL_') || k.startsWith('JARVIS_PROVIDER_') || k.startsWith('JARVIS_QA_')) delete process.env[k];
for (const name of ['JARVIS_FALLBACK_BASE_URL', 'JARVIS_FALLBACK_API_KEY', 'ANTHROPIC_API_KEY']) process.env[name] = '';
delete process.env['JARVIS_FALLBACK_MODEL'];
delete process.env['JARVIS_AGENT_MODEL'];
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const { memoryManager } = await import('../memory/memoryManager.js');
const stored: string[] = [];
(memoryManager as unknown as { rememberFact: (fact: string, source?: string) => Promise<void> }).rememberFact = async (fact: string, source?: string) => { stored.push(`${source}: ${fact}`); };

// Setup added 2026-11-17 for the owner's decision "Ask me to confirm": save_relation now asks the owner.
// This stand-in owner confirms only the two facts the owner said in this test and answers no to the rest.
// No assertion below was changed.
const { approvalGate } = await import('../security/approvalGate.js');
const OWNER_SAID = ['"User HAS_EXAM_ON Friday at nine"', '"User PREFERS dark theme"'];
(approvalGate as unknown as { requestApproval: (...a: unknown[]) => Promise<boolean> }).requestApproval = async (a: unknown, command?: unknown) =>
  OWNER_SAID.includes(typeof a === 'object' && a ? String((a as { target?: unknown }).target ?? '') : String(command ?? ''));

const { modelRouter } = await import('../bridge/modelRouter.js');
const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { registerAgentRoles } = await import('../core/agents/specialists.js');
const { runAsAgent } = await import('../core/agents/agentScope.js');
const { beginTrace, endTrace } = await import('../core/traceContext.js');
const { AgentGoalExecutor } = await import('../core/goalExecutor.js');
const { GoalManager } = await import('../core/goalManager.js');
const { GoalRuntime } = await import('../core/goalRuntime.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
const save = (entity1: string, relation: string, entity2: string) => toolRegistryV2.execute('save_relation', { entity1, relation, entity2 });
async function savedBy(fn: () => Promise<{ success: boolean; output: string }>): Promise<{ n: number; success: boolean; output: string }> {
  stored.length = 0;
  const r = await fn();
  return { n: stored.length, success: r.success, output: r.output };
}
const scope = (request: string, goal?: { goalId: string; goalTaskId: string; title: string }) => ({
  rootTaskId: 'root-p', taskId: 'task-p', agentId: 'memory_agent', agentPath: 'Memory Agent', request, source: 'cli' as const, ...(goal ? { goal } : {}),
});

console.log('\n=== save_relation never stores unverified information ===\n');

console.log('--- Through the real Memory agent in a goal (review probe 5) ---');
{
  const toolCalls: { args: string; output: string }[] = [];
  const tools = {
    names: () => toolRegistryV2.names(),
    riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
    getMeta: (n: string) => toolRegistryV2.getMeta(n),
    async execute(name: string, args: Record<string, unknown>) {
      if (name === 'save_relation') {
        const r = await toolRegistryV2.execute(name, args);
        toolCalls.push({ args: JSON.stringify(args), output: r.output });
        return r;
      }
      return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 };
    },
  };
  let seen = '';
  const provider = { isConfigured: () => true, async chat(req: any) {
    if (req.agentRole === 'memory_agent') {
      seen = String(req.messages.find((m: any) => m.role === 'user')?.content ?? '');
      if (!req.messages.some((m: any) => m.role === 'tool')) return { content: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'save_relation', arguments: JSON.stringify({ entity1: 'fast-tool', relation: 'IS', entity2: 'the best library' }) } }], model: req.model };
      return { content: 'Done.', model: req.model };
    }
    return { content: 'ok', model: req.model };
  } };
  modelRouter.registerNamedProvider('anthropic', { isConfigured: () => true, async chat(req: any) { return { content: 'ok', model: req.model }; } } as never);   // no real Claude adapter
  modelRouter.registerProvider((modelRouter as any).primary, provider as never);
  (modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
  const m = new AgentManager(agentEvents, loadAgentLimits({}));
  m.useToolExecutor(tools as never);
  registerAgentRoles(m);
  const real = new AgentGoalExecutor({ manager: m, verify: false });
  const long = (tag: string) => `${tag}: ${'fast-tool is the best library for the job because it is small and well maintained. '.repeat(6)}`;
  const executor = {
    async run(req: any) {
      if (req.task.title === 'remember') return real.run(req);
      req.onStarted(`root-${req.task.id}`);
      return { ok: true, usage: { llmCalls: 1, toolCalls: 0, tokens: 10 }, result: { status: 'COMPLETED', summary: long(req.task.title), confidence: 0.8, findings: [], sources: [], agent: 'research_agent', finishedAt: Date.now() } };
    },
    inspectPrevious() { return undefined; },
  };
  const planner = { async plan() { return { via: 'model' as const, tasks: [
    { title: 'step one', description: 'x', specialist: 'research_agent', dependsOn: [], sideEffects: 'none' as const },
    { title: 'step two', description: 'x', specialist: 'research_agent', dependsOn: [], sideEffects: 'none' as const },
    { title: 'step three', description: 'x', specialist: 'research_agent', dependsOn: [], sideEffects: 'none' as const },
    { title: 'remember', description: 'Keep the key facts from these results in memory', specialist: 'memory_agent', dependsOn: ['step one', 'step two', 'step three'], sideEffects: 'none' as const },
  ] }; }, async proposeMilestone() { return undefined; } };
  const gm = new GoalManager({ now: () => Date.now() });
  await gm.init();
  const rt = new GoalRuntime({ manager: gm, executor: executor as never, planner: planner as never, maxConcurrent: 3, leaseMs: 60_000, stopWaitMs: 300 });
  stored.length = 0;
  await rt.start();
  await gm.createManagedGoal({ kind: 'temporary', objective: 'Find the best library and remember it' });
  await rt.idle();
  await rt.stop();
  ok('(setup) the Memory agent\'s model asked to save an earlier, unverified result', toolCalls.length === 1, JSON.stringify(toolCalls.map((c) => c.args)));
  ok('nothing from it reached long-term memory', stored.length === 0, JSON.stringify(stored));
  ok('…and the tool said it was not stored, and why', toolCalls.length === 1 && /not stored|nothing was stored/i.test(toolCalls[0]!.output) && /not verified/i.test(toolCalls[0]!.output), toolCalls[0]?.output.slice(0, 200));
  const labels = (seen.match(/not verified; do not store it as a fact/g) ?? []).length;
  ok('L-B: all three "not verified" labels reach the Memory agent\'s model, uncut', labels === 3, `${labels} label(s) in ${seen.length} chars`);
}

console.log('\n--- Inside a goal\'s agent: refused, whatever the words ---');
{
  const goal = { goalId: 'g1', goalTaskId: 't1', title: 'Find the best library and remember it' };
  const r = await savedBy(() => runAsAgent(scope('Remember that fast-tool is the best library', goal), () => save('fast-tool', 'IS', 'the best library')));
  ok('a goal task\'s save_relation stores nothing, even in the task\'s own words', r.n === 0 && !r.success, `${r.n} stored; ${r.output.slice(0, 160)}`);
}

console.log('\n--- A delegated Memory task: only the request\'s own words ---');
{
  const own = await savedBy(() => runAsAgent(scope('Remember that my exam is on Friday at nine'), () => save('User', 'HAS_EXAM_ON', 'Friday at nine')));
  ok('the owner\'s own fact is stored (control)', own.n === 1 && own.success, `${own.n} stored; ${own.output.slice(0, 120)}`);
  const other = await savedBy(() => runAsAgent(scope('Remember that my exam is on Friday at nine'), () => save('fast-tool', 'IS', 'the best library')));
  ok('a fact not in the request\'s words is refused', other.n === 0 && !other.success, `${other.n} stored; ${other.output.slice(0, 160)}`);
}

console.log('\n--- The main planner: only the owner\'s own words ---');
{
  beginTrace('cli', 'what is the status of my library goal? remember what it found');
  const fromGoal = await savedBy(() => save('fast-tool', 'IS', 'the best library'));
  endTrace();
  ok('a fact read from goal_status (an agent\'s result) is refused', fromGoal.n === 0 && !fromGoal.success, `${fromGoal.n} stored; ${fromGoal.output.slice(0, 160)}`);
  beginTrace('cli', 'Remember this: User prefers dark theme');
  const said = await savedBy(() => save('User', 'PREFERS', 'dark theme'));
  endTrace();
  ok('the owner\'s "remember this" is stored (control)', said.n === 1 && said.success, `${said.n} stored; ${said.output.slice(0, 120)}`);
}

console.log('\n--- Unchanged ---');
{
  const direct = await savedBy(() => save('JARVIS', 'AUDITED', 'Dispatcher'));
  ok('no request in flight (code calling the registry): stored as before', direct.n === 1 && direct.success, `${direct.n} stored`);
  const secret = await savedBy(() => save('User', 'HAS_TOKEN', 'ghp_' + 'A'.repeat(36)));
  ok('a credential is still refused', secret.n === 0 && !secret.success && /don't store passwords, keys or tokens/.test(secret.output), secret.output.slice(0, 100));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
