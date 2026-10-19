/**
 * core/worktreeExecutor.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Where a proposed code repair is written and checked: a git worktree on its
 * own branch, beside the checkout, never the checkout itself (self-healing
 * architecture, code-repair phase).
 *
 *   <repo>/../jarvis-repairs/<id>   on branch jarvis/repair/<id>, from HEAD
 *
 * Only this module writes there. It refuses paths outside the worktree and
 * paths no repair may touch (security policy, .env files, dependency
 * manifests and lockfiles, data/, .git, node_modules, CI workflows). The diff
 * linter rejects a patch that weakens tests: a deleted test file, a removed
 * assertion, an added skip, a raised timeout. Checks run inside the worktree
 * with a child environment that has no keys and a temporary data folder.
 *
 * Nothing here merges, pushes, rebases or touches the checkout's branch:
 * the result is a local branch for the owner to review.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runProcess, stoppedReason } from '../system/processRunner.js';
import { childEnv } from '../system/childEnv.js';
import { redact } from '../security/redactor.js';

export interface Worktree {
  id: string;
  path: string;
  branch: string;
  baseCommit: string;
  repoRoot: string;
}

export interface FileChange {
  /** Repository-relative, forward slashes. */
  path: string;
  content: string;
}

export interface CheckCommand {
  file: string;
  args: string[];
  /** Shown in reports. */
  label: string;
}

export interface CheckResult {
  label: string;
  passed: boolean;
  exitCode: number | undefined;
  /** The last lines of the output, redacted. */
  tail: string;
}

/** Paths a repair may never change. */
export const FORBIDDEN_PATHS: readonly RegExp[] = [
  /^security\//,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)requirements[^/]*\.txt$/,
  /^data\//,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /^\.github\//,
];

const GIT_MS = 60_000;
const CHECK_MS = 15 * 60_000;

async function git(cwd: string, args: string[], timeoutMs = GIT_MS) {
  return runProcess('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false', '-C', cwd, ...args], {
    timeoutMs,
    env: childEnv({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }),
  });
}

