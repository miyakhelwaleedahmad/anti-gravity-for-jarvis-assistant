/**
 * memory/vault.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Safe access to the owner's Obsidian vault for JARVIS's second brain.
 *
 *   which vault   JARVIS_OBSIDIAN_VAULT only. The folder must exist and hold
 *                 an .obsidian folder (Obsidian has opened it). JARVIS never
 *                 picks another folder and never creates a vault.
 *   where         writes only under <vault>/JARVIS/; a path is relative, has
 *                 no "..", no reserved or invalid Windows names, and its real
 *                 location (links resolved) stays inside that folder.
 *   whose notes   a note JARVIS writes carries `jarvis_managed: true` and its
 *                 own `jarvis_id` in its frontmatter. Only such notes are ever
 *                 updated, moved or appended to. Any other note is the owner's:
 *                 readable and searchable, never changed.
 *   how           atomic writes (temporary file, then rename); reads and
 *                 searches are bounded (files, size, results).
 *   offline       a write the vault cannot take now goes to an outbox in
 *                 data/brain/ and is replayed by flushOutbox() later.
 *
 * Vault text is data, never instructions: readers wrap it before it reaches a
 * model (security/untrustedText.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { dataRoot, getWorkspaceRoot } from '../core/workspaceRoot.js';
import { redact } from '../security/redactor.js';

export const BRAIN_ROOT = 'JARVIS';
const MAX_NOTE_BYTES = 512 * 1024;
const MAX_SCAN_FILES = 5_000;
const MAX_READ_BYTES = 256 * 1024;
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export type VaultState =
  | { ok: true; vault: string }
  | { ok: false; reason: 'not_configured' | 'missing' | 'not_a_folder' | 'not_obsidian' | 'not_writable'; detail: string };

/** The configured vault, checked. Never a guess. */
export function checkVault(env: Record<string, string | undefined> = process.env): VaultState {
  const raw = env['JARVIS_OBSIDIAN_VAULT']?.trim();
  if (!raw) return { ok: false, reason: 'not_configured', detail: 'JARVIS_OBSIDIAN_VAULT is not set; set it in .env to your Obsidian vault folder' };
  const vault = path.resolve(raw);
  let st: fs.Stats;
  try { st = fs.statSync(vault); } catch { return { ok: false, reason: 'missing', detail: `the vault folder ${vault} does not exist (is the drive connected?)` }; }
  if (!st.isDirectory()) return { ok: false, reason: 'not_a_folder', detail: `${vault} is not a folder` };
  if (!fs.existsSync(path.join(vault, '.obsidian'))) {
    return { ok: false, reason: 'not_obsidian', detail: `${vault} has no .obsidian folder, so it is not an Obsidian vault; open it once in Obsidian, or correct JARVIS_OBSIDIAN_VAULT` };
  }
  try { fs.accessSync(vault, fs.constants.W_OK); } catch { return { ok: false, reason: 'not_writable', detail: `JARVIS cannot write to ${vault} (permissions)` }; }
  return { ok: true, vault: fs.realpathSync(vault) };
}

/** A safe file or folder name: no path characters, no Windows-invalid characters, bounded. */
export function safeName(name: string, max = 80): string {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, max)
    .trim();
  if (!cleaned || WINDOWS_RESERVED.test(cleaned)) throw new Error(`"${name}" is not a usable name`);
  return cleaned;
}

