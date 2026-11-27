/**
 * core/tools/historyTool.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * action_history: what JARVIS did recently — its last tool calls and approval
 * decisions — without credentials, so "what did you just do?" has a factual
 * answer.
 */

import { toolRegistryV2, type AgentTool } from '../toolRegistryV2.js';
import { approvalGate } from '../../security/approvalGate.js';
import { redactDeep } from '../../security/redactor.js';

export const actionHistoryTool: AgentTool = {
  name: 'action_history',
  description:
    'Use to answer what JARVIS did recently. Returns the last tool calls (tool, arguments, success, error, time) ' +
    'and the last approval decisions (action, target, approved, by whom), oldest first. ' +
    'Optional parameter: limit (1-50, default 10). Read-only.',
  riskLevel: 'low',
  inputSchema: {
    limit: { type: 'number', description: 'How many calls and decisions to list (1-50, default 10).', required: false },
  },
  fallbacks: [],

  async execute(args) {
    const asked = Number(args['limit'] ?? 10);
    const limit = Number.isFinite(asked) ? Math.max(1, Math.min(50, Math.round(asked))) : 10;
    const calls = toolRegistryV2.getHistory(limit).map((r) => ({
      tool: r.tool,
      args: r.args,
      success: r.success,
      ...(r.error ? { error: r.error.slice(0, 200) } : {}),
      at: new Date(r.timestamp).toISOString(),
      durationMs: r.durationMs,
    }));
    const approvals = approvalGate.recentDecisions(limit).map((d) => ({
      action: d.action,
      target: d.target,
      risk: d.risk,
      approved: d.approved,
      by: d.by,
      at: new Date(d.at).toISOString(),
    }));
    return JSON.stringify(redactDeep({ calls, approvals }), null, 2);
  },
};
