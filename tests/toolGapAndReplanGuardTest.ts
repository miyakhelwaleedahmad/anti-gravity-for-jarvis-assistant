/**
 * tests/toolGapAndReplanGuardTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS-004 — the per-node delay must be conditional, not a flat 500 ms before
 *              every node including the first call to a tool.
 * JARVIS-008 — a goal that has spent its replan budget must not stay poisoned
 *              for the rest of the session.
 */

import { TaskGraphEngine } from '../core/taskGraphEngine.js';
import type { TaskGraph, TaskNode } from '../core/taskGraphEngine.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`);
    failed++;
  }
}

function makeGraph(id: string, goal: string, tool: string): TaskGraph {
  const node: TaskNode = {
    id: 'n1',
    tool,
    args: {},
    dependencies: [],
    status: 'pending',
    retryCount: 0,
    maxRetries: 0,
    priority: 1,
    createdAt: Date.now(),
    description: `invoke ${tool}`,
  };
  return {
    id,
    goal,
    nodes: new Map([[node.id, node]]),
    status: 'building',
    createdAt: Date.now(),
  };
}

const succeed = async () => 'ok';

console.log('\n=== Tool Gap & Replan Guard Test ===\n');

console.log('--- JARVIS-004: conditional per-tool spacing ---');
{
  const engine = new TaskGraphEngine();
  const t0 = Date.now();
  const g = await engine.execute(makeGraph('g1', 'first call', 'tool_alpha'), succeed);
  const elapsed = Date.now() - t0;
  ok('graph actually completed', g.status === 'completed', String(g.status));
  ok('first call to a tool is NOT delayed by ~500ms', elapsed < 200, `${elapsed}ms`);
}
{
  const engine = new TaskGraphEngine();
  await engine.execute(makeGraph('g2a', 'warm', 'tool_beta'), succeed);
  const t0 = Date.now();
  await engine.execute(makeGraph('g2b', 'other tool', 'tool_gamma'), succeed);
  ok('a *different* tool is not delayed by the first', Date.now() - t0 < 200, `${Date.now() - t0}ms`);
}
{
  const engine = new TaskGraphEngine();
  await engine.execute(makeGraph('g3a', 'same tool 1', 'tool_delta'), succeed);
  const t0 = Date.now();
  await engine.execute(makeGraph('g3b', 'same tool 2', 'tool_delta'), succeed);
  const elapsed = Date.now() - t0;
  ok('an immediate repeat of the SAME tool is still spaced out', elapsed >= 100, `${elapsed}ms`);
}

console.log('\n--- JARVIS-008: the replan budget is released on success ---');
{
  const engine = new TaskGraphEngine();
  const goal = 'take a screenshot';

  ok('replan 1 allowed', engine.canReplan(goal) === true);

  const g1 = await engine.execute(makeGraph('r1', goal, 'tool_epsilon'), succeed);
  ok('goal completed', g1.status === 'completed', String(g1.status));

  // Without the fix the counter would still be 1 here and only one further
  // replan would be granted before the goal was refused.
  ok('replan budget was released by the success (1/2)', engine.canReplan(goal) === true);
  ok('replan budget was released by the success (2/2)', engine.canReplan(goal) === true);
  ok('budget is still finite — third replan refused', engine.canReplan(goal) === false);
}

console.log('\n--- JARVIS-008: the same command runs every time ---');
{
  const engine = new TaskGraphEngine();
  const goal = 'open notepad';
  const statuses: string[] = [];

  for (let i = 0; i < 3; i++) {
    // Each attempt needs a replan before it settles, as a flaky command would.
    engine.canReplan(goal);
    const g = await engine.execute(makeGraph(`s${i}`, goal, 'tool_zeta'), succeed);
    statuses.push(g.status);
  }

  ok(
    'the identical command executed all three times',
    statuses.every((s) => s === 'completed'),
    statuses.join(', '),
  );
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
