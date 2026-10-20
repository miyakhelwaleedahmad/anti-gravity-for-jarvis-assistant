/**
 * memory/secondBrain.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS's second brain: durable, organized memory in the owner's Obsidian
 * vault (memory/vault.ts), maintained by JARVIS itself.
 *
 *   initialize  creates <vault>/JARVIS/ and the initial memory spaces
 *               (00 Index … 09 Templates), their index notes and templates;
 *               repeatable: what exists is kept, nothing is duplicated.
 *   remember    a useful, durable item is classified into the best-fitting
 *               space (deterministic scoring: no model call, no token cost);
 *               with no good fit it goes to 08 Memory Inbox. A repeat of a
 *               note already kept updates that note instead of adding one.
 *   discover    when several inbox notes on different days share a subject
 *               that no space covers, a new space is created (folder, index,
 *               template), registered, and those notes are moved into it.
 *               Bounded: at least 3 notes over 2 days, at most 2 new spaces a
 *               day and 40 in all, names checked against existing spaces.
 *   organize    inbox notes that now fit a space are moved; redundant
 *               added spaces (most keywords shared) are merged (notes moved, the old index kept
 *               as a pointer, nothing deleted); a note moves at most 3 times.
 *   retrieve    before a task, the few most relevant notes (bounded) are
 *               given to planning as data, never as instructions.
 *   learn       a resolved issue with verification evidence becomes a lesson;
 *               task outcomes are appended to the daily log.
 *
 * Only notes JARVIS wrote (jarvis_managed) are ever changed or moved; the
 * owner's notes are read and searched only. The category registry, decisions
 * and an operations log live in data/brain/; the vault holds readable indexes.
 * The issue store (core/issueStore.ts) stays the authority for errors; its
 * notes are mirrored into 01 Active Errors / 02 Resolved Errors.
 * When the vault is unavailable, writes queue in data/brain/outbox.jsonl and
 * sync() replays them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { dataRoot, getWorkspaceRoot } from '../core/workspaceRoot.js';
import { redact, hasSecret } from '../security/redactor.js';
import { untrusted } from '../security/untrustedText.js';
import { Vault, contentId, safeName, BRAIN_ROOT, type Note, type NoteMeta, type OutboxEntry } from './vault.js';

export const BRAIN_SCHEMA = 1;

/** Memory types: extensible (a space may declare a new one); working memory never leaves the process. */
export const DEFAULT_MEMORY_TYPES = ['error', 'preference', 'knowledge', 'project', 'experience', 'log'] as const;

export interface Category {
  id: string;
  title: string;
  folder: string;
  type: string;
  description: string;
  keywords: string[];
  origin: 'initial' | 'discovered' | 'requested';
  /** System spaces are written only by their owners (indexes, error mirror, daily log, templates). */
  system?: boolean;
  createdAt: string;
  mergedInto?: string;
}

export interface Decision { at: string; kind: 'created' | 'rejected' | 'merged' | 'moved' | 'classified'; subject: string; reason: string }

interface Registry {
  schemaVersion: number;
  initializedAt?: string;
  vault?: string;
  categories: Category[];
  decisions: Decision[];
  /** term → last rejection time (no re-evaluation storm). */
  rejected: Record<string, string>;
}

export interface RememberInput {
  text: string;
  title?: string;
  /** A memory type hint (preference, knowledge, project, experience, …). */
  type?: string;
  source?: string;
  evidence?: string;
  tags?: string[];
  /** Explicit owner request: skips the durability filter's length minimum. */
  explicit?: boolean;
}

export interface RememberResult {
  status: 'saved' | 'updated' | 'queued' | 'skipped';
  category?: string;
  path?: string;
  reason: string;
  newCategory?: string;
}

const INITIAL: Omit<Category, 'createdAt' | 'origin'>[] = [
  { id: 'index', title: 'Index', folder: '00 Index', type: 'system', description: 'The map of JARVIS memory.', keywords: [], system: true },
  { id: 'active_errors', title: 'Active Errors', folder: '01 Active Errors', type: 'error', description: 'Open issues from the issue record.', keywords: [], system: true },
  { id: 'resolved_errors', title: 'Resolved Errors', folder: '02 Resolved Errors', type: 'error', description: 'Issues resolved with verification evidence.', keywords: [], system: true },
  { id: 'preferences', title: 'Preferences', folder: '03 Preferences', type: 'preference', description: 'Stable instructions and preferences of the owner.', keywords: ['prefer', 'preference', 'always', 'never', 'like', 'dislike', 'want', 'default', 'call', 'style', 'favourite', 'favorite'] },
  { id: 'lessons', title: 'Lessons Learned', folder: '04 Lessons Learned', type: 'experience', description: 'Verified lessons from previous actions.', keywords: ['lesson', 'learned', 'avoid', 'mistake', 'worked', 'works', 'fixed', 'because', 'next'] },
  { id: 'architecture', title: 'Architecture', folder: '05 Architecture', type: 'project', description: 'How JARVIS and the owner\'s systems are built, and why.', keywords: ['architecture', 'design', 'component', 'module', 'service', 'pipeline', 'decision', 'interface', 'database', 'schema'] },
  { id: 'projects', title: 'Projects and Tasks', folder: '06 Projects and Tasks', type: 'project', description: 'Projects, goals, tasks and their status.', keywords: ['project', 'task', 'goal', 'deadline', 'todo', 'milestone', 'plan', 'release', 'status', 'deliver'] },
  { id: 'daily', title: 'Daily Logs', folder: '07 Daily Logs', type: 'log', description: 'What JARVIS did each day, with outcomes.', keywords: [], system: true },
  { id: 'inbox', title: 'Memory Inbox', folder: '08 Memory Inbox', type: 'knowledge', description: 'Items without a fitting space yet.', keywords: [] },
  { id: 'templates', title: 'Templates', folder: '09 Templates', type: 'system', description: 'Note templates for each space.', keywords: [], system: true },
];

