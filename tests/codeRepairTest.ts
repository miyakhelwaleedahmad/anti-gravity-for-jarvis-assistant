/**
 * tests/codeRepairTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Code repair, propose only (core/worktreeExecutor.ts, core/codeRepair.ts),
 * against a fixture repository with a planted bug. Real git, a real worktree
 * and the real test runner; only the patch author and the reviewer are
 * scripted (no model here).
 *
 *   1. A good patch: written in a worktree on jarvis/repair/<id>, its new
 *      regression test fails on the old code and passes on the new, the
 *      checks pass, the reviewer approves, it is committed on that branch.
 *      The checkout is byte-identical, its branch and HEAD unmoved: nothing
 *      merged. The issue is BLOCKED waiting for the owner, not "resolved".
 *   2. Rejected patches: one that removes an assertion, one that adds a skip,
 *      one that raises a time limit, one that edits package.json, one whose
 *      "regression test" passes without the fix, one with no test.
 *   3. The same failing checks twice stop the run (no progress); a failed
 *      run leaves no worktree and no branch behind.
 *   4. Only a code defect at a known line qualifies.
 *   5. The tool: risk 3 (typed approval); a spoken approval is refused even
 *      when JARVIS_VOICE_APPROVAL_MAX_RISK would allow risk 3.
 *   6. Routes.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-code-repair-')));
for (const d of ['memory', 'data', path.join('data', 'logs'), 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
const here = path.dirname(fileURLToPath(import.meta.url));
const jarvisRepo = path.resolve(here, '..');

const { IssueStore } = await import('../core/issueStore.js');
const { proposeCodeRepair, codeRepairProblem } = await import('../core/codeRepair.js');
const { lintPatch, pathProblem } = await import('../core/worktreeExecutor.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

// ── The fixture repository ───────────────────────────────────────────────────
const repo = path.join(root, 'fixture');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
const BUGGY = 'export function add(a: number, b: number): number {\n  return a - b;\n}\n';
const FIXED = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
const EXISTING_TEST = [
  "import { add } from '../src/add.js';",
  'let failed = 0;',
  "function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log('FAIL ' + name); } }",
  "ok('adding zero', add(2, 0) === 2);",
  'const TIMEOUT_MS = 1000;',
  "console.log('=== Results: ' + (failed ? 0 : 1) + ' passed, ' + failed + ' failed ===');",
  'process.exit(failed ? 1 : 0);',
  '',
].join('\n');
const REGRESSION_TEST = [
  "import { add } from '../src/add.js';",
  'const good = add(2, 3) === 5;',
  "console.log('=== Results: ' + (good ? 1 : 0) + ' passed, ' + (good ? 0 : 1) + ' failed ===');",
  'process.exit(good ? 0 : 1);',
  '',
].join('\n');
fs.writeFileSync(path.join(repo, 'src', 'add.ts'), BUGGY);
fs.writeFileSync(path.join(repo, 'tests', 'existingTest.ts'), EXISTING_TEST);
fs.writeFileSync(path.join(repo, 'package.json'), '{ "name": "fixture", "type": "module" }\n');
fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
// The fixture uses JARVIS's installed tsx.
fs.symlinkSync(path.join(jarvisRepo, 'node_modules'), path.join(repo, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const git = (args: string[], cwd = repo) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
git(['init', '-q', '-b', 'main']);
git(['add', '-A']);
git(['commit', '-q', '-m', 'fixture with a planted bug']);
const baseHead = git(['rev-parse', 'HEAD']);
const snapshot = () => `${git(['rev-parse', '--abbrev-ref', 'HEAD'])} ${git(['rev-parse', 'HEAD'])}\n${git(['status', '--porcelain=v1', '-uall'])}\n${fs.readFileSync(path.join(repo, 'src', 'add.ts'), 'utf8')}`;
const before = snapshot();

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const checks = (_changed: string[], testName: string | undefined) => [
  { file: npx, args: ['tsx', 'tests/existingTest.ts'], label: 'existing test' },
  ...(testName ? [{ file: npx, args: ['tsx', `tests/${testName}.ts`], label: testName }] : []),
];

let caseN = 0;
function defect() {
  const store = new IssueStore(path.join(root, `store-${++caseN}`));
  const err = new TypeError('add returned the wrong sum');
  const issue = store.recordOccurrence({ component: 'tool:calculator', tool: 'calculator', message: 'TypeError: add returned the wrong sum', error: err }).issue;
  // The planted bug's location in the fixture (not this test file).
  issue.sourceLocation = { status: 'KNOWN', file: 'src/add.ts', line: 2, column: 3, symbol: 'add', frames: [], commit: baseHead.slice(0, 12) };
  return { store, issue };
}
const approve = async () => ({ approved: true, notes: 'fixes the sign; adds a regression test' });
const run = (store: InstanceType<typeof IssueStore>, issueId: string, author: Parameters<typeof proposeCodeRepair>[1] extends infer D ? D extends { author?: infer A } ? A : never : never, extra: Record<string, unknown> = {}) =>
  proposeCodeRepair(issueId, { store, repoRoot: repo, worktreeParent: path.join(root, 'repairs'), author: author as never, review: approve, checks, ...extra });

// ── 1. A good patch ──────────────────────────────────────────────────────────
console.log('\n--- 1. A good patch is proposed on a branch, not merged ---');
{
  const { store, issue } = defect();
  let attempts = 0;
  const report = await run(store, issue.issueId, async () => {
    attempts++;
    return { files: [{ path: 'src/add.ts', content: FIXED }, { path: 'tests/addRegressionTest.ts', content: REGRESSION_TEST }], testName: 'addRegressionTest', explanation: 'add subtracted instead of adding', tokens: null };
  });
  ok('PROPOSED on a jarvis/repair/* branch with a commit', report.status === 'PROPOSED' && /^jarvis\/repair\//.test(report.branch ?? '') && /^[0-9a-f]{40}$/.test(report.commit ?? ''), `${report.status}: ${report.reason}`);
  ok('one attempt', attempts === 1 && report.attempts.length === 1);
  ok('the checks ran and passed in the worktree', report.attempts[0]!.checks.length === 2 && report.attempts[0]!.checks.every((c) => c.passed), JSON.stringify(report.attempts[0]!.checks));
  const onBranch = git(['show', `${report.branch}:src/add.ts`]);
  ok('the fix is on the repair branch', onBranch.includes('a + b') && git(['show', `${report.branch}:tests/addRegressionTest.ts`]).includes('add(2, 3)'));
  ok('the checkout is byte-identical: same branch, HEAD, status and file', snapshot() === before, snapshot());
  ok('nothing merged: main is still the base commit, the bug still in the checkout', git(['rev-parse', 'main']) === baseHead && fs.readFileSync(path.join(repo, 'src', 'add.ts'), 'utf8') === BUGGY);
  ok('the checkout reported unchanged', report.checkoutUnchanged === true);
  ok('the worktree folder is gone, the branch stays for review', !fs.existsSync(path.join(root, 'repairs', report.repairId)) && git(['branch', '--list', report.branch!]).includes('jarvis/repair/'));
  const after = store.get(issue.issueId)!;
  ok('the issue is BLOCKED waiting for the owner, not resolved', after.status === 'BLOCKED' && after.blockedReason!.includes(report.branch!) && /JARVIS does not merge/.test(after.blockedReason!));
  ok('tokens not reported: null, not 0', report.tokensUsed === null);
  ok('the report is saved', fs.existsSync(path.join(root, 'data', 'repairs', 'code', `${report.repairId}.json`)));
}

// ── 2. Rejected patches ──────────────────────────────────────────────────────
console.log('\n--- 2. Patches that weaken tests are rejected ---');
const weakened = EXISTING_TEST.replace("ok('adding zero', add(2, 0) === 2);\n", '');
const cases: [string, () => { files: { path: string; content: string }[]; testName?: string }, RegExp][] = [
  ['removes an assertion', () => ({ files: [{ path: 'src/add.ts', content: FIXED }, { path: 'tests/existingTest.ts', content: weakened }, { path: 'tests/addRegressionTest.ts', content: REGRESSION_TEST }], testName: 'addRegressionTest' }), /removes 1 assertion/],
  ['adds a skip', () => ({ files: [{ path: 'src/add.ts', content: FIXED }, { path: 'tests/existingTest.ts', content: EXISTING_TEST.replace('let failed = 0;', 'let failed = 0;\nprocess.exit(0);') }, { path: 'tests/addRegressionTest.ts', content: REGRESSION_TEST }], testName: 'addRegressionTest' }), /adds a skip or an early successful exit/],
  ['raises a time limit', () => ({ files: [{ path: 'src/add.ts', content: FIXED }, { path: 'tests/existingTest.ts', content: EXISTING_TEST.replace('TIMEOUT_MS = 1000', 'TIMEOUT_MS = 60000') }, { path: 'tests/addRegressionTest.ts', content: REGRESSION_TEST }], testName: 'addRegressionTest' }), /raises a time limit \(1000 → 60000\)/],
  ['edits package.json', () => ({ files: [{ path: 'src/add.ts', content: FIXED }, { path: 'package.json', content: '{}' }], testName: 'addRegressionTest' }), /no repair may change/],
  ['writes outside the repository', () => ({ files: [{ path: '../evil.ts', content: 'x' }], testName: 'x' }), /leaves the repository/],
  ['has no regression test', () => ({ files: [{ path: 'src/add.ts', content: FIXED }] }), /no new regression test/],
  ['has a "test" that passes without the fix', () => ({ files: [{ path: 'src/add.ts', content: FIXED }, { path: 'tests/addRegressionTest.ts', content: "console.log('=== Results: 1 passed, 0 failed ===');\n" }], testName: 'addRegressionTest' }), /passes without the fix/],
];
for (const [name, patch, why] of cases) {
  const { store, issue } = defect();
  const report = await run(store, issue.issueId, async () => ({ ...patch(), explanation: name, tokens: 10 }));
  const all = report.attempts.map((a) => `${a.result} ${a.lint.join(' ')}`).join(' | ');
  ok(`${name}: rejected, nothing proposed`, report.status === 'FAILED' && why.test(all), `${report.status}: ${all}`);
}
ok('after every rejection the checkout is still byte-identical', snapshot() === before);
ok('…and no repair branch was left except the proposed one', git(['branch', '--list', 'jarvis/repair/*']).split('\n').filter(Boolean).length === 1, git(['branch', '--list', 'jarvis/repair/*']));

// ── 3. No progress ───────────────────────────────────────────────────────────
console.log('\n--- 3. Bounds ---');
{
  const { store, issue } = defect();
  let calls = 0;
  const wrong = 'export function add(a: number, b: number): number {\n  return a * b;\n}\n';
  const report = await run(store, issue.issueId, async () => { calls++; return { files: [{ path: 'src/add.ts', content: wrong }, { path: 'tests/addRegressionTest.ts', content: REGRESSION_TEST }], testName: 'addRegressionTest', explanation: 'multiplies', tokens: 100 }; });
  ok('the same failing checks twice: stopped, no progress', report.status === 'FAILED' && /no progress: the same checks failed twice/.test(report.reason) && calls === 2, `${report.status} ${report.reason} (${calls})`);
  ok('a failed run leaves no worktree and no branch', !fs.existsSync(path.join(root, 'repairs', report.repairId)) && !git(['branch', '--list', `jarvis/repair/${report.repairId}`]));
  ok('reported token use is counted', report.tokensUsed === 200, String(report.tokensUsed));
  ok('the issue says it needs a person', store.get(issue.issueId)!.status === 'BLOCKED' && /did not produce a passing patch/.test(store.get(issue.issueId)!.blockedReason ?? ''));
}

// ── 4. Which issues qualify ─────────────────────────────────────────────────
console.log('\n--- 4. Which issues qualify ---');
{
  const store = new IssueStore(path.join(root, 'store-q'));
  const ext = store.recordOccurrence({ component: 'brain_to_llm', message: 'Groq API error 429: rate limit' }).issue;
  ok('an external failure does not qualify', /not a code defect/.test(codeRepairProblem(ext) ?? ''));
  const unknown = store.recordOccurrence({ component: 'tool:x', message: "TypeError: Cannot read properties of undefined (reading 'a')" }).issue;
  ok('a code defect without a known line does not qualify (no guessing)', /not known/.test(codeRepairProblem(unknown) ?? ''), codeRepairProblem(unknown));
  const sec = store.recordOccurrence({ component: 'tool:y', message: 'TypeError: boom y' }).issue;
  sec.sourceLocation = { status: 'KNOWN', file: 'security/riskEngine.ts', line: 10, frames: [], commit: 'x' };
  ok('a defect inside security/ does not qualify', /does not change/.test(codeRepairProblem(sec) ?? ''));
  const report = await proposeCodeRepair(ext.issueId, { store, repoRoot: repo });
  ok('asking anyway: BLOCKED with the reason, no worktree made', report.status === 'BLOCKED' && !report.branch);
  ok('path rules', !!pathProblem('.env') && !!pathProblem('security/x.ts') && !!pathProblem('data/goals.json') && !!pathProblem('pnpm-lock.yaml') && !!pathProblem('.github/workflows/ci.yml') && !pathProblem('core/x.ts'));
  ok('the linter: a deleted test file', lintPatch([{ status: 'D', path: 'tests/aTest.ts' }], '').some((f) => /deletes the test file/.test(f)));
}

// ── 5. The tool and its approval ─────────────────────────────────────────────
console.log('\n--- 5. Approval ---');
{
  const { registerAllTools } = await import('../core/tools/index.js');
  const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
  const { approvalGate } = await import('../security/approvalGate.js');
  const { voiceMayApprove, buildApprovalRequest } = await import('../security/approvalRequest.js');
  registerAllTools();
  ok('propose_code_repair is risk 3 (typed approval)', toolRegistryV2.getMeta('propose_code_repair')?.risk === 3);
  const req = buildApprovalRequest({ tool: 'propose_code_repair', action: 'propose a code repair', target: 'iss-x', risk: 3, why: 'test', effect: 'a branch' } as never);
  ok('by default a spoken answer cannot approve it', !voiceMayApprove(req, {}));
  const tool = toolRegistryV2.get('propose_code_repair')!;
  const realRecent = approvalGate.recentDecisions.bind(approvalGate);
  process.env['JARVIS_VOICE_APPROVAL_MAX_RISK'] = '3';
  ok('with JARVIS_VOICE_APPROVAL_MAX_RISK=3 the gate itself would accept speech for risk 3', voiceMayApprove(req));
  (approvalGate as any).recentDecisions = () => [{ requestId: 'r', tool: 'propose_code_repair', action: 'a', target: 't', risk: 3, approved: true, by: 'voice' }];
  const viaVoice = JSON.parse(await tool.execute({}));
  delete process.env['JARVIS_VOICE_APPROVAL_MAX_RISK'];
  ok('a spoken approval is refused by the tool itself (even with JARVIS_VOICE_APPROVAL_MAX_RISK=3)', viaVoice.started === false && /typed at the console/.test(viaVoice.spoken), JSON.stringify(viaVoice));
  (approvalGate as any).recentDecisions = () => [];
  ok('no approval at all is refused', JSON.parse(await tool.execute({})).started === false);
  (approvalGate as any).recentDecisions = () => [{ requestId: 'r', tool: 'propose_code_repair', action: 'a', target: 't', risk: 3, approved: true, by: 'console' }];
  const typed = JSON.parse(await tool.execute({}));
  ok('a typed approval with no qualifying issue: told why, nothing started', typed.started === false && /no open issue is a code defect/.test(typed.spoken), JSON.stringify(typed));
  (approvalGate as any).recentDecisions = realRecent;
}

// ── 6. Routes ────────────────────────────────────────────────────────────────
console.log('\n--- 6. Routes ---');
{
  const { matchDeterministicCommand } = await import('../core/deterministicRoutes.js');
  for (const p of ['propose a code repair', 'propose a fix for the last error', 'prepare a patch', 'fix your code']) ok(`"${p}" → propose_code_repair`, matchDeterministicCommand(p)?.type === 'propose_code_repair', String(matchDeterministicCommand(p)?.type));
  for (const [p, t] of [['fix my app', 'diagnose_app'], ['heal yourself', 'heal'], ['fix the last problem', 'repair_last']] as const) ok(`"${p}" keeps ${t}`, matchDeterministicCommand(p)?.type === t);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
process.exit(failed > 0 ? 1 : 0);
