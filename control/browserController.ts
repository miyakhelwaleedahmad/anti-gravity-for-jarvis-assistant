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

const DEBUG_PORT = 9222;
const BASE_URL = `http://127.0.0.1:${DEBUG_PORT}`;

export interface CDPTab {
  id: string;
  title: string;
  url: string;
  type: string;
}

export class BrowserController {
  private getInstruction(): string {
    return 'Please start Chrome with remote debugging enabled:\nstart chrome.exe --remote-debugging-port=9222 --user-data-dir="W:\\jarvis-chrome-profile"';
  }

  private async fetchCDPTabs(): Promise<CDPTab[]> {
    try {
      const response = await axios.get(`${BASE_URL}/json/list`, { timeout: 1500 });
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
    const match = tabs.find(t => 
      t.type === 'page' && 
      (t.title.toLowerCase().includes(lower) || t.url.toLowerCase().includes(lower))
    );
    return match || null;
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

    await axios.get(`${BASE_URL}/json/activate/${tab.id}`);
    return `Focused tab: "${tab.title}"`;
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

    await axios.get(`${BASE_URL}/json/close/${tab.id}`);
    return `Closed tab: "${tab.title}"`;
  }

  public async closeActiveTab(): Promise<string> {
    // Close active tab using Ctrl+W shortcut via keyboard controller as safe backup or direct CDP
    try {
      const tabs = await this.fetchCDPTabs();
      const pageTabs = tabs.filter(t => t.type === 'page');
      if (pageTabs.length > 0) {
        return this.closeTab(pageTabs[0].id);
      }
    } catch {}
    
    // Fallback shortcut
    await keyboardController.pressHotkey(['ctrl', 'w']);
    return 'Closed active tab via Ctrl+W shortcut.';
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
      // Direct CDP new tab
      const response = await axios.get(`${BASE_URL}/json/new?${encodeURIComponent(finalUrl)}`);
      const newTab = response.data;
      
      rollbackManager.register('open_url', `Close opened tab: ${finalUrl}`, async () => {
        await axios.get(`${BASE_URL}/json/close/${newTab.id}`);
        return true;
      });

      return `Opened URL: ${finalUrl}`;
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
    
    const tab = await this.findTab(query);
    if (tab) {
      await this.focusTab(tab.id);
    }
    
    await keyboardController.pressHotkey(['ctrl', 'r']);
    return `Refreshed tab: "${tab ? tab.title : 'active'}"`;
  }
}

export const browserController = new BrowserController();
