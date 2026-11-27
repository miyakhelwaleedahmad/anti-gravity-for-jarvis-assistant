/**
 * tests/fallbackToolStrategyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS-006 — the `fallback_tool` repair strategy was byte-identical to
 * `retry_same`: it reset the failed nodes and re-ran them under the SAME tool,
 * so it never switched tools despite its name.
 *
 * `repairPhase` is private to the orchestrator; it is reached here through an
 * `any` cast because the behaviour under test is internal repair semantics.
 */

import { orchestrator } from '../core/orchestrator.js';
import { toolRegistryV2, type AgentTool } from '../core/toolRegistryV2.js';
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

function tool(name: string, fallbacks: string[]): AgentTool {
  return {
    name,
    description: `test tool ${name}`,
    riskLevel: 'low',
    inputSchema: {},
    fallbacks,
    async execute() {
      return 'ok';
    },
  };
}

function failedNode(id: string, toolName: string): TaskNode {
  return {
    id,
    tool: toolName,
    args: { a: 1 },
    dependencies: [],
    status: 'failed',
    retryCount: 1,
    maxRetries: 2,
    priority: 1,
    createdAt: Date.now(),
    description: `run ${toolName}`,
    error: 'boom',
    errorType: 'fatal',
  };
}

function graphWith(...nodes: TaskNode[]): TaskGraph {
  return {
    id: 'g_fallback',
    goal: 'test fallback switching',
    nodes: new Map(nodes.map((n) => [n.id, n])),
    status: 'failed',
    createdAt: Date.now(),
  };
}

console.log('\n=== Fallback Tool Strategy Test ===\n');

toolRegistryV2.register(tool('reliable_backup', []));
toolRegistryV2.register(tool('flaky_primary', ['reliable_backup']));
toolRegistryV2.register(tool('lonely_tool', []));
toolRegistryV2.register(tool('dangling_ref_tool', ['tool_that_does_not_exist']));

const repair = (g: TaskGraph, ids: string[]) =>
  (orchestrator as unknown as {
    repairPhase(s: string, a: Record<string, unknown>, g: TaskGraph, i: string): Promise<TaskGraph | null>;
  }).repairPhase('fallback_tool', { nodeIds: ids }, g, 'test goal');

console.log('--- A failed node switches to its registered fallback ---');
{
  const g = graphWith(failedNode('n1', 'flaky_primary'));
  await repair(g, ['n1']);
  const n = g.nodes.get('n1')!;
  ok('node tool was switched', n.tool === 'reliable_backup', `tool=${n.tool}`);
  ok('node was reset for re-execution', n.status === 'pending', `status=${n.status}`);
  ok('stale error was cleared', n.error === undefined, `error=${n.error}`);
}

console.log('\n--- A node with no alternative is left on its original tool ---');
{
  const g = graphWith(failedNode('n1', 'lonely_tool'));
  await repair(g, ['n1']);
  const n = g.nodes.get('n1')!;
  ok('tool unchanged', n.tool === 'lonely_tool', `tool=${n.tool}`);
  ok('still reset for a plain retry', n.status === 'pending', `status=${n.status}`);
}

console.log('\n--- A fallback naming an unregistered tool is ignored ---');
{
  const g = graphWith(failedNode('n1', 'dangling_ref_tool'));
  await repair(g, ['n1']);
  const n = g.nodes.get('n1')!;
  ok('does not switch to a non-existent tool', n.tool === 'dangling_ref_tool', `tool=${n.tool}`);
}

console.log('\n--- Only the named nodes are touched ---');
{
  const g = graphWith(failedNode('n1', 'flaky_primary'), failedNode('n2', 'flaky_primary'));
  await repair(g, ['n1']);
  ok('named node switched', g.nodes.get('n1')!.tool === 'reliable_backup');
  ok('unnamed node untouched', g.nodes.get('n2')!.tool === 'flaky_primary');
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
