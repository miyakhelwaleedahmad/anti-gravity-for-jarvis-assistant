/**
 * monitoring/traceWiring.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Subscribes the structured logger to the task graph's existing event stream,
 * tagging every entry with the current request's correlation id so one request
 * produces one joinable trace (JARVIS-015).
 *
 * The engine already emitted all of these events and the logger already
 * supported correlation ids; nothing consumed them. This module is the join,
 * and is the only thing that needs calling at startup.
 */

import { taskGraphEngine } from '../core/taskGraphEngine.js';
import { getTraceId } from '../core/traceContext.js';
import { logger } from './structuredLogger.js';

let wired = false;

export function wireExecutionTracing(): void {
  if (wired) return; // idempotent — startup paths call init twice in places
  wired = true;

  const log = logger.child('TaskGraph');

  taskGraphEngine.on('graph_started', (e: { graphId: string; goal: string }) => {
    log.withCorrelation(getTraceId() ?? 'no-trace').info('graph_started', { ...e });
  });

  taskGraphEngine.on('graph_completed', (e: { graphId: string; status: string; durationMs: number }) => {
    log.withCorrelation(getTraceId() ?? 'no-trace').info('graph_completed', { ...e });
  });

  taskGraphEngine.on('graph_interrupted', (e: { graphId: string }) => {
    log.withCorrelation(getTraceId() ?? 'no-trace').warn('graph_interrupted', { ...e });
  });

  taskGraphEngine.on('node_started', (e: { nodeId: string; tool: string }) => {
    // Args are deliberately not logged: they routinely carry file paths and
    // user text, and the trace file is not a place for that.
    log.withCorrelation(getTraceId() ?? 'no-trace').debug('node_started', {
      nodeId: e.nodeId,
      tool: e.tool,
    });
  });

  taskGraphEngine.on('node_completed', (e: Record<string, unknown>) => {
    log.withCorrelation(getTraceId() ?? 'no-trace').info('node_completed', {
      nodeId: e['nodeId'],
      tool: e['tool'],
      durationMs: e['durationMs'],
    });
  });

  taskGraphEngine.on('node_retry', (e: Record<string, unknown>) => {
    log.withCorrelation(getTraceId() ?? 'no-trace').warn('node_retry', { ...e });
  });

  taskGraphEngine.on('node_failed', (e: Record<string, unknown>) => {
    log.withCorrelation(getTraceId() ?? 'no-trace').error('node_failed', {
      nodeId: e['nodeId'],
      tool: e['tool'],
      error: e['error'],
      errorType: e['errorType'],
    });
  });

  logger.info('Execution tracing wired to the task graph event stream.', {}, 'startup');
}
