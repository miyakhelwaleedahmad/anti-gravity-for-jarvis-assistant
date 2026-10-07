/**
 * control/uiRefs.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The element references of UI Automation (P14), kept apart from the code
 * that runs PowerShell so the risk engine can look them up.
 *
 * The model sees references such as `u12`. What each one stands for — the
 * window, the element's runtime id, its name and control type — stays here,
 * like the browser's references (perception/browserRefs.ts): an element can be
 * acted on only after JARVIS has looked at it, for 10 minutes.
 */

export interface UiElement {
  id: string;
  name: string;
  type: string;
  automationId: string;
  className: string;
  enabled: boolean;
  focused: boolean;
  password: boolean;
  offscreen: boolean;
  patterns: string[];
  value: string;
  depth: number;
}

export interface UiWindow { hwnd: string; title: string; process: string }

export interface UiRef {
  ref: string;
  /** The window, as decimal digits (what uia.ps1 takes). */
  hwnd: string;
  id: string;
  name: string;
  type: string;
  password: boolean;
  patterns: string[];
  windowTitle: string;
  process: string;
  /** The window's own words (its text elements), for what a dialog asks. */
  windowText: string;
  at: number;
}

export const UI_REF_MAX_AGE_MS = 10 * 60_000;

const refs = new Map<string, UiRef>();
let nextRef = 1;

/** Remember what was seen in `window`; a new look replaces its earlier references. */
export function rememberUi(window: UiWindow, elements: UiElement[], now = Date.now()): Array<UiElement & { ref: string }> {
  for (const [key, entry] of refs) if (entry.hwnd === window.hwnd) refs.delete(key);
  const windowText = elements.filter((e) => e.type === 'Text' && e.name).map((e) => e.name).join(' ').slice(0, 400);
  return elements.map((e) => {
    const ref = `u${nextRef++}`;
    refs.set(ref, {
      ref, hwnd: window.hwnd, id: e.id, name: e.name, type: e.type, password: e.password, patterns: e.patterns,
      windowTitle: window.title, process: window.process, windowText, at: now,
    });
    return { ...e, ref };
  });
}

/** What `ref` stands for, if JARVIS looked at it in the last 10 minutes. */
export function lookupUiRef(ref: unknown, now = Date.now()): UiRef | undefined {
  if (typeof ref !== 'string' || !/^u\d{1,9}$/.test(ref)) return undefined;
  const entry = refs.get(ref);
  if (!entry) return undefined;
  if (now - entry.at > UI_REF_MAX_AGE_MS) {
    refs.delete(ref);
    return undefined;
  }
  return entry;
}

/** "Button "OK" in Delete File (explorer)" — for approval requests. */
export function describeUiElement(e: UiRef): string {
  return `${e.type || 'element'} "${e.name.slice(0, 60)}" in ${e.windowTitle.slice(0, 60) || 'a window'}${e.process ? ` (${e.process})` : ''}`;
}
