/**
 * tools/fsTools.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The `files` tool (P10): list, search, compare, create, modify, rename, move,
 * delete (into the JARVIS trash), restore, trash, empty_trash — only inside
 * the approved folders (security/fsPolicy.ts), no shell. Every change is
 * checked on disk afterwards; `verify` hands the check to the registry (P5).
 *
 * Deleting moves the item into <data>/trash/<id>/ with a note of where it was;
 * modifying keeps the previous version there too. Both can be restored until
 * the trash is emptied (level 3).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { AgentTool } from '../core/toolRegistryV2.js';
import type { Verifier } from '../core/verifiers.js';
import { dataRoot, getWorkspaceRoot } from '../core/workspaceRoot.js';
import { checkFilePath, isApprovedRoot, isExecutable, isSecretFile } from '../security/fsPolicy.js';

type CheckStatus = 'verified' | 'failed' | 'unverifiable';
interface Check { status: CheckStatus; evidence: string }
interface FileReport { success: boolean; action: string; error?: string; check?: Check; [key: string]: unknown }

/** A request the tool does not carry out, with the reason. */
class NotDone extends Error {}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.cache', '.turbo']);
const MAX_LIST = 300;
const MAX_RESULTS = 100;
const MAX_SCAN = 20_000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DEPTH = 8;
const DIFF_LINES = 200;
const MAX_DIFF_INPUT = 2_000;

const verified = (evidence: string): Check => ({ status: 'verified', evidence });
const failed = (evidence: string): Check => ({ status: 'failed', evidence });

function need(raw: unknown): string {
  const check = checkFilePath(raw);
  if (!check.ok) throw new NotDone(check.reason);
  return check.path;
}

function statOf(p: string): fs.Stats | undefined {
  try { return fs.lstatSync(p); } catch { return undefined; }
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8_192).includes(0);
}

function readText(p: string, limit = MAX_TEXT_BYTES): string {
  const stat = statOf(p);
  if (!stat) throw new NotDone(`${p} does not exist.`);
  if (!stat.isFile()) throw new NotDone(`${path.basename(p)} is not a file.`);
  if (stat.size > limit) throw new NotDone(`${path.basename(p)} is larger than ${Math.round(limit / 1024)} KB.`);
  const buffer = fs.readFileSync(p);
  if (isBinary(buffer)) throw new NotDone(`${path.basename(p)} is not a text file.`);
  return buffer.toString('utf8');
}

/** Moves across drives too (rename, or copy then remove). */
function moveItem(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// ── Trash ────────────────────────────────────────────────────────────────────

export function trashDir(): string {
  return path.join(dataRoot(getWorkspaceRoot()), 'data', 'trash');
}

interface TrashNote { id: string; kind: 'deleted' | 'previous-version'; originalPath: string; name: string; at: string }

function intoTrash(item: string, kind: TrashNote['kind']): TrashNote {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const folder = path.join(trashDir(), id);
  fs.mkdirSync(folder, { recursive: true });
  const note: TrashNote = { id, kind, originalPath: item, name: path.basename(item), at: new Date().toISOString() };
  if (kind === 'deleted') moveItem(item, path.join(folder, note.name));
  else fs.copyFileSync(item, path.join(folder, note.name));
  fs.writeFileSync(path.join(folder, 'trash-note.json'), JSON.stringify(note, null, 2));
  return note;
}

function trashNotes(): TrashNote[] {
  const dir = trashDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((id) => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir, id, 'trash-note.json'), 'utf8')) as TrashNote]; } catch { return []; }
  }).sort((a, b) => b.at.localeCompare(a.at));
}

// ── Reading ──────────────────────────────────────────────────────────────────

