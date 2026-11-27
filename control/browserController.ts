/**
 * control/browserController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Controls browser tabs using the Chrome DevTools Protocol (CDP) HTTP API.
 * Supports opening, closing, focusing, and listing tabs, and integrates safety approvals.
 */

import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';
import { rollbackManager } from './rollbackManager.js';
import { activateTab, closeTabById, listPages, openTab } from '../perception/cdpClient.js';
import { chromeStartHint } from '../perception/chromeProfile.js';
import { resolveTab, resolveTabOrAsk } from '../perception/tabResolver.js';
import { withoutApproval } from '../security/approvalScope.js';
import { checkTabClose } from './tabClose.js';
import { checkedChromePort, closeTabKeepingChrome, jarvisChrome, type JarvisChrome } from './jarvisChrome.js';

// Phase A4: every tab action goes to JARVIS's checked Chrome (no stale
// profile port, no 9222 guess), finds its tab with the one finder in
// perception/tabResolver.ts, and never presses Ctrl+W / Ctrl+R into whatever
// browser window is in front when that Chrome does not answer.

export interface CDPTab {
  id: string;
  title: string;
  url: string;
  type: string;
}

export interface BrowserControllerDeps {
  chrome: JarvisChrome;
  approve: (title: string, command: string) => Promise<boolean>;
}

const DEFAULT_DEPS: BrowserControllerDeps = {
  chrome: jarvisChrome,
  approve: (title, command) => approvalGate.requestApproval(title, command),
};

export class BrowserController {
  constructor(private readonly deps: BrowserControllerDeps = DEFAULT_DEPS) {}

  private getInstruction(): string {
    return chromeStartHint();
  }

  /** JARVIS's checked Chrome; it says why when there is none. */
  private port(): Promise<number> {
    return checkedChromePort(this.deps.chrome);
  }

  private async fetchCDPTabs(): Promise<CDPTab[]> {
    const port = await this.port();
    try {
      return await listPages(port);
    } catch {
      throw new Error(`Chrome DevTools endpoint unavailable.\n${this.getInstruction()}`);
    }
  }

  public async listTabs(): Promise<string> {
    // A failure is thrown, never returned as text (A5c, TRA-10).
    if (!permissionSession.checkPermission(0, 'List browser tabs')) {
      throw new Error('Permission denied.');
    }
    const tabs = await this.fetchCDPTabs();
    const pageTabs = tabs.filter(t => t.type === 'page').map(t => ({ title: t.title, url: t.url }));
    return JSON.stringify(pageTabs, null, 2);
  }

  /** The one tab a name means; null when none does, or when it is not clear which (several, none on screen). */
  public async findTab(query: string): Promise<CDPTab | null> {
    try {
      const choice = await resolveTab(query, await this.port());
      return choice.kind === 'one' ? choice.tab : null;
    } catch {
      return null;
    }
  }

  /** Some tab's title or address contains the name; an empty name is no tab. */
  public async isTabOpen(query: string): Promise<boolean> {
    const lower = query.toLowerCase().trim();
    if (!lower) return false;
    try {
      const tabs = await this.fetchCDPTabs();
      return tabs.some((t) => t.id === query.trim() || t.title.toLowerCase().includes(lower) || t.url.toLowerCase().includes(lower));
    } catch {
      return false;
    }
  }

  public async focusTab(query: string): Promise<string> {
    if (!permissionSession.checkPermission(1, `Focus tab: ${query}`)) {
      throw new Error('Permission denied.');
    }

    const port = await this.port();
    const tab = await resolveTabOrAsk(query, port);
    if (!tab) {
      throw new Error(`Browser tab matching "${query}" not found.`);
    }

    await activateTab(tab.id, port);
    return `Focused tab: "${tab.title}" (tab ${tab.id})`;
  }

  public async closeTab(query: string): Promise<string> {
    // A first check from the words, before Chrome is read: "youtube" or
    // "about:blank" may be level 1, anything else (an empty name, the tab on
    // screen, included) needs level 2. The tab that is found decides again
    // (control/tabClose.ts): "youtube" can match a Google sign-in page.
    const youTubeOrBlank = /youtube/i.test(query) || query.trim().toLowerCase() === 'about:blank';
    const requiredLevel = youTubeOrBlank ? 1 : 2;

    if (!permissionSession.checkPermission(requiredLevel, `Close tab: ${query}`)) {
      throw new Error(`Permission level ${requiredLevel} required to close tab.`);
    }

    const port = await this.port();
    // Several matches and none on screen, or no tab on screen: a question (owner, Q1).
    const tab = await resolveTabOrAsk(query, port);
    if (!tab) {
      // Nothing was closed: a failure, not a done action (owner, A5c Q1).
      throw new Error(`Tab matching "${query}" is not open, so nothing was closed.`);
    }

    // The same rule as browser_tab: the level of the tab found, and a question
    // for a sensitive tab (GitHub, Antigravity).
    await checkTabClose(tab);

    // The last tab: a blank one is opened first, so JARVIS's Chrome stays open (owner, Q4).
    await closeTabKeepingChrome(tab.id, port);

    // A way to reopen it, once it is closed (not before: a failed close left a reopen of an open tab).
    const urlToReopen = tab.url;
    rollbackManager.register('close_tab', `Reopen closed tab: ${urlToReopen}`, async () => {
      await this.openUrl(urlToReopen);
      return true;
    });
    return `Closed tab: "${tab.title}" (tab ${tab.id})`;
  }

