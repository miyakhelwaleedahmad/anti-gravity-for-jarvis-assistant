/**
 * core/tools/secondBrainTool.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "memory_brain": the owner's commands for JARVIS's second brain in the
 * Obsidian vault (memory/secondBrain.ts) and its error history (the issue
 * store, which stays the authority for errors).
 *
 *   status          check the memory connection (risk 0)
 *   search          search the vault, the owner's notes included (risk 0)
 *   find_error      the last time an error happened (risk 0)
 *   lessons         what was learned from previous failures (risk 0)
 *   unresolved      open errors (risk 0)
 *   init            initialize the second brain (risk 1)
 *   organize        organize memory: inbox review, new spaces, merges (risk 1)
 *   review_inbox    the same, reporting what is still in the inbox (risk 1)
 *   remember        keep an item, classified (risk 1)
 *   remember_preference  keep a preference (risk 1)
 *   create_space    a new memory space for a subject (risk 1)
 *
 * Writes go only to JARVIS-managed notes under <vault>/JARVIS; vault text
 * returned to a model is wrapped as data.
 */

import type { AgentTool } from '../toolRegistryV2.js';
import { issueStore, type Issue } from '../issueStore.js';
import { secondBrain, terms } from '../../memory/secondBrain.js';
import { untrusted } from '../../security/untrustedText.js';
import { hasSecret } from '../../security/redactor.js';

export const MEMORY_BRAIN_ACTIONS = ['status', 'search', 'find_error', 'lessons', 'unresolved', 'init', 'organize', 'review_inbox', 'remember', 'remember_preference', 'create_space'] as const;

/** `refused`: bad input or a policy refusal, not a fault (the health ledger and issue record skip it). */
type Result = { success: boolean; action: string; message: string; refused?: boolean; [k: string]: unknown };

/** createCategory's own refusals (name, overlap, limits), as opposed to a failure to write. */
const SPACE_REFUSAL = /not a clear space name|not a usable name|already exists|overlaps|limit of|new spaces today/;

function where(i: Issue): string {
  const l = i.sourceLocation;
  return l.status === 'KNOWN' ? `${l.file}:${l.line}${l.column !== undefined ? `:${l.column}` : ''}` : 'location unknown';
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `on ${iso.slice(0, 10)}`;
}