function list(dirArg: unknown, depthArg: unknown): Record<string, unknown> {
  const dir = need(dirArg);
  if (!statOf(dir)?.isDirectory()) throw new NotDone(`${dirArg} is not a folder.`);
  const depth = Math.min(3, Math.max(1, Number(depthArg) || 1));
  const entries: Array<{ path: string; type: string; size?: number; modified: string }> = [];
  let truncated = false;
  const walk = (folder: string, level: number) => {
    for (const name of fs.readdirSync(folder).sort()) {
      if (entries.length >= MAX_LIST) { truncated = true; return; }
      const full = path.join(folder, name);
      const stat = statOf(full);
      if (!stat) continue;
      const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'folder' : 'file';
      entries.push({ path: path.relative(dir, full), type, ...(type === 'file' ? { size: stat.size } : {}), modified: stat.mtime.toISOString() });
      if (type === 'folder' && level < depth && !SKIP_DIRS.has(name)) walk(full, level + 1);
    }
  };
  walk(dir, 1);
  return { folder: dir, entries, truncated };
}

function search(dirArg: unknown, nameArg: unknown, textArg: unknown, maxArg: unknown): Record<string, unknown> {
  const dir = need(dirArg);
  if (!statOf(dir)?.isDirectory()) throw new NotDone(`${dirArg} is not a folder.`);
  const name = typeof nameArg === 'string' ? nameArg.trim().toLowerCase() : '';
  const text = typeof textArg === 'string' ? textArg.trim() : '';
  if (!name && !text) throw new NotDone('Say what to look for: part of a file name, a text, or both.');
  const max = Math.min(MAX_RESULTS, Math.max(1, Number(maxArg) || 50));
  const needle = text.toLowerCase();
  const results: Array<{ path: string; lines?: Array<{ line: number; text: string }> }> = [];
  let scanned = 0;
  let truncated = false;
  const walk = (folder: string, level: number) => {
    let names: string[];
    try { names = fs.readdirSync(folder); } catch { return; }
    for (const entry of names) {
      if (results.length >= max || scanned >= MAX_SCAN) { truncated = true; return; }
      const full = path.join(folder, entry);
      const stat = statOf(full);
      if (!stat || stat.isSymbolicLink()) continue; // links are not followed out of the folder
      scanned++;
      if (stat.isDirectory()) {
        if (level < MAX_DEPTH && !SKIP_DIRS.has(entry)) walk(full, level + 1);
        continue;
      }
      if (name && !entry.toLowerCase().includes(name)) continue;
      if (!text) { results.push({ path: path.relative(dir, full) }); continue; }
      if (isSecretFile(full) || stat.size > MAX_TEXT_BYTES) continue; // keys are found by name only
      let content: Buffer;
      try { content = fs.readFileSync(full); } catch { continue; }
      if (isBinary(content)) continue;
      const lines = content.toString('utf8').split(/\r?\n/);
      const hits = lines.flatMap((line, i) => (line.toLowerCase().includes(needle) ? [{ line: i + 1, text: line.trim().slice(0, 160) }] : [])).slice(0, 3);
      if (hits.length) results.push({ path: path.relative(dir, full), lines: hits });
    }
  };
  walk(dir, 1);
  return { folder: dir, results, scanned, truncated };
}

/** A unified diff of two texts (3 lines of context), at most `limit` lines. */
export function unifiedDiff(a: string, b: string, labelA: string, labelB: string, limit = DIFF_LINES): { diff: string; changed: number; truncated: boolean } {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  if (x.length > MAX_DIFF_INPUT || y.length > MAX_DIFF_INPUT) throw new NotDone(`The files are longer than ${MAX_DIFF_INPUT} lines.`);
  const n = x.length;
  const m = y.length;
  const lcs = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = x[i] === y[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
    }
  }
  const ops: Array<{ op: ' ' | '-' | '+'; text: string; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { ops.push({ op: ' ', text: x[i]!, ai: i, bi: j }); i++; j++; }
    else if (j < m && (i >= n || lcs[i * (m + 1) + j + 1]! >= lcs[(i + 1) * (m + 1) + j]!)) { ops.push({ op: '+', text: y[j]!, ai: i, bi: j }); j++; }
    else { ops.push({ op: '-', text: x[i]!, ai: i, bi: j }); i++; }
  }
  const changed = ops.filter((o) => o.op !== ' ').length;
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.op === ' ') { k++; continue; }
    const start = Math.max(0, k - 3);
    let end = k;
    while (end < ops.length) {
      if (ops[end]!.op !== ' ') { end++; continue; }
      let run = 0;
      while (end + run < ops.length && ops[end + run]!.op === ' ') run++;
      if (end + run >= ops.length || run > 6) { end = Math.min(ops.length, end + 3); break; }
      end += run;
    }
    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((o) => o.op !== '+').length;
    const bCount = hunk.filter((o) => o.op !== '-').length;
    out.push(`@@ -${hunk[0]!.ai + 1},${aCount} +${hunk[0]!.bi + 1},${bCount} @@`);
    for (const o of hunk) out.push(`${o.op}${o.text}`);
    k = end;
  }
  const truncated = out.length > limit;
  return { diff: out.slice(0, limit).join('\n'), changed, truncated };
}

