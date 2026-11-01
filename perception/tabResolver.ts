/**
 * perception/tabResolver.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Which tab a request means: the one finder for every tab tool (phase A4,
 * TRA-01, TRA-02, TRA-11; owner decision Q1 of 2026-11-01).
 *
 *   - a tab id: that tab;
 *   - a name: the tabs whose title or address contains it. One → that tab;
 *     several → the one on screen if it is among them, else a question;
 *   - no name: the tab on screen; none on screen (Chrome minimised) → a
 *     question, never "the first listed".
 *
 * An empty name never matches every tab. Read-only.
 */

import { listPages, type CdpTarget } from './cdpClient.js';
import { redact } from '../security/redactor.js';

export type TabChoice =
  | { kind: 'one'; tab: CdpTarget }
  | { kind: 'none'; reason: string }
  | { kind: 'ask'; question: string; tabs: CdpTarget[] };

/** A question about which tab, thrown where a tool cannot ask itself. */
export class TabQuestion extends Error {
  constructor(question: string, readonly tabs: CdpTarget[]) {
    super(question);
    this.name = 'TabQuestion';
  }
}

const MAX_NAMED = 3;
/** Short enough for JARVIS to say after a failed route (core/orchestrator.ts keeps reasons up to 120 characters). */
const MAX_QUESTION = 118;

/** Page titles are the page's own text: redacted, no angle brackets (review R10). */
function short(text: string, max: number): string {
  const t = redact(text).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** "Which tab, sir? 2 match "youtube": "YouTube", "lofi beats - YouTube"." within MAX_QUESTION. */
function whichQuestion(lead: string, tabs: CdpTarget[]): string {
  for (let width = 40; width >= 8; width -= 4) {
    const named = tabs.slice(0, MAX_NAMED).map((t) => `"${short(t.title || t.url, width)}"`);
    const more = tabs.length > MAX_NAMED ? ` and ${tabs.length - MAX_NAMED} more` : '';
    const q = `${lead}: ${named.join(', ')}${more}.`;
    if (q.length <= MAX_QUESTION) return q;
  }
  return short(`${lead}.`, MAX_QUESTION);
}

/**
 * The tabs on screen among these, by asking each page
 * (document.visibilityState). Not "the first listed": with Chrome minimised
 * none is visible; with two windows two can be (review R5).
 */
async function visibleAmong(tabs: CdpTarget[], port: number): Promise<CdpTarget[]> {
  const { readBrowserState } = await import('./browserState.js');
  const state = await readBrowserState(port);
  const visible = new Set(state.tabs.filter((t) => t.visible).map((t) => t.id));
  return tabs.filter((t) => visible.has(t.id));
}

export async function resolveTab(name: string | undefined, port: number): Promise<TabChoice> {
  const pages = await listPages(port);
  const q = (name ?? '').trim();
  if (!q) {
    if (pages.length === 0) return { kind: 'none', reason: 'No tab is open in JARVIS\'s Chrome.' };
    const onScreen = await visibleAmong(pages, port);
    if (onScreen.length === 1) return { kind: 'one', tab: onScreen[0]! };
    if (onScreen.length > 1) return { kind: 'ask', tabs: onScreen, question: whichQuestion(`Which tab, sir? ${onScreen.length} are on screen`, onScreen) };
    return { kind: 'ask', tabs: pages, question: whichQuestion('No tab is on screen (is Chrome minimised?). Which tab, sir', pages) };
  }
  const byId = pages.find((p) => p.id === q);
  if (byId) return { kind: 'one', tab: byId };
  const lower = q.toLowerCase();
  const matches = pages.filter((p) => p.title.toLowerCase().includes(lower) || p.url.toLowerCase().includes(lower));
  if (matches.length === 0) return { kind: 'none', reason: `No open tab matches "${short(q, 60)}".` };
  if (matches.length === 1) return { kind: 'one', tab: matches[0]! };
  const onScreen = await visibleAmong(matches, port);
  if (onScreen.length === 1) return { kind: 'one', tab: onScreen[0]! };
  return { kind: 'ask', tabs: matches, question: whichQuestion(`Which tab, sir? ${matches.length} match "${short(q, 20)}"`, matches) };
}

/** The tab, or a TabQuestion; undefined when none matches. */
export async function resolveTabOrAsk(name: string | undefined, port: number): Promise<CdpTarget | undefined> {
  const choice = await resolveTab(name, port);
  if (choice.kind === 'ask') throw new TabQuestion(choice.question, choice.tabs);
  return choice.kind === 'one' ? choice.tab : undefined;
}
