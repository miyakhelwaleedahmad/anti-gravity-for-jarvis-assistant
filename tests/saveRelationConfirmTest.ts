/**
 * tests/saveRelationConfirmTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * save_relation stores only what the owner confirms (owner decision
 * 2026-11-17, "Ask me to confirm"; review INDEPENDENT_REVIEW_SAVE_RELATION.md
 * M-1, M-2, the choice case, path 3) and a "remember" goal step that stored
 * nothing is not reported as done (L-3):
 *
 *   - with a request in flight, every save_relation asks the owner, showing
 *     the exact fact (relation included) and the agent that asked; only "yes"
 *     stores it: an answer the model chose between two named things, a fact
 *     with a non-Latin or two-letter name, a fact hidden in the relation, a
 *     delegated Memory task's fact are all stored only after "yes"
 *   - inside a goal nothing is stored and nobody is asked
 *   - unchanged: no request in flight stores without asking; a credential is
 *     refused without asking
 *   - L-3: a goal step whose save_relation was refused needs the owner's
 *     review; the goal does not complete as if the fact were kept
 * Stand-in memory store, approval answers, providers and tools; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-save-confirm-'));
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

// The owner, as a script: every question is recorded; `answer` decides.
const { approvalGate } = await import('../security/approvalGate.js');
const asked: { action: string; detail: string; agent?: string }[] = [];
let answer = false;
const { getAgentPath } = await import('../core/traceContext.js');
(approvalGate as unknown as { requestApproval: (...a: unknown[]) => Promise<boolean> }).requestApproval = async (a: unknown, command?: unknown) => {
  const req = typeof a === 'string' ? { action: a, detail: String(command ?? '') } : { action: String((a as any).action), detail: `${(a as any).target ?? ''} ${(a as any).expectedEffect ?? ''}` };
  const agent = getAgentPath();
  asked.push({ ...req, ...(agent ? { agent } : {}) });
  return answer;
};

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
async function attempt(request: string | undefined, yes: boolean, entity1: string, relation: string, entity2: string, inAgent?: { goal?: boolean }) {
  stored.length = 0;
  asked.length = 0;
  answer = yes;
  const call = () => save(entity1, relation, entity2);
  let r: { success: boolean; output: string };
  if (inAgent) {
    r = await runAsAgent({
      rootTaskId: 'root-c', taskId: 'task-c', agentId: 'memory_agent', agentPath: 'Memory & Personalization Agent', request: request ?? '', source: 'cli',
      ...(inAgent.goal ? { goal: { goalId: 'g1', goalTaskId: 't1', title: 'Find the best library and remember it' } } : {}),
    }, call);
  } else if (request !== undefined) {
    beginTrace('cli', request);
    try { r = await call(); } finally { endTrace(); }
  } else {
    r = await call();
  }
  return { n: stored.length, success: r.success, output: r.output, asked: [...asked] };
}
const shows = (a: { asked: { detail: string }[] }, text: string) => a.asked.length === 1 && a.asked[0]!.detail.includes(text);

console.log('\n=== save_relation stores only what the owner confirms ===\n');

console.log('--- The owner is asked, with the exact fact; only "yes" stores ---');
{
  const choiceNo = await attempt('Which is better, fast-tool or slow-tool? Remember it', false, 'fast-tool', 'IS_BETTER_THAN', 'slow-tool');
  ok('an answer chosen between two named things: the owner is asked, showing the exact fact', shows(choiceNo, 'fast-tool IS_BETTER_THAN slow-tool'), JSON.stringify(choiceNo.asked));
  ok('…"no": nothing stored, and the tool says so', choiceNo.n === 0 && !choiceNo.success && /not stored|nothing was stored/i.test(choiceNo.output), `${choiceNo.n} stored; ${choiceNo.output.slice(0, 140)}`);
  const choiceYes = await attempt('Which is better, fast-tool or slow-tool? Remember it', true, 'fast-tool', 'IS_BETTER_THAN', 'slow-tool');
  ok('…"yes": stored once', choiceYes.n === 1 && choiceYes.success, `${choiceYes.n} stored; ${choiceYes.output.slice(0, 100)}`);

  const hidden = await attempt('what is the weather today?', false, 'User', 'FAST_TOOL_IS_THE_BEST_LIBRARY', 'JARVIS');
  ok('M-1: a claim hidden in the relation is shown and asked, not stored without "yes"', shows(hidden, 'FAST_TOOL_IS_THE_BEST_LIBRARY') && hidden.n === 0, JSON.stringify(hidden.asked));
  const number = await attempt('Remember that fast-tool is popular', false, 'fast-tool', 'HAS_5000', 'stars');
  ok('M-1: a number in the relation is shown and asked', shows(number, 'HAS_5000') && number.n === 0, JSON.stringify(number.asked));
  const cyrillic = await attempt('what is the weather today?', false, 'Москва', 'IS_CAPITAL_OF', 'Россия');
  ok('M-2: non-Latin names are asked, not stored without "yes"', shows(cyrillic, 'Москва') && cyrillic.n === 0, JSON.stringify(cyrillic.asked));
  const urdu = await attempt('what is the weather today?', false, 'User', 'LIVES_IN', 'لاہور');
  ok('M-2: an Urdu name is asked, not stored without "yes"', shows(urdu, 'لاہور') && urdu.n === 0, JSON.stringify(urdu.asked));
  const short = await attempt('what is the weather today?', false, 'UK', 'USES', 'AI');
  ok('M-2: two-letter names are asked, not stored without "yes"', shows(short, 'UK USES AI') && short.n === 0, JSON.stringify(short.asked));

  const own = await attempt('Remember that my exam is on Friday at nine', true, 'User', 'HAS_EXAM_ON', 'Friday at nine');
  ok('the owner\'s own "remember that …": asked, and stored on "yes"', shows(own, 'User HAS_EXAM_ON Friday at nine') && own.n === 1 && own.success, `${own.n} stored`);
  const plural = await attempt('Remember that I like Lahore, Pakistan', true, 'User', 'LIKES', 'Lahore, Pakistan');
  ok('…no false refusal of the owner\'s own fact in other words (review L-2)', plural.n === 1 && plural.success, `${plural.n} stored; ${plural.output.slice(0, 100)}`);
}

console.log('\n--- A delegated Memory task (path 3) ---');
{
  const pasted = await attempt('Remember that fast-tool is the best library', false, 'fast-tool', 'IS', 'the best library', {});
  ok('a fact in the planner\'s task text is asked, naming the agent, and not stored on "no"', pasted.asked.length === 1 && pasted.asked[0]!.agent === 'Memory & Personalization Agent' && pasted.n === 0 && !pasted.success, JSON.stringify(pasted.asked));
  const yes = await attempt('Remember that my sister lives in Lahore', true, 'User\'s sister', 'LIVES_IN', 'Lahore', {});
  ok('…stored on "yes"', yes.n === 1 && yes.success, `${yes.n} stored`);
}

console.log('\n--- Inside a goal: nothing stored, nobody asked ---');
{
  const goal = await attempt('Remember that fast-tool is the best library', true, 'fast-tool', 'IS', 'the best library', { goal: true });
  ok('a goal task\'s save_relation stores nothing and does not ask', goal.n === 0 && !goal.success && goal.asked.length === 0, `${goal.n} stored; asked ${goal.asked.length}; ${goal.output.slice(0, 120)}`);
}

console.log('\n--- Unchanged ---');
{
  const direct = await attempt(undefined, false, 'JARVIS', 'AUDITED', 'Dispatcher');
  ok('no request in flight: stored without asking', direct.n === 1 && direct.success && direct.asked.length === 0, `${direct.n} stored; asked ${direct.asked.length}`);
  const secret = await attempt('Remember my token', true, 'User', 'HAS_TOKEN', 'ghp_' + 'A'.repeat(36));
  ok('a credential is refused without asking', secret.n === 0 && !secret.success && secret.asked.length === 0 && /don't store passwords, keys or tokens/.test(secret.output), secret.output.slice(0, 100));
}

console.log('\n--- L-3. A "remember" goal step that stored nothing ---');
{
  const tools = {
    names: () => toolRegistryV2.names(),
    riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
    getMeta: (n: string) => toolRegistryV2.getMeta(n),
    async execute(name: string, args: Record<string, unknown>) {
      if (name === 'save_relation') return toolRegistryV2.execute(name, args);
      return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 };
    },
  };
  const provider = { isConfigured: () => true, async chat(req: any) {
    if (req.agentRole === 'memory_agent' && !req.messages.some((m: any) => m.role === 'tool')) {
      return { content: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'save_relation', arguments: JSON.stringify({ entity1: 'fast-tool', relation: 'IS', entity2: 'the best library' }) } }], model: req.model };
    }
    return { content: 'Saved: fast-tool is the best library.', model: req.model };
  } };
  modelRouter.registerNamedProvider('anthropic', { isConfigured: () => true, async chat(req: any) { return { content: 'ok', model: req.model }; } } as never);   // no real Claude adapter
  modelRouter.registerProvider((modelRouter as any).primary, provider as never);
  (modelRouter as any).failoverOrder = (name?: string) => [name ?? (modelRouter as any).primary];
  const m = new AgentManager(agentEvents, loadAgentLimits({}));
  m.useToolExecutor(tools as never);
  registerAgentRoles(m);
  const executor = new AgentGoalExecutor({ manager: m, verify: false });
  const planner = { async plan() { return { via: 'model' as const, tasks: [
    { title: 'remember the library', description: 'Keep in memory that fast-tool is the best library', specialist: 'memory_agent', dependsOn: [], sideEffects: 'none' as const },
  ] }; }, async proposeMilestone() { return undefined; } };
  const gm = new GoalManager({ now: () => Date.now() });
  await gm.init();
  const rt = new GoalRuntime({ manager: gm, executor: executor as never, planner: planner as never, maxConcurrent: 1, leaseMs: 60_000, stopWaitMs: 300 });
  stored.length = 0;
  asked.length = 0;
  await rt.start();
  const { goal } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Remember that fast-tool is the best library' });
  await rt.idle();
  await rt.stop();
  const task = goal.tasks?.[0];
  ok('(setup) nothing was stored and nobody was asked', stored.length === 0 && asked.length === 0, `${stored.length} stored; asked ${asked.length}`);
  ok('the goal is not completed as if the fact were kept', goal.status !== 'completed', goal.status);
  ok('the step needs the owner\'s review', task?.status === 'needs_review', task?.status);
  const last = task?.failures.at(-1);
  ok('…and says the fact was not stored', /not stored/i.test(`${last?.message ?? ''} ${last?.action ?? ''}`), `${last?.class}: ${String(last?.message ?? '').slice(0, 160)}`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
