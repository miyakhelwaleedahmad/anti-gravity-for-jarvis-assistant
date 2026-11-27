/**
 * core/voiceSummaries.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What JARVIS says about an observation (P12): at most three short sentences.
 * The full result goes to the console; nothing here is read out as JSON.
 *
 * Page titles and window titles are other people's text: they are cut short,
 * stripped of anything but plain words, and never more than a few are read.
 * Log lines and earlier requests (P13) have their credentials hidden first.
 */

import { redact } from '../security/redactor.js';

/** Plain words only, at most `max` characters. */
function spoken(text: unknown, max = 40): string {
  const words = String(text ?? '').replace(/\[REDACTED:[^\]]*\]/g, ' a hidden value ')
    .replace(/[^\p{L}\p{N}\s.,'&-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return words.length > max ? `${words.slice(0, max - 1).trim()}…` : words;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 tabs are open, sir. On screen: Shop. The others: Next and Price table." */
export function tabsSummary(tabs: Array<{ title?: string; url?: string; visible?: boolean; active?: boolean; error?: string }>): string {
  if (!tabs.length) return 'No tab is open in the Chrome I can reach, sir.';
  const name = (t: { title?: string; url?: string }) => spoken(t.title) || hostOf(t.url) || 'an untitled tab';
  const shown = tabs.find((t) => t.visible ?? t.active);
  const others = tabs.filter((t) => t !== shown).map(name);
  const sentences = [`${tabs.length === 1 ? 'One tab is' : `${tabs.length} tabs are`} open, sir.`];
  if (shown) sentences.push(`On screen: ${name(shown)}${shown.error ? ', which shows an error page' : ''}.`);
  if (others.length) {
    sentences.push(others.length <= 3 ? `${shown ? 'The others' : 'They are'}: ${list(others)}.` : `${shown ? 'Others include' : 'They include'} ${list(others.slice(0, 3))}.`);
  }
  return sentences.join(' ');
}

function hostOf(url: unknown): string {
  try { return new URL(String(url)).host; } catch { return ''; }
}

/** The background observer's state ("what is open"): active window, apps, tabs. */
export function systemStateSummary(state: any): string {
  const sentences: string[] = [];
  const active = spoken(state?.activeWindow?.title, 50);
  const apps: string[] = [...new Set<string>((state?.openApps ?? []).map((a: any) => spoken(a?.name, 24)).filter(Boolean))];
  if (active) sentences.push(`The active window is ${active}, sir.`);
  if (apps.length) sentences.push(`${plural(apps.length, 'app')} open: ${list(apps.slice(0, 5))}${apps.length > 5 ? ' and more' : ''}.`);
  const tabs = state?.chrome?.tabs ?? [];
  if (state?.chrome?.running || tabs.length) sentences.push(`Chrome has ${plural(tabs.length, 'tab')} open.`);
  return sentences.length ? sentences.slice(0, 3).join(' ') : 'I cannot see any open window or app from here, sir.';
}

/** "What's running": open apps and local servers, from real readings. */
export function runningSummary(apps: Array<{ name?: string }>, servers: string): string {
  const names: string[] = [...new Set<string>(apps.map((a) => spoken(a?.name, 24)).filter(Boolean))];
  const first = names.length ? `${plural(names.length, 'app')} open, sir: ${list(names.slice(0, 5))}${names.length > 5 ? ' and more' : ''}.` : '';
  return [first, servers].filter(Boolean).join(' ');
}

/**
 * A fault, a log line or a request as words that can be said: a hidden value
 * named as such, no brackets or symbols, no sentence break inside.
 */
export function sayable(text: unknown, max = 140): string {
  const s = redact(String(text ?? ''))
    .replace(/\[REDACTED:[^\]]*\]/g, ' a hidden value ')
    .replace(/[;:()[\]{}]/g, ', ')
    .replace(/[.!?]+(?=\s|$)/g, ',')
    .replace(/[^\p{L}\p{N}\s.,'&-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,[\s,]*/g, ', ')
    .replace(/^[\s,]+|[\s,]+$/g, '');
  return s.length > max ? `${s.slice(0, max - 1).trim()}…` : s;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface FaultLike { text: string; line?: string; note?: string; repairs?: unknown[] }
interface DiagnosisLike {
  faults?: FaultLike[];
  healthy?: string[];
  question?: string;
  tabs?: Array<{ id?: string; title?: string; error?: string; status?: number }>;
}

function faultSentence(f: FaultLike): string {
  return `${cap(sayable(f.text))}, sir${f.line ? `; its last line was: ${sayable(f.line, 100)}` : ''}.`;
}

function more(n: number): string {
  return n > 0 ? `There ${n === 1 ? 'is one more problem' : `are ${n} more problems`}; the console lists them.` : '';
}

/** What the diagnosis found, when JARVIS repairs nothing: at most three sentences. */
export function diagnosisSummary(d: DiagnosisLike): string {
  const faults = d.faults ?? [];
  if (!faults.length) {
    if (d.question) return d.question;
    return `I see no fault, sir: ${list((d.healthy ?? []).slice(0, 2).map((h) => sayable(h)))}. What looks wrong?`;
  }
  const first = faults[0]!;
  return [faultSentence(first), first.note ?? d.question ?? '', more(faults.length - 1)].filter(Boolean).slice(0, 3).join(' ');
}

/**
 * After repairs: the fault, what JARVIS did, and what it found when it
 * looked again (`after`, the second diagnosis) — or why it stopped.
 */
export function repairSummary(
  before: DiagnosisLike,
  done: string[],
  stop: { says: string; reason: string } | null,
  after: DiagnosisLike | null,
  reloadedTab?: string,
): string {
  const faults = before.faults ?? [];
  const first = faults.find((f) => f.repairs?.length) ?? faults[0];
  const opening = first ? faultSentence(first) : 'I found a problem, sir.';
  if (stop) {
    const tried = `${done.length ? `I ${list(done)}, then wanted to` : 'I wanted to'} ${sayable(stop.says)}`;
    return `${opening} ${tried}, but ${sayable(stop.reason, 160)}.`;
  }
  if (!after) return `${opening} I ${list(done)}, but I could not look again to check it.`;
  const left = after.faults ?? [];
  if (left.length) return `${opening} I ${list(done)}, but ${sayable(left[0]!.text)}.`;
  const tab = reloadedTab ? after.tabs?.find((t) => t.id === reloadedTab) : undefined;
  return `${opening} I ${list(done)}; it answers now${tab?.title ? `, and the tab shows ${sayable(tab.title, 40)}` : ''}.`;
}

/** Why a request did not finish, in words, from its goal. */
export function unfinishedReason(status: string, lastError?: string): string {
  const e = String(lastError ?? '');
  if (/not approved|APPROVAL_DENIED|did not approve|cancelled by user/i.test(e)) return 'it was not approved';
  if (/refused|blocked by safety|RISK_REFUSED|PERMISSION_DENIED/i.test(e)) return 'the safety policy refused a step';
  if (/interrupt|abort/i.test(e)) return 'it was interrupted';
  if (status === 'paused') return 'JARVIS was shut down before it finished';
  return e ? `it failed, ${sayable(e, 60)}` : 'it did not finish';
}

/** "Continue what I was doing", sure of it: the request, why it stopped, the offer. */
export function continueOffer(description: string, reason: string): string {
  return `Your last request, ${sayable(description, 80)}, was not finished, sir: ${reason}. Shall I try it again? Say yes or no.`;
}

/** "Continue what I was doing", not sure: what JARVIS knows, and a question. */
export function continueQuestion(last: { description: string; done: boolean } | undefined, onScreen?: string): string {
  const first = last?.done
    ? `Your last request, ${sayable(last.description, 80)}, is done, sir.`
    : 'I have no unfinished request to continue, sir.';
  return [first, onScreen ? `On screen is ${spoken(onScreen, 50)}.` : '', 'What would you like to continue?'].filter(Boolean).join(' ');
}

/** How many sentences `text` has (for tests and checks). */
export function sentenceCount(text: string): number {
  return (text.match(/[.!?](\s|$)/g) ?? []).length;
}
