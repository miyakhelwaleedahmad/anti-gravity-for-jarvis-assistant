/**
 * control/browserController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Controls browser tabs using the Chrome DevTools Protocol (CDP) HTTP API.
 * Supports opening, closing, focusing, and listing tabs, and integrates safety approvals.
 */

import axios from 'axios';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';
import { keyboardController } from './keyboardController.js';
import { rollbackManager } from './rollbackManager.js';
import { activateTab, cdpPort, closeTabById, listPages, openTab } from '../perception/cdpClient.js';
import { chromeStartHint } from '../perception/chromeProfile.js';
import { withoutApproval } from '../security/approvalScope.js';
import { jarvisChrome, type JarvisChrome } from './jarvisChrome.js';

/** JARVIS_CDP_PORT (default 9222), read at each call. */
const baseUrl = () => `http://127.0.0.1:${cdpPort()}`;

/**
 * A browser window has the keyboard. Known on Windows only; elsewhere false,
 * so that a shortcut is never pressed into some other application.
 */
async function browserInFront(): Promise<boolean> {
  try {
    const { getWindowsState } = await import('../perception/windowsState.js');
    const state = await getWindowsState({ allowStale: false });
    return /^(chrome|msedge|brave|firefox|opera|vivaldi)$/i.test(state.activeWindow.processName.replace(/\.exe$/i, ''));
  } catch {
    return false;
  }
}

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

  private async fetchCDPTabs(): Promise<CDPTab[]> {
    try {
      const response = await axios.get(`${baseUrl()}/json/list`, { timeout: 1500 });
      return Array.isArray(response.data) ? response.data : [];
    } catch {
      throw new Error(`Chrome DevTools endpoint unavailable.\n${this.getInstruction()}`);
    }
  }

  public async listTabs(): Promise<string> {
    if (!permissionSession.checkPermission(0, 'List browser tabs')) {
      return 'Permission denied.';
    }
    try {
      const tabs = await this.fetchCDPTabs();
      const pageTabs = tabs.filter(t => t.type === 'page').map(t => ({ title: t.title, url: t.url }));
      return JSON.stringify(pageTabs, null, 2);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  public async findTab(query: string): Promise<CDPTab | null> {
    let tabs: CDPTab[] = [];
    try {
      tabs = await this.fetchCDPTabs();
    } catch {
      return null;
    }
    const lower = query.toLowerCase().trim();
    // A tab's own id first: closeActiveTab and refreshTab pass one, and an id
    // is in no title or URL, so those calls used to find nothing.
    const match = tabs.find(t => t.type === 'page' && t.id === query.trim()) ?? tabs.find(t =>
      t.type === 'page' &&
      (t.title.toLowerCase().includes(lower) || t.url.toLowerCase().includes(lower))
    );
    return match || null;
  }

  /** The tab on screen, or null when Chrome is not reachable. */
  private async visibleTab(): Promise<CDPTab | null> {
    try {
      const { readBrowserState } = await import('../perception/browserState.js');
      const tab = (await readBrowserState(cdpPort())).visibleTab;
      return tab ? { id: tab.id, title: tab.title, url: tab.url, type: 'page' } : null;
    } catch {
      return null;
    }
  }

  public async isTabOpen(query: string): Promise<boolean> {
    try {
      const tab = await this.findTab(query);
      return tab !== null;
    } catch {
      return false;
    }
  }

  public async focusTab(query: string): Promise<string> {
    if (!permissionSession.checkPermission(1, `Focus tab: ${query}`)) {
      throw new Error('Permission denied.');
    }

    const tab = await this.findTab(query);
    if (!tab) {
      throw new Error(`Browser tab matching "${query}" not found.`);
    }

    await activateTab(tab.id, cdpPort());
    return `Focused tab: "${tab.title}" (tab ${tab.id})`;
  }

  public async closeTab(query: string): Promise<string> {
    // Level 1 allows closing YouTube or empty tabs, Level 2 for normal tabs, protected tabs always confirm
    const isYouTube = query.toLowerCase().includes('youtube');
    const requiredLevel = (isYouTube || query === 'about:blank' || query === '') ? 1 : 2;

    if (!permissionSession.checkPermission(requiredLevel, `Close tab: ${query}`)) {
      return `Permission level ${requiredLevel} required to close tab.`;
    }

    const tab = await this.findTab(query);
    if (!tab) {
      return `Tab matching "${query}" is not open.`;
    }

    // High risk checks: if we are closing a tab that looks like code editors or active tasks
    if (tab.title.toLowerCase().includes('antigravity') || tab.title.toLowerCase().includes('github')) {
      const approved = await approvalGate.requestApproval('Close browser tab', `Close sensitive tab: "${tab.title}"`);
      if (!approved) {
        throw new Error('Action cancelled by user.');
      }
    }

    // Register rollback to reopen the tab
    const urlToReopen = tab.url;
    rollbackManager.register('close_tab', `Reopen closed tab: ${urlToReopen}`, async () => {
      await this.openUrl(urlToReopen);
      return true;
    });

    await closeTabById(tab.id, cdpPort());
    return `Closed tab: "${tab.title}" (tab ${tab.id})`;
  }

  public async closeActiveTab(): Promise<string> {
    // The tab on screen (not the first in the list), closed by its id.
    const tab = await this.visibleTab();
    if (tab) return this.closeTab(tab.id);

    // Chrome cannot be reached: Ctrl+W only when a browser window is in front,
    // never into whatever other application has the keyboard.
    if (await browserInFront()) {
      await keyboardController.pressHotkey(['ctrl', 'w']);
      return 'Closed active tab via Ctrl+W shortcut.';
    }
    throw new Error(`No browser tab could be closed: Chrome is not reachable for JARVIS and no browser window is in front.\n${this.getInstruction()}`);
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
      await closeTabById(newTab.id, cdpPort());
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
    
    const tab = query.trim() ? await this.findTab(query) : await this.visibleTab();
    if (tab) {
      // Reload through DevTools, and check the page loaded again.
      const { navigate } = await import('./browserAgent.js');
      const report = await navigate({ action: 'reload', tab: tab.id });
      if (!report.success) throw new Error(report.error ?? 'The tab could not be reloaded.');
      return report.check?.status === 'verified'
        ? `Refreshed tab: "${tab.title}" (tab ${tab.id}) (checked: ${report.check.evidence})`
        : `Reloaded tab "${tab.title}" (tab ${tab.id}), but the check found that ${report.check?.evidence ?? 'nothing could be checked'}`;
    }

    // Chrome cannot be reached: Ctrl+R only when a browser window is in front.
    if (await browserInFront()) {
      await keyboardController.pressHotkey(['ctrl', 'r']);
      return 'Refreshed the browser window in front (Ctrl+R; not checked).';
    }
    throw new Error(query.trim()
      ? `No browser tab matches "${query}".`
      : `No browser tab could be refreshed: Chrome is not reachable for JARVIS and no browser window is in front.\n${this.getInstruction()}`);
  }
}

export const browserController = new BrowserController();
