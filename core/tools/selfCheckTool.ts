/**
 * core/tools/selfCheckTool.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Level-0 tool for questions about JARVIS itself (core/selfCheck.ts): a
 * self-check, a full self-check, the repair report, and why it is stuck.
 * Read-only: it starts no repair and changes nothing.
 */

import type { AgentTool } from '../toolRegistryV2.js';
import { runSelfCheck, type SelfCheckMode } from '../selfCheck.js';

const MODES: SelfCheckMode[] = ['quick', 'full', 'report', 'stuck'];

export const selfCheckTool: AgentTool = {
  name: 'self_check',
  description:
    'Use when the user asks about JARVIS itself: "check yourself" (mode quick), "run a full self-check" (full), ' +
    '"show the repair report" (report), "why are you stuck" (stuck). Reports what was observed working, failing, ' +
    'blocked or not verified, and the open issues. Read-only: it never repairs anything.',
  riskLevel: 'low',
  inputSchema: {
    mode: { type: 'string', description: 'quick | full | report | stuck (default quick)', required: false, enum: MODES },
  },
  fallbacks: [],

  async execute(args) {
    const mode = MODES.includes(args['mode'] as SelfCheckMode) ? args['mode'] as SelfCheckMode : 'quick';
    const report = await runSelfCheck(mode);
    return JSON.stringify(report, null, 2);
  },
};