/** The problem with a brain-relative path, or undefined. */
export function brainPathProblem(rel: string): string | undefined {
  const p = String(rel).replace(/\\/g, '/');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return `${p || '(empty)'} is not a relative path`;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.' || s === '')) return `${p} leaves the JARVIS folder`;
  if (parts.some((s) => WINDOWS_RESERVED.test(s.replace(/\.[^.]*$/, '')) || /[:*?"<>|\u0000-\u001f]/.test(s))) return `${p} has a name Windows does not allow`;
  if (p.length > 200) return `${p} is too long`;
  return undefined;
}

export interface NoteMeta {
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface Note {
  /** Vault-relative, forward slashes. */
  path: string;
  meta: NoteMeta;
  body: string;
  managed: boolean;
  mtimeMs: number;
}

/** Frontmatter (simple key: value, lists as [a, b]) and body. */
export function parseNote(text: string): { meta: NoteMeta; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: NoteMeta = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const v = kv[2]!.trim();
    if (/^\[.*\]$/.test(v)) meta[kv[1]!] = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
    else if (v === 'true' || v === 'false') meta[kv[1]!] = v === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(v)) meta[kv[1]!] = Number(v);
    else meta[kv[1]!] = v.replace(/^"(.*)"$/, '$1');
  }
  return { meta, body: text.slice(m[0].length) };
}

export function renderNote(meta: NoteMeta, body: string): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(String(x))).join(', ')}]`);
    else if (typeof v === 'string') lines.push(`${k}: ${/[:#\[\]{}"'\n]|^\s|\s$/.test(v) ? JSON.stringify(v) : v}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '');
  return lines.join('\n') + body.replace(/^\n+/, '');
}

export interface OutboxEntry { at: string; op: 'write' | 'append'; path: string; content: string; meta?: NoteMeta; id?: string }

export class Vault {
  constructor(private readonly env: Record<string, string | undefined> = process.env, private readonly dataDir?: string) {}

  state(): VaultState { return checkVault(this.env); }

  private brainDir(vault: string): string { return path.join(vault, BRAIN_ROOT); }
  outboxPath(): string { return path.join(this.dataDir ?? path.join(dataRoot(getWorkspaceRoot()), 'data', 'brain'), 'outbox.jsonl'); }

  /** Absolute path of a brain-relative path, after every check. Throws on any problem. */
  resolve(vault: string, rel: string): string {
    const problem = brainPathProblem(rel);
    if (problem) throw new Error(problem);
    const root = this.brainDir(vault);
    const target = path.resolve(root, rel);
    const inside = path.relative(root, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`${rel} leaves the JARVIS folder`);
    // The nearest existing ancestor must really be inside the vault's JARVIS folder (no link out).
    let probe = path.dirname(target);
    while (!fs.existsSync(probe) && probe !== root && probe.length > root.length) probe = path.dirname(probe);
    if (fs.existsSync(probe)) {
      const real = fs.realpathSync(probe);
      const rootReal = fs.existsSync(root) ? fs.realpathSync(root) : root;
      const r = path.relative(rootReal, real);
      if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(`${rel} is reached through a link out of the JARVIS folder`);
    }
    return target;
  }

  ensureDir(vault: string, rel: string): boolean {
    const dir = rel ? this.resolve(vault, rel) : this.brainDir(vault);
    if (fs.existsSync(dir)) return false;
    fs.mkdirSync(dir, { recursive: true });
    return true;
  }

  exists(vault: string, rel: string): boolean {
    try { return fs.existsSync(this.resolve(vault, rel)); } catch { return false; }
  }

  /** A note under JARVIS/, or undefined. */
  readBrain(vault: string, rel: string): Note | undefined {
    const file = this.resolve(vault, rel);
    return this.readFile(vault, file);
  }

  private readFile(vault: string, file: string): Note | undefined {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_READ_BYTES) return undefined;
      const { meta, body } = parseNote(fs.readFileSync(file, 'utf8'));
      return { path: path.relative(vault, file).split(path.sep).join('/'), meta, body, managed: meta['jarvis_managed'] === true && typeof meta['jarvis_id'] === 'string', mtimeMs: st.mtimeMs };
    } catch {
      return undefined;
    }
  }

  /**
   * Write a JARVIS note. A file already at that path that JARVIS does not own
   * (no jarvis_managed marker, or another jarvis_id) is never overwritten.
   */
  writeManaged(vault: string, rel: string, id: string, meta: NoteMeta, body: string): 'written' | 'unchanged' {
    const file = this.resolve(vault, rel);
    const existing = this.readFile(vault, file);
    if (existing && !(existing.managed && existing.meta['jarvis_id'] === id)) throw new Error(`${rel} is a note JARVIS did not write; it is left unchanged`);
    const text = redact(renderNote({ ...meta, jarvis_managed: true, jarvis_id: id }, body));
    if (Buffer.byteLength(text) > MAX_NOTE_BYTES) throw new Error(`${rel} would be larger than ${MAX_NOTE_BYTES / 1024} KB`);
    if (existing && fs.readFileSync(file, 'utf8') === text) return 'unchanged';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return 'written';
  }

  /** Move a JARVIS note (never an owner's note); refuses to replace anything at the target. */
  moveManaged(vault: string, from: string, to: string): void {
    const src = this.resolve(vault, from);
    const dst = this.resolve(vault, to);
    const note = this.readFile(vault, src);
    if (!note?.managed) throw new Error(`${from} is not a JARVIS note; it is not moved`);
    if (fs.existsSync(dst)) throw new Error(`${to} already exists; nothing moved`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
  }

  /** Every markdown note in the vault (bounded), JARVIS's and the owner's. */
  listNotes(vault: string, under = ''): string[] {
    const out: string[] = [];
    const start = under ? path.join(vault, under) : vault;
    const walk = (dir: string) => {
      if (out.length >= MAX_SCAN_FILES) return;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= MAX_SCAN_FILES) return;
        if (e.isSymbolicLink()) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p); }
        else if (e.name.endsWith('.md')) out.push(path.relative(vault, p).split(path.sep).join('/'));
      }
    };
    walk(start);
    return out;
  }

  /** Read any note in the vault by its vault-relative path (read-only; bounded). */
  readAny(vault: string, rel: string): Note | undefined {
    const file = path.resolve(vault, rel);
    const r = path.relative(vault, file);
    if (r.startsWith('..') || path.isAbsolute(r)) return undefined;
    try {
      const real = path.relative(fs.realpathSync(vault), fs.realpathSync(file));
      if (real.startsWith('..') || path.isAbsolute(real)) return undefined;   // a link out of the vault
    } catch { return undefined; }
    return this.readFile(vault, file);
  }

  // ─── outbox ────────────────────────────────────────────────────────────────

  queue(entry: Omit<OutboxEntry, 'at'>): void {
    const file = this.outboxPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...entry, content: redact(entry.content), at: new Date().toISOString() }) + '\n');
  }

  pending(): OutboxEntry[] {
    try {
      return fs.readFileSync(this.outboxPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as OutboxEntry);
    } catch { return []; }
  }

  /** Replay queued writes; keeps those that still fail. Returns how many were written. */
  flushOutbox(apply: (e: OutboxEntry, vault: string) => void): { written: number; left: number; error?: string } {
    const st = this.state();
    const items = this.pending();
    if (!items.length) return { written: 0, left: 0 };
    if (!st.ok) return { written: 0, left: items.length, error: st.detail };
    const left: OutboxEntry[] = [];
    let written = 0;
    let error: string | undefined;
    for (const e of items) {
      try { apply(e, st.vault); written++; } catch (err) { left.push(e); error = (err as Error).message; }
    }
    const file = this.outboxPath();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, left.map((e) => JSON.stringify(e)).join('\n') + (left.length ? '\n' : ''));
    fs.renameSync(tmp, file);
    return { written, left: left.length, ...(error ? { error } : {}) };
  }
}

/** A short, stable id for a note's content. */
export function contentId(prefix: string, text: string): string {
  return `${prefix}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}