async function gitOk(cwd: string, args: string[], timeoutMs = GIT_MS): Promise<string> {
  const r = await git(cwd, args, timeoutMs);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${redact((r.stderr || r.stdout || stoppedReason(r, 'git')).trim().split('\n').slice(-2).join(' ')).slice(0, 300)}`);
  }
  return r.stdout;
}

/** A path a repair may write: relative, inside, not forbidden. Returns the reason if not. */
export function pathProblem(rel: string): string | undefined {
  const p = String(rel).replace(/\\/g, '/');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return `${p || '(empty)'} is not a repository-relative path`;
  if (p.split('/').some((s) => s === '..' || s === '')) return `${p} leaves the repository`;
  const hit = FORBIDDEN_PATHS.find((re) => re.test(p));
  if (hit) return `${p} is a path no repair may change (security policy, secrets, dependencies, data, git or CI)`;
  return undefined;
}

/** The checkout's state: HEAD and every changed or untracked file. Compared before and after a repair. */
export async function checkoutState(repoRoot: string): Promise<string> {
  const head = (await gitOk(repoRoot, ['rev-parse', 'HEAD'])).trim();
  const branch = (await gitOk(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const status = await gitOk(repoRoot, ['status', '--porcelain=v1', '-uall']);
  return `${branch} ${head}\n${status}`;
}

export class WorktreeExecutor {
  /** `parentDir`: where worktrees go (default: beside the repository, in jarvis-repairs/). */
  constructor(private readonly repoRoot: string, private readonly parentDir = path.join(path.dirname(repoRoot), 'jarvis-repairs')) {}

  async create(id: string): Promise<Worktree> {
    if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(id)) throw new Error(`unexpected repair id ${id}`);
    const baseCommit = (await gitOk(this.repoRoot, ['rev-parse', 'HEAD'])).trim();
    const branch = `jarvis/repair/${id}`;
    const dir = path.join(this.parentDir, id);
    if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
    fs.mkdirSync(this.parentDir, { recursive: true });
    await gitOk(this.repoRoot, ['worktree', 'add', '-b', branch, dir, baseCommit]);
    // The checkout's installed packages, read-only to the repair. A link is not matched by the
    // "node_modules/" ignore rule, so add and clean exclude it by name.
    const nm = path.join(this.repoRoot, 'node_modules');
    if (fs.existsSync(nm) && !fs.existsSync(path.join(dir, 'node_modules'))) {
      try { fs.symlinkSync(nm, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (err) { console.warn(`[Worktree] node_modules not linked: ${(err as Error).message}`); }
    }
    return { id, path: dir, branch, baseCommit, repoRoot: this.repoRoot };
  }

  /** Back to the base commit (between attempts). */
  async reset(wt: Worktree): Promise<void> {
    await gitOk(wt.path, ['reset', '-q', '--hard', wt.baseCommit]);
    await gitOk(wt.path, ['clean', '-q', '-fd', '-e', 'node_modules']);
  }

  /** Write the files of a patch. Throws, writing nothing, if any path is not allowed. */
  write(wt: Worktree, files: FileChange[]): void {
    const problems = files.map((f) => pathProblem(f.path)).filter((p): p is string => !!p);
    if (problems.length) throw new Error(problems.join('; '));
    const root = fs.realpathSync(wt.path);
    for (const f of files) {
      const target = path.resolve(root, f.path);
      const rel = path.relative(root, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${f.path} leaves the worktree`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // A link inside the worktree must not lead out of it.
      const parentReal = fs.realpathSync(path.dirname(target));
      const parentRel = path.relative(root, parentReal);
      if (parentRel.startsWith('..') || path.isAbsolute(parentRel)) throw new Error(`${f.path} is reached through a link out of the worktree`);
      fs.writeFileSync(target, f.content);
    }
  }

  /** Stage the patch; the node_modules link (ignored by name or not) is never part of it. */
  private async stage(wt: Worktree): Promise<void> {
    await gitOk(wt.path, ['add', '-A']);
    await git(wt.path, ['reset', '-q', '--', 'node_modules']);
  }

  /** The patch against the base: changed files and the unified diff. */
  async diff(wt: Worktree): Promise<{ files: { status: string; path: string }[]; text: string }> {
    await this.stage(wt);
    const names = await gitOk(wt.path, ['diff', '--cached', '--name-status', '--no-renames', wt.baseCommit]);
    const text = await gitOk(wt.path, ['diff', '--cached', '--no-renames', '-U0', wt.baseCommit]);
    const files = names.split('\n').filter(Boolean).map((l) => { const [status, ...rest] = l.split('\t'); return { status: status!, path: rest.join('\t') }; });
    return { files, text };
  }

  /** Run checks inside the worktree: no keys, a temporary data folder. */
  async check(wt: Worktree, commands: CheckCommand[], signal?: AbortSignal): Promise<CheckResult[]> {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-repair-data-'));
    const results: CheckResult[] = [];
    try {
      for (const c of commands) {
        const r = await runProcess(c.file, c.args, {
          cwd: wt.path, timeoutMs: CHECK_MS, ...(signal ? { signal } : {}),
          env: childEnv({ JARVIS_DATA_ROOT: dataRoot, JARVIS_WORKSPACE_ROOT: wt.path, CI: '1' }),
        });
        const out = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-15).join('\n');
        results.push({ label: c.label, passed: r.exitCode === 0 && !r.timedOut && !r.cancelled, exitCode: r.exitCode, tail: redact(stoppedReason(r, c.label) || out).slice(0, 2000) });
        if (r.cancelled) break;
      }
    } finally {
      try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    return results;
  }

  /** Commit the patch on the repair branch (local only: never pushed, never merged). */
  async commit(wt: Worktree, message: string): Promise<string> {
    await this.stage(wt);
    await gitOk(wt.path, ['-c', 'user.name=JARVIS repair', '-c', 'user.email=jarvis-repair@localhost', 'commit', '-q', '--no-verify', '-m', message]);
    return (await gitOk(wt.path, ['rev-parse', 'HEAD'])).trim();
  }

  /** Remove the worktree; with `dropBranch`, its branch too (the rollback of a failed repair). */
  async remove(wt: Worktree, dropBranch: boolean): Promise<void> {
    try { fs.unlinkSync(path.join(wt.path, 'node_modules')); } catch { /* not linked */ }
    await git(this.repoRoot, ['worktree', 'remove', '--force', wt.path]);
    if (dropBranch) await git(this.repoRoot, ['branch', '-D', wt.branch]);
  }
}

