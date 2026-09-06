import axios from 'axios';
import { execa } from 'execa';

export interface ChromeTab {
  title: string;
  url: string;
  active: boolean;
}

export interface ChromeState {
  running: boolean;
  debugPort: number;
  tabs: ChromeTab[];
  error?: string;
}

/**
 * Checks if chrome.exe process is running on Windows.
 */
async function isChromeProcessRunning(): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false;
  }
  try {
    const result = await execa('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { reject: false });
    return result.stdout.toLowerCase().includes('chrome.exe');
  } catch {
    return false;
  }
}

export async function getChromeState(): Promise<ChromeState> {
  const debugPort = 9222;
  const endpoint = `http://127.0.0.1:${debugPort}/json`;
  
  try {
    const response = await axios.get(endpoint, { timeout: 1000 });
    const tabsData = response.data;
    
    if (Array.isArray(tabsData)) {
      const tabs: ChromeTab[] = tabsData
        .filter((tab: any) => tab.type === 'page')
        .map((tab: any, index: number) => ({
          title: tab.title || '',
          url: tab.url || '',
          // Chrome DevTools Protocol lists tabs in MRU order usually,
          // so we can mark the first page tab as active as a heuristic.
          active: index === 0
        }));

      return {
        running: true,
        debugPort,
        tabs
      };
    }
    
    return {
      running: true,
      debugPort,
      tabs: []
    };
  } catch (err: any) {
    const running = await isChromeProcessRunning();
    return {
      running,
      debugPort,
      tabs: [],
      error: 'Chrome DevTools endpoint unavailable. Suggest starting Chrome with: start chrome.exe --remote-debugging-port=9222 --user-data-dir="W:\\jarvis-chrome-profile"'
    };
  }
}
