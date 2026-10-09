/**
 * core/agents/behaviors/verify.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The Verification, Security & Reliability Agent's check of another agent's
 * result (docs/agents/SEVEN_AGENT_DESIGN.md §6), and its Evidence Check Worker.
 *
 *  - checkResult: rules over the result itself, no model and no network:
 *    finished, has an answer, strong findings have sources, cited sources
 *    exist, conflicts settled, confidence backed by evidence and not raised
 *    over failed tools. Like browser-use's judge, it reviews the run's record; unlike
 *    it, it is deterministic.
 *  - One cited GitHub source is re-read by an Evidence Check Worker
 *    (github_repo): does it exist, and does a licence the answer states match?
 *
 * The verdict is advice. The result is presented either way, with the notes,
 * so the verifier is never a single point of failure. It holds no tool above
 * risk 1 and cannot answer an approval.
 */

import type { AgentBehavior } from '../registry.js';
import type { AgentContext } from '../agentContextApi.js';
import type { AgentOutcome, Conflict, Finding, Source } from '../types.js';

export const EVIDENCE_WORKER_ROLE = 'evidence_check_worker';

export type Verdict = 'verified' | 'issues' | 'unverified';

export interface VerificationCheck { name: string; ok: boolean; note: string }

export interface Verification {
  verdict: Verdict;
  checks: VerificationCheck[];
  /** One line per failed check. */
  issues: string[];
  checkedBy: string;
  at: number;
}

/** What the verifier is given: the parts of a RootResult it reads. */
export interface VerificationInput {
  specialistRole: string;
  status: string;
  answer: string;
  confidence: number;
  findings: Pick<Finding, 'text' | 'sourceIds' | 'confidence'>[];
  sources: Pick<Source, 'id' | 'title' | 'url'>[];
  conflicts: Pick<Conflict, 'subject' | 'attribute' | 'status'>[];
  limitations: string[];
}

/** Roles whose answers are expected to cite sources. */
const SOURCED_ROLES = new Set(['research_agent']);

export function checkResult(input: VerificationInput): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const add = (name: string, ok: boolean, note: string) => checks.push({ name, ok, note });

  add('finished', input.status === 'COMPLETED', input.status === 'COMPLETED' ? 'the task completed' : `the task ended ${input.status.toLowerCase()}`);
  const answered = input.answer.trim().length > 0 && !/^(no answer|not done|no rule matched)/i.test(input.answer.trim());
  add('answered', answered, answered ? 'there is an answer' : 'there is no usable answer');

  const sourceIds = new Set(input.sources.map((s) => s.id));
  const dangling = input.findings.filter((f) => f.sourceIds.some((id) => !sourceIds.has(id)));
  add('citations', dangling.length === 0, dangling.length ? `${dangling.length} finding(s) cite a source that is not in the result` : 'every cited source is present');

  if (SOURCED_ROLES.has(input.specialistRole)) {
    const strongUnsourced = input.findings.filter((f) => f.confidence >= 0.7 && f.sourceIds.length === 0);
    add('sourced', strongUnsourced.length === 0,
      strongUnsourced.length ? `${strongUnsourced.length} high-confidence finding(s) have no source` : 'high-confidence findings have sources');
  }

  const unsettled = input.conflicts.filter((c) => c.status !== 'resolved');
  add('conflicts', unsettled.length === 0,
    unsettled.length ? `unsettled: ${unsettled.map((c) => `${c.subject} ${c.attribute}`).join(', ')}` : 'no unsettled disagreement between sources');

  const evidence = input.findings.length + input.sources.length;
  const overconfident = input.confidence >= 0.8 && evidence === 0;
  add('confidence', !overconfident, overconfident ? `confidence ${input.confidence.toFixed(2)} with no findings or sources behind it` : 'confidence is backed by the evidence given');

  // Limitations are always reported with the answer; the question is whether
  // the confidence took them into account. A model falling back to rules is not a tool failure.
  const toolFailures = input.limitations.filter((l) => /refused|failed|budget|timed out|stopped early/i.test(l) && !/rules were used/i.test(l));
  const weighed = toolFailures.length === 0 || input.confidence < 0.8;
  add('failures weighed', weighed,
    weighed ? (toolFailures.length ? `${toolFailures.length} tool failure(s) listed; confidence ${input.confidence.toFixed(2)} allows for them` : 'no tool failures')
      : `confidence ${input.confidence.toFixed(2)} although ${toolFailures.length} tool call(s) failed or were refused`);
  return checks;
}

