/**
 * core/obsidianMirror.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A human-readable copy of each issue as a note in the owner's Obsidian vault
 * (self-healing architecture, Phase 2).
 *
 * JARVIS had no Obsidian integration (no code, plugin, MCP server or config;
 * only `.obsidian/` in .gitignore), so there was no existing write path to
 * reuse. This writes plain Markdown files into a vault folder, which is how
 * Obsidian stores notes; nothing else is needed.
 *
 *   off by default    JARVIS_OBSIDIAN_VAULT must name an existing Obsidian
 *                     vault (a folder holding .obsidian); never another folder
 *   its own folder    <vault>/JARVIS/01 Active Errors/<issueId>.md, and
 *                     <vault>/JARVIS/02 Resolved Errors/<issueId>.md once
 *                     resolved (the second brain's error spaces). A copy left
 *                     in the earlier JARVIS/Repairs folders is removed if ours.
 *   never clobbers    a file is overwritten or moved only if its frontmatter
 *                     carries this issue's `jarvis_issue_id`; any other file at
 *                     that path is left alone and the sync reported as a conflict
 *   atomic            written to a temporary file, then renamed
 *   honest            a failed write is reported as failed, never as synced
 *
 * The issue store (core/issueStore.ts) is the authority; a note is a mirror.
 */

import * as fs from 'fs';
import * as path from 'path';
import { redact } from '../security/redactor.js';
import type { Issue } from './issueStore.js';

export interface MirrorResult {
  syncStatus: 'disabled' | 'synced' | 'conflict' | 'failed';
  /** Vault-relative path of the note. */
  path?: string;
  error?: string;
  at?: string;
}

const ACTIVE = path.join('JARVIS', '01 Active Errors');
const RESOLVED = path.join('JARVIS', '02 Resolved Errors');
/** Where earlier versions wrote the same notes. */
const LEGACY = [path.join('JARVIS', 'Repairs'), path.join('JARVIS', 'Repairs', 'Resolved')];

export function vaultDir(): string | undefined {
  const v = process.env['JARVIS_OBSIDIAN_VAULT']?.trim();
  return v ? path.resolve(v) : undefined;
}

function notePath(issue: Issue): string {
  if (!/^iss-[0-9a-f]{12}$/.test(issue.issueId)) throw new Error(`unexpected issue id ${issue.issueId}`);
  return path.join(issue.status === 'RESOLVED' ? RESOLVED : ACTIVE, `${issue.issueId}.md`);
}

/** True when the nearest existing folder of `target` is really outside the vault (a link or junction out). */
function leavesVault(vault: string, target: string): boolean {
  let probe = path.dirname(target);
  while (!fs.existsSync(probe) && probe.length > vault.length) probe = path.dirname(probe);
  try {
    const r = path.relative(fs.realpathSync(vault), fs.realpathSync(probe));
    return r.startsWith('..') || path.isAbsolute(r);
  } catch { return true; }
}

/** True if the file is missing or is this issue's own note. */
function ownsOrMissing(file: string, issueId: string): boolean {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return true; }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  return new RegExp(`^jarvis_issue_id: ${issueId}\\r?$`, 'm').test(front);
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

