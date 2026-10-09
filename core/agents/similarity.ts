/**
 * core/agents/similarity.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Word-overlap similarity for duplicate detection: is this task the same as
 * one already running or done, and is a child being handed its parent's whole
 * task (ReDel's guard, RECURSIVE_AGENT_RESEARCH.md §4.4)? No dependency; the
 * texts compared are short task descriptions.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'about',
  'is', 'are', 'be', 'it', 'its', 'this', 'that', 'these', 'those', 'please', 'jarvis', 'me', 'my',
  'find', 'get', 'give', 'show', 'tell', 'what', 'which', 'how', 'all', 'any', 'some',
]);

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, (u) => u.replace(/[?#].*$/, '').replace(/\/+$/, ''))
    .replace(/[^a-z0-9:/._\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function contentWords(text: string): Set<string> {
  // Numbers count, even one digit: "level 2" and "level 3" are different tasks.
  const words = normalizeText(text).split(' ').filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP_WORDS.has(w));
  return new Set(words.map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)));
}

/** Jaccard similarity of content words, 0–1. Identical normalized texts are 1. */
export function similarity(a: string, b: string): number {
  if (normalizeText(a) === normalizeText(b)) return 1;
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/** Key for "the same statement": case, punctuation and spacing ignored. */
export function statementKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A URL reduced to scheme-less host + path, for source de-duplication. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
    return `${host}${path}`;
  } catch {
    return normalizeText(url);
  }
}
