/**
 * tests/executionTraceTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS-015 — the pieces of a trace all existed (the logger takes a
 * correlationId, the engine emits graph/node events) but nothing joined them,
 * so a request could not be reconstructed from the logs.
 *
 * Proves one execution produces one set of correlated entries.
 */

import { taskGraphEngine } from '../core/taskGraphEngine.js';
import type { TaskGraph, TaskNode } from '../core/taskGraphEngine.js';
import { beginTrace, getTraceId, endTrace } from '../core/traceContext.js';
import { wireExecutionTracing } from '../monitoring/traceWiring.js';
import { logger, type LogEntry } from '../monitoring/structuredLogger.js';

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

function graph(id: string, goal: string, tool: string): TaskGraph {
  const node: TaskNode = {
    id: 'n1', tool, args: {}, dependencies: [], status: 'pending',
    retryCount: 0, maxRetries: 0, priority: 1, createdAt: Date.now(),
    description: `run ${tool}`,
  };
  return { id, goal, nodes: new Map([[node.id, node]]), status: 'building', createdAt: Date.now() };
}

console.log('\n=== Execution Trace Test ===\n');

// Capture entries by wrapping the logger's core write. StructuredLogger is not
// an EventEmitter, and reading the rotating log file would make the test depend
// on flush timing.
const captured: LogEntry[] = [];
type LogFn = (
  level: string, module: string, message: string,
  data?: Record<string, unknown>, correlationId?: string, error?: unknown,
) => void;
const loggerInternals = logger as unknown as { _log: LogFn; setLevel(l: string): void };
const originalLog = loggerInternals._log.bind(logger);
loggerInternals.setLevel('DEBUG'); // node_started is logged at DEBUG
loggerInternals._log = ((level, module, message, data, correlationId, error) => {
  captured.push({
    timestamp: new Date().toISOString(),
    level: level as LogEntry['level'],
    module, message,
    ...(data ? { data } : {}),
    ...(correlationId ? { correlationId } : {}),
    pid: process.pid,
  });
  originalLog(level, module, message, data, correlationId, error);
}) as LogFn;

console.log('--- Trace ids are issued per request ---');
{
  endTrace();
  ok('no trace id outside a request', getTraceId() === undefined);
  const a = beginTrace();
  ok('beginTrace returns an id', typeof a === 'string' && a.startsWith('trace_'), a);
  ok('the id is readable while active', getTraceId() === a);
  const b = beginTrace();
  ok('a second request gets a different id', b !== a, `${a} vs ${b}`);
  endTrace();
  ok('endTrace clears it', getTraceId() === undefined);
}

console.log('\n--- Wiring is idempotent ---');
{
  wireExecutionTracing();
  wireExecutionTracing();
  const listeners = taskGraphEngine.listenerCount('graph_started');
  ok('subscribing twice does not double-register', listeners === 1, `${listeners} listener(s)`);
}

console.log('\n--- One execution yields one correlated trace ---');
{
  captured.length = 0;
  const traceId = beginTrace();
  await taskGraphEngine.execute(graph('g_trace', 'trace me', 'tool_trace'), async () => 'ok');
  endTrace();

  const mine = captured.filter((e) => e.correlationId === traceId);
  const recorded = mine.length > 0;
  ok('entries were recorded for this trace', recorded, `${mine.length} entries`);

  const messages = mine.map((e) => e.message);
  ok('the graph start is traced', messages.includes('graph_started'), messages.join(','));
  ok('the tool invocation is traced', messages.includes('node_started'));
  ok('the outcome is traced', messages.includes('graph_completed'));
  // These would pass vacuously on an empty array, so require entries first.
  ok('every entry shares the one correlation id',
     recorded && mine.every((e) => e.correlationId === traceId));
  ok('entries name their module', recorded && mine.every((e) => e.module === 'TaskGraph'));

  // Tool arguments must not be written to the trace file.
  const nodeStarts = mine.filter((e) => e.message === 'node_started');
  ok('node_started does not log tool arguments',
     nodeStarts.length > 0 && nodeStarts.every((e) => !('args' in (e.data ?? {}))),
     `${nodeStarts.length} node_started entries`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
