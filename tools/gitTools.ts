/**
 * tools/gitTools.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Git for the repositories in the project folders (P10), with fixed arguments
 * and no shell:
 *
 *   git       status, diff, branches, log (level 0); commit (2); switch (2)
 *   git_push  push the current branch (3; to main or master 4). There is no
 *             way to force a push.
 *
 * A commit refuses files that hold keys (`.env`, `*.pem`, `id_rsa`…) and
 * changes in which the redactor finds a credential, before anything is
 * staged. Every change is checked afterwards; `verify` hands the check to the
 * registry (P5).
 */

import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentTool } from '../core/toolRegistryV2.js';
import type { Verifier } from '../core/verifiers.js';
import { checkRepoPath, projectRoots } from '../perception/gitProbe.js';
import { realPathOf } from '../security/fsPolicy.js';
import { isPathInside } from '../core/workspaceRoot.js';
import { hasSecret, redact } from '../security/redactor.js';
import { isSecretFile } from '../security/fsPolicy.js';

type CheckStatus = 'verified' | 'failed' | 'unverifiable';
interface Check { status: CheckStatus; evidence: string }
interface GitReport { success: boolean; action: string; repo?: string; error?: string; check?: Check; [key: string]: unknown }

class NotDone extends Error {}

const READ_MS = 15_000;
const WRITE_MS = 60_000;
const PUSH_MS = 120_000;
const DIFF_LINES = 200;

const verified = (evidence: string): Check => ({ status: 'verified', evidence });
const failed = (evidence: string): Check => ({ status: 'failed', evidence });

interface GitRun { code: number; stdout: string; stderr: string }

/** git with fixed arguments: no shell, no pager, no password prompt, no fsmonitor. */
function git(repo: string, args: string[], timeoutMs = READ_MS): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false', '-C', repo, ...args],
      {
        timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell: false,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function gitOk(repo: string, args: string[], timeoutMs = READ_MS): Promise<string> {
  const run = await git(repo, args, timeoutMs);
  if (run.code !== 0) throw new NotDone(`git ${args[0]} failed: ${redact((run.stderr || run.stdout).trim().split('\n').slice(-2).join(' ')).slice(0, 300)}`);
  return run.stdout;
}

/** A repository inside the project folders (real path compared), or the reason it is not one. */
export function repoProblem(raw: unknown): { repo?: string; refused?: string } {
  const roots = projectRoots();
  const requested = typeof raw === 'string' && raw.trim() ? raw.trim() : roots[0] ?? '';
  const check = checkRepoPath(requested, roots);
  if (!check.path) return { refused: `JARVIS works only with repositories in the project folders: ${check.refused}.` };
  const real = realPathOf(check.path);
  if (!roots.map((r) => realPathOf(r)).some((root) => isPathInside(root, real))) {
    return { refused: 'JARVIS works only with repositories in the project folders (JARVIS_PROJECT_DIRS).' };
  }
  if (!fs.existsSync(path.join(check.path, '.git'))) return { refused: `${check.path} is not a git repository.` };
  return { repo: check.path };
}

function needRepo(raw: unknown): string {
  const { repo, refused } = repoProblem(raw);
  if (!repo) throw new NotDone(refused ?? 'No repository.');
  return repo;
}

/** A path inside the repository, as git expects it (relative, forward slashes). */
function repoRelative(repo: string, raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.startsWith('-')) throw new NotDone(`"${text}" is not a path in the repository.`);
  const full = path.resolve(repo, text);
  if (!isPathInside(repo, full) || full === path.resolve(repo, '.git') || full.startsWith(path.resolve(repo, '.git') + path.sep)) {
    throw new NotDone(`${text} is not inside the repository.`);
  }
  return path.relative(repo, full).split(path.sep).join('/') || '.';
}

