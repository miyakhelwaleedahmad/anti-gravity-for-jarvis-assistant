/**
 * core/codeRepair.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Propose a code repair for a suspected code defect, on a branch, for the
 * owner to review (self-healing architecture, code-repair phase).
 *
 * JARVIS never changes its own running code and never merges:
 *   1. only an open issue whose category is code_defect and whose location is
 *      a known file of this repository qualifies;
 *   2. a worktree on jarvis/repair/<id> is created from HEAD
 *      (core/worktreeExecutor.ts); the checkout is compared before and after
 *      and must be unchanged;
 *   3. the author (the "coding" model category) writes the fix and a
 *      regression test, as whole files, into the worktree only;
 *   4. the diff linter rejects forbidden paths and weakened tests;
 *   5. the checks run in the worktree: the type check and the tests that
 *      touch the changed files plus the new test (no keys, temporary data);
 *   6. a reviewer (the "review" category, a different model when configured)
 *      reads the diff;
 *   7. at most 2 attempts (JARVIS_REPAIR_MAX_ATTEMPTS), the same failing
 *      checks twice stop it (no progress), a token cap (JARVIS_REPAIR_TOKEN_CAP)
 *      where the provider reports tokens;
 *   8. a passing patch is committed on the repair branch; a failed one is
 *      discarded with its worktree and branch. The issue is not resolved: it
 *      waits, blocked, for the owner to review and merge the branch.
 *
 * The tool that starts this (propose_code_repair) is risk 3: it needs a typed
 * approval, and it refuses any approval that was not typed at the console,
 * whatever JARVIS_VOICE_APPROVAL_MAX_RISK says. Voice never approves a code
 * repair.
 */

import * as fs from 'fs';
import * as path from 'path';
import { dataRoot, getWorkspaceRoot } from './workspaceRoot.js';
import { issueStore as defaultStore, isActive, type Issue, type IssueStore } from './issueStore.js';
import { REPO_ROOT } from './sourceLocation.js';
import { WorktreeExecutor, checkoutState, lintPatch, type CheckCommand, type CheckResult, type FileChange, type Worktree } from './worktreeExecutor.js';
import { redact } from '../security/redactor.js';

export interface RepairBrief {
  issueId: string;
  summary: string;
  component: string;
  location: { file: string; line: number; column?: number; symbol?: string; commit: string };
  frames: string[];
  occurrences: string[];
  /** The file around the failing line, numbered, from the worktree. */
  excerpt: string;
}

export interface PatchProposal {
  /** Whole new contents of each changed file. */
  files: FileChange[];
  /** Name of the regression test the patch adds (tests/<name>.ts), which must fail before and pass after. */
  testName?: string;
  explanation: string;
  /** Tokens the author used, when the provider reported them. */
  tokens?: number | null;
}

export interface CodeRepairDeps {
  store?: IssueStore;
  repoRoot?: string;
  worktreeParent?: string;
  author?: (brief: RepairBrief, attempt: number, lastFailure?: string) => Promise<PatchProposal>;
  review?: (diff: string, brief: RepairBrief) => Promise<{ approved: boolean; notes: string; tokens?: number | null }>;
  /** The checks for a patch (default: type check + tests touching the changed files + its regression test). */
  checks?: (changed: string[], testName: string | undefined, wt: Worktree) => CheckCommand[];
  /** Whether the regression test fails on the unpatched code (default: run it at the base commit). */
  testFailsBefore?: (testName: string, wt: Worktree) => Promise<boolean>;
  now?: () => number;
}

