/**
 * core/sourceLocation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Where in JARVIS's source an error came from, from its stack trace, without
 * guessing (self-healing architecture, Phase 2).
 *
 *   KNOWN     a frame in this repository: file (repository-relative), line,
 *             column and function, plus the commit the line refers to
 *   EXTERNAL  the frames are all outside it (node_modules, Node itself,
 *             Python's own libraries): where it failed is not JARVIS's code
 *   UNKNOWN   no stack trace (an error reported as text, a stripped stack)
 *
 * Node stacks ("at fn (file:///…/core/x.ts:12:5)") and Python tracebacks
 * ('File "…/voice/tts.py", line 12, in speak') are read. tsx maps TypeScript
 * lines through source maps, so a .ts line is the source line. A line number
 * only holds for the commit it was produced at; that commit is recorded.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface StackFrame {
  file: string;
  line: number;
  column?: number;
  symbol?: string;
  /** Inside this repository (and not in node_modules). */
  inRepo: boolean;
}

export interface SourceLocation {
  status: 'KNOWN' | 'EXTERNAL' | 'UNKNOWN';
  file?: string;
  line?: number;
  column?: number;
  symbol?: string;
  /** Why the status is EXTERNAL or UNKNOWN. */
  reason?: string;
  /** Up to 8 frames, repository-relative where possible. */
  frames: StackFrame[];
  /** The commit the line numbers refer to ("unknown" outside a git checkout). */
  commit: string;
}

let cachedCommit: string | undefined;

/** The checked-out commit, read from .git without running git. */
export function currentCommit(root = REPO_ROOT): string {
  if (cachedCommit !== undefined && root === REPO_ROOT) return cachedCommit;
  let commit = 'unknown';
  try {
    let gitDir = path.join(root, '.git');
    if (fs.statSync(gitDir).isFile()) {   // a worktree: ".git" names the real directory
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(gitDir, 'utf8'));
      if (m) gitDir = path.resolve(root, m[1]!.trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) commit = head;
    else {
      const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
      if (ref) {
        const commonDir = fs.existsSync(path.join(gitDir, 'commondir'))
          ? path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()) : gitDir;
        const loose = [path.join(gitDir, ref), path.join(commonDir, ref)].find((p) => fs.existsSync(p));
        if (loose) commit = fs.readFileSync(loose, 'utf8').trim();
        else {
          const packed = fs.readFileSync(path.join(commonDir, 'packed-refs'), 'utf8');
          commit = new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[/.]/g, (c) => `\\${c}`)}$`, 'm').exec(packed)?.[1] ?? 'unknown';
        }
      }
    }
  } catch { /* not a git checkout */ }
  if (root === REPO_ROOT) cachedCommit = commit.slice(0, 12);
  return commit.slice(0, 12);
}

function toRepoRelative(file: string, root: string): { file: string; inRepo: boolean } {
  let f = file;
  if (f.startsWith('file://')) { try { f = fileURLToPath(f); } catch { /* keep */ } }
  // Only an absolute path can be a file of this checkout: "node:internal/…",
  // "<anonymous>" and "native" are Node's own.
  if (!path.isAbsolute(f)) return { file: f, inRepo: false };
  const rel = path.relative(root, f);
  const inside = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const inRepo = inside && !rel.split(path.sep).includes('node_modules');
  return { file: inside ? rel.split(path.sep).join('/') : f, inRepo };
}

/** Frames of a Node stack or a Python traceback. */
export function parseStack(stack: string, root = REPO_ROOT): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of String(stack).split('\n')) {
    const line = raw.trim();
    let m = /^at (?:async )?(.*?) \((.+):(\d+):(\d+)\)$/.exec(line);
    if (m) {
      const loc = toRepoRelative(m[2]!, root);
      frames.push({ file: loc.file, line: Number(m[3]), column: Number(m[4]), symbol: m[1] || undefined, inRepo: loc.inRepo });
      continue;
    }
    m = /^at (?:async )?(.+):(\d+):(\d+)$/.exec(line);
    if (m && !m[1]!.includes(' ')) {
      const loc = toRepoRelative(m[1]!, root);
      frames.push({ file: loc.file, line: Number(m[2]), column: Number(m[3]), inRepo: loc.inRepo });
      continue;
    }
    m = /^File "(.+)", line (\d+)(?:, in (.+))?$/.exec(line);
    if (m) {
      const loc = toRepoRelative(m[1]!, root);
      frames.push({ file: loc.file, line: Number(m[2]), symbol: m[3], inRepo: loc.inRepo });
    }
  }
  // Python lists the innermost frame last; Node first.
  if (/Traceback \(most recent call last\)/.test(stack)) frames.reverse();
  return frames;
}

/** Where an error came from. `err` may be an Error, a traceback text, or a plain message. */
export function sourceLocationOf(err: unknown, root = REPO_ROOT): SourceLocation {
  const commit = currentCommit(root);
  const stack = err instanceof Error ? err.stack ?? '' : typeof err === 'string' ? err : '';
  const frames = stack ? parseStack(stack, root) : [];
  const kept = frames.slice(0, 8).map((f) => ({ ...f }));
  if (frames.length === 0) {
    return { status: 'UNKNOWN', reason: err instanceof Error ? 'the error has no readable stack trace' : 'the error was reported as text, without a stack trace', frames: [], commit };
  }
  const first = frames.find((f) => f.inRepo);
  if (!first) {
    return { status: 'EXTERNAL', reason: `every frame is outside JARVIS's source (first: ${frames[0]!.file})`, frames: kept, commit };
  }
  return {
    status: 'KNOWN',
    file: first.file,
    line: first.line,
    ...(first.column !== undefined ? { column: first.column } : {}),
    ...(first.symbol ? { symbol: first.symbol } : {}),
    frames: kept,
    commit,
  };
}