function compare(aArg: unknown, bArg: unknown): Record<string, unknown> {
  const a = need(aArg);
  const b = need(bArg);
  const left = readText(a);
  const right = readText(b);
  if (left === right) return { same: true, diff: '' };
  return { same: false, ...unifiedDiff(left, right, path.basename(a), path.basename(b)) };
}

// ── Changes ──────────────────────────────────────────────────────────────────

function refuseExecutable(p: string): void {
  if (isExecutable(p)) throw new NotDone(`JARVIS does not create or change files that run when opened (${path.extname(p)}).`);
}

function create(pathArg: unknown, contentArg: unknown, folderArg: unknown): Omit<FileReport, 'success' | 'action'> {
  const target = need(pathArg);
  if (statOf(target)) throw new NotDone(`${pathArg} already exists.`);
  const folder = folderArg === true;
  if (folder) {
    fs.mkdirSync(target, { recursive: true });
    return { path: target, did: `created the folder ${path.basename(target)}`, check: statOf(target)?.isDirectory() ? verified(`the folder ${path.basename(target)} is there`) : failed('the folder is not there') };
  }
  refuseExecutable(target);
  const content = typeof contentArg === 'string' ? contentArg : '';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
  const holds = fs.readFileSync(target, 'utf8') === content;
  return { path: target, did: `created ${path.basename(target)}`, check: holds ? verified(`${path.basename(target)} holds the ${content.length} characters written`) : failed(`${path.basename(target)} holds different text`) };
}

function modify(pathArg: unknown, findArg: unknown, replaceArg: unknown, allArg: unknown, contentArg: unknown): Omit<FileReport, 'success' | 'action'> {
  const target = need(pathArg);
  refuseExecutable(target);
  const original = readText(target, 2 * MAX_TEXT_BYTES);
  let next: string;
  let what: string;
  if (typeof findArg === 'string' && findArg) {
    if (typeof replaceArg !== 'string') throw new NotDone('Say what to put in place of the text (replace).');
    const count = original.split(findArg).length - 1;
    if (count === 0) throw new NotDone(`The text to replace is not in ${path.basename(target)}.`);
    if (count > 1 && allArg !== true) throw new NotDone(`The text appears ${count} times in ${path.basename(target)}: give more of it, or set all to true.`);
    next = allArg === true ? original.split(findArg).join(replaceArg) : original.replace(findArg, () => replaceArg);
    what = `replaced ${allArg === true ? count : 1} occurrence${(allArg === true ? count : 1) === 1 ? '' : 's'}`;
  } else if (typeof contentArg === 'string') {
    next = contentArg;
    what = 'replaced the whole text';
  } else {
    throw new NotDone('Say what to change: find and replace, or the new content.');
  }
  const backup = intoTrash(target, 'previous-version');
  fs.writeFileSync(target, next, 'utf8');
  const holds = fs.readFileSync(target, 'utf8') === next;
  return {
    path: target, did: `${what} in ${path.basename(target)} (the previous version is in the JARVIS trash as ${backup.id})`, backup: backup.id,
    check: holds ? verified(`${path.basename(target)} holds the new text`) : failed(`${path.basename(target)} does not hold the new text`),
  };
}