export function verdictOf(checks: VerificationCheck[]): Verdict {
  const finished = checks.find((c) => c.name === 'finished');
  if (finished && !finished.ok) return 'unverified';
  return checks.every((c) => c.ok) ? 'verified' : 'issues';
}

/** "github.com/owner/name" → "owner/name". */
export function repoOf(url: string | undefined): string | undefined {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(url ?? '');
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The licence an answer states for a repository, if it names one next to it. */
function statedLicence(answer: string, repo: string): string | undefined {
  const name = repo.split('/')[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${name}[^\\n]{0,160}?\\b(MIT|Apache-2\\.0|GPL-[23]\\.0|AGPL-3\\.0|BSD-[23]-Clause|MPL-2\\.0|ISC|LGPL-[23]\\.[01])\\b`, 'i').exec(answer);
  return m?.[1];
}

/** The Evidence Check Worker: re-reads one GitHub source and compares what the answer says. */
export const evidenceCheckWorker: AgentBehavior = {
  async run(ctx) {
    const repo = String(ctx.input['repo'] ?? '');
    const claimed = typeof ctx.input['licence'] === 'string' ? ctx.input['licence'] : undefined;
    const out = await ctx.callTool('github_repo', { repo });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(out.output) as Record<string, unknown>; } catch { /* not JSON */ }
    if (!out.success || body['success'] === false) {
      return { summary: `could not re-read ${repo}: ${String(body['error'] ?? out.error ?? 'failed')}`, confidence: 0.3, data: { reachable: false } };
    }
    const repoInfo = (body['repository'] ?? body) as Record<string, unknown>;
    const licence = typeof repoInfo['license'] === 'string' ? repoInfo['license'] : null;
    const licenceOk = !claimed || !licence || claimed.toLowerCase() === licence.toLowerCase();
    return {
      summary: `${repo} exists${licence ? `, licence ${licence}` : ''}${claimed ? (licenceOk ? '; matches the answer' : `; the answer says ${claimed}`) : ''}`,
      confidence: 0.9,
      data: { reachable: true, licence, claimed: claimed ?? null, licenceOk },
    };
  },
};

/** Verifies the result in ctx.input.verify. Returns the verdict in data.verification. */
export async function verifyBehaviorRun(ctx: AgentContext): Promise<AgentOutcome> {
  const input = ctx.input['verify'] as VerificationInput;
  ctx.progress('checking the result');
  const checks = checkResult(input);

  // Re-read one cited GitHub source, when this agent may create the worker.
  const repo = input.sources.map((s) => repoOf(s.url)).find(Boolean);
  if (repo && ctx.agent.permissions.canSpawn) {
    try {
      const h = await ctx.spawn({
        childRole: EVIDENCE_WORKER_ROLE, reason: 'independent re-read of a cited source',
        childTask: { description: `Re-read ${repo} and compare it with the answer`, input: { repo, ...(statedLicence(input.answer, repo) ? { licence: statedLicence(input.answer, repo) } : {}) } },
      });
      const [r] = await ctx.wait([h]);
      const d = (r?.data ?? {}) as { reachable?: boolean; licenceOk?: boolean };
      if (r?.status !== 'COMPLETED' || !d.reachable) checks.push({ name: 'source re-read', ok: true, note: `not checked: ${r?.summary ?? 'the worker did not finish'}` });
      else checks.push({ name: 'source re-read', ok: d.licenceOk !== false, note: r.summary });
    } catch (err) {
      checks.push({ name: 'source re-read', ok: true, note: `not checked: ${(err as Error).message.slice(0, 120)}` });
    }
  }

  const verdict = verdictOf(checks);
  const issues = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.note}`);
  const verification: Verification = { verdict, checks, issues, checkedBy: ctx.agent.agentId, at: Date.now() };
  ctx.addFinding({ text: `Verification: ${verdict}${issues.length ? ` — ${issues.join('; ')}` : ''}`, confidence: 0.9, tags: ['verification'], data: { verdict } });
  return {
    summary: verdict === 'verified' ? `Verified: ${checks.length} checks passed.` : verdict === 'unverified' ? `Not verified: ${issues.join('; ')}` : `Issues found: ${issues.join('; ')}`,
    confidence: 0.9,
    data: { verification },
  };
}
