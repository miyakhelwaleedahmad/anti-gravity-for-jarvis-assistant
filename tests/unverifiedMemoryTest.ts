/**
 * tests/unverifiedMemoryTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Review L-5 (LR2_L5_PLAN.md; owner approval 2026-11-17, option S and L-5b).
 * Unverified agent results never enter trusted long-term memory:
 *
 *   - with JARVIS_AGENT_VERIFY=0, no research, data or coding result is stored
 *   - a result of an agent that is never verified (browser, PC, memory, QA)
 *     is not stored either; only a "verified" verdict is
 *   - a result that is not stored is still kept, provisionally, in the task
 *     archive, and the console line says where
 *   - L-5b: in a goal, a result a later task builds on is marked "not
 *     verified" when it was not verified, so it is not stored as a fact
 * Stand-in memory store, executor and planner; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-unverified-memory-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
delete process.env['JARVIS_AGENT_MEMORY'];
delete process.env['JARVIS_AGENT_VERIFY'];

const { memoryManager } = await import('../memory/memoryManager.js');
const { promoteToMemory, shouldVerify } = await import('../core/agents/jarvisAgents.js');
const { GoalManager } = await import('../core/goalManager.js');
const { GoalRuntime } = await import('../core/goalRuntime.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const stored: string[] = [];
(memoryManager as unknown as { rememberFact: (fact: string) => Promise<void> }).rememberFact = async (fact: string) => { stored.push(fact); };

const result = (role: string, conflicts: unknown[] = []) => ({
  rootTaskId: 'root-l5', status: 'COMPLETED', answer: 'fast-tool is the best fit for the job.', confidence: 0.8,
  findings: [{ text: 'fast-tool is MIT licensed', confidence: 0.9, sourceIds: [], tags: [] }], sources: [], conflicts, limitations: [],
  specialist: { role, status: 'COMPLETED' },
}) as never;
const verification = (verdict: string) => ({ verdict, checks: [], issues: [], checkedBy: 'qa', at: 0 }) as never;
const logs: string[] = [];
const realLog = console.log;
async function count(fn: () => Promise<number>): Promise<number> {
  stored.length = 0;
  logs.length = 0;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console.log = realLog; }
  return stored.length;
}

console.log('\n=== Unverified agent results stay out of long-term memory (L-5) ===\n');

console.log('--- Verification turned off (JARVIS_AGENT_VERIFY=0) ---');
process.env['JARVIS_AGENT_VERIFY'] = '0';
for (const role of ['research_agent', 'data_agent', 'coding_agent']) {
  const r = result(role);
  ok(`${role} result, verification off: not stored`, await count(() => promoteToMemory(r, 'best tool', undefined, shouldVerify(r))) === 0, `${stored.length} stored`);
}
{
  const r = result('research_agent');
  ok('…the same through the default arguments', await count(() => promoteToMemory(r, 'best tool')) === 0, `${stored.length} stored`);
  ok('…the console says it was not stored and points to the task archive', logs.some((l) => /not stored in long-term memory/i.test(l) && /archive/i.test(l) && l.includes('root-l5.json')), logs.join(' | ').slice(0, 300));
}
delete process.env['JARVIS_AGENT_VERIFY'];

console.log('\n--- Agents whose results are never verified ---');
for (const role of ['browser_agent', 'pc_agent', 'memory_agent', 'qa_agent']) {
  const r = result(role);
  ok(`${role} result, no verification: not stored`, await count(() => promoteToMemory(r, 'what happened', undefined, shouldVerify(r))) === 0, `${stored.length} stored`);
}

console.log('\n--- Only a verified result is stored ---');
ok('a verified research result: stored (control)', await count(() => promoteToMemory(result('research_agent'), 'best tool', verification('verified'))) > 0);
ok('a verified result of any agent: stored', await count(() => promoteToMemory(result('browser_agent', [{ subject: 'x', attribute: 'y', status: 'open' }]), 'page facts', verification('verified'))) > 0);
for (const verdict of ['issues', 'inconclusive', 'unverified']) {
  ok(`verdict "${verdict}": not stored`, await count(() => promoteToMemory(result('research_agent'), 'best tool', verification(verdict))) === 0);
}

console.log('\n--- L-5b. Goal context marks results that were not verified ---');
{
  const gm = new GoalManager({ now: () => Date.now() });
  await gm.init();
  const contexts = new Map<string, string>();
  const res = (summary: string, verdict?: string) => ({
    ok: true, usage: { llmCalls: 1, toolCalls: 0, tokens: 10 },
    result: { status: 'COMPLETED', summary, confidence: 0.8, findings: [summary], sources: [], agent: 'research_agent', finishedAt: Date.now(), ...(verdict ? { verification: { verdict } } : {}) },
  });
  const executor = {
    async run(req: any) {
      contexts.set(req.task.title, req.context);
      req.onStarted(`root-${req.task.id}`);
      if (req.task.title === 'unchecked step') return res('the unchecked claim');
      if (req.task.title === 'checked step') return res('the checked claim', 'verified');
      return res('stored it');
    },
    inspectPrevious() { return undefined; },
  };
  const planner = {
    async plan() {
      return { via: 'model' as const, tasks: [
        { title: 'unchecked step', description: 'x', specialist: 'research_agent', dependsOn: [], sideEffects: 'none' as const },
        { title: 'checked step', description: 'x', specialist: 'research_agent', dependsOn: [], sideEffects: 'none' as const },
        { title: 'remember', description: 'remember the findings', specialist: 'memory_agent', dependsOn: ['unchecked step', 'checked step'], sideEffects: 'none' as const },
      ] };
    },
    async proposeMilestone() { return undefined; },
  };
  const rt = new GoalRuntime({ manager: gm, executor: executor as never, planner: planner as never, maxConcurrent: 2, leaseMs: 60_000, stopWaitMs: 300 });
  await rt.start();
  await gm.createManagedGoal({ kind: 'temporary', objective: 'Find and remember' });
  await rt.idle();
  await rt.stop();
  const ctx = contexts.get('remember') ?? '';
  const line = (s: string) => ctx.split('\n').find((l) => l.includes(s)) ?? '';
  ok('(setup) the dependent task got both results', ctx.includes('the unchecked claim') && ctx.includes('the checked claim'), ctx.slice(0, 300));
  ok('an unverified result it builds on is marked not verified', /not verified/i.test(line('the unchecked claim')), line('the unchecked claim'));
  ok('a verified result is not marked', !/not verified/i.test(line('the checked claim')), line('the checked claim'));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
