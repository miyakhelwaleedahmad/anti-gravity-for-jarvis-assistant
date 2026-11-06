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
 *
 * ARCH-07: state changes, security events (risk decisions, refusals,
 * approvals asked and answered) and every tool call are joined here too, so
 * one request can be followed in one file (data/logs/jarvis.*.jsonl). Before,
 * they went to the console, security_audit.log and the registry's memory.
 * Arguments and command text are left out, as for task-graph nodes: they
 * carry paths and the owner's words. security_audit.log keeps its own full
 * (redacted) record.
 *
 * Phase A6 (TRA-13): every check of a call's effect that ran (verified or
 * failed) is a `verification` entry here and a `verification` line in the
 * action log (data/logs/jarvis-actions.jsonl) with the same trace id. Its
 * evidence is redacted and cut to 200 characters; it can name what was checked,
 * such as a window title or a file name.
 */

import { taskGraphEngine } from '../core/taskGraphEngine.js';
import { getAgentPath, getTraceId } from '../core/traceContext.js';
import { agentStateMachine } from '../core/agentStateMachine.js';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { securityAuditLogger } from '../security/securityAuditLogger.js';
import { logger } from './structuredLogger.js';
import { actionAuditLog } from '../control/actionAuditLog.js';

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

  const trace = () => getTraceId() ?? 'no-trace';
  const stateLog = logger.child('State').fileOnly(); // already said on the console by the state machine
  agentStateMachine.on('transition', (e: { from: string; to: string }) => {
    stateLog.withCorrelation(trace()).info('state_transition', { from: e.from, to: e.to });
  });
  agentStateMachine.on('watchdog_reset', (e: { fromState: string; reason: string }) => {
    stateLog.withCorrelation(trace()).warn('watchdog_reset', { from: e.fromState, reason: String(e.reason).slice(0, 120) });
  });

  const securityLog = logger.child('Security').fileOnly();
  securityAuditLogger.onEvent((e) => {
    const data = {
      eventType: e.eventType,
      ...(e.toolName ? { toolName: e.toolName } : {}),
      ...(e.action ? { action: e.action.slice(0, 120) } : {}),
      ...(e.riskLevel ? { riskLevel: e.riskLevel } : {}),
      ...(e.approved !== undefined ? { approved: e.approved } : {}),
      ...(e.decidedBy ? { decidedBy: e.decidedBy } : {}),
      ...(e.requestId ? { requestId: e.requestId } : {}),
      ...(e.partOf ? { partOf: e.partOf } : {}),
      ...(e.reason ? { reason: e.reason.slice(0, 200) } : {}),
      ...(e.agent ? { agent: e.agent } : {}),
    };
    const denied = e.eventType === 'COMMAND_DENIED' || e.eventType === 'APPROVAL_DENIED' || e.eventType === 'APPROVAL_TIMEOUT';
    securityLog.withCorrelation(trace())[denied ? 'warn' : 'info']('security', data);
  });

  const toolLog = logger.child('Tool').fileOnly();
  toolRegistryV2.onCall((c) => {
    toolLog.withCorrelation(trace())[c.success ? 'info' : 'warn']('tool_call', {
      tool: c.tool, success: c.success, durationMs: c.durationMs, attempt: c.attemptNumber,
      ...(c.error ? { error: c.error.slice(0, 200) } : {}),
    });
  });

  // Every check of an effect that ran, in the trace and in the action log with
  // the same trace id, so the two agree after a VERIFICATION_FAILED (phase A6, TRA-13).
  // A check inside an agent carries the agent's name, not the foreground trace id,
  // as the action line does (review F10).
  toolRegistryV2.onVerification((v) => {
    const agentPath = getAgentPath();
    const traceId = agentPath ? undefined : getTraceId();
    const evidence = v.evidence.slice(0, 200);
    toolLog.withCorrelation(trace())[v.status === 'verified' ? 'info' : 'warn']('verification', {
      tool: v.tool, status: v.status, evidence, ...(agentPath ? { agentPath } : {}),
    });
    void actionAuditLog.logVerification({
      ...(traceId ? { traceId } : {}), ...(agentPath ? { agentPath } : {}), tool: v.tool, status: v.status, evidence,
    });
  });

  logger.info('Execution tracing wired: task graph, state changes, security events and tool calls.', {}, 'startup');
}
