/**
 * tests/goalVerifierReasonTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MM-1A-P2 (change_log.md:106; owner authorization 2026-11-24): when the
 * review model cannot judge a goal's success criterion, the check waits for
 * the owner's review (unchanged) and its evidence says why. Before, modelJudge
 * dropped the error and every such check said "model unavailable", whatever
 * happened (a refused strict route, a rate limit, an answer out of form).
 *
 *   1  modelJudge still returns undefined when the model fails (contract kept;
 *      tests/modelRouteCorrectionsTest.ts depends on it) and reports the reason
 *   2  an answer that is not the expected JSON: undefined, with its own reason
 *   3  verifyCriteria through modelJudge: needs review, the reason in the evidence
 *   4  a judge that throws: needs review, its message in the evidence
 *   5  a judge that returns undefined and gives no reason: the old wording (control)
 *   6  a judge that answers: unchanged (control)
 *   7  a secret in the error is not copied into the evidence
 *   8  a long, multi-line error becomes one short line
 *
 * Pure functions; no model, no network.
 */

import type { GoalCriterion, GoalTask } from '../core/goalLifecycle.js';
const { modelJudge, verifyCriteria } = await import('../core/goalVerifier.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const task = {
  id: 't1', title: 'compare frameworks', specialist: 'research_agent', status: 'completed', attempts: 1, maxAttempts: 3, failures: [],
  result: { summary: 'Svelte and React compared; React recommended.', findings: ['React has the larger ecosystem'], sources: [], confidence: 0.8, agent: 'research_agent' },
} as unknown as GoalTask;
const criterion = { id: 'c1', description: 'names a recommendation', kind: 'judge' } as GoalCriterion;
const input = { objective: 'Pick a framework', criterion: 'names a recommendation', evidence: 'React recommended.' };
const judgeCheck = async (judge: Parameters<typeof verifyCriteria>[0]['judge']) => {
  const v = await verifyCriteria({ objective: 'Pick a framework', tasks: [task], criteria: [criterion], ...(judge ? { judge } : {}) });
  return { status: v.status, check: v.checks.find((c) => c.id === 'c1') };
};
const failingChat = (message: string) => async () => { throw new Error(message); };

console.log('\n=== Goal criteria: why a check could not run (MM-1A-P2) ===\n');

console.log('--- 1. modelJudge: the contract is kept and the reason is reported ---');
{
  let reported: string | undefined;
  const verdict = await modelJudge(failingChat('StrictRouteError: JARVIS_MODEL_REVIEW review-model failed: 429 rate limited'))({ ...input, onFailure: (r: string) => { reported = r; } } as never);
  ok('modelJudge still returns undefined when the model fails', verdict === undefined, JSON.stringify(verdict));
  ok('…and reports the model error as the reason', !!reported && /429 rate limited/.test(reported), String(reported));
}

console.log('\n--- 2. An answer that is not the expected JSON ---');
{
  let reported: string | undefined;
  const verdict = await modelJudge(async () => ({ content: 'I think it is fine.' }))({ ...input, onFailure: (r: string) => { reported = r; } } as never);
  ok('an answer out of form gives no verdict', verdict === undefined, JSON.stringify(verdict));
  ok('…and says the answer was not in the expected form', !!reported && /expected form/i.test(reported), String(reported));
}

console.log('\n--- 3. verifyCriteria through modelJudge ---');
{
  const { status, check } = await judgeCheck(modelJudge(failingChat('StrictRouteError: JARVIS_MODEL_REVIEW review-model failed: 429 rate limited')));
  ok('the criterion is not met and waits for review (unchanged)', status === 'needs_review' && check?.met === undefined, `${status}; met ${check?.met}`);
  ok('…and its evidence gives the reason, not only "model unavailable"', !!check && /could not run/.test(check.evidence) && /429 rate limited/.test(check.evidence), check?.evidence);
  ok('…and still asks for the owner\'s review', !!check && /waiting for your review/.test(check.evidence), check?.evidence);
}

console.log('\n--- 4. A judge that throws ---');
{
  const { status, check } = await judgeCheck(async () => { throw new Error('judge crashed: socket hang up'); });
  ok('needs review, with the thrown message in the evidence', status === 'needs_review' && check?.met === undefined && /socket hang up/.test(check?.evidence ?? ''), check?.evidence);
}

console.log('\n--- 5. A judge that gives no verdict and no reason (control) ---');
{
  const { status, check } = await judgeCheck(async () => undefined);
  ok('the old wording is kept', status === 'needs_review' && check?.evidence === 'the check could not run (model unavailable); waiting for your review', check?.evidence);
}

console.log('\n--- 6. A judge that answers (control) ---');
{
  const yes = await judgeCheck(async () => ({ met: true, reason: 'React is recommended' }));
  const no = await judgeCheck(async () => ({ met: false, reason: 'no recommendation' }));
  ok('a "met" verdict is unchanged', yes.status === 'met' && yes.check?.met === true && yes.check.evidence === 'React is recommended', `${yes.status}; ${yes.check?.evidence}`);
  ok('an "unmet" verdict is unchanged', no.status === 'unmet' && no.check?.met === false && no.check.evidence === 'no recommendation', `${no.status}; ${no.check?.evidence}`);
}

console.log('\n--- 7. A secret in the error ---');
{
  const key = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const { check } = await judgeCheck(modelJudge(failingChat(`401 invalid api key ${key}`)));
  ok('the key is not copied into the evidence', !!check && !check.evidence.includes(key) && /401/.test(check.evidence), check?.evidence);
}

console.log('\n--- 8. A long, multi-line error ---');
{
  const { check } = await judgeCheck(modelJudge(failingChat(`first line of the error\n${'x'.repeat(2000)}\nlast line`)));
  ok('the evidence is one line of at most 300 characters', !!check && !/[\r\n]/.test(check.evidence) && check.evidence.length <= 300 && /first line of the error/.test(check.evidence), `${check?.evidence.length} chars`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
