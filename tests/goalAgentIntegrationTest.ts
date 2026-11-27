/**
 * tests/goalAgentIntegrationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Goal Runtime phase 4: goals run through the real agent system — the
 * AgentManager, the in-process A2A server, specialists and their workers, the
 * tool registry, the risk engine and the approval gate. Only the model is
 * scripted (or down) and nothing reaches the network.
 *
 *   - a goal-task runs as an agent root task bound to its goal; the Data
 *     agent's result is verified by the Verification agent; the archive
 *     records the goal
 *   - independent tasks run as parallel root tasks; a specialist splits its
 *     task across workers and the result names them
 *   - the goal's budget reaches the agents
 *   - approvals: each request names its goal and task; two goals asking at
 *     once get their own answers; an answer typed as the next request appears
 *     is not taken; an unanswered approval leaves the goal waiting
 *   - pausing a goal cancels its agents; resuming runs the task again
 *   - after a restart, the agent archive tells finished from unfinished
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-goal-agents-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspaceDir, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspaceDir;
process.env['JARVIS_DATA_ROOT'] = workspaceDir;
process.env['JARVIS_LEVEL2_POLICY'] = 'ask';      // level-2 actions ask for approval
process.env['JARVIS_APPROVAL_GRACE_MS'] = '200';  // typed answers count 200 ms after a goal's request appears
process.env['JARVIS_AGENT_LOG'] = '0';
process.chdir(workspaceDir);

globalThis.fetch = (async () => { throw new Error('network is off in this test'); }) as typeof fetch;

const { registerAllTools } = await import('../core/tools/index.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { GoalManager } = await import('../core/goalManager.js');
const { GoalRuntime } = await import('../core/goalRuntime.js');
const { AgentGoalExecutor } = await import('../core/goalExecutor.js');
const { approvalGate } = await import('../security/approvalGate.js');
const { formatApprovalRequest } = await import('../security/approvalRequest.js');
type Goal = import('../core/goalManager.js').Goal;
type AgentContext = import('../core/agents/agentContextApi.js').AgentContext;

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(20); }
  return cond();
}

registerAllTools();

let modelDown = true;
modelRouter.chat = (async (req: { messages: { role: string; content: unknown }[] }) => {
  if (modelDown) throw new Error('503 (test)');
  const user = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
  await sleep(100);
  return { content: `answer for: ${user.split('\n')[0]}` };
}) as typeof modelRouter.chat;

// Test-only specialists: one writes a file (level 2: asks for approval), one waits until released or stopped.
let release = false;
function testRoles(m: InstanceType<typeof AgentManager>): void {
  const base = { capabilities: ['test'], supportedTaskTypes: [], canSpawn: false, allowedChildRoles: [], permanent: true, version: '1.0.0' };
  m.defineRole({
    ...base, role: 'test_writer', name: 'Test Writer Agent', description: 'Writes one file (test only).', tools: ['write_file'], maxRisk: 2,
    behavior: {
      async run(ctx: AgentContext) {
        const file = /write (\S+)/.exec(ctx.task.description)?.[1] ?? 'out.txt';
        const out = await ctx.callTool('write_file', { filePath: path.join(workspaceDir, file), content: 'hello' });
        if (!out.success) throw new Error(out.output);
        return { summary: `wrote ${file}`, confidence: 0.9 };
      },
    },
  });
  m.defineRole({
    ...base, role: 'test_slow', name: 'Test Slow Agent', description: 'Waits until released (test only).', tools: [], maxRisk: 0,
    behavior: {
      async run(ctx: AgentContext) {
        while (!release) {
          if (ctx.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
          await sleep(20);
        }
        return { summary: 'slow work done', confidence: 0.8 };
      },
    },
  });
}

const m = new AgentManager();
testRoles(m);
const gm = new GoalManager();
await gm.init();
const executor = new AgentGoalExecutor({ manager: m });
const noPlanner = { plan: async () => { throw new Error('this test gives every goal its tasks'); } };
const rt = new GoalRuntime({ manager: gm, executor, planner: noPlanner, maxConcurrent: 3, stopWaitMs: 2_000 });
await rt.start();

console.log('\n=== Goals through the agent system (phase 4) ===\n');

console.log('--- A goal-task is an agent root task bound to its goal ---');
let dataRoot = '';
{
  const { goal } = await gm.createManagedGoal({
    kind: 'temporary', objective: 'Average of three numbers', successCriteria: [{ description: 'checked by the Verification agent', kind: 'verified' }],
    tasks: [{ title: 'average', description: 'What is the average of 3, 5 and 10?', specialist: 'data_agent' }],
  });
  await rt.idle(20_000);
  const t = goal.tasks![0]!;
  dataRoot = t.rootTaskId ?? '';
  ok('the goal completed through the Data agent', goal.status === 'completed' && /mean 6\b/.test(t.result?.summary ?? ''), `${goal.status}: ${t.result?.summary}`);
  ok('the Verification agent checked the result', t.result?.verification?.verdict === 'verified', JSON.stringify(t.result?.verification));
  ok('the "verified" criterion was met from that check', goal.successCriteria![0]!.met === true);
  ok('the root task id is stored on the task', /^task-/.test(dataRoot));
  const archive = JSON.parse(fs.readFileSync(path.join(m.archiveDir(), `${dataRoot}.json`), 'utf8')) as { goal?: { goalId: string; goalTaskId: string } };
  ok('the agent archive records the goal and task', archive.goal?.goalId === goal.id && archive.goal?.goalTaskId === t.id);
  const prev = executor.inspectPrevious(dataRoot);
  ok('after a restart the archive shows it finished, with its result', prev?.status === 'COMPLETED' && /mean 6/.test(prev.result?.summary ?? ''));
}

console.log('\n--- Parallel root tasks; a specialist splits work across workers ---');
{
  modelDown = false;
  const parallelExec = new AgentGoalExecutor({ manager: m, verify: false });
  const startCalls: { budget?: Record<string, number> }[] = [];
  const realStart = m.startRootTask.bind(m);
  m.startRootTask = (async (input: Parameters<typeof m.startRootTask>[0]) => { startCalls.push({ ...(input.budget ? { budget: input.budget as Record<string, number> } : {}) }); return realStart(input); }) as typeof m.startRootTask;
  await rt.stop();
  const rt2 = new GoalRuntime({ manager: gm, executor: parallelExec, planner: noPlanner, maxConcurrent: 3, stopWaitMs: 2_000 });
  await rt2.start();
  const { goal } = await gm.createManagedGoal({
    kind: 'temporary', objective: 'Two analyses', budget: { llmCalls: 40 },
    policy: { maxParallelTasks: 2 },
    tasks: [
      { title: 'growth', description: 'estimate the monthly growth rate from the sales notes; then rank the three suppliers by delivery delays; then what is 2 + 2', specialist: 'data_agent' },
      { title: 'costs', description: 'summarise the cost notes by department; then list the three largest cost items', specialist: 'data_agent' },
    ],
  });
  await rt2.idle(30_000);
  const [a, b] = goal.tasks!;
  ok('both tasks completed', goal.status === 'completed' && a!.status === 'completed' && b!.status === 'completed', `${goal.status} ${a!.status} ${b!.status}`);
  ok('they ran at the same time (overlapping root tasks)', a!.startedAt! < b!.finishedAt! && b!.startedAt! < a!.finishedAt!);
  ok('the specialist used workers, and the result names them', (a!.result?.agents?.length ?? 0) > 1, (a!.result?.agents ?? []).join(', '));
  ok('the parent combined the workers\' results in order', /1\. [\s\S]*2\. /.test(a!.result?.summary ?? ''), a!.result?.summary);
  ok('the goal\'s budget reached the agents', startCalls.some((c) => c.budget?.['llmCalls'] !== undefined && c.budget['llmCalls'] <= 40), JSON.stringify(startCalls));
  ok('usage was charged to the goal', (goal.usage?.llmCalls ?? 0) > 0, `${goal.usage?.llmCalls} model calls`);
  m.startRootTask = realStart;
  modelDown = true;
  await rt2.stop();
  await rt.start();
}

console.log('\n--- Approvals belong to their goal ---');
{
  // Nobody can answer (no console attached, no terminal): the goal waits, nothing is written.
  const { goal: u } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Unattended write', policy: { allowDesktop: true },
    tasks: [{ title: 'write u', description: 'write u.txt', specialist: 'test_writer', sideEffects: 'possible' }] });
  await rt.idle(10_000);
  ok('an approval nobody can answer leaves the goal waiting, not failed', u.status === 'waiting' && u.waitingFor === 'approval', `${u.status}/${u.waitingFor}`);
  ok('… and nothing was written', !fs.existsSync(path.join(workspaceDir, 'u.txt')));
  const ud = approvalGate.recentDecisions().find((d) => d.goalId === u.id);
  ok('the decision is recorded against that goal and its task', ud?.by === 'unavailable' && ud.goalTaskId === u.tasks![0]!.id);

  approvalGate.attachConsole();
  const shown: string[] = [];
  const swallowed: boolean[] = [];
  const handled = new Set<string>();
  const { goal: ga } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Goal A writes', policy: { allowDesktop: true },
    tasks: [{ title: 'write a', description: 'write a.txt', specialist: 'test_writer', sideEffects: 'possible' }] });
  const { goal: gb } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Goal B writes', policy: { allowDesktop: true },
    tasks: [{ title: 'write b', description: 'write b.txt', specialist: 'test_writer', sideEffects: 'possible' }] });
  const answerer = (async () => {
    const end = Date.now() + 15_000;
    while (Date.now() < end && handled.size < 2) {
      const req = approvalGate.pendingRequest();
      if (req && !handled.has(req.id)) {
        handled.add(req.id);
        shown.push(formatApprovalRequest(req, 30));
        if (req.goalId === gb.id) {
          // Typed the instant it appeared (meant for the previous request): not taken.
          approvalGate.offerConsoleAnswer('yes');
          await sleep(20);
          swallowed.push(approvalGate.pendingRequest()?.id === req.id);
          await sleep(250);
          approvalGate.offerConsoleAnswer('no');
        } else {
          await sleep(250);
          approvalGate.offerConsoleAnswer(req.goalId === ga.id ? 'yes' : 'no');
        }
      }
      await sleep(10);
    }
  })();
  await until(() => ['completed', 'blocked', 'failed'].includes(ga.status) && ['completed', 'blocked', 'failed'].includes(gb.status), 20_000);
  await answerer;
  ok('both requests were shown, one at a time', shown.length === 2);
  ok('each request names its goal and task', shown.some((s) => s.includes(`FOR GOAL:`) && s.includes(ga.id)) && shown.some((s) => s.includes(gb.id)));
  ok('goal A\'s approval let goal A write', ga.status === 'completed' && fs.existsSync(path.join(workspaceDir, 'a.txt')), ga.status);
  ok('goal B\'s refusal blocked goal B, which wrote nothing', gb.status === 'blocked' && !fs.existsSync(path.join(workspaceDir, 'b.txt')), `${gb.status}: ${gb.blockedReason}`);
  ok('a "yes" typed as B\'s request appeared did not approve it', swallowed[0] === true);
  const decisions = approvalGate.recentDecisions();
  ok('the decisions are recorded against the right goals', decisions.some((d) => d.goalId === ga.id && d.approved) && decisions.some((d) => d.goalId === gb.id && !d.approved && d.by === 'console'));

  // The unattended goal, resumed with someone there.
  const answer = (async () => {
    await until(() => approvalGate.pendingRequest()?.goalId === u.id, 10_000);
    await sleep(250);
    approvalGate.offerConsoleAnswer('yes');
  })();
  await gm.resumeGoal(u.id);
  await rt.idle(10_000);
  await answer;
  ok('resumed with someone to answer, it asks again and completes', u.status === 'completed' && fs.existsSync(path.join(workspaceDir, 'u.txt')), u.status);
}

console.log('\n--- Pausing a goal stops its agents ---');
{
  release = false;
  const { goal } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Slow work', tasks: [{ title: 'slow', description: 'slow task', specialist: 'test_slow' }] });
  await until(() => !!goal.tasks![0]!.rootTaskId && goal.tasks![0]!.status === 'running');
  const root = goal.tasks![0]!.rootTaskId!;
  await gm.pauseGoal(goal.id);
  await until(() => goal.tasks![0]!.status !== 'running');
  ok('the agent root task was cancelled', m.tasks.get(root)?.status === 'CANCELLED' || m.rootRuns().find((r) => r.rootTaskId === root)?.status === 'CANCELLED');
  ok('the task is ready to run again; the goal is paused', goal.tasks![0]!.status === 'ready' && goal.status === 'paused', `${goal.tasks![0]!.status}/${goal.status}`);
  release = true;
  await gm.resumeGoal(goal.id);
  await rt.idle(10_000);
  ok('resumed, it ran again as a new root task and completed', goal.status === 'completed' && goal.tasks![0]!.rootTaskId !== root);
}

console.log('\n--- Restart: the archive tells finished from unfinished ---');
{
  release = false;
  const { goal } = await gm.createManagedGoal({ kind: 'temporary', objective: 'Cut off', tasks: [{ title: 'slow', description: 'slow task 2', specialist: 'test_slow' }] });
  await until(() => !!goal.tasks![0]!.rootTaskId && goal.tasks![0]!.status === 'running');
  const root = goal.tasks![0]!.rootTaskId!;
  // A "crash": a new process sees the archive as it was left.
  const m2 = new AgentManager();
  testRoles(m2);
  const marked = m2.markInterruptedArchives();
  ok('JARVIS marks the root task left running as interrupted', marked.includes(root));
  const exec2 = new AgentGoalExecutor({ manager: m2 });
  ok('the executor reads it as not finished', exec2.inspectPrevious(root)?.status === 'INTERRUPTED');
  ok('and a finished one as finished', exec2.inspectPrevious(dataRoot)?.status === 'COMPLETED');
  await rt.stop();
  m.cancelAll('test crash');
  await gm.flush();
  const gm2 = new GoalManager();
  await gm2.init();
  release = true;
  const rt3 = new GoalRuntime({ manager: gm2, executor: exec2, planner: noPlanner, maxConcurrent: 2, stopWaitMs: 2_000 });
  await rt3.start();
  await rt3.idle(10_000);
  const again = gm2.getGoal(goal.id)!;
  ok('the read-only task ran again in the new process and completed', again.status === 'completed' && again.tasks![0]!.rootTaskId !== root, again.status);
  await rt3.stop();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