/**
 * Ways a patch can make a test pass without fixing anything. Returns one
 * finding per problem; an empty list is a clean patch.
 */
export function lintPatch(files: { status: string; path: string }[], diffText: string): string[] {
  const findings: string[] = [];
  const isTest = (p: string) => /^tests\//.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /\.(test|spec)\.[jt]s$/.test(p);
  for (const f of files) {
    const problem = pathProblem(f.path);
    if (problem) findings.push(problem);
    if (f.status.startsWith('D') && isTest(f.path)) findings.push(`deletes the test file ${f.path}`);
  }
  // Per file: removed and added lines of the diff.
  let current = '';
  const removed = new Map<string, string[]>();
  const added = new Map<string, string[]>();
  for (const line of diffText.split('\n')) {
    const m = /^diff --git a\/(.+?) b\//.exec(line);
    if (m) { current = m[1]!; continue; }
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) (removed.get(current) ?? removed.set(current, []).get(current)!).push(line.slice(1));
    else if (line.startsWith('+')) (added.get(current) ?? added.set(current, []).get(current)!).push(line.slice(1));
  }
  const ASSERT = /\b(ok|assert\w*|expect|check)\s*\(|\bassert\b/;
  const SKIP = /\.skip\s*\(|\bxit\s*\(|\bit\.only\b|\b(?:test|describe)\.skip\b|@pytest\.mark\.skip|\bSKIP\b|process\.exit\(\s*0\s*\)/;
  for (const file of new Set([...removed.keys(), ...added.keys()])) {
    if (!isTest(file)) continue;
    const rem = removed.get(file) ?? [];
    const add = added.get(file) ?? [];
    const addSet = new Set(add.map((l) => l.trim()));
    const lostAsserts = rem.filter((l) => ASSERT.test(l) && !addSet.has(l.trim()));
    const newAsserts = add.filter((l) => ASSERT.test(l));
    if (lostAsserts.length > newAsserts.length) findings.push(`${file}: removes ${lostAsserts.length - newAsserts.length} assertion(s)`);
    if (add.some((l) => SKIP.test(l) && !rem.some((r) => r.trim() === l.trim()))) findings.push(`${file}: adds a skip or an early successful exit`);
  }
  // A raised time limit, in any file: the same line with a bigger number.
  for (const [file, rem] of removed) {
    for (const r of rem) {
      if (!/time.?out|_ms\b|Ms\b|deadline|wait/i.test(r)) continue;
      const shape = r.replace(/\d[\d_]*/g, '#').trim();
      for (const a of added.get(file) ?? []) {
        if (a.replace(/\d[\d_]*/g, '#').trim() !== shape) continue;
        const before = Math.max(...(r.match(/\d[\d_]*/g) ?? ['0']).map((n) => Number(n.replace(/_/g, ''))));
        const after = Math.max(...(a.match(/\d[\d_]*/g) ?? ['0']).map((n) => Number(n.replace(/_/g, ''))));
        if (after > before) findings.push(`${file}: raises a time limit (${before} → ${after}) without a finding that says why`);
      }
    }
  }
  return [...new Set(findings)];
}
