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
import { activateTab, cdpPort, closeTabById, openTab } from '../perception/cdpClient.js';

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

export class BrowserController {
  private getInstruction(): string {
    return `Please start Chrome with remote debugging enabled:\nstart chrome.exe --remote-debugging-port=${cdpPort()} --user-data-dir="W:\\jarvis-chrome-profile"`;
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

    try {
      // Direct CDP new tab (PUT: current Chrome answers 405 to the GET used before)
      const newTab = await openTab(finalUrl, cdpPort());

      rollbackManager.register('open_url', `Close opened tab: ${finalUrl}`, async () => {
        await closeTabById(newTab.id, cdpPort());
        return true;
      });

      return `Opened URL: ${finalUrl} (tab ${newTab.id})`;
    } catch {
      // Fallback: spawn default browser
      const { appController } = await import('./appController.js');
      return appController.openApp(finalUrl);
    }
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