function relocate(action: 'rename' | 'move', pathArg: unknown, toArg: unknown): Omit<FileReport, 'success' | 'action'> {
  const source = need(pathArg);
  const sourceCheck = checkFilePath(pathArg);
  if (sourceCheck.ok && isApprovedRoot(sourceCheck.real)) throw new NotDone('JARVIS does not move or rename a whole approved folder.');
  if (!statOf(source)) throw new NotDone(`${pathArg} does not exist.`);
  const to = typeof toArg === 'string' ? toArg.trim() : '';
  if (!to) throw new NotDone(action === 'rename' ? 'Say the new name.' : 'Say where to move it.');
  let destination: string;
  if (action === 'rename') {
    if (/[\\/]/.test(to) || to === '.' || to === '..') throw new NotDone('A new name has no folder in it; use move to put it elsewhere.');
    destination = path.join(path.dirname(source), to);
  } else {
    const target = need(to);
    destination = statOf(target)?.isDirectory() ? path.join(target, path.basename(source)) : target;
  }
  need(destination);
  if (statOf(destination)) throw new NotDone(`${destination} already exists.`);
  if (statOf(source)?.isFile()) refuseExecutable(destination);
  if (path.resolve(destination).startsWith(path.resolve(source) + path.sep)) throw new NotDone('A folder cannot be moved into itself.');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  moveItem(source, destination);
  const done = !!statOf(destination) && !statOf(source);
  return {
    path: source, to: destination, did: `${action === 'rename' ? 'renamed' : 'moved'} ${path.basename(source)} to ${destination}`,
    check: done ? verified(`${path.basename(destination)} is there and ${path.basename(source)} is gone from where it was`) : failed('the item is not where it should be'),
  };
}

function remove(pathArg: unknown): Omit<FileReport, 'success' | 'action'> {
  const check = checkFilePath(pathArg);
  if (!check.ok) throw new NotDone(check.reason);
  if (isApprovedRoot(check.real)) throw new NotDone('JARVIS does not delete a whole approved folder.');
  if (path.resolve(check.path).startsWith(path.resolve(trashDir()))) throw new NotDone('Use empty_trash for what is in the trash.');
  if (!statOf(check.path)) throw new NotDone(`${pathArg} does not exist.`);
  const note = intoTrash(check.path, 'deleted');
  const gone = !statOf(check.path);
  const kept = !!statOf(path.join(trashDir(), note.id, note.name));
  return {
    path: check.path, trashId: note.id, did: `moved ${note.name} to the JARVIS trash (restore with id ${note.id})`,
    check: gone && kept ? verified(`${note.name} is gone from its folder and kept in the trash`) : failed(gone ? 'the trash copy is missing' : `${note.name} is still there`),
  };
}