/** Issues (open and closed) whose text shares words with the query, best first; the latest when no query. */
export function findIssues(query: string, limit = 5): Issue[] {
  const all = issueStore.all();
  const q = terms(query);
  if (!q.length) return all.slice(0, limit);
  return all
    .map((i) => {
      const hay = [i.summary, i.component, i.signature, i.normalized, i.tool ?? '', i.sourceLocation.file ?? '', i.category].join(' ').toLowerCase();
      return { i, score: q.filter((t) => hay.includes(t)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.i.lastSeen.localeCompare(a.i.lastSeen))
    .slice(0, limit)
    .map((x) => x.i);
}

function notAvailable(action: string): Result | undefined {
  const st = secondBrain.vault.state();
  return st.ok ? undefined : { success: false, action, message: `My second brain is not available, sir: ${st.detail}.`, ...(st.reason === 'not_configured' ? { refused: true } : {}) };
}

export async function runMemoryBrain(action: string, value: string): Promise<Result> {
  switch (action) {
    case 'status': {
      const s = secondBrain.status();
      const msg = s.connected
        ? `My second brain is connected, sir: ${s.categories} memory spaces${s.initialized ? '' : ', not initialized yet'}${s.pending ? `, ${s.pending} queued write(s) waiting` : ''}.`
        : `My second brain is not connected, sir: ${s.detail}.${s.pending ? ` ${s.pending} write(s) are queued until it is back.` : ''}`;
      return { success: s.connected, action, message: msg, status: s };
    }
    case 'init': {
      const r = secondBrain.initialize();
      return { success: r.ok, action, message: `${r.message.replace(/\.$/, '')}, sir.`, created: r.created, migrated: r.migrated };
    }
    case 'organize':
    case 'review_inbox': {
      const r = secondBrain.organize();
      if (!r.ok) return { success: false, action, message: `${r.message.replace(/\.$/, '')}, sir.` };
      const left = secondBrain.inboxCount();
      return { success: true, action, message: `${r.message.replace(/\.$/, '')}; ${left} item${left === 1 ? '' : 's'} still in the Memory Inbox, sir.`, moved: r.moved, created: r.created, merged: r.merged, inbox: left };
    }
    case 'remember':
    case 'remember_preference': {
      if (!value.trim()) return { success: false, action, message: 'What should I remember, sir?', refused: true };
      if (hasSecret(value)) return { success: false, action, message: "I don't keep passwords, keys or tokens in my notes, sir.", refused: true };
      const r = secondBrain.remember({ text: value, explicit: true, source: 'owner', ...(action === 'remember_preference' ? { type: 'preference' } : {}) });
      const space = r.category ? secondBrain.category(r.category)?.title ?? r.category : '';
      const msg = r.status === 'saved' ? `Noted in ${space}, sir.${r.newCategory ? ` I started a new memory space for it: ${r.newCategory}.` : ''}`
        : r.status === 'updated' ? `I already had that, sir; I updated the note in ${space}.`
        : r.status === 'queued' ? `My vault is not reachable, sir, so I queued it; it is filed when the vault is back.`
        : `I did not keep that, sir: ${r.reason}.`;
      return { success: r.status !== 'skipped', action, message: msg, result: r, ...(r.status === 'skipped' ? { refused: true } : {}) };
    }
    case 'create_space': {
      const na = notAvailable(action);
      if (na) return na;
      const title = value.trim().replace(/^(for|about|on)\s+/i, '');
      if (!title) return { success: false, action, message: 'What subject should the new space be for, sir?', refused: true };
      try {
        const c = secondBrain.createCategory(title, { origin: 'requested', reason: 'asked by the owner', keywords: terms(title) });
        return { success: true, action, message: `Created the memory space ${c.folder}, sir.`, folder: c.folder };
      } catch (err) {
        const why = (err as Error).message;
        return { success: false, action, message: `I did not create it, sir: ${why}.`, ...(SPACE_REFUSAL.test(why) ? { refused: true } : {}) };
      }
    }
    case 'search': {
      const na = notAvailable(action);
      if (na) return na;
      const hits = secondBrain.search(value, 5);
      if (!hits.length) return { success: true, action, message: `Nothing in my notes matches that, sir.`, hits: [] };
      const lines = hits.map((h) => `- ${h.title} (${h.path}): ${h.snippet}`).join('\n');
      return { success: true, action, message: `I found ${hits.length} note${hits.length === 1 ? '' : 's'}, sir; the best is "${hits[0]!.title}".`, notes: untrusted('second_brain:obsidian', lines, 2_000) };
    }
    case 'find_error': {
      const found = findIssues(value, 3);
      if (!found.length) return { success: true, action, message: value.trim() ? `I have no record of an error like that, sir.` : 'I have no errors on record, sir.' };
      const i = found[0]!;
      const fix = i.status === 'RESOLVED' && i.verification?.passed ? ` It was resolved, verified by: ${i.verification.evidence}.` : ` It is ${i.status.toLowerCase()}.`;
      return {
        success: true, action,
        message: `The last time was ${ago(i.lastSeen)}, sir: ${i.summary} in ${i.component} (${where(i)}), ${i.occurrenceCount} occurrence${i.occurrenceCount === 1 ? '' : 's'}${i.recurrenceCount ? `, came back ${i.recurrenceCount} time${i.recurrenceCount === 1 ? '' : 's'}` : ''}.${fix}`,
        issues: found.map((x) => ({ issueId: x.issueId, status: x.status, lastSeen: x.lastSeen, component: x.component, where: where(x) })),
      };
    }
    case 'lessons': {
      const resolved = issueStore.all().filter((i) => i.status === 'RESOLVED' && i.verification?.passed).slice(0, 5);
      const notes = secondBrain.vault.state().ok ? secondBrain.lessons(5) : [];
      if (!resolved.length && !notes.length) return { success: true, action, message: 'I have no verified lessons from failures yet, sir.' };
      const parts = resolved.slice(0, 3).map((i) => `${i.component}: ${i.summary.slice(0, 80)} — fixed and verified by ${i.verification!.evidence.slice(0, 80)}`);
      return {
        success: true, action,
        message: `From ${resolved.length} verified fix${resolved.length === 1 ? '' : 'es'}${notes.length ? ` and ${notes.length} lesson note${notes.length === 1 ? '' : 's'}` : ''}, sir: ${parts.join('; ') || notes.map((n) => n.title).join('; ')}.`,
        lessonNotes: notes.map((n) => n.path),
      };
    }
    case 'unresolved': {
      const open = issueStore.active();
      if (!open.length) return { success: true, action, message: 'There are no unresolved errors, sir.', issues: [] };
      const top = open.slice(0, 3).map((i) => `${i.component}: ${i.summary.slice(0, 70)} (${i.status.toLowerCase()}, last ${ago(i.lastSeen)})`);
      return { success: true, action, message: `${open.length} unresolved error${open.length === 1 ? '' : 's'}, sir. ${top.join('; ')}.`, issues: open.slice(0, 10).map((i) => ({ issueId: i.issueId, status: i.status, component: i.component, where: where(i) })) };
    }
    default:
      return { success: false, action, message: `Unknown action "${action}". Use one of: ${MEMORY_BRAIN_ACTIONS.join(', ')}.`, refused: true };
  }
}

export const secondBrainTool: AgentTool = {
  name: 'memory_brain',
  description:
    'JARVIS\'s second brain in the owner\'s Obsidian vault and its error history. Use when the user asks to initialize or organize '
    + 'its memory, review the Memory Inbox, remember an item or a preference in its notes, create a new memory space for a subject, '
    + 'search its notes, find the last time an error happened, say what it learned from previous failures, list unresolved errors, '
    + 'or check its memory connection. Parameters: action (one of: ' + MEMORY_BRAIN_ACTIONS.join(', ') + '), value (the text, query or subject).',
  riskLevel: 'low',
  inputSchema: {
    action: { type: 'string', description: MEMORY_BRAIN_ACTIONS.join(', '), required: true, enum: [...MEMORY_BRAIN_ACTIONS] },
    value: { type: 'string', description: 'What to remember, search for, or the subject of a new space', required: false },
  },
  fallbacks: [],
  async execute(args) {
    const action = String(args['action'] ?? '');
    const value = typeof args['value'] === 'string' ? args['value'] : '';
    return JSON.stringify(await runMemoryBrain(action, value));
  },
};
