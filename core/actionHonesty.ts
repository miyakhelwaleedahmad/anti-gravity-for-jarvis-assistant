/**
 * core/actionHonesty.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A request to do something, answered after only read-only tools ran. On the
 * owner's PC (2026-10-28) "close youtube tab" ran browser_state alone (it
 * reads the tab list) and the reply model said "I have closed the YouTube tab
 * for you, sir." The tab was still open.
 *
 *   requestedAction  the verb, when the request starts with one that asks for
 *                    an action ("close …", "can you open …", "jarvis, delete
 *                    …"); questions ("is youtube open", "type of cpu?") give
 *                    undefined
 *   onlyLooks        a tool step that changes nothing: risk 0, or a network
 *                    lookup (web search, weather, GitHub reads)
 *   claimsAction     a reply that says the action was done
 *   NO_ACTION_NOTE   what the reply model is told when nothing acted
 *   noActionReply    what JARVIS says instead of a claim
 */

import type { ToolMeta } from './toolRegistryV2.js';

/** Wake word and polite openings before the verb. */
const OPENING = /^(?:(?:hey|ok|okay)\s+)?(?:jarvis[\s,.:!-]+)?(?:(?:please|kindly)\s+|(?:can|could|would|will) you(?: please)?\s+|i (?:want|need) you to\s+)*/;

/** Verbs that ask for an action, with their past forms where not regular. */
const ACTION_VERBS: Record<string, string> = {
  close: '', open: '', launch: '', start: '', kill: '', quit: 'quit', exit: '', end: '', delete: '', remove: '',
  rename: '', move: '', copy: 'copied', create: '', type: '', click: '', press: '', play: '', pause: '', resume: '',
  minimize: '', minimise: '', maximize: '', maximise: '', restore: '', restart: '', install: '', uninstall: '',
  send: 'sent', save: '', download: '', upload: '', refresh: '', reload: '', mute: '', unmute: '', submit: 'submitted',
};

export function requestedAction(input: string): string | undefined {
  const text = input.trim().toLowerCase();
  if (text.endsWith('?')) return undefined;
  const words = text.replace(OPENING, '').split(/\s+/);
  const verb = /^[a-z]+/.exec(words[0] ?? '')?.[0];
  if (!verb || !(verb in ACTION_VERBS)) return undefined;
  // "type of cpu …", "end of the month …": a noun, not a request.
  return words[1] === 'of' ? undefined : verb;
}

/** A step that changes nothing: it only reads, here or from a web service. */
export function onlyLooks(meta: ToolMeta | undefined, risk: number): boolean {
  if (risk === 0) return true;
  return meta?.category === 'NETWORK' && meta.external === 'query' && !meta.actions;
}

/** -ing forms that double the last letter. */
const DOUBLED: Record<string, string> = { quit: 'quitting', submit: 'submitting' };

function ingForm(verb: string): string {
  if (DOUBLED[verb]) return DOUBLED[verb]!;
  return /[^e]e$/.test(verb) ? `${verb.slice(0, -1)}ing` : `${verb}ing`;
}

function pastForm(verb: string): string {
  const irregular = ACTION_VERBS[verb];
  if (irregular) return irregular;
  if (verb.endsWith('e')) return `${verb}d`;
  if (/[^aeiou]y$/.test(verb)) return `${verb.slice(0, -1)}ied`;
  return `${verb}ed`;
}

const NEGATION = /\b(?:not|no|nothing|never|none|cannot|unable)\b|n't\b/;
/** Politeness that contains a negation word but negates nothing. */
const POLITE_NEGATION = /\b(?:no worries|no problem|not to worry)\b/g;

/**
 * Whether the reply says the action was done or is being done: a part of a
 * sentence with the verb's past form ("closed"), its -ing form ("closing
 * the tab now", "opening YouTube for you" — JARVIS's own wording for a
 * launch), "will / 'll / going to <verb>", "now open" for open, or "done",
 * "completed", "successfully", "all set", and no negation in that part ("no
 * worries" is not one). A reply that says what was found ("no YouTube tab is
 * open, so nothing was closed") is not a claim.
 */
export function claimsAction(reply: string, verb: string): boolean {
  const forms = [pastForm(verb), ingForm(verb), `(?:will|'ll|going to|about to) ${verb}`, 'done', 'completed', 'successfully', 'all set'];
  if (verb === 'open') forms.push('now open');
  const claim = new RegExp(`\\b(?:${forms.join('|')})\\b`);
  return reply.toLowerCase()
    .split(/[.;,:!?\n]|\b(?:but|and|so)\b/)
    .some((part) => claim.test(part) && !NEGATION.test(part.replace(POLITE_NEGATION, '')));
}

export const NO_ACTION_NOTE = 'Only read-only tools ran, so nothing was changed. Do not say that anything was done; say what the results show.';

/** `checked`: read-only tools ran (otherwise no tool ran at all). */
export function noActionReply(verb: string, checked = true): string {
  return checked ? `I didn't ${verb} anything, sir. I only checked what is there.` : `I didn't ${verb} anything, sir.`;
}
