/**
 * tests/verificationInconclusiveTest.ts  (MM-1A-P7; approved 2026-11-16)
 * ─────────────────────────────────────────────────────────────────────────────
 * A verification step that could not run is never counted as passed
 * (owner, 2026-11-15; core/agents/behaviors/verify.ts:147).
 *
 *   1. the cited source re-read succeeds and matches → "verified"
 *   2. it succeeds and contradicts the answer → "issues" (unchanged)
 *   3. it cannot run (GitHub unreachable) → "inconclusive", never
 *      "verified"; the check is not ok; the original error is kept in full
 *   4. a goal's "verified" criterion: verified → met; issues → unmet;
 *      inconclusive, unverified or "not verified" → needs review, never met
 *   5. (final review L4) the re-read worker cannot be created, or times out:
 *      inconclusive with the reason; a source with no licence against an
 *      answer that states one: inconclusive; the spoken completion says the
 *      result needs review
 * Stand-in tool executor; no network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-verify-inconclusive-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.chdir(workspace);
process.env['JARVIS_AGENT_ARCHIVE'] = '0';

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const { AgentManager } = await import('../core/agents/agentManager.js');
const { agentEvents } = await import('../core/agents/events.js');
const { loadAgentLimits } = await import('../core/agents/config.js');
const { registerAgentRoles } = await import('../core/agents/specialists.js');
const { verifyCriteria } = await import('../core/goalVerifier.js');
const { completionSpeech } = await import('../core/agents/jarvisAgents.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

registerAllTools();
const UNREACHABLE = 'GitHub API answered 503 Service Unavailable for repos/acme/fast-tool (request id gh-0123456789abcdef-0123456789abcdef-0123456789abcdef-0123456789abcdef)';
let github: 'mit' | 'down' | 'hang' | 'nolicence' = 'mit';
const executor = {
  names: () => toolRegistryV2.names(),
  riskOf: (n: string, a?: Record<string, unknown>) => toolRegistryV2.riskOf(n, a),
  getMeta: (n: string) => toolRegistryV2.getMeta(n),
  async execute(name: string) {
    if (name === 'github_repo') {
      if (github === 'hang') throw new Error('the GitHub tool crashed while reading acme/fast-tool');
      if (github === 'nolicence') return { success: true, output: JSON.stringify({ success: true, repository: { name: 'acme/fast-tool', license: null } }), tool: name, durationMs: 1 };
      return github === 'down'
        ? { success: false, output: JSON.stringify({ success: false, error: UNREACHABLE }), error: UNREACHABLE, tool: name, durationMs: 1 }
        : { success: true, output: JSON.stringify({ success: true, repository: { name: 'acme/fast-tool', license: 'MIT' } }), tool: name, durationMs: 1 };
    }
    return { success: true, output: `${name}: stand-in`, tool: name, durationMs: 1 };
  },
};
function manager(limits: Record<string, string> = {}) {
  const m = new AgentManager(agentEvents, loadAgentLimits(limits));
  m.useToolExecutor(executor as never);
  registerAgentRoles(m);
  return m;
}
const base = { specialistRole: 'research_agent', status: 'COMPLETED', confidence: 0.7, conflicts: [], limitations: [], findings: [{ text: 'fast-tool fits', sourceIds: ['s1'], confidence: 0.8 }], sources: [{ id: 's1', title: 'fast-tool', url: 'https://github.com/acme/fast-tool' }] };
async function verify(m: any, answer: string) {
  const h = await m.startRootTask({ request: 'verify', specialistRole: 'qa_agent', task: { description: 'Verify the research result', input: { verify: { ...base, answer } } } });
  const r = await h.result as any;
  return { r, v: r.specialist.data?.['verification'] as { verdict: string; checks: { name: string; ok: boolean; note: string; inconclusive?: boolean }[] } | undefined };
}
const reread = (v: any) => v?.checks?.find((c: any) => c.name === 'source re-read');

console.log('\n=== A verification step that could not run is not a pass ===\n');
{
  github = 'mit';
  const { v } = await verify(manager(), 'fast-tool (MIT) is the best fit.');
  ok('re-read succeeds and matches: verified', v?.verdict === 'verified', JSON.stringify(reread(v)));
  const bad = await verify(manager(), 'fast-tool (GPL-3.0) is the best fit.');
  ok('re-read contradicts the answer: issues (unchanged)', bad.v?.verdict === 'issues', JSON.stringify(reread(bad.v)));
}
{
  github = 'down';
  const { r, v } = await verify(manager(), 'fast-tool (MIT) is the best fit.');
  const c = reread(v);
  ok('re-read could not run: never "verified"', v?.verdict !== 'verified', v?.verdict);
  ok('…the verdict is "inconclusive"', v?.verdict === 'inconclusive', v?.verdict);
  ok('…the re-read check is not counted as passed', c !== undefined && c.ok === false && c.inconclusive === true, JSON.stringify(c));
  ok('…the original error is kept in full', String(c?.note ?? '').includes(UNREACHABLE), String(c?.note ?? ''));
  ok('…the summary does not say "Verified"', !/^Verified/.test(String(r.specialist?.summary ?? '')), String(r.specialist?.summary ?? ''));
  github = 'mit';
}
{
  const task = (verdict: string) => ({ id: 't1', title: 'research', status: 'completed', result: { summary: 'done', findings: [], sources: [], confidence: 0.8, agent: 'research_agent', verification: { verdict, note: 'n' } } });
  const crit = [{ id: 'v', kind: 'verified', description: 'the results were verified' }];
  const status = async (verdict: string) => (await verifyCriteria({ objective: 'o', tasks: [task(verdict)] as any, criteria: crit as any })).status;
  ok('goal criterion "verified": a verified result is met', await status('verified') === 'met');
  ok('…a result with issues is unmet', await status('issues') === 'unmet');
  ok('…an inconclusive verification needs review, never met', await status('inconclusive') === 'needs_review');
  ok('…an unverified result needs review, never met', await status('unverified') === 'needs_review');
  ok('…a result recorded as "not verified" needs review, never met', await status('not verified') === 'needs_review');
}

console.log('\n--- Final review L4 additions ---');
{
  github = 'mit';
  const { v } = await verify(manager({ JARVIS_AGENT_MAX_DEPTH: '1' }), 'fast-tool (MIT) is the best fit.');
  const c = reread(v);
  ok('the re-read worker cannot be created: inconclusive, never verified', v?.verdict === 'inconclusive' && c?.ok === false && c?.inconclusive === true, `${v?.verdict} ${JSON.stringify(c)}`);
  ok('…with the reason kept (which source, and why it was not re-read)', /acme\/fast-tool/.test(String(c?.note ?? '')) && /may not create the Evidence Check Worker/.test(String(c?.note ?? '')), String(c?.note ?? ''));
}
{
  // A worker that does not complete (failed here; a time-out or cancellation takes the same path: status ≠ COMPLETED).
  github = 'hang';
  const { v } = await verify(manager(), 'fast-tool (MIT) is the best fit.');
  const c = reread(v);
  ok('the re-read worker does not complete: inconclusive, never verified', v?.verdict === 'inconclusive' && c?.ok === false && c?.inconclusive === true, `${v?.verdict} ${JSON.stringify(c)}`);
  ok('…with the worker\'s error kept', /crashed while reading/.test(String(c?.note ?? '')), String(c?.note ?? ''));
  github = 'mit';
}
{
  github = 'nolicence';
  const { v } = await verify(manager(), 'fast-tool (MIT) is the best fit.');
  const c = reread(v);
  ok('the source states no licence but the answer states one: inconclusive, not a match', v?.verdict === 'inconclusive' && c?.ok === false && c?.inconclusive === true, `${v?.verdict} ${JSON.stringify(c)}`);
  github = 'mit';
}
{
  const result = { status: 'COMPLETED', answer: 'fast-tool is the best fit.', specialist: { role: 'research_agent' } } as never;
  const speech = completionSpeech(result, { verdict: 'inconclusive', checks: [], issues: [], checkedBy: 'qa', at: 0 } as never);
  ok('the spoken completion says an inconclusive result needs review', /review/i.test(speech), speech);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
