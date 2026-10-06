/**
 * core/voiceSummaries.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What JARVIS says about an observation (P12): at most three short sentences.
 * The full result goes to the console; nothing here is read out as JSON.
 *
 * Page titles and window titles are other people's text: they are cut short,
 * stripped of anything but plain words, and never more than a few are read.
 */

/** Plain words only, at most `max` characters. */
function spoken(text: unknown, max = 40): string {
  const words = String(text ?? '').replace(/[^\p{L}\p{N}\s.,'&-]/gu, ' ').replace(/\s+/g, ' ').trim();
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
export function tabsSummary(tabs: Array<{ title?: string; url?: string; visible?: boolean; active?: boolean }>): string {
  if (!tabs.length) return 'No tab is open in the Chrome I can reach, sir.';
  const name = (t: { title?: string; url?: string }) => spoken(t.title) || hostOf(t.url) || 'an untitled tab';
  const shown = tabs.find((t) => t.visible ?? t.active);
  const others = tabs.filter((t) => t !== shown).map(name);
  const sentences = [`${tabs.length === 1 ? 'One tab is' : `${tabs.length} tabs are`} open, sir.`];
  if (shown) sentences.push(`On screen: ${name(shown)}.`);
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

/** How many sentences `text` has (for tests and checks). */
export function sentenceCount(text: string): number {
  return (text.match(/[.!?](\s|$)/g) ?? []).length;
}