async function currentBranch(repo: string): Promise<string> {
  return (await gitOk(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

/** The branch a push goes to (upstream, else origin/<current>) — synchronous, for the risk engine. */
export function pushTargetSync(repo: string): string {
  const run = (args: string[]) => execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-C', repo, ...args],
    { timeout: 3_000, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).toString().trim();
  try {
    return run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    try { return `origin/${run(['rev-parse', '--abbrev-ref', 'HEAD'])}`; } catch { return 'origin/main'; }
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

async function status(repo: string): Promise<Record<string, unknown>> {
  // -z: paths unquoted, records separated by NUL; a rename is followed by its old path.
  const records = (await gitOk(repo, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal'])).split('\0');
  const report: { branch?: string; upstream?: string; ahead?: number; behind?: number; files: Array<{ path: string; state: string }> } = { files: [] };
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const fields = record.split(' ');
    if (record.startsWith('# branch.head ')) report.branch = record.slice(14).trim();
    else if (record.startsWith('# branch.upstream ')) report.upstream = record.slice(18).trim();
    else if (record.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(record);
      if (m) { report.ahead = Number(m[1]); report.behind = Number(m[2]); }
    } else if (record.startsWith('1 ')) report.files.push({ path: fields.slice(8).join(' '), state: describeXY(fields[1] ?? '..') });
    else if (record.startsWith('2 ')) { report.files.push({ path: fields.slice(9).join(' '), state: describeXY(fields[1] ?? '..') }); i++; }
    else if (record.startsWith('u ')) report.files.push({ path: fields.slice(10).join(' '), state: 'conflict' });
    else if (record.startsWith('? ')) report.files.push({ path: record.slice(2), state: 'untracked' });
  }
  report.files = report.files.slice(0, 100);
  return report;
}

function describeXY(xy: string): string {
  const [staged, worktree] = [xy[0], xy[1]];
  const word = (c?: string) => ({ M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' } as Record<string, string>)[c ?? ''] ?? '';
  return [staged && staged !== '.' ? `${word(staged)} (staged)` : '', worktree && worktree !== '.' ? word(worktree) : ''].filter(Boolean).join(', ') || 'changed';
}

async function diff(repo: string, pathArg: unknown, staged: unknown): Promise<Record<string, unknown>> {
  const args = ['diff', '--no-ext-diff', '--no-textconv', ...(staged === true ? ['--cached'] : [])];
  if (pathArg !== undefined && pathArg !== '') args.push('--', repoRelative(repo, pathArg));
  const lines = (await gitOk(repo, args)).split('\n');
  return { diff: lines.slice(0, DIFF_LINES).join('\n'), lines: lines.length, truncated: lines.length > DIFF_LINES };
}

async function branches(repo: string): Promise<Record<string, unknown>> {
  const out = await gitOk(repo, ['branch', '--list', '--format=%(HEAD)\t%(refname:short)\t%(upstream:short)']);
  return {
    branches: out.split('\n').filter(Boolean).slice(0, 100).map((l) => {
      const [head, name, upstream] = l.split('\t');
      return { name, current: head === '*', ...(upstream ? { upstream } : {}) };
    }),
  };
}

async function log(repo: string, countArg: unknown): Promise<Record<string, unknown>> {
  const count = Math.min(30, Math.max(1, Number(countArg) || 10));
  const out = await gitOk(repo, ['log', `-n${count}`, '--format=%h%x09%an%x09%ar%x09%s']).catch((err) => {
    if (/does not have any commits|bad default revision/i.test(String(err.message))) return '';
    throw err;
  });
  return { commits: out.split('\n').filter(Boolean).map((l) => { const [hash, author, when, subject] = l.split('\t'); return { hash, author, when, subject }; }) };
}

// ── Changes ──────────────────────────────────────────────────────────────────

/** Files a commit would take, and whether any of them, or their changes, hold a key. */
async function commitProblems(repo: string, paths: string[] | undefined): Promise<string | undefined> {
  const files = (await status(repo)).files as Array<{ path: string; state: string }>;
  const chosen = paths ? files.filter((f) => paths.some((p) => p === '.' || f.path === p || f.path.startsWith(`${p.replace(/\/$/, '')}/`))) : files;
  if (!chosen.length) return 'There is nothing to commit.';
  const secretNamed = chosen.filter((f) => isSecretFile(f.path));
  if (secretNamed.length) return `JARVIS does not commit key or credential files (${secretNamed.map((f) => f.path).slice(0, 3).join(', ')}); add them to .gitignore.`;
  for (const f of chosen.slice(0, 200)) {
    let text = '';
    if (f.state === 'untracked') {
      try {
        const full = path.join(repo, f.path);
        if (fs.statSync(full).isFile() && fs.statSync(full).size <= 1024 * 1024) text = fs.readFileSync(full, 'utf8');
      } catch { /* unreadable: skipped */ }
    } else {
      text = (await git(repo, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', f.path])).stdout;
    }
    if (text && hasSecret(text)) return `JARVIS does not commit ${f.path}: it holds what looks like a key or password.`;
  }
  return undefined;
}

async function commit(repo: string, messageArg: unknown, pathsArg: unknown): Promise<Omit<GitReport, 'success' | 'action'>> {
  const message = typeof messageArg === 'string' ? messageArg.trim() : '';
  if (!message) throw new NotDone('Say the commit message.');
  if (message.length > 500) throw new NotDone('The commit message is longer than 500 characters.');
  if (hasSecret(message)) throw new NotDone('The commit message holds what looks like a key or password.');
  const paths = Array.isArray(pathsArg) && pathsArg.length ? pathsArg.map((p) => repoRelative(repo, p)) : undefined;
  const problem = await commitProblems(repo, paths);
  if (problem) throw new NotDone(problem);
  await gitOk(repo, paths ? ['add', '--', ...paths] : ['add', '-A'], WRITE_MS);
  const run = await git(repo, ['commit', '-m', message], WRITE_MS);
  if (run.code !== 0) throw new NotDone(`git commit failed: ${redact((run.stderr || run.stdout).trim().split('\n').slice(-2).join(' ')).slice(0, 300)}`);
  const [head, left] = await Promise.all([
    gitOk(repo, ['log', '-1', '--format=%h%x09%s']),
    git(repo, ['diff', '--cached', '--quiet']),
  ]);
  const [hash, subject] = head.trim().split('\t');
  const ok = subject === message.split('\n')[0] && left.code === 0;
  return {
    repo, commit: hash, did: `committed "${message.split('\n')[0]!.slice(0, 80)}" (${hash})`,
    check: ok ? verified(`the last commit is ${hash} with that message, and nothing is left staged`) : failed('the last commit is not the one made'),
  };
}

async function switchBranch(repo: string, branchArg: unknown, createArg: unknown): Promise<Omit<GitReport, 'success' | 'action'>> {
  const branch = typeof branchArg === 'string' ? branchArg.trim() : '';
  if (!branch || branch.startsWith('-')) throw new NotDone('Say which branch.');
  const valid = await git(repo, ['check-ref-format', '--branch', branch]);
  if (valid.code !== 0) throw new NotDone(`"${branch}" is not a valid branch name.`);
  await gitOk(repo, createArg === true ? ['switch', '-c', branch] : ['switch', branch], WRITE_MS);
  const now = await currentBranch(repo);
  return {
    repo, branch, did: `${createArg === true ? 'created and switched to' : 'switched to'} ${branch}`,
    check: now === branch ? verified(`the repository is on ${branch}`) : failed(`the repository is on ${now}`),
  };
}

export async function push(repo: string): Promise<Omit<GitReport, 'success' | 'action'>> {
  const branch = await currentBranch(repo);
  if (branch === 'HEAD') throw new NotDone('The repository is not on a branch (detached HEAD).');
  const upstream = await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let args: string[];
  let target: string;
  if (upstream.code === 0) {
    target = upstream.stdout.trim();
    args = ['push'];
  } else {
    const remotes = (await gitOk(repo, ['remote'])).split('\n').map((r) => r.trim());
    if (!remotes.includes('origin')) throw new NotDone('The branch has no upstream and there is no "origin" remote.');
    target = `origin/${branch}`;
    args = ['push', '--set-upstream', 'origin', branch];
  }
  const run = await git(repo, args, PUSH_MS);
  if (run.code !== 0) throw new NotDone(`git push failed: ${redact((run.stderr || run.stdout).trim().split('\n').slice(-2).join(' ')).slice(0, 300)}`);
  const [local, remote] = await Promise.all([gitOk(repo, ['rev-parse', 'HEAD']), git(repo, ['rev-parse', '@{u}'])]);
  const same = remote.code === 0 && remote.stdout.trim() === local.trim();
  return {
    repo, branch, target, did: `pushed ${branch} to ${target}`,
    check: same ? verified(`${target} has the same commit as ${branch} (${local.trim().slice(0, 7)})`) : failed(`${target} does not have the pushed commit`),
  };
}

// ── The tools ────────────────────────────────────────────────────────────────

export const GIT_ACTIONS = ['status', 'diff', 'branches', 'log', 'commit', 'switch'] as const;

async function report(action: string, fn: () => Promise<Record<string, unknown>>): Promise<string> {
  try {
    return JSON.stringify({ success: true, action, ...(await fn()) }, null, 2);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ success: false, action, error: err instanceof NotDone ? message : `git ${action} failed: ${message}` }, null, 2);
  }
}

const ownCheck: Verifier = async (_args, output) => {
  try {
    const parsed = JSON.parse(output) as GitReport;
    if (parsed.check) return parsed.check;
  } catch {
    // not a report
  }
  return { status: 'unverifiable', evidence: 'reading changes nothing' };
};

export const gitTool: AgentTool = {
  name: 'git',
  description:
    'Use for git in a repository of the project folders. action: status, diff (path, staged), branches, log (count), ' +
    'commit (message; paths, default every change — files with keys are refused), switch (branch; create: true for a new ' +
    'one). repo: the repository folder (default: the first project folder). JARVIS checks each change. To push, use git_push.',
  riskLevel: 'medium',
  inputSchema: {
    action: { type: 'string', description: GIT_ACTIONS.join(', '), required: true, enum: [...GIT_ACTIONS] },
    repo: { type: 'string', description: 'The repository folder.', required: false },
    path: { type: 'string', description: 'diff: one file or folder.', required: false },
    staged: { type: 'boolean', description: 'diff: staged changes.', required: false },
    count: { type: 'number', description: 'log: how many commits (1-30).', required: false },
    message: { type: 'string', description: 'commit: the message.', required: false },
    paths: { type: 'array', description: 'commit: which files (default all changes).', required: false },
    branch: { type: 'string', description: 'switch: the branch.', required: false },
    create: { type: 'boolean', description: 'switch: create the branch.', required: false },
  },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    const action = typeof args['action'] === 'string' ? args['action'].toLowerCase() : '';
    return report(action, async () => {
      const repo = needRepo(args['repo']);
      switch (action) {
        case 'status': return { repo, ...(await status(repo)) };
        case 'diff': return { repo, ...(await diff(repo, args['path'], args['staged'])) };
        case 'branches': return { repo, ...(await branches(repo)) };
        case 'log': return { repo, ...(await log(repo, args['count'])) };
        case 'commit': return commit(repo, args['message'], args['paths']);
        case 'switch': return switchBranch(repo, args['branch'], args['create']);
        default: throw new NotDone(`Unknown git action "${action}".`);
      }
    });
  },
};

export const gitPushTool: AgentTool = {
  name: 'git_push',
  description:
    'Use to push the current branch of a repository in the project folders to its remote (its upstream, or origin). ' +
    'Always asks for approval; pushing to main or master needs a typed code. JARVIS never force-pushes. Parameter: repo.',
  riskLevel: 'high',
  requiredLevel: 0,
  inputSchema: { repo: { type: 'string', description: 'The repository folder.', required: false } },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    return report('push', async () => push(needRepo(args['repo'])));
  },
};
