/**
 * perception/browserState.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What is open in the browser JARVIS can reach, and what a page says
 * (docs/upgrade/BROWSER_CONTROL.md): browser and version, windows, tabs, the
 * tab on screen, and — for one tab — its text or its structure.
 *
 * Read-only, through the fixed scripts in cdpScripts.ts. Page content is the
 * page's own text: callers hand it to the model as untrusted data.
 */

import { cdpPort, cdpVersion, evaluateFixed, listPages, withPage, type CdpTarget } from './cdpClient.js';
import { PAGE_STRUCTURE_SCRIPT, PAGE_TEXT_SCRIPT, VISIBILITY_SCRIPT } from './cdpScripts.js';
import { redact, redactDeep } from '../security/redactor.js';

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  visible: boolean;
  windowId?: number;
}

export interface BrowserStateReport {
  browser: string;
  protocol: string;
  windows: Array<{ windowId?: number; tabs: string[] }>;
  tabs: BrowserTab[];
  visibleTab?: BrowserTab;
}

const MAX_TABS = 20;
const PER_TAB_MS = 2_000;

async function tabDetails(target: CdpTarget, port: number): Promise<BrowserTab> {
  const tab: BrowserTab = { id: target.id, title: redact(target.title).slice(0, 200), url: redact(target.url).slice(0, 500), visible: false };
  try {
    await withPage(target, async (session) => {
      // The window comes from the browser, the visibility from the page: a
      // frozen page still gets its window.
      const [visibility, win] = await Promise.allSettled([
        evaluateFixed<string>(session, VISIBILITY_SCRIPT, PER_TAB_MS),
        session.send<{ windowId?: number }>('Browser.getWindowForTarget', { targetId: target.id }, PER_TAB_MS),
      ]);
      tab.visible = visibility.status === 'fulfilled' && visibility.value === 'visible';
      if (win.status === 'fulfilled' && typeof win.value.windowId === 'number') tab.windowId = win.value.windowId;
    }, port);
  } catch {
    // A tab that cannot be reached (closed meanwhile, crashed) is listed without details.
  }
  return tab;
}

export async function readBrowserState(port = cdpPort()): Promise<BrowserStateReport> {
  const version = await cdpVersion(port);
  const pages = (await listPages(port)).slice(0, MAX_TABS);
  const tabs = await Promise.all(pages.map((p) => tabDetails(p, port)));
  const windows = new Map<number | undefined, string[]>();
  for (const tab of tabs) windows.set(tab.windowId, [...(windows.get(tab.windowId) ?? []), tab.id]);
  return {
    browser: version.Browser,
    protocol: version['Protocol-Version'],
    windows: [...windows].map(([windowId, ids]) => ({ ...(windowId !== undefined ? { windowId } : {}), tabs: ids })),
    tabs,
    // /json/list lists the most recently active page first.
    visibleTab: tabs.find((t) => t.visible) ?? tabs[0],
  };
}

/** The tab a request means: by id, by words in its title or URL, or the one on screen. */
export async function findTab(query: string | undefined, port = cdpPort()): Promise<CdpTarget | undefined> {
  const pages = await listPages(port);
  const q = (query ?? '').trim().toLowerCase();
  if (!q) {
    const state = await readBrowserState(port);
    return pages.find((p) => p.id === state.visibleTab?.id) ?? pages[0];
  }
  return pages.find((p) => p.id === query)
    ?? pages.find((p) => p.title.toLowerCase().includes(q))
    ?? pages.find((p) => p.url.toLowerCase().includes(q));
}

export interface PageText { title: string; url: string; text: string; truncated: boolean }

export interface PageStructure {
  title: string;
  url: string;
  headings: Array<{ level: string; text: string; ref: string }>;
  links: Array<{ text: string; href: string; ref: string }>;
  buttons: Array<{ text: string; type: string; disabled: boolean; ref: string }>;
  forms: Array<{ action: string; method: string; ref: string; fields: Array<{ label: string; name: string; type: string; required: boolean; value?: string; ref: string }> }>;
  tables: Array<{ caption: string; header: string[]; rows: string[][]; totalRows: number; ref: string }>;
}

export async function readPageText(target: CdpTarget, port = cdpPort(), timeoutMs = 5_000): Promise<PageText> {
  return redactDeep(await withPage(target, (s) => evaluateFixed<PageText>(s, PAGE_TEXT_SCRIPT, timeoutMs), port));
}

export async function readPageStructure(target: CdpTarget, port = cdpPort(), timeoutMs = 5_000): Promise<PageStructure> {
  return redactDeep(await withPage(target, (s) => evaluateFixed<PageStructure>(s, PAGE_STRUCTURE_SCRIPT, timeoutMs), port));
}

/**
 * Page content for the model: JSON inside an untrusted wrapper. `<` and `>`
 * are escaped so that nothing in the page can close the wrapper; the JSON
 * stays valid.
 */
export function asUntrustedPage(value: unknown): string {
  const json = JSON.stringify(value, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<untrusted_context source="web-page">\n${json}\n</untrusted_context>`;
}