export interface CodeRepairReport {
  repairId: string;
  issueId: string;
  status: 'PROPOSED' | 'FAILED' | 'BLOCKED';
  reason: string;
  branch?: string;
  commit?: string;
  baseCommit?: string;
  worktree?: string;
  attempts: { n: number; explanation: string; lint: string[]; checks: CheckResult[]; review?: { approved: boolean; notes: string }; result: string }[];
  checkoutUnchanged: boolean | null;
  tokensUsed: number | null;
  startedAt: string;
  finishedAt: string;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

/** Why an issue cannot get a code repair proposal, or undefined if it can. */
export function codeRepairProblem(issue: Issue | undefined): string | undefined {
  if (!issue) return 'there is no such issue';
  if (!isActive(issue)) return `the issue is ${issue.status.toLowerCase()}, not open`;
  if (issue.category !== 'code_defect') return `the issue is a ${issue.category} failure, not a code defect; code repair is only for faults in JARVIS's own code`;
  const loc = issue.sourceLocation;
  if (loc.status !== 'KNOWN' || !loc.file || !loc.line) return `the failing line is not known (${loc.status}: ${loc.reason ?? 'no stack trace'}), and a repair is not guessed`;
  if (/^(security\/|tests\/|node_modules\/)/.test(loc.file)) return `the failure is in ${loc.file}, which code repair does not change`;
  return undefined;
}

function excerpt(file: string, line: number, radius = 40): string {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const from = Math.max(0, line - 1 - radius);
    return lines.slice(from, line + radius).map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`).join('\n');
  } catch {
    return '(file not readable)';
  }
}

/** Tests that import a changed file (by its base name), at most 10. */
function testsTouching(repo: string, changed: string[]): string[] {
  const names = changed.filter((f) => !f.startsWith('tests/')).map((f) => path.basename(f).replace(/\.[jt]s$/, ''));
  if (!names.length) return [];
  let files: string[] = [];
  try { files = fs.readdirSync(path.join(repo, 'tests')).filter((f) => /Test\.ts$/.test(f)); } catch { return []; }
  const hits: string[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(repo, 'tests', f), 'utf8');
    if (names.some((n) => new RegExp(`['"/]${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.js)?['"]`).test(text))) hits.push(f.replace(/\.ts$/, ''));
    if (hits.length >= 10) break;
  }
  return hits;
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function defaultChecks(changed: string[], testName: string | undefined, wt: Worktree): CheckCommand[] {
  const tests = [...new Set([...(testName ? [testName] : []), ...testsTouching(wt.path, changed)])];
  return [
    { file: npx, args: ['tsc', '--noEmit', '-p', '.'], label: 'type check' },
    ...(tests.length ? [{ file: npx, args: ['tsx', 'tests/runAll.ts', '--ci', `--only=${tests.join(',')}`], label: `tests: ${tests.join(', ')}` }] : []),
  ];
}

async function defaultAuthor(brief: RepairBrief, attempt: number, lastFailure?: string): Promise<PatchProposal> {
  const { modelRouter } = await import('../bridge/modelRouter.js');
  const res = await modelRouter.categoryChat('coding', {
    messages: [
      { role: 'system', content: 'You repair one defect in a TypeScript project. Reply with JSON only: {"files":[{"path":"repo/relative/path","content":"the whole new file"}],"testName":"<name of a new tests/<name>.ts file you add, which fails before the fix and passes after>","explanation":"one sentence"}. Change as little as possible. Never edit or delete existing tests, never skip a test, never raise a time limit, never touch security/, .env files, package files, data/ or CI. The test prints "=== Results: N passed, M failed ===" and exits non-zero on failure, like the other tests.' },
      { role: 'user', content: JSON.stringify({ ...brief, attempt, ...(lastFailure ? { previousAttemptFailed: lastFailure } : {}) }) },
    ],
  });
  const raw = res.content.replace(/^```(?:json)?\s*|\s*```\s*$/g, '').trim();
  const body = JSON.parse(raw) as { files?: FileChange[]; testName?: string; explanation?: string };
  if (!Array.isArray(body.files) || !body.files.length) throw new Error('the author returned no files');
  return {
    files: body.files.map((f) => ({ path: String(f.path), content: String(f.content) })),
    ...(body.testName ? { testName: String(body.testName).replace(/\.ts$/, '').replace(/^tests\//, '') } : {}),
    explanation: String(body.explanation ?? ''),
    tokens: res.usage?.totalTokens ?? null,
  };
}

async function defaultReview(diff: string, brief: RepairBrief): Promise<{ approved: boolean; notes: string; tokens?: number | null }> {
  const { modelRouter } = await import('../bridge/modelRouter.js');
  const res = await modelRouter.categoryChat('review', {
    messages: [
      { role: 'system', content: 'You review a proposed fix independently. Reply with JSON only: {"approved":true|false,"notes":"one or two sentences"}. Approve only if the diff fixes the described defect, adds a real regression test, and changes nothing else.' },
      { role: 'user', content: JSON.stringify({ defect: brief.summary, location: brief.location, diff: diff.slice(0, 60_000) }) },
    ],
  });
  const raw = res.content.replace(/^```(?:json)?\s*|\s*```\s*$/g, '').trim();
  const body = JSON.parse(raw) as { approved?: unknown; notes?: unknown };
  return { approved: body.approved === true, notes: String(body.notes ?? ''), tokens: res.usage?.totalTokens ?? null };
}

async function defaultTestFailsBefore(testName: string, wt: Worktree, exec: WorktreeExecutor): Promise<boolean> {
  // The new test, alone, against the base code: copy it aside, reset, run, restore.
  const rel = `tests/${testName}.ts`;
  const file = path.join(wt.path, rel);
  const content = fs.readFileSync(file, 'utf8');
  const changed = (await exec.diff(wt)).files.map((f) => f.path).filter((p) => p !== rel);
  const saved = changed.map((p) => ({ p, c: fs.existsSync(path.join(wt.path, p)) ? fs.readFileSync(path.join(wt.path, p), 'utf8') : null }));
  await exec.reset(wt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const [r] = await exec.check(wt, [{ file: npx, args: ['tsx', rel], label: `${testName} before the fix` }]);
  for (const s of saved) if (s.c !== null) { fs.mkdirSync(path.dirname(path.join(wt.path, s.p)), { recursive: true }); fs.writeFileSync(path.join(wt.path, s.p), s.c); }
  return !r!.passed;
}

export async function proposeCodeRepair(issueId: string, deps: CodeRepairDeps = {}): Promise<CodeRepairReport> {
  const store = deps.store ?? defaultStore;
  const now = deps.now ?? Date.now;
  const repo = deps.repoRoot ?? REPO_ROOT;
  const startedAt = new Date(now()).toISOString();
  const repairId = `${issueId.replace(/^iss-/, '')}-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const issue = store.get(issueId);
  const base: CodeRepairReport = { repairId, issueId, status: 'BLOCKED', reason: '', attempts: [], checkoutUnchanged: null, tokensUsed: null, startedAt, finishedAt: startedAt };
  const problem = codeRepairProblem(issue);
  if (problem) return finish(base, 'BLOCKED', problem, now);

  const maxAttempts = envInt('JARVIS_REPAIR_MAX_ATTEMPTS', 2, 1, 5);
  const tokenCap = envInt('JARVIS_REPAIR_TOKEN_CAP', 200_000, 0, 5_000_000);
  const exec = new WorktreeExecutor(repo, deps.worktreeParent);
  const before = await checkoutState(repo);
  const wt = await exec.create(repairId);
  Object.assign(base, { branch: wt.branch, baseCommit: wt.baseCommit, worktree: wt.path });
  const loc = issue!.sourceLocation;
  const brief: RepairBrief = {
    issueId,
    summary: issue!.summary,
    component: issue!.component,
    location: { file: loc.file!, line: loc.line!, ...(loc.column !== undefined ? { column: loc.column } : {}), ...(loc.symbol ? { symbol: loc.symbol } : {}), commit: loc.commit },
    frames: loc.frames.map((f) => `${f.file}:${f.line}${f.symbol ? ` (${f.symbol})` : ''}`),
    occurrences: issue!.recent.slice(-5).map((o) => `${o.at} ${o.message}`),
    excerpt: excerpt(path.join(wt.path, loc.file!), loc.line!),
  };
  try {
    store.transition(issueId, issue!.status === 'BLOCKED' ? 'REPAIR_PLANNED' : (issue!.status === 'REPAIR_PLANNED' ? 'REPAIR_PLANNED' : 'DIAGNOSING'), 'code repair proposal started');
  } catch { /* already in a repair state */ }

  let tokens: number | null = 0;
  const addTokens = (n: number | null | undefined) => { tokens = tokens === null || n === null || n === undefined ? null : tokens + n; };
  let lastFailure: string | undefined;
  let lastFailingSet: string | undefined;
  let outcome: { status: CodeRepairReport['status']; reason: string; commit?: string } | undefined;
  for (let n = 1; n <= maxAttempts && !outcome; n++) {
    if (typeof tokens === 'number' && tokens > tokenCap) { outcome = { status: 'FAILED', reason: `the token cap of ${tokenCap} was reached` }; break; }
    if (n > 1) await exec.reset(wt);
    const attempt: CodeRepairReport['attempts'][number] = { n, explanation: '', lint: [], checks: [], result: '' };
    base.attempts.push(attempt);
    let proposal: PatchProposal;
    try {
      proposal = await (deps.author ?? defaultAuthor)(brief, n, lastFailure);
    } catch (err) {
      attempt.result = `the author failed: ${redact((err as Error).message).slice(0, 200)}`;
      lastFailure = attempt.result;
      continue;
    }
    addTokens(proposal.tokens);
    attempt.explanation = redact(proposal.explanation).slice(0, 300);
    try { exec.write(wt, proposal.files); }
    catch (err) { attempt.lint = [(err as Error).message]; attempt.result = 'rejected before writing'; lastFailure = attempt.lint.join('; '); continue; }
    const diff = await exec.diff(wt);
    attempt.lint = lintPatch(diff.files, diff.text);
    if (attempt.lint.length) { attempt.result = 'rejected by the diff linter'; lastFailure = attempt.lint.join('; '); continue; }
    if (!proposal.testName || !diff.files.some((f) => f.path === `tests/${proposal.testName}.ts` && f.status.startsWith('A'))) {
      attempt.result = 'rejected: no new regression test'; lastFailure = 'add a new regression test file under tests/'; continue;
    }
    if (!(await (deps.testFailsBefore ?? ((t, w) => defaultTestFailsBefore(t, w, exec)))(proposal.testName, wt))) {
      attempt.result = 'rejected: the regression test passes without the fix, so it proves nothing'; lastFailure = attempt.result; continue;
    }
    attempt.checks = await exec.check(wt, (deps.checks ?? defaultChecks)(diff.files.map((f) => f.path), proposal.testName, wt));
    const failing = attempt.checks.filter((c) => !c.passed).map((c) => c.label).sort().join('|');
    if (failing) {
      attempt.result = `checks failed: ${failing}`;
      if (lastFailingSet === failing) { outcome = { status: 'FAILED', reason: `no progress: the same checks failed twice (${failing})` }; break; }
      lastFailingSet = failing;
      lastFailure = attempt.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.tail.slice(-400)}`).join('\n');
      continue;
    }
    const review = await (deps.review ?? defaultReview)(diff.text, brief);
    addTokens(review.tokens);
    attempt.review = { approved: review.approved, notes: redact(review.notes).slice(0, 300) };
    if (!review.approved) { attempt.result = 'the reviewer did not approve'; lastFailure = `review: ${review.notes}`; continue; }
    const commit = await exec.commit(wt, `JARVIS repair proposal for ${issueId}\n\n${attempt.explanation}\n\nChecks: ${attempt.checks.map((c) => c.label).join('; ')}\nReview: ${attempt.review.notes}\nNot merged: review the branch and merge it yourself.`);
    attempt.result = 'proposed';
    outcome = { status: 'PROPOSED', reason: `a patch passed the checks and the review; it is on branch ${wt.branch}, not merged`, commit };
  }
  outcome ??= { status: 'FAILED', reason: `${maxAttempts} attempt(s), none passed: ${lastFailure ?? 'no detail'}` };

  base.tokensUsed = tokens;
  base.checkoutUnchanged = (await checkoutState(repo)) === before;
  if (!base.checkoutUnchanged) outcome = { status: 'FAILED', reason: `the checkout changed during the repair, which must never happen; the proposal is withdrawn (${outcome.reason})` };
  if (outcome.status === 'PROPOSED') {
    base.commit = outcome.commit;
    await exec.remove(wt, false);   // the branch stays for review; the working folder goes
    delete base.worktree;
    markIssue(store, issueId, 'BLOCKED', `a repair is proposed on branch ${wt.branch} (${outcome.commit!.slice(0, 12)}); review and merge it yourself — JARVIS does not merge`, `review branch ${wt.branch}`);
  } else {
    await exec.remove(wt, true);    // rollback: worktree and branch
    delete base.worktree; delete base.branch;
    markIssue(store, issueId, 'BLOCKED', `code repair did not produce a passing patch: ${outcome.reason}`, 'repair it by hand or with Claude Code');
  }
  return finish(base, outcome.status, outcome.reason, now);
}

function markIssue(store: IssueStore, issueId: string, to: 'BLOCKED', reason: string, nextAction: string): void {
  try {
    const cur = store.get(issueId);
    if (cur && isActive(cur) && cur.status !== 'BLOCKED') store.transition(issueId, to, reason, { blockedReason: reason, nextAction });
    else if (cur && cur.status === 'BLOCKED') { store.transition(issueId, 'OPEN', 'code repair finished'); store.transition(issueId, to, reason, { blockedReason: reason, nextAction }); }
  } catch (err) {
    console.warn(`[CodeRepair] could not update ${issueId}: ${(err as Error).message}`);
  }
}

function finish(report: CodeRepairReport, status: CodeRepairReport['status'], reason: string, now: () => number): CodeRepairReport {
  report.status = status;
  report.reason = redact(reason).slice(0, 600);
  report.finishedAt = new Date(now()).toISOString();
  try {
    const dir = path.join(dataRoot(getWorkspaceRoot()), 'data', 'repairs', 'code');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${report.repairId}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn(`[CodeRepair] could not save the report: ${(err as Error).message}`);
  }
  return report;
}
