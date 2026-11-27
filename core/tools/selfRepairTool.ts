/**
 * core/tools/selfRepairTool.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "Heal yourself" and its companions (core/repairRun.ts): start a bounded
 * runtime repair, repair only the latest issue, continue an interrupted run,
 * stop, or explain what is blocked. The only action is restarting one of
 * JARVIS's own voice services; it never changes code, settings or files.
 */

import type { AgentTool } from '../toolRegistryV2.js';
import { repairRunner, spokenResult } from '../repairRun.js';
import { healthCheck } from '../selfCheck.js';
import { getRequestSource } from '../traceContext.js';

const ACTIONS = ['heal', 'last', 'continue', 'stop', 'explain'] as const;
type Action = typeof ACTIONS[number];

export const selfRepairTool: AgentTool = {
  name: 'self_repair',
  description:
    'Use only when the user asks JARVIS to heal or repair itself: "heal yourself" (action heal), "fix the last problem" ' +
    '(last), "continue the repair" (continue), "stop healing" (stop), "why can\'t you fix it" (explain). Restarts JARVIS\'s ' +
    'own voice services when they failed and checks they work again; never changes code, settings or files.',
  riskLevel: 'medium',
  inputSchema: {
    action: { type: 'string', description: 'heal | last | continue | stop | explain', required: true, enum: [...ACTIONS] },
  },
  fallbacks: [],

  async execute(args) {
    const action: Action = ACTIONS.includes(args['action'] as Action) ? args['action'] as Action : 'heal';
    if (action === 'stop') return JSON.stringify({ spoken: repairRunner.stop() });
    if (action === 'explain') return JSON.stringify({ spoken: repairRunner.explainBlock() });
    if (action === 'continue') return JSON.stringify({ spoken: repairRunner.resume().reply });
    const { run, reply } = repairRunner.start(action === 'last' ? 'last' : 'all', getRequestSource());
    if (run.status === 'NOTHING_TO_REPAIR') {
      // Nothing recorded to repair: a self-check instead, said plainly.
      const check = await healthCheck(false);
      return JSON.stringify({ spoken: `No open issue is recorded, so there is nothing to repair, sir. ${check.spoken}`, runId: run.runId, status: run.status });
    }
    const finished = !['PLANNED', 'REPAIRING', 'VERIFYING', 'AWAITING_APPROVAL'].includes(run.status);
    return JSON.stringify({ spoken: finished && !reply ? spokenResult(run) : reply, runId: run.runId, status: run.status });
  },
};