  public async closeActiveTab(): Promise<string> {
    // The tab on screen (not the first in the list), closed by its id; with
    // none on screen, a question. Chrome not answering: said, nothing pressed.
    const tab = await resolveTabOrAsk('', await this.port());
    if (!tab) throw new Error('No tab is open in JARVIS\'s Chrome.');
    return this.closeTab(tab.id);
  }

  public async openUrl(url: string): Promise<string> {
    if (!permissionSession.checkPermission(1, `Open URL: ${url}`)) {
      throw new Error('Permission denied.');
    }

    let finalUrl = url;
    if (!/^https?:\/\//i.test(url)) {
      finalUrl = `https://${url}`;
    }

    // In JARVIS's own Chrome, started if needed; never the default browser
    // (the everyday Chrome, which JARVIS cannot see: D1, TRA-03).
    const port = await this.deps.chrome.ensure();
    const newTab = await openTab(finalUrl, port);
    await activateTab(newTab.id, port);

    rollbackManager.register('open_url', `Close opened tab: ${finalUrl}`, async () => {
      await closeTabById(newTab.id, port);
      return true;
    });

    return `Opened URL: ${finalUrl} (tab ${newTab.id})`;
  }

  /**
   * Closes JARVIS's own Chrome, after asking every time (D3). The owner's
   * everyday Chrome is never reached: only the Chrome JARVIS started (or the
   * owner's JARVIS_CDP_PORT one) is closed, through DevTools.
   */
  public async closeBrowser(signal?: AbortSignal): Promise<string> {
    if (!permissionSession.checkPermission(2, 'Close JARVIS\'s Chrome')) {
      throw new Error('Permission Level 2 required to close JARVIS\'s Chrome.');
    }
    const chrome = await this.deps.chrome.running();
    if (!chrome) throw new Error('JARVIS\'s Chrome is not open; JARVIS never closes your own Chrome.');
    const { port } = chrome;
    const pages = await listPages(port).catch(() => []);
    const titles = pages.slice(0, 3).map((p) => `"${(p.title || p.url).slice(0, 40)}"`).join(', ');
    const tabs = `${pages.length} tab${pages.length === 1 ? '' : 's'}${titles ? `: ${titles}${pages.length > 3 ? ', …' : ''}` : ''}`;
    // Asked outside any approval already given: that one did not show the tabs.
    const approved = await withoutApproval(() => this.deps.approve('Close JARVIS\'s Chrome',
      `Close JARVIS's Chrome (${tabs})? Your own Chrome stays open.`));
    if (!approved) throw new Error('JARVIS\'s Chrome was not closed: not approved.');
    // An answer that came after the request ended (its time ran out, or it was
    // cancelled) closes nothing: JARVIS has already said it was not done.
    if (signal?.aborted) throw new Error('JARVIS\'s Chrome was not closed: the request had already ended when the answer came.');
    if (!(await this.deps.chrome.close(chrome))) {
      throw new Error(`JARVIS's Chrome is still open: port ${port} still answers after the close request.`);
    }
    return `Closed JARVIS's Chrome (${tabs}) (port ${port} no longer answers).`;
  }

  public async refreshTab(query: string): Promise<string> {
    if (!permissionSession.checkPermission(1, `Refresh tab: ${query}`)) {
      throw new Error('Permission denied.');
    }
    
    const tab = await resolveTabOrAsk(query.trim(), await this.port());
    if (tab) {
      // Reload through DevTools, and check the page loaded again.
      const { navigate } = await import('./browserAgent.js');
      const report = await navigate({ action: 'reload', tab: tab.id });
      if (!report.success) throw new Error(report.error ?? 'The tab could not be reloaded.');
      return report.check?.status === 'verified'
        ? `Refreshed tab: "${tab.title}" (tab ${tab.id}) (checked: ${report.check.evidence})`
        : `Reloaded tab "${tab.title}" (tab ${tab.id}), but the check found that ${report.check?.evidence ?? 'nothing could be checked'}`;
    }

    throw new Error(query.trim() ? `No browser tab matches "${query}".` : 'No tab is open in JARVIS\'s Chrome.');
  }
}

export const browserController = new BrowserController();