export function renderNote(issue: Issue): string {
  const loc = issue.sourceLocation;
  const where = loc.status === 'KNOWN'
    ? `\`${loc.file}:${loc.line}${loc.column !== undefined ? `:${loc.column}` : ''}\`${loc.symbol ? ` in \`${loc.symbol}\`` : ''} (commit \`${loc.commit}\`)`
    : `${loc.status}: ${loc.reason ?? 'not stated'}`;
  const lines = [
    '---',
    `jarvis_issue_id: ${issue.issueId}`,
    'jarvis_managed: true',
    `jarvis_id: ${issue.issueId}`,
    'jarvis_kind: error',
    'jarvis_record: repair-issue',
    'schema_version: 1',
    `status: ${issue.status}`,
    `signature: ${issue.signature}`,
    `category: ${issue.category}`,
    `severity: ${issue.severity}`,
    `component: ${yamlString(issue.component)}`,
    `first_seen: ${issue.firstSeen}`,
    `last_seen: ${issue.lastSeen}`,
    `occurrences: ${issue.occurrenceCount}`,
    `recurrences: ${issue.recurrenceCount}`,
    ...(issue.resolvedAt ? [`resolved_at: ${issue.resolvedAt}`] : []),
    'tags: [jarvis/repair]',
    '---',
    '',
    `# ${issue.status === 'RESOLVED' ? 'Resolved' : 'Open'}: ${issue.component}`,
    '',
    '> Written by JARVIS from its issue record (data/repairs/issues.json, the authority). Edits here are overwritten.',
    '',
    `**Summary:** ${issue.summary}`,
    '',
    `**Where:** ${where}`,
    '',
    `**Pipeline:** ${issue.pipeline ?? 'none'} · **Tool:** ${issue.tool ?? 'none'}`,
    '',
    ...(issue.blockedReason ? [`**Blocked:** ${issue.blockedReason}`, ''] : []),
    ...(issue.nextAction ? [`**Next action:** ${issue.nextAction}`, ''] : []),
    ...(issue.verification ? [`**Verification (${issue.verification.passed ? 'passed' : 'failed'}, ${issue.verification.at}):** ${issue.verification.evidence}`, ''] : []),
    '## Diagnosis',
    '',
    `- Confidence: ${issue.diagnosis.confidence}; reproduced: ${issue.diagnosis.reproduced}`,
    ...issue.diagnosis.facts.map((f) => `- Fact: ${f}`),
    ...issue.diagnosis.hypotheses.map((h) => `- Hypothesis: ${h}`),
    '',
    '## Recent occurrences',
    '',
    '| Time | Correlation | Location | Message |',
    '|---|---|---|---|',
    ...issue.recent.slice(-10).map((o) => {
      const l = o.source.status === 'KNOWN' ? `${o.source.file}:${o.source.line}` : o.source.status;
      return `| ${o.at} | ${o.correlationId} | ${l} | ${o.message.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160)} |`;
    }),
    '',
    '## History',
    '',
    ...issue.history.slice(-20).map((h) => `- ${h.at}: ${h.from ?? 'new'} → ${h.to} (${h.reason})`),
    '',
  ];
  return redact(lines.join('\n'));
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Write (or move) the issue's note. Never throws for an expected problem; reports it. */
export function mirrorIssue(issue: Issue, vault = vaultDir()): MirrorResult {
  if (!vault) return { syncStatus: 'disabled' };
  const at = new Date().toISOString();
  let rel: string;
  try { rel = notePath(issue); } catch (err) { return { syncStatus: 'failed', error: (err as Error).message, at }; }
  try {
    if (!fs.statSync(vault).isDirectory()) return { syncStatus: 'failed', path: rel, error: 'JARVIS_OBSIDIAN_VAULT is not a folder', at };
  } catch {
    return { syncStatus: 'failed', path: rel, error: 'the JARVIS_OBSIDIAN_VAULT folder does not exist', at };
  }
  if (!fs.existsSync(path.join(vault, '.obsidian'))) return { syncStatus: 'failed', path: rel, error: 'JARVIS_OBSIDIAN_VAULT has no .obsidian folder, so it is not an Obsidian vault', at };
  const target = path.join(vault, rel);
  if (leavesVault(vault, target)) return { syncStatus: 'failed', path: rel, error: 'the JARVIS folder links out of the vault; nothing was written', at };
  if (!ownsOrMissing(target, issue.issueId)) {
    return { syncStatus: 'conflict', path: rel, error: 'a note JARVIS did not write is at this path; it was left unchanged', at };
  }
  try {
    writeAtomic(target, renderNote(issue));
  } catch (err) {
    return { syncStatus: 'failed', path: rel, error: (err as Error).message, at };
  }
  // The note moved folders (resolved, reopened, or from the earlier location): remove the old copy, if it is ours.
  for (const dir of [issue.status === 'RESOLVED' ? ACTIVE : RESOLVED, ...LEGACY]) {
    const other = path.join(vault, dir, `${issue.issueId}.md`);
    if (fs.existsSync(other) && ownsOrMissing(other, issue.issueId)) {
      try { fs.unlinkSync(other); } catch { /* the new note is written; a stale copy is harmless */ }
    }
  }
  return { syncStatus: 'synced', path: rel.split(path.sep).join('/'), at };
}
