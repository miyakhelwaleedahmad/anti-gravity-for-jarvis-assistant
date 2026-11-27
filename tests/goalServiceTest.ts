/**
 * tests/goalServiceTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The Goal Runtime as JARVIS runs it (core/goalService.ts): the real planner
 * (falling back without a model), the real agent system and tools, the goal
 * tools as the orchestrator calls them through the registry, the dashboard
 * line, and start/stop. The model is down and nothing reaches the network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-goal-service-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspaceDir, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspaceDir;
process.env['JARVIS_DATA_ROOT'] = workspaceDir;
process.env['JARVIS_AGENT_LOG'] = '0';
process.chdir(workspaceDir);
globalThis.fetch = (async () => { throw new Error('network is off in this test'); }) as typeof fetch;

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { modelRouter } = await import('../bridge/modelRouter.js');
modelRouter.chat = (async () => { throw new Error('503 (test)'); }) as typeof modelRouter.chat;
const { goalManager } = await import('../core/goalManager.js');
const { startGoalRuntime, stopGoalRuntime, goalRuntime, goalSummaryLine } = await import('../core/goalService.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
await goalManager.init();

console.log('\n=== Goal service (JARVIS wiring) ===\n');

process.env['JARVIS_GOAL_RUNTIME'] = '0';
const off = await startGoalRuntime();
ok('JARVIS_GOAL_RUNTIME=0 keeps it off', !off.started && off.reason === 'disabled');
delete process.env['JARVIS_GOAL_RUNTIME'];

const on = await startGoalRuntime();
const rt = goalRuntime();
ok('it starts', on.started && rt.isRunning);
ok('the dashboard line says what it is doing', /^0 active/.test(goalSummaryLine(rt)), goalSummaryLine(rt));

// Through the registry, as the orchestrator calls it.
const created = await toolRegistryV2.execute('goal_create', { objective: 'What is the average of 3, 5 and 10?' });
const body = JSON.parse(created.output) as { success: boolean; goalId: string; message: string };
ok('goal_create records the goal (and its check passes)', body.success && created.verification?.status === 'verified', `${body.message} / ${created.verification?.evidence}`);
await rt.idle(30_000);
const g = goalManager.getGoal(body.goalId)!;
ok('without a model, the planner falls back to one task for the right specialist', g.tasks?.length === 1 && g.tasks[0]!.specialist === 'data_agent', g.planSummary);
ok('the goal ran in the background and completed', g.status === 'completed' && /mean 6/.test(g.outcome ?? ''), `${g.status}: ${g.outcome}`);
ok('the result was verified by the Verification agent', g.tasks![0]!.result?.verification?.verdict === 'verified');

const status = await toolRegistryV2.execute('goal_status', {});
ok('goal_status reports it', status.success && /Recently finished/.test(status.output) && status.output.includes(g.id));

const { goal: p } = await goalManager.createManagedGoal({ kind: 'permanent', objective: 'Keep the notes folder tidy', schedule: { type: 'interval', everyMs: 86_400_000 } });
const paused = await toolRegistryV2.execute('goal_control', { action: 'pause', goal: 'notes folder' });
ok('goal_control pauses it, checked against the store', paused.success && p.status === 'paused' && paused.verification?.status === 'verified', paused.verification?.evidence);
const prio = await toolRegistryV2.execute('goal_control', { action: 'priority', goal: p.id, value: '8' });
ok('… and changes its priority', prio.success && p.priority === 8 && prio.verification?.status === 'verified');
const bad = await toolRegistryV2.execute('goal_create', { objective: 'x', schedule: 'whenever' });
ok('a schedule it cannot read is refused with a reason', !JSON.parse(bad.output).success && /not a schedule/.test(bad.output));

await stopGoalRuntime();
ok('it stops', !rt.isRunning);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
