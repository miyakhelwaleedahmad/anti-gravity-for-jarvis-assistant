/**
 * perception/browserRefs.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The page elements JARVIS has looked at (docs/upgrade/BROWSER_CONTROL.md).
 *
 * browser_page_structure gives each element it reports a short reference
 * ("e12"). A browser action takes such a reference — never a selector or a
 * position — so it can act only on an element JARVIS has seen. The risk
 * engine reads what the element is (a submit button, a password field) from
 * here, synchronously, before anything runs; the action then checks in the
 * page that the element is still the same one.
 *
 * A new look at a tab replaces its earlier references. References expire
 * after 10 minutes. Nothing here is written to disk.
 */

export type ElementKind = 'link' | 'button' | 'field' | 'heading' | 'table' | 'form';

export interface ElementInfo {
  kind: ElementKind;
  /** CSS path, computed in the page. Internal: never shown to the model. */
  css: string;
  /** What the element was (kind, tag, type, name, id, label, flags). */
  fp: string;
  label: string;
  tag: string;
  /** Field type (text, search, password, select-one, file, contenteditable…). */
  type?: string;
  href?: string;
  /** A link with a `download` attribute. */
  download?: boolean;
  /** A button that submits its form. */
  submits?: boolean;
  /** In a form that has a password field. */
  passwordForm?: boolean;
  inForm?: boolean;
  /** A password, card or one-time-code field. */
  credential?: boolean;
  search?: boolean;
}

export interface ObservedElement extends ElementInfo {
  ref: string;
  tabId: string;
  /** The page's address when it was looked at. */
  pageUrl: string;
  observedAt: number;
}

export const REF_MAX_AGE_MS = 10 * 60_000;
const MAX_REFS = 2_000;

let counter = 0;
const byRef = new Map<string, ObservedElement>();

/** Records one look at a tab: its earlier references go, these get new ones. */
export function rememberElements(tabId: string, pageUrl: string, elements: ElementInfo[], now = Date.now()): ObservedElement[] {
  forgetTab(tabId);
  const observed = elements.map((info) => {
    const element: ObservedElement = { ...info, ref: `e${++counter}`, tabId, pageUrl, observedAt: now };
    byRef.set(element.ref, element);
    return element;
  });
  // Oldest first in a Map: drop the oldest beyond the cap.
  for (const ref of byRef.keys()) {
    if (byRef.size <= MAX_REFS) break;
    byRef.delete(ref);
  }
  return observed;
}

/** The element `ref` names, if it was seen less than 10 minutes ago. */
export function lookupRef(ref: unknown, now = Date.now()): ObservedElement | undefined {
  if (typeof ref !== 'string') return undefined;
  const element = byRef.get(ref.trim());
  if (!element) return undefined;
  if (now - element.observedAt > REF_MAX_AGE_MS) {
    byRef.delete(element.ref);
    return undefined;
  }
  return element;
}

export function forgetTab(tabId: string): void {
  for (const [ref, element] of byRef) if (element.tabId === tabId) byRef.delete(ref);
}

/** How an approval request or a reply names the element: kind, label, site. */
export function describeElement(element: Pick<ObservedElement, 'kind' | 'label' | 'type' | 'pageUrl'>): string {
  let site = '';
  try { site = new URL(element.pageUrl).host; } catch { /* not a URL */ }
  const what = element.kind === 'field' ? `${element.type ?? 'text'} field` : element.kind;
  const label = element.label.replace(/[<>"]/g, '').slice(0, 60);
  return `${what}${label ? ` "${label}"` : ''}${site ? ` on ${site}` : ''}`;
}
