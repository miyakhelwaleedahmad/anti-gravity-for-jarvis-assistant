/**
 * core/tools/codeRepairTool.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "Propose a code repair" (core/codeRepair.ts): a patch for a suspected code
 * defect, written and checked in a separate worktree, left on a branch for
 * the owner. Never merged, never applied to the running checkout.
 *
 * Risk 3 in the catalog, so the registry asks for a typed approval. The tool
 * also refuses an approval given any other way than typed at the console, so
 * raising JARVIS_VOICE_APPROVAL_MAX_RISK cannot let speech approve it.
 * The repair runs in the background (type check and tests take minutes); the
 * result is said when it ends and kept in data/repairs/code/.
 */

import type { AgentTool } from '../toolRegistryV2.js';
import { issueStore } from '../issueStore.js';
import { codeRepairProblem, proposeCodeRepair, type CodeRepairReport } from '../codeRepair.js';

let running: Promise<CodeRepairReport> | null = null;

/** The latest approval decision for this tool, if it was approved. */
async function approvalChannel(): Promise<string | undefined> {
  const { approvalGate } = await import('../../security/approvalGate.js');
  const d = [...approvalGate.recentDecisions(50)].reverse().find((x) => x.tool === 'propose_code_repair');
  return d?.approved ? d.by : undefined;
}

async function announce(text: string): Promise<void> {
  console.log(`[CodeRepair] ${text}`);
  try {
    const [{ nodeBridge }, { conversationBus }] = await Promise.all([import('../../bridge/nodeBridge.js'), import('../conversationBus.js')]);
    const say = () => nodeBridge.speakToClients(text);
    if (conversationBus.isIdle) say(); else conversationBus.onceIdle(say);
  } catch { /* no bridge: the console line above is the report */ }
}

export const codeRepairTool: AgentTool = {
  name: 'propose_code_repair',
  description:
    'Use only when the user asks JARVIS to propose a fix for a fault in its own code. Writes a patch and a regression ' +
    'test in a separate git worktree on a jarvis/repair/* branch, runs the type check and the related tests there, ' +
    'has it reviewed, and leaves the branch for the owner to review and merge. Never changes the running code, never merges. ' +
    'Optional parameter: issueId (default: the latest open code-defect issue).',
  riskLevel: 'medium',
  inputSchema: {
    issueId: { type: 'string', description: 'The issue to repair (iss-…); default the latest open code defect.', required: false },
  },
  fallbacks: [],

  async execute(args) {
    const by = await approvalChannel();
    if (by !== 'console') {
      return JSON.stringify({ started: false, spoken: 'A code repair needs your approval typed at the console, sir; a spoken approval is not accepted for it.' });
    }
    if (running) return JSON.stringify({ started: false, spoken: 'A code repair proposal is already running, sir.' });
    const wanted = typeof args['issueId'] === 'string' && args['issueId'].trim() ? args['issueId'].trim() : undefined;
    const issue = wanted ? issueStore.get(wanted) : issueStore.active().find((i) => !codeRepairProblem(i));
    const problem = codeRepairProblem(issue);
    if (problem) return JSON.stringify({ started: false, spoken: `I cannot propose a code repair, sir: ${wanted || issue ? problem : 'no open issue is a code defect at a known line'}.` });
    running = proposeCodeRepair(issue!.issueId);
    void running.then(
      (r) => announce(r.status === 'PROPOSED'
        ? `A repair is ready for your review, sir, on branch ${r.branch}. It passed the checks and the review. I have not merged it.`
        : `I could not propose a working repair, sir: ${r.reason}`),
      (err) => announce(`The code repair stopped on an error, sir: ${(err as Error).message}`),
    ).finally(() => { running = null; });
    return JSON.stringify({ started: true, issueId: issue!.issueId, spoken: `Preparing a repair for ${issue!.component} in a separate copy of the code, sir. Your running code is not changed; I will tell you when the branch is ready.` });
  },
};
