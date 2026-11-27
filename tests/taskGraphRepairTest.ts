/**
 * tests/taskGraphRepairTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-01: in a plan A → B → C, when A failed, B and C were marked failed with
 * "Deadlock: dependencies never resolved". After a repair, the orchestrator
 * reset A only (reflectionEngine.resetFailedNodes): A ran again and
 * succeeded, B and C stayed failed, and the plan could not finish. The
 * "Deadlock" label also misdescribed a step that never ran because the one
 * before it failed.
 *
 *   1. a step after a failed one is reported as not run, naming that step
 *   2. resetting the failed step also resets the steps that never ran because
 *      of it; the whole plan then finishes
 *   3. a step that ran and failed on its own is not reset with it
 *   4. a real deadlock (a dependency that can never finish) is still called one
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-task-graph-'));
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;

const { TaskGraphBuilder, taskGraphEngine } = await import('../core/taskGraphEngine.js');
const { reflectionEngine } = await import('../core/reflectionEngine.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Repairing a plan with dependent steps (BUG-01) ===\n');

const ran: string[] = [];
let aFails = true;
const executor = async (tool: string) => {
  ran.push(tool);
  // "unknown tool" is fatal: no retries, as a real refused step.
  if (tool === 'step_a' && aFails) throw new Error('unknown tool step_a (simulated failure)');
  return `${tool} ok`;
};

const b = new TaskGraphBuilder('A then B then C');
const A = b.addTask({ tool: 'step_a', args: {}, description: 'A' });
const B = b.addTask({ tool: 'step_b', args: {}, description: 'B', dependencies: [A] });
const C = b.addTask({ tool: 'step_c', args: {}, description: 'C', dependencies: [B] });
let graph = b.build();

console.log('--- 1. A fails ---');
graph = await taskGraphEngine.execute(graph, executor as any);
const nodeA = graph.nodes.get(A)!;
const nodeB = graph.nodes.get(B)!;
const nodeC = graph.nodes.get(C)!;
ok('A failed', nodeA.status === 'failed');
ok('B and C did not run', !ran.includes('step_b') && !ran.includes('step_c'), ran.join(','));
ok('B is reported as not run because A failed (not "Deadlock")', /did not run: it depends on/i.test(nodeB.error ?? '') && !/Deadlock/.test(nodeB.error ?? ''), nodeB.error);
ok('C likewise', /did not run: it depends on/i.test(nodeC.error ?? ''), nodeC.error);

console.log('\n--- 2. Repaired: A is reset, the plan finishes ---');
aFails = false;
ran.length = 0;
reflectionEngine.resetFailedNodes(graph, [A]);
ok('B and C are reset with A', nodeB.status === 'pending' && nodeC.status === 'pending', `${nodeB.status}, ${nodeC.status}`);
graph = await taskGraphEngine.execute(graph, executor as any);
ok('A, B and C all run', ran.join(',') === 'step_a,step_b,step_c', ran.join(','));
ok('the plan completes', graph.status === 'completed', graph.status);

console.log('\n--- 3. A step that failed on its own ---');
const b2 = new TaskGraphBuilder('X then Y, Y fails by itself');
const X = b2.addTask({ tool: 'step_x', args: {}, description: 'X' });
const Y = b2.addTask({ tool: 'step_y', args: {}, description: 'Y', dependencies: [X] });
let g2 = b2.build();
g2 = await taskGraphEngine.execute(g2, (async (tool: string) => {
  if (tool === 'step_y') throw new Error('unknown tool step_y (its own failure)');
  return 'ok';
}) as any);
g2.nodes.get(X)!.status = 'failed'; // as if X were the one being repaired
reflectionEngine.resetFailedNodes(g2, [X]);
ok('Y, which ran and failed by itself, keeps its own failure', g2.nodes.get(Y)!.status === 'failed' && /its own failure/.test(g2.nodes.get(Y)!.error ?? ''), g2.nodes.get(Y)!.error);

console.log('\n--- 4. A real deadlock ---');
const b3 = new TaskGraphBuilder('P waits on Q, which is never scheduled');
const Q = b3.addTask({ tool: 'step_q', args: {}, description: 'Q' });
const P = b3.addTask({ tool: 'step_p', args: {}, description: 'P', dependencies: [Q] });
const g3 = b3.build();
g3.nodes.get(Q)!.status = 'running'; // stuck: never finishes, never fails
await taskGraphEngine.execute(g3, (async () => 'ok') as any);
ok('a step waiting on one that never finishes is reported as a deadlock', /Deadlock/.test(g3.nodes.get(P)!.error ?? ''), g3.nodes.get(P)!.error);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