const STOP = new Set(('the a an and or but if then than that this these those with without for from into onto over under about after before when while where what which who whom whose why how is are was were be been being have has had do does did can could should would will shall may might must not no yes you your yours i me my mine we our ours they them their it its he she his her him on in at by of to as so very just also more most less least some any each every all both either neither such only own same other another much many few lot lots really thing things there here again once note notes remember please jarvis sir okay today yesterday tomorrow time make made get got use used using want need like').split(' '));

/** Content words of a text, lowercased (≥ 4 letters, no stop words). */
export function terms(text: string): string[] {
  return (String(text).toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter((w) => !STOP.has(w));
}

function termSet(text: string): Set<string> { return new Set(terms(text)); }

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Shared share of the smaller set: two spaces whose keywords mostly coincide are redundant. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

function titleCase(s: string): string { return s.replace(/\b[a-z]/g, (c) => c.toUpperCase()); }
function today(now: number): string { return new Date(now).toISOString().slice(0, 10); }

const LIMITS = {
  minClusterNotes: 3,
  minClusterDays: 2,
  maxNewPerDay: 2,
  maxDiscovered: 40,
  maxMovesPerNote: 3,
  rejectCooldownMs: 24 * 3600_000,
  retrieveChars: 1_500,
  retrieveNotes: 4,
  dailyLines: 200,
  maxTextChars: 20_000,
  minTextChars: 20,
};

export interface BrainDeps {
  env?: Record<string, string | undefined>;
  dataDir?: string;
  now?: () => number;
}

export class SecondBrain {
  readonly vault: Vault;
  private registry: Registry | null = null;
  private searchCache = new Map<string, { mtime: number; title: string; terms: Map<string, number>; managed: boolean; category?: string }>();
  private listing: { vault: string; at: number; paths: string[] } | null = null;
  private now: () => number;

  constructor(private readonly deps: BrainDeps = {}) {
    this.vault = new Vault(deps.env ?? process.env, deps.dataDir);
    this.now = deps.now ?? Date.now;
  }

  private dir(): string { return this.deps.dataDir ?? path.join(dataRoot(getWorkspaceRoot()), 'data', 'brain'); }
  private registryPath(): string { return path.join(this.dir(), 'registry.json'); }

  private reg(): Registry {
    if (this.registry) return this.registry;
    try {
      const r = JSON.parse(fs.readFileSync(this.registryPath(), 'utf8')) as Registry;
      if (r.schemaVersion === BRAIN_SCHEMA && Array.isArray(r.categories)) this.registry = { ...r, rejected: r.rejected ?? {}, decisions: r.decisions ?? [] };
    } catch { /* first run */ }
    this.registry ??= { schemaVersion: BRAIN_SCHEMA, categories: [], decisions: [], rejected: {} };
    // The initial spaces are always known (classification works before the vault is reachable).
    const at = new Date(this.now()).toISOString();
    for (const c of INITIAL) if (!this.registry.categories.some((x) => x.id === c.id)) this.registry.categories.push({ ...c, origin: 'initial', createdAt: at });
    return this.registry;
  }

  private saveRegistry(): void {
    const r = this.reg();
    if (r.decisions.length > 500) r.decisions.splice(0, r.decisions.length - 500);
    fs.mkdirSync(this.dir(), { recursive: true });
    const tmp = `${this.registryPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
    fs.renameSync(tmp, this.registryPath());
  }

  /** One line per JARVIS-managed operation, for review. */
  private op(kind: string, detail: string): void {
    this.listing = null;
    try {
      fs.mkdirSync(this.dir(), { recursive: true });
      fs.appendFileSync(path.join(this.dir(), 'operations.jsonl'), JSON.stringify({ at: new Date(this.now()).toISOString(), kind, detail: redact(detail).slice(0, 300) }) + '\n');
    } catch { /* the log is optional */ }
  }

  private decide(kind: Decision['kind'], subject: string, reason: string): void {
    this.reg().decisions.push({ at: new Date(this.now()).toISOString(), kind, subject: subject.slice(0, 80), reason: redact(reason).slice(0, 200) });
  }

  categories(): Category[] { return this.reg().categories.filter((c) => !c.mergedInto); }
  category(id: string): Category | undefined { return this.reg().categories.find((c) => c.id === id); }
  decisions(limit = 50): Decision[] { return this.reg().decisions.slice(-limit); }

  // ─── initialize ──────────────────────────────────────────────────────────────

  /** Create what is missing; keep what exists. Returns what was done, or why not. */
  initialize(): { ok: boolean; created: string[]; existing: string[]; migrated: string[]; message: string } {
    const st = this.vault.state();
    if (!st.ok) return { ok: false, created: [], existing: [], migrated: [], message: `The second brain is not available: ${st.detail}.` };
    const v = st.vault;
    const r = this.reg();
    const created: string[] = [];
    const existing: string[] = [];
    try { if (this.vault.ensureDir(v, '')) created.push(BRAIN_ROOT); }
    catch (err) { return { ok: false, created, existing, migrated: [], message: `The second brain is not available: ${(err as Error).message}.` }; }
    const at = new Date(this.now()).toISOString();
    for (const c of r.categories) {
      if (c.mergedInto) continue;
      (this.vault.ensureDir(v, c.folder) ? created : existing).push(c.folder);
      if (!c.system || c.id === 'active_errors' || c.id === 'resolved_errors') this.writeCategoryFiles(v, c);
    }
    const migrated = this.migrateLegacyRepairs(v);
    if (!r.initializedAt) { r.initializedAt = at; this.decide('created', 'second brain', 'initialized'); }
    r.vault = v;
    this.saveRegistry();
    this.writeMainIndex(v);
    this.op('initialize', `created ${created.length}, kept ${existing.length}, migrated ${migrated.length}`);
    return {
      ok: true, created, existing, migrated,
      message: created.length
        ? `Second brain ready in ${v}: created ${created.length} folder${created.length === 1 ? '' : 's'}, kept ${existing.length}.`
        : `Second brain already initialized in ${v}; nothing was missing.`,
    };
  }

  /** Earlier repair notes (JARVIS/Repairs) move into the error spaces; only notes JARVIS wrote. */
  private migrateLegacyRepairs(v: string): string[] {
    const moved: string[] = [];
    for (const [from, to] of [['Repairs', '01 Active Errors'], [path.join('Repairs', 'Resolved'), '02 Resolved Errors']] as const) {
      const dir = path.join(v, BRAIN_ROOT, from);
      let files: string[] = [];
      try { files = fs.readdirSync(dir).filter((f) => /^iss-[0-9a-f]{12}\.md$/.test(f)); } catch { continue; }
      for (const f of files) {
        let src: string, dst: string;
        try { src = this.vault.resolve(v, `${from.split(path.sep).join('/')}/${f}`); dst = this.vault.resolve(v, `${to}/${f}`); }
        catch (err) { this.op('migrate_skipped', `${f}: ${(err as Error).message}`); continue; }   // a link out of the vault
        const text = fs.readFileSync(src, 'utf8');
        if (!new RegExp(`^jarvis_issue_id: ${f.replace(/\.md$/, '')}\\r?$`, 'm').test(text)) continue;   // not ours
        if (fs.existsSync(dst)) continue;
        fs.renameSync(src, dst);
        moved.push(`${from}/${f}`.split(path.sep).join('/'));
      }
    }
    if (moved.length) this.decide('moved', 'repair notes', `moved ${moved.length} earlier repair note(s) into the error spaces`);
    return moved;
  }

  private writeCategoryFiles(v: string, c: Category): void {
    const indexRel = `${c.folder}/${c.title} Index.md`;
    const notes = this.notesIn(v, c.folder).filter((n) => n.path !== `${BRAIN_ROOT}/${indexRel}`);
    const body = [
      `# ${c.title}`, '', c.description, '',
      `Type: ${c.type} · Created: ${c.createdAt.slice(0, 10)} (${c.origin})${c.mergedInto ? ` · Merged into [[${c.mergedInto}]]` : ''}`, '',
      '## Notes', '',
      ...(notes.length ? notes.slice(0, 200).map((n) => `- [[${path.basename(n.path, '.md')}]]`) : ['(none yet)']),
      '',
    ].join('\n');
    try {
      this.vault.writeManaged(v, indexRel, `index-${c.id}`, { jarvis_kind: 'index', category: c.id }, body);
    } catch (err) { this.op('index_skipped', `${indexRel}: ${(err as Error).message}`); }
    if (!c.system) {
      const tpl = ['# {{title}}', '', '**Summary:** ', '', '**Evidence:** ', '', '**Related:** ', '', `_Space: ${c.title}_`, ''].join('\n');
      try { this.vault.writeManaged(v, `09 Templates/${c.title} Template.md`, `template-${c.id}`, { jarvis_kind: 'template', category: c.id }, tpl); }
      catch (err) { this.op('template_skipped', (err as Error).message); }
    }
  }

  private writeMainIndex(v: string): void {
    const cats = this.categories();
    const body = [
      '# JARVIS Memory Index', '',
      '> Maintained by JARVIS. Notes JARVIS writes carry `jarvis_managed: true`; your own notes are never changed or moved.', '',
      '| Space | Type | Origin | Notes |', '|---|---|---|---|',
      ...cats.map((c) => `| [[${c.title} Index\\|${c.folder}]] | ${c.type} | ${c.origin} | ${this.notesIn(v, c.folder).length} |`),
      '', '## Recent organization decisions', '',
      ...this.decisions(15).reverse().map((d) => `- ${d.at.slice(0, 16).replace('T', ' ')} ${d.kind}: ${d.subject} — ${d.reason}`),
      '',
    ].join('\n');
    try { this.vault.writeManaged(v, '00 Index/JARVIS Memory Index.md', 'index-main', { jarvis_kind: 'index', jarvis_brain_schema: BRAIN_SCHEMA }, body); }
    catch (err) { this.op('index_skipped', (err as Error).message); }
  }

  private notesIn(v: string, folder: string): Note[] {
    return this.vault.listNotes(v, path.join(BRAIN_ROOT, folder))
      .map((p) => this.vault.readAny(v, p))
      .filter((n): n is Note => !!n && n.meta['jarvis_kind'] !== 'index');
  }

  // ─── classify and remember ──────────────────────────────────────────────────

  /** The best space for an item, with its score; the inbox when nothing fits well. */
  classify(input: { text: string; title?: string; type?: string }): { category: Category; score: number; reason: string } {
    const words = terms(`${input.title ?? ''} ${input.title ?? ''} ${input.text}`);
    const set = new Set(words);
    let best: { category: Category; score: number } | undefined;
    for (const c of this.categories()) {
      if (c.system || c.id === 'inbox') continue;
      let score = 0;
      for (const k of c.keywords) if (set.has(k)) score += 1;
      for (const t of terms(c.title)) if (set.has(t)) score += 1.5;
      if (input.type && input.type === c.type) score += 2;
      if (!best || score > best.score) best = { category: c, score };
    }
    const inbox = this.category('inbox')!;
    if (!best || best.score < 2) return { category: inbox, score: best?.score ?? 0, reason: 'no space fits well enough yet' };
    return { category: best.category, score: best.score, reason: `matches ${best.category.title} (score ${best.score})` };
  }

  /** Whether an item is worth keeping. */
  private durable(input: RememberInput): string | undefined {
    const t = input.text.trim();
    if (!t) return 'empty';
    if (t.length > LIMITS.maxTextChars) return 'too long to keep as one note';
    if (!input.explicit && t.length < LIMITS.minTextChars) return 'too short to be useful later';
    if (!input.explicit && /^(hi|hello|thanks|thank you|ok|okay|yes|no)\b/i.test(t) && t.length < 60) return 'small talk';
    return undefined;
  }

  remember(input: RememberInput): RememberResult {
    const not = this.durable(input);
    if (not) return { status: 'skipped', reason: not };
    const text = redact(input.text.trim());
    const title = safeName(input.title ?? text.split(/[.\n]/)[0]!.slice(0, 70), 70);
    const st = this.vault.state();
    if (!st.ok && st.reason === 'not_configured') return { status: 'skipped', reason: st.detail };
    const c = this.classify({ text, title, ...(input.type ? { type: input.type } : {}) });
    const id = contentId('mem', terms(text).sort().join(' ') || text.toLowerCase());
    const rel = `${c.category.folder}/${title}.md`;
    const meta: NoteMeta = {
      jarvis_kind: 'memory', category: c.category.id, type: input.type ?? c.category.type,
      created: new Date(this.now()).toISOString(), source: input.source ?? 'jarvis',
      ...(input.tags?.length ? { tags: input.tags.map((t) => safeName(t, 30)) } : {}),
      moves: 0,
    };
    const body = [`# ${title}`, '', text, '', ...(input.evidence ? ['**Evidence:** ' + redact(input.evidence), ''] : []), '## History', '', `- ${meta.created}: saved in ${c.category.title} (${c.reason})`, ''].join('\n');
    if (!st.ok) {
      this.vault.queue({ op: 'write', path: rel, content: body, meta, id });
      this.op('queued', `${rel}: ${st.detail}`);
      return { status: 'queued', category: c.category.id, reason: `the vault is unavailable (${st.detail}); kept in the outbox until it is back` };
    }
    if (this.reg().vault !== st.vault) this.initialize();
    // A note already kept (same id anywhere, or nearly the same words in the target space or the inbox) is updated.
    const dup = this.findDuplicate(st.vault, id, text, [c.category.folder, this.category('inbox')!.folder]);
    if (dup) {
      const note = this.vault.readAny(st.vault, dup)!;
      const rel2 = dup.slice(BRAIN_ROOT.length + 1);
      const extra = `- ${new Date(this.now()).toISOString()}: seen again${input.evidence ? ` (evidence: ${redact(input.evidence).slice(0, 200)})` : ''}`;
      this.vault.writeManaged(st.vault, rel2, String(note.meta['jarvis_id']), { ...note.meta, updated: new Date(this.now()).toISOString() }, `${note.body.trimEnd()}\n${extra}\n`);
      this.op('updated', rel2);
      return { status: 'updated', category: String(note.meta['category']), path: dup, reason: 'an equivalent note exists; it was updated instead of duplicated' };
    }
    const finalRel = this.freePath(st.vault, rel);
    const related = this.search(text, 3).filter((h) => h.path !== `${BRAIN_ROOT}/${finalRel}`).map((h) => `[[${path.basename(h.path, '.md')}]]`);
    const fullBody = related.length ? `${body}\n## Related\n\n${related.map((r) => `- ${r}`).join('\n')}\n` : body;
    this.vault.writeManaged(st.vault, finalRel, id, meta, fullBody);
    this.decide('classified', title, c.reason);
    this.op('saved', finalRel);
    let newCategory: string | undefined;
    if (c.category.id === 'inbox') newCategory = this.discover(st.vault)[0];
    this.saveRegistry();
    this.writeCategoryFiles(st.vault, this.category(c.category.id)!);
    this.writeMainIndex(st.vault);
    return { status: 'saved', category: newCategory ?? c.category.id, path: `${BRAIN_ROOT}/${finalRel}`, reason: c.reason, ...(newCategory ? { newCategory } : {}) };
  }

  private freePath(v: string, rel: string): string {
    if (!this.vault.exists(v, rel)) return rel;
    for (let i = 2; i < 100; i++) {
      const alt = rel.replace(/\.md$/, ` (${i}).md`);
      if (!this.vault.exists(v, alt)) return alt;
    }
    throw new Error(`no free name for ${rel}`);
  }

  private findDuplicate(v: string, id: string, text: string, folders: string[]): string | undefined {
    const words = termSet(text);
    for (const p of this.vault.listNotes(v, BRAIN_ROOT)) {
      const n = this.vault.readAny(v, p);
      if (!n?.managed || n.meta['jarvis_kind'] !== 'memory') continue;
      if (n.meta['jarvis_id'] === id) return p;
      if (folders.some((f) => p.startsWith(`${BRAIN_ROOT}/${f}/`)) && jaccard(words, termSet(n.body)) >= 0.8) return p;
    }
    return undefined;
  }

  // ─── discover, create, merge, organize ──────────────────────────────────────

  /** Validate a proposed space name against the existing ones. */
  private nameProblem(title: string): string | undefined {
    if (!/^[A-Za-z][A-Za-z0-9 &-]{2,39}$/.test(title)) return `"${title}" is not a clear space name (3-40 letters, digits, spaces)`;
    const t = termSet(title);
    for (const c of this.categories()) {
      if (c.title.toLowerCase() === title.toLowerCase()) return `${c.title} already exists`;
      if (jaccard(t, termSet(`${c.title} ${c.keywords.join(' ')}`)) >= 0.5 || [...t].some((w) => c.keywords.includes(w) || termSet(c.title).has(w))) return `it overlaps ${c.title}`;
    }
    return undefined;
  }

  /** Create a space (folder, index, template) and register it. */
  createCategory(title: string, opts: { description?: string; keywords?: string[]; type?: string; origin: 'discovered' | 'requested'; reason: string }): Category {
    const st = this.vault.state();
    if (!st.ok) throw new Error(st.detail);
    const name = titleCase(safeName(title, 40));
    const problem = this.nameProblem(name);
    if (problem) throw new Error(problem);
    const r = this.reg();
    const discovered = r.categories.filter((c) => c.origin !== 'initial');
    if (discovered.length >= LIMITS.maxDiscovered) throw new Error(`the limit of ${LIMITS.maxDiscovered} added spaces is reached; organize or merge first`);
    const day = today(this.now());
    if (opts.origin === 'discovered' && discovered.filter((c) => c.createdAt.startsWith(day)).length >= LIMITS.maxNewPerDay) throw new Error(`already ${LIMITS.maxNewPerDay} new spaces today`);
    const nums = r.categories.map((c) => Number(/^(\d+)/.exec(c.folder)?.[1] ?? 0));
    const folder = `${String(Math.max(9, ...nums) + 1).padStart(2, '0')} ${name}`;
    const c: Category = {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), title: name, folder,
      type: opts.type && /^[a-z][a-z_]{2,20}$/.test(opts.type) ? opts.type : 'knowledge',
      description: (opts.description ?? `Knowledge about ${name.toLowerCase()}.`).slice(0, 200),
      keywords: [...new Set([...(opts.keywords ?? []), ...terms(name)])].slice(0, 20),
      origin: opts.origin, createdAt: new Date(this.now()).toISOString(),
    };
    r.categories.push(c);
    this.vault.ensureDir(st.vault, folder);
    this.writeCategoryFiles(st.vault, c);
    this.decide('created', name, opts.reason);
    this.op('category_created', `${folder}: ${opts.reason}`);
    this.saveRegistry();
    this.writeMainIndex(st.vault);
    return c;
  }

  /** New spaces from recurring inbox subjects. Returns the titles created. */
  discover(v: string): string[] {
    const inbox = this.category('inbox')!;
    const notes = this.notesIn(v, inbox.folder).filter((n) => n.managed);
    const byTerm = new Map<string, { paths: string[]; days: Set<string> }>();
    for (const n of notes) {
      const day = String(n.meta['created'] ?? '').slice(0, 10);
      for (const t of new Set(terms(`${path.basename(n.path, '.md')} ${n.body.split('## History')[0]}`))) {
        const e = byTerm.get(t) ?? { paths: [], days: new Set<string>() };
        e.paths.push(n.path); e.days.add(day);
        byTerm.set(t, e);
      }
    }
    const created: string[] = [];
    const candidates = [...byTerm.entries()]
      .filter(([, e]) => e.paths.length >= LIMITS.minClusterNotes && e.days.size >= LIMITS.minClusterDays)
      .sort((a, b) => b[1].paths.length - a[1].paths.length);
    const r = this.reg();
    const taken = new Set<string>();
    for (const [term, e] of candidates) {
      const last = r.rejected[term];
      if (last && this.now() - Date.parse(last) < LIMITS.rejectCooldownMs) continue;
      if (e.paths.filter((p) => !taken.has(p)).length < LIMITS.minClusterNotes) continue;   // already placed by a stronger subject
      const title = titleCase(term);
      try {
        const c = this.createCategory(title, { origin: 'discovered', keywords: [term], reason: `${e.paths.length} inbox notes over ${e.days.size} days share "${term}"` });
        for (const p of e.paths) if (!taken.has(p) && this.moveNote(v, p, c, `space created for "${term}"`)) taken.add(p);
        this.writeCategoryFiles(v, c);
        this.writeCategoryFiles(v, inbox);
        created.push(c.title);
      } catch (err) {
        r.rejected[term] = new Date(this.now()).toISOString();
        this.decide('rejected', title, (err as Error).message);
      }
      if (created.length >= LIMITS.maxNewPerDay) break;
    }
    this.saveRegistry();
    return created;
  }

  /** Move a JARVIS note into a space, recording why in its history. */
  private moveNote(v: string, notePath: string, to: Category, why: string): boolean {
    const note = this.vault.readAny(v, notePath);
    if (!note?.managed) return false;
    const moves = Number(note.meta['moves'] ?? 0);
    if (moves >= LIMITS.maxMovesPerNote) return false;
    const fromRel = notePath.slice(BRAIN_ROOT.length + 1);
    const toRel = this.freePath(v, `${to.folder}/${path.basename(notePath)}`);
    this.vault.moveManaged(v, fromRel, toRel);
    const at = new Date(this.now()).toISOString();
    this.vault.writeManaged(v, toRel, String(note.meta['jarvis_id']), { ...note.meta, category: to.id, moves: moves + 1, moved_from: fromRel.split('/')[0], organized_at: at },
      `${note.body.trimEnd()}\n- ${at}: moved from ${fromRel.split('/')[0]} to ${to.folder} (${why})\n`);
    this.op('moved', `${fromRel} → ${toRel}`);
    return true;
  }

  /** Inbox review, discovery and redundant-space merges. */
  organize(): { ok: boolean; moved: number; created: string[]; merged: string[]; message: string } {
    const st = this.vault.state();
    if (!st.ok) return { ok: false, moved: 0, created: [], merged: [], message: `The second brain is not available: ${st.detail}.` };
    const v = st.vault;
    if (!this.reg().initializedAt) this.initialize();
    let moved = 0;
    const inbox = this.category('inbox')!;
    for (const n of this.notesIn(v, inbox.folder)) {
      if (!n.managed) continue;
      const organized = Date.parse(String(n.meta['organized_at'] ?? ''));
      if (Number.isFinite(organized) && this.now() - organized < 24 * 3600_000) continue;
      const c = this.classify({ text: n.body.split('## History')[0]!, title: path.basename(n.path, '.md') });
      if (c.category.id !== 'inbox' && this.moveNote(v, n.path, c.category, c.reason)) { moved++; this.decide('moved', path.basename(n.path, '.md'), c.reason); }
    }
    const created = this.discover(v);
    const merged = this.mergeRedundant(v);
    for (const c of this.categories()) this.writeCategoryFiles(v, c);
    this.saveRegistry();
    this.writeMainIndex(v);
    this.op('organize', `moved ${moved}, created ${created.length}, merged ${merged.length}`);
    return { ok: true, moved, created, merged, message: `Memory organized: ${moved} note(s) moved, ${created.length} new space(s)${created.length ? ` (${created.join(', ')})` : ''}, ${merged.length} merge(s).` };
  }

  /** Merge one pair of overlapping added spaces (never initial ones); the old index stays as a pointer. */
  private mergeRedundant(v: string): string[] {
    const added = this.categories().filter((c) => c.origin !== 'initial');
    for (let i = 0; i < added.length; i++) {
      for (let j = i + 1; j < added.length; j++) {
        const a = added[i]!, b = added[j]!;
        if (overlap(new Set(a.keywords), new Set(b.keywords)) < 0.6) continue;
        const [from, into] = this.notesIn(v, a.folder).length <= this.notesIn(v, b.folder).length ? [a, b] : [b, a];
        for (const n of this.notesIn(v, from.folder)) this.moveNote(v, n.path, into, `${from.title} merged into ${into.title}`);
        from.mergedInto = `${into.title} Index`;
        into.keywords = [...new Set([...into.keywords, ...from.keywords])].slice(0, 30);
        this.writeCategoryFiles(v, from);
        this.decide('merged', from.title, `overlaps ${into.title}; notes moved, the old index kept as a pointer`);
        return [`${from.title} → ${into.title}`];
      }
    }
    return [];
  }

  // ─── search and retrieval ───────────────────────────────────────────────────

  /** Notes (JARVIS's and the owner's) ranked for a query; bounded and cached by modification time. */
  search(query: string, k = 5): { path: string; title: string; score: number; snippet: string; managed: boolean; category?: string }[] {
    const st = this.vault.state();
    if (!st.ok) return [];
    const q = [...termSet(query)];
    if (!q.length) return [];
    const hits: { path: string; title: string; score: number; snippet: string; managed: boolean; category?: string }[] = [];
    if (!this.listing || this.listing.vault !== st.vault || Date.now() - this.listing.at > 10_000) this.listing = { vault: st.vault, at: Date.now(), paths: this.vault.listNotes(st.vault) };
    for (const p of this.listing.paths) {
      let entry = this.searchCache.get(p);
      let mtime = 0;
      try { mtime = fs.statSync(path.join(st.vault, p)).mtimeMs; } catch { continue; }
      let note: Note | undefined;
      if (!entry || entry.mtime !== mtime) {
        note = this.vault.readAny(st.vault, p);
        if (!note) continue;
        const tf = new Map<string, number>();
        for (const t of terms(note.body)) tf.set(t, (tf.get(t) ?? 0) + 1);
        entry = { mtime, title: path.basename(p, '.md'), terms: tf, managed: note.managed, ...(note.meta['category'] ? { category: String(note.meta['category']) } : {}) };
        this.searchCache.set(p, entry);
      }
      if (entry.title.endsWith(' Index') || entry.title.endsWith(' Template')) continue;
      const titleTerms = termSet(entry.title);
      let score = 0;
      for (const t of q) score += Math.min(3, entry.terms.get(t) ?? 0) + (titleTerms.has(t) ? 2 : 0);
      if (!score) continue;
      if (entry.category === 'lessons' || entry.category === 'preferences') score *= 1.3;
      note ??= this.vault.readAny(st.vault, p);
      const lines = (note?.body ?? '').split('\n').filter((l) => q.some((t) => l.toLowerCase().includes(t)) && !l.startsWith('- 20'));
      // The owner's notes may hold a credential: never passed on.
      hits.push({ path: p, title: entry.title, score, snippet: redact(lines.slice(0, 2).join(' ')).slice(0, 300), managed: entry.managed, ...(entry.category ? { category: entry.category } : {}) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** The few relevant memories for a task, wrapped as data (never instructions). Empty when none or unavailable. */
  retrieveForTask(query: string): string {
    const hits = this.search(query, LIMITS.retrieveNotes).filter((h) => h.score >= 2);
    if (!hits.length) return '';
    let text = '';
    for (const h of hits) {
      const line = `- ${h.title}${h.category ? ` (${h.category})` : ''}: ${h.snippet}\n`;
      if (text.length + line.length > LIMITS.retrieveChars) break;
      text += line;
    }
    return text ? untrusted('second_brain:obsidian', text, LIMITS.retrieveChars + 200) : '';
  }

  // ─── lessons, daily log, errors ─────────────────────────────────────────────

  /** A resolved issue with evidence becomes (or updates) its lesson. */
  noteResolvedIssue(issue: { issueId: string; signature: string; component: string; summary: string; category: string; recurrenceCount: number; verification?: { passed: boolean; evidence: string }; sourceLocation?: { status: string; file?: string; line?: number } }): RememberResult {
    if (!issue.verification?.passed || !issue.verification.evidence) return { status: 'skipped', reason: 'not verified, so not a lesson' };
    const st = this.vault.state();
    if (!st.ok && st.reason === 'not_configured') return { status: 'skipped', reason: st.detail };
    const title = safeName(`Lesson ${issue.component} ${issue.summary.slice(0, 50)}`, 70);
    const where = issue.sourceLocation?.status === 'KNOWN' ? `${issue.sourceLocation.file}:${issue.sourceLocation.line}` : (issue.sourceLocation?.status ?? 'UNKNOWN');
    const body = [`# ${title}`, '', `**Failure:** ${issue.summary}`, '', `**Where:** ${where} · **Kind:** ${issue.category} · **Signature:** ${issue.signature}`, '',
      `**Resolved by (verified):** ${issue.verification.evidence}`, '', `**Times it came back:** ${issue.recurrenceCount}`, '',
      'Reuse only after checking that a new failure has the same signature and the same check passes again.', ''].join('\n');
    const id = `lesson-${issue.signature.replace(/^sig-/, '')}`;
    const meta: NoteMeta = { jarvis_kind: 'memory', category: 'lessons', type: 'experience', created: new Date(this.now()).toISOString(), source: issue.issueId, signature: issue.signature };
    const rel = `04 Lessons Learned/${title}.md`;
    if (!st.ok) { this.vault.queue({ op: 'write', path: rel, content: body, meta, id }); return { status: 'queued', reason: st.detail }; }
    const existing = this.vault.listNotes(st.vault, `${BRAIN_ROOT}/04 Lessons Learned`).map((p) => this.vault.readAny(st.vault, p)).find((n) => n?.meta['jarvis_id'] === id);
    const target = existing ? existing.path.slice(BRAIN_ROOT.length + 1) : this.freePath(st.vault, rel);
    this.vault.writeManaged(st.vault, target, id, meta, body);
    this.op('lesson', target);
    return { status: existing ? 'updated' : 'saved', category: 'lessons', path: `${BRAIN_ROOT}/${target}`, reason: 'verified resolution' };
  }

  /** One line per task outcome in today's log (bounded). */
  noteTaskOutcome(input: string, outcome: 'success' | 'failed' | 'blocked', reason?: string): void {
    const now = this.now();
    const day = today(now);
    const rel = `07 Daily Logs/${day}.md`;
    const line = `- ${new Date(now).toISOString().slice(11, 16)} ${outcome === 'success' ? 'done' : outcome}: ${redact(input).replace(/\s+/g, ' ').slice(0, 120)}${reason ? ` — ${redact(reason).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
    const st = this.vault.state();
    if (!st.ok && st.reason === 'not_configured') return;
    if (!st.ok) { this.vault.queue({ op: 'append', path: rel, content: line, id: `daily-${day}` }); return; }
    this.appendLine(st.vault, rel, `daily-${day}`, `# ${day}`, line);
  }

  private appendLine(v: string, rel: string, id: string, heading: string, line: string): void {
    const existing = this.vault.readBrain(v, rel);
    const lines = existing?.managed ? existing.body.trimEnd().split('\n') : [heading, ''];
    if (lines.filter((l) => l.startsWith('- ')).length >= LIMITS.dailyLines) return;
    lines.push(line);
    this.vault.writeManaged(v, rel, id, { jarvis_kind: 'log', category: 'daily' }, lines.join('\n') + '\n');
  }

  /** JARVIS notes waiting in the Memory Inbox. */
  inboxCount(): number {
    const st = this.vault.state();
    return st.ok ? this.notesIn(st.vault, this.category('inbox')!.folder).filter((n) => n.managed).length : 0;
  }

  /** The most recent lesson notes. */
  lessons(k = 5): { path: string; title: string }[] {
    const st = this.vault.state();
    if (!st.ok) return [];
    return this.notesIn(st.vault, this.category('lessons')!.folder)
      .sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, k)
      .map((n) => ({ path: n.path, title: path.basename(n.path, '.md') }));
  }

  // ─── status and sync ────────────────────────────────────────────────────────

  status(): { connected: boolean; detail: string; initialized: boolean; categories: number; pending: number; lastDecision?: Decision } {
    const st = this.vault.state();
    const r = this.reg();
    return {
      connected: st.ok, detail: st.ok ? `connected to ${st.vault}` : st.detail, initialized: !!r.initializedAt,
      categories: this.categories().length, pending: this.vault.pending().length,
      ...(r.decisions.length ? { lastDecision: r.decisions[r.decisions.length - 1]! } : {}),
    };
  }

  /** Replay queued writes now that the vault is back. */
  sync(): { written: number; left: number; error?: string } {
    const res = this.vault.flushOutbox((e: OutboxEntry, v: string) => {
      if (e.op === 'append') { const day = e.path.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? ''; this.appendLine(v, e.path, e.id ?? `daily-${day}`, `# ${day}`, e.content); return; }
      const rel = this.vault.exists(v, e.path) && this.vault.readBrain(v, e.path)?.meta['jarvis_id'] !== e.id ? this.freePath(v, e.path) : e.path;
      this.vault.writeManaged(v, rel, e.id ?? contentId('mem', e.content), e.meta ?? { jarvis_kind: 'memory' }, e.content);
    });
    if (res.written) this.op('sync', `${res.written} queued write(s) applied, ${res.left} left`);
    return res;
  }

  /** For tests. */
  reset(): void { this.registry = null; this.searchCache.clear(); this.listing = null; }
}

/** True when the text holds a credential (never remembered as such: it is redacted). */
export function holdsSecret(text: string): boolean { return hasSecret(text); }

export const secondBrain = new SecondBrain();

/** Memory types for long-term fact sources; other sources (system, agent_failure, …) are not mirrored. */
const SOURCE_TYPES: Record<string, string | undefined> = {
  conversation: undefined, user: undefined, user_feedback: undefined, owner: undefined,
  lesson: 'experience', agents: 'knowledge', relation: 'knowledge',
};

/**
 * A long-term fact JARVIS decided to keep (memoryManager.rememberFact) is also
 * classified into the second brain, when a vault is configured. Only owner,
 * lesson, research and relation facts of importance 5 or more; never blocks
 * or fails the caller.
 */
export function ingestFact(fact: string, source: string, importance: number): void {
  if (!(source in SOURCE_TYPES) || importance < 5) return;
  if (!process.env['JARVIS_OBSIDIAN_VAULT']?.trim()) return;
  setImmediate(() => {
    try {
      const type = SOURCE_TYPES[source];
      secondBrain.remember({ text: fact, source, ...(type ? { type } : {}) });
    } catch (err) { console.warn('[SecondBrain] ⚠️ fact not filed:', (err as Error).message); }
  });
}

let started = false;
/**
 * At startup: initialize if a vault is configured, sync the outbox, keep
 * syncing periodically, and turn verified issue resolutions into lessons
 * (queued while the vault is away). Nothing at all when no vault is set.
 */
export function startSecondBrain(
  log: (s: string) => void = console.log,
  onResolved?: (fn: (issue: Parameters<SecondBrain['noteResolvedIssue']>[0]) => void) => void,
): void {
  if (started) return;
  const st = secondBrain.vault.state();
  if (!st.ok && st.reason === 'not_configured') return;
  started = true;
  onResolved?.((issue) => { try { secondBrain.noteResolvedIssue(issue); } catch (err) { log(`[SecondBrain] ⚠️ lesson not saved: ${(err as Error).message}`); } });
  if (!st.ok) log(`[SecondBrain] ⚠️ ${st.detail}; memories are queued until it is back.`);
  else {
    try {
      const init = secondBrain.initialize();
      log(`[SecondBrain] ${init.message}`);
      const s = secondBrain.sync();
      if (s.written || s.left) log(`[SecondBrain] Sync: ${s.written} queued write(s) applied, ${s.left} left.`);
    } catch (err) {
      log(`[SecondBrain] ⚠️ ${(err as Error).message}`);
    }
  }
  const timer = setInterval(() => {
    try {
      const was = secondBrain.status().initialized;
      if (!was && secondBrain.vault.state().ok) secondBrain.initialize();
      secondBrain.sync();
    } catch { /* reported by status */ }
  }, 15 * 60_000);
  timer.unref?.();
}
