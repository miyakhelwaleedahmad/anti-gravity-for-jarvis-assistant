/**
 * perception/gitProbe.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The state of the git repositories in the user's project folders: branch,
 * ahead/behind, changed and untracked files, last commits, diff summary.
 *
 * `git` is run with fixed arguments through execFile — no shell — with a 3 s
 * limit per call. Repository config cannot run a program from these reads:
 * fsmonitor is switched off and diffs use no external driver.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot, isPathInside, isProtectedSystemPath } from '../core/workspaceRoot.js';
import { redactDeep } from '../security/redactor.js';

export interface RepoOverview {
  path: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  changed: number;
  untracked: number;
  files: string[];
  lastCommits: string[];
  diffSummary?: string;
  error?: string;
}

const MAX_REPOS = 20;
const GIT_TIMEOUT_MS = 3_000;
/** Control characters and `;`: never part of a folder JARVIS is told to look in. */
const SUSPICIOUS = /[\u0000-\u001f\u007f;]/;

/**
 * JARVIS_PROJECT_DIRS="C:\code;D:\work" (`;` or new lines), or the JARVIS folder.
 * Entries that are not absolute, hold control characters, are system folders
 * or do not exist are dropped.
 */
export function projectRoots(env: Record<string, string | undefined> = process.env): string[] {
  const listed = (env['JARVIS_PROJECT_DIRS'] ?? '').split(/[;\n]+/).map((p) => p.trim()).filter(Boolean);
  const roots = (listed.length ? listed : [getWorkspaceRoot()]).filter(isUsableRoot);
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

function isUsableRoot(p: string): boolean {
  if (!path.isAbsolute(p) || /[\u0000-\u001f\u007f]/.test(p) || isProtectedSystemPath(p)) return false;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * A folder the caller named, accepted only inside the configured roots.
 * Returns the resolved path, or the reason it was refused.
 */
export function checkRepoPath(requested: string, roots = projectRoots()): { path?: string; refused?: string } {
  const raw = requested.trim();
  if (!raw) return { refused: 'no path given' };
  if (SUSPICIOUS.test(raw)) return { refused: 'the path holds characters a folder name does not need' };
  const resolved = path.resolve(roots[0] ?? getWorkspaceRoot(), raw);
  if (!roots.some((root) => isPathInside(root, resolved))) {
    return { refused: 'the path is outside the project folders (JARVIS_PROJECT_DIRS)' };
  }
  return { path: resolved };
}

function isRepo(dir: string): boolean {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

/** Repositories at each root and one level below it. */
export function findRepos(roots = projectRoots()): string[] {
  const found: string[] = [];
  for (const root of roots) {
    if (isRepo(root)) found.push(root);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (found.length >= MAX_REPOS) break;
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const dir = path.join(root, entry.name);
      if (isRepo(dir)) found.push(dir);
    }
  }
  return [...new Set(found)].slice(0, MAX_REPOS);
}

function git(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-c', 'color.ui=false', '-C', repo, ...args],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, shell: false },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n')[0])) : resolve(stdout)),
    );
  });
}

export async function repoOverview(repo: string): Promise<RepoOverview> {
  const overview: RepoOverview = { path: repo, changed: 0, untracked: 0, files: [], lastCommits: [] };
  try {
    const [status, log, diff] = await Promise.all([
      git(repo, ['status', '--porcelain=v2', '--branch']),
      git(repo, ['log', '-5', '--format=%h %s']).catch(() => ''), // a repository with no commit yet
      git(repo, ['diff', '--stat', '--no-ext-diff', '--no-textconv']),
    ]);
    for (const line of status.split('\n')) {
      if (line.startsWith('# branch.head ')) overview.branch = line.slice('# branch.head '.length).trim();
      else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(line);
        if (m) { overview.ahead = Number(m[1]); overview.behind = Number(m[2]); }
      } else if (line.startsWith('? ')) {
        overview.untracked++;
        if (overview.files.length < 10) overview.files.push(`? ${line.slice(2)}`);
      } else if (/^[12u] /.test(line)) {
        overview.changed++;
        const file = line.split(' ').slice(line.startsWith('2 ') ? 9 : 8).join(' ').split('\t')[0];
        if (overview.files.length < 10 && file) overview.files.push(`M ${file}`);
      }
    }
    overview.lastCommits = log.split('\n').map((l) => l.trim()).filter(Boolean);
    const summary = diff.trim().split('\n').pop()?.trim();
    if (summary && /changed/.test(summary)) overview.diffSummary = summary;
  } catch (err) {
    overview.error = err instanceof Error ? err.message : String(err);
  }
  // Commit messages and file names are the user's text: no credentials.
  return redactDeep(overview);
}

export async function gitOverview(repos = findRepos()): Promise<RepoOverview[]> {
  return Promise.all(repos.map(repoOverview));
}