function restore(idArg: unknown): Omit<FileReport, 'success' | 'action'> {
  const id = typeof idArg === 'string' ? idArg.trim() : '';
  const note = trashNotes().find((n) => n.id === id);
  if (!note) throw new NotDone(`Nothing in the JARVIS trash has the id "${id}".`);
  const destination = need(note.originalPath);
  const kept = path.join(trashDir(), note.id, note.name);
  if (note.kind === 'deleted') {
    if (statOf(destination)) throw new NotDone(`Something is already at ${destination}.`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    moveItem(kept, destination);
  } else {
    const keep = statOf(destination) ? intoTrash(destination, 'previous-version') : undefined;
    fs.copyFileSync(kept, destination);
    void keep;
  }
  fs.rmSync(path.join(trashDir(), note.id), { recursive: true, force: true });
  const back = !!statOf(destination);
  return {
    path: destination, did: `restored ${note.name} to ${destination}`,
    check: back ? verified(`${note.name} is back at ${destination}`) : failed(`${note.name} is not back`),
  };
}

function emptyTrash(): Omit<FileReport, 'success' | 'action'> {
  const dir = trashDir();
  const count = trashNotes().length;
  if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  const left = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  return { did: `emptied the JARVIS trash (${count} item${count === 1 ? '' : 's'})`, check: left === 0 ? verified('the trash is empty') : failed(`${left} items are still in the trash`) };
}

// ── The tool ─────────────────────────────────────────────────────────────────

export const FILE_ACTIONS = ['list', 'search', 'compare', 'create', 'modify', 'rename', 'move', 'delete', 'restore', 'trash', 'empty_trash'] as const;

export function runFiles(args: Record<string, unknown>): FileReport {
  const action = typeof args['action'] === 'string' ? args['action'].toLowerCase() : '';
  try {
    switch (action) {
      case 'list': return { success: true, action, ...list(args['path'], args['depth']) };
      case 'search': return { success: true, action, ...search(args['path'], args['name'], args['text'], args['max']) };
      case 'compare': return { success: true, action, ...compare(args['path'], args['other']) };
      case 'trash': return { success: true, action, items: trashNotes() };
      case 'create': return { success: true, action, ...create(args['path'], args['content'], args['folder']) };
      case 'modify': return { success: true, action, ...modify(args['path'], args['find'], args['replace'], args['all'], args['content']) };
      case 'rename':
      case 'move': return { success: true, action, ...relocate(action, args['path'], args['to']) };
      case 'delete': return { success: true, action, ...remove(args['path']) };
      case 'restore': return { success: true, action, ...restore(args['id']) };
      case 'empty_trash': return { success: true, action, ...emptyTrash() };
      default: return { success: false, action, error: `Unknown files action "${action}".` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, action, error: err instanceof NotDone ? message : `The ${action} failed: ${message}` };
  }
}

/** The check the action made on disk itself; reading actions make none. */
const ownCheck: Verifier = async (_args, output) => {
  try {
    const report = JSON.parse(output) as FileReport;
    if (report.check) return report.check;
  } catch {
    // not a report
  }
  return { status: 'unverifiable', evidence: 'reading changes nothing' };
};

export const filesTool: AgentTool = {
  name: 'files',
  description:
    'Use to work with files and folders in the approved folders (the JARVIS folder, Desktop, Documents, Downloads, temp). ' +
    'action: list (path, depth 1-3), search (path of a folder; name and/or text; max), compare (path, other: a line diff), ' +
    'create (path; content, or folder: true), modify (path; find and replace, all: true for every occurrence — or content ' +
    'for the whole text), rename (path, to: new name), move (path, to: folder or new path), delete (path: goes to the ' +
    'JARVIS trash), restore (id from delete or trash), trash (lists it), empty_trash. JARVIS checks each change on disk.',
  riskLevel: 'medium',
  inputSchema: {
    action: { type: 'string', description: FILE_ACTIONS.join(', '), required: true, enum: [...FILE_ACTIONS] },
    path: { type: 'string', description: 'The file or folder.', required: false },
    other: { type: 'string', description: 'compare: the second file.', required: false },
    to: { type: 'string', description: 'rename: the new name; move: the folder or new path.', required: false },
    name: { type: 'string', description: 'search: part of a file name.', required: false },
    text: { type: 'string', description: 'search: text inside files.', required: false },
    max: { type: 'number', description: 'search: at most this many results (default 50).', required: false },
    depth: { type: 'number', description: 'list: how many folder levels (1-3).', required: false },
    content: { type: 'string', description: 'create: the text; modify: the whole new text.', required: false },
    folder: { type: 'boolean', description: 'create: make a folder.', required: false },
    find: { type: 'string', description: 'modify: the exact text to replace.', required: false },
    replace: { type: 'string', description: 'modify: what to put in its place.', required: false },
    all: { type: 'boolean', description: 'modify: replace every occurrence.', required: false },
    id: { type: 'string', description: 'restore: the trash id.', required: false },
  },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    return JSON.stringify(runFiles(args), null, 2);
  },
};

/** For the risk engine: the temp folder, where a .txt change is level 1. */
export const TEMP_ROOT = os.tmpdir();
