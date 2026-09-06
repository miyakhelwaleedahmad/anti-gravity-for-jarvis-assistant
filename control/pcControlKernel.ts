/**
 * control/pcControlKernel.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The single authority for all local PC control actions.
 * Wraps operations with permission checks, performance tracking, audit logging,
 * and standardizes result formatting.
 */

import { execa } from 'execa';
import { permissionSession } from './permissionSession.js';
import { actionAuditLog } from './actionAuditLog.js';
import { actionQueue } from './actionQueue.js';
import { appController } from './appController.js';
import { windowController } from './windowController.js';
import { browserController } from './browserController.js';
import { keyboardController } from './keyboardController.js';
import { mouseController } from './mouseController.js';
import { fileController } from './fileController.js';
import { processController } from './processController.js';
import { systemController } from './systemController.js';
import { adminController } from './adminController.js';
import { getChromeState } from '../perception/chromeState.js';
import { getWindowsState } from '../perception/windowsState.js';
import { getJarvisServiceState } from '../perception/jarvisServiceState.js';

export interface KernelResult {
  success: boolean;
  action: string;
  target: string;
  permissionLevel: number;
  durationMs: number;
  message: string;
  error: string | null;
}

export class PcControlKernel {
  private async executeAction(
    actionName: string,
    targetName: string,
    isReadOnly: boolean,
    runFn: () => Promise<any>
  ): Promise<KernelResult> {
    const t0 = performance.now();
    const permLevel = permissionSession.getCurrentLevel();
    const riskLevel = isReadOnly ? 'safe' : (permLevel === 2 ? 'medium' : 'high');
    
    try {
      let message = '';
      if (isReadOnly) {
        message = await runFn();
      } else {
        // Queue stateful mutations
        message = await actionQueue.enqueue(actionName, () => runFn());
      }
      
      const durationMs = Math.round(performance.now() - t0);
      const result: KernelResult = {
        success: true,
        action: actionName,
        target: targetName,
        permissionLevel: permLevel,
        durationMs,
        message: typeof message === 'string' ? message : JSON.stringify(message),
        error: null
      };

      await actionAuditLog.log({
        userCommand: actionName,
        normalizedIntent: actionName,
        action: actionName,
        target: targetName,
        permissionLevel: permLevel,
        riskLevel: isReadOnly ? 'safe' : 'medium',
        allowed: true,
        confirmationRequired: false,
        result: 'success',
        durationMs,
        rollbackAvailable: true
      });

      return result;

    } catch (err: any) {
      const durationMs = Math.round(performance.now() - t0);
      const errMsg = err.message || String(err);
      
      const result: KernelResult = {
        success: false,
        action: actionName,
        target: targetName,
        permissionLevel: permLevel,
        durationMs,
        message: '',
        error: errMsg
      };

      await actionAuditLog.log({
        userCommand: actionName,
        normalizedIntent: actionName,
        action: actionName,
        target: targetName,
        permissionLevel: permLevel,
        riskLevel: isReadOnly ? 'safe' : 'high',
        allowed: false,
        confirmationRequired: false,
        result: errMsg.includes('cancelled') || errMsg.includes('Denied') ? 'blocked' : 'failure',
        durationMs,
        rollbackAvailable: false,
        error: errMsg
      });

      return result;
    }
  }

  // ── Awareness ──────────────────────────────────────────────────────────────

  public async getPcState(): Promise<KernelResult> {
    return this.executeAction('getPcState', 'system', true, async () => {
      const win = await getWindowsState();
      const chrome = await getChromeState();
      const svcs = await getJarvisServiceState();
      return JSON.stringify({ activeWindow: win.activeWindow, openApps: win.openApps, chrome, jarvisServices: svcs }, null, 2);
    });
  }

  public async getOpenApps(): Promise<KernelResult> {
    return this.executeAction('getOpenApps', 'apps', true, () => appController.listApps());
  }

  public async getOpenWindows(): Promise<KernelResult> {
    return this.executeAction('getOpenWindows', 'windows', true, () => windowController.listOpenWindows());
  }

  public async getActiveWindow(): Promise<KernelResult> {
    return this.executeAction('getActiveWindow', 'window', true, () => windowController.getActiveWindow());
  }

  public async getChromeTabs(): Promise<KernelResult> {
    return this.executeAction('getChromeTabs', 'browser', true, () => browserController.listTabs());
  }

  public async getJarvisServices(): Promise<KernelResult> {
    return this.executeAction('getJarvisServices', 'services', true, async () => {
      const svcs = await getJarvisServiceState();
      return JSON.stringify(svcs, null, 2);
    });
  }

  public async getSystemResources(): Promise<KernelResult> {
    return this.executeAction('getSystemResources', 'resources', true, () => systemController.getSystemStatus());
  }

  // ── Apps ───────────────────────────────────────────────────────────────────

  public async openApp(target: string): Promise<KernelResult> {
    return this.executeAction('openApp', target, false, () => appController.openApp(target));
  }

  public async closeApp(target: string): Promise<KernelResult> {
    return this.executeAction('closeApp', target, false, () => appController.closeApp(target));
  }

  public async focusApp(target: string): Promise<KernelResult> {
    return this.executeAction('focusApp', target, false, () => appController.focusApp(target));
  }

  public async isAppOpen(target: string): Promise<KernelResult> {
    return this.executeAction('isAppOpen', target, true, async () => String(await appController.isAppOpen(target)));
  }

  public async listApps(): Promise<KernelResult> {
    return this.getOpenApps();
  }

  public async restartApp(target: string): Promise<KernelResult> {
    return this.executeAction('restartApp', target, false, () => appController.restartApp(target));
  }

  // ── Windows ────────────────────────────────────────────────────────────────

  public async focusWindow(target: string): Promise<KernelResult> {
    return this.executeAction('focusWindow', target, false, () => windowController.focusWindow(target));
  }

  public async closeWindow(target: string): Promise<KernelResult> {
    return this.executeAction('closeWindow', target, false, () => windowController.closeWindow(target));
  }

  public async closeCurrentWindow(): Promise<KernelResult> {
    return this.executeAction('closeCurrentWindow', 'active', false, () => windowController.closeCurrentWindow());
  }

  public async minimizeWindow(target: string): Promise<KernelResult> {
    return this.executeAction('minimizeWindow', target, false, () => windowController.minimizeWindow(target));
  }

  public async maximizeWindow(target: string): Promise<KernelResult> {
    return this.executeAction('maximizeWindow', target, false, () => windowController.maximizeWindow(target));
  }

  public async moveWindow(target: string, x: number, y: number): Promise<KernelResult> {
    return this.executeAction('moveWindow', target, false, () => windowController.moveWindow(target, x, y));
  }

  public async resizeWindow(target: string, w: number, h: number): Promise<KernelResult> {
    return this.executeAction('resizeWindow', target, false, () => windowController.resizeWindow(target, w, h));
  }

  // ── Browser ────────────────────────────────────────────────────────────────

  public async listBrowserTabs(): Promise<KernelResult> {
    return this.getChromeTabs();
  }

  public async findBrowserTab(query: string): Promise<KernelResult> {
    return this.executeAction('findBrowserTab', query, true, async () => {
      const tab = await browserController.findTab(query);
      return tab ? JSON.stringify(tab, null, 2) : 'Tab not found';
    });
  }

  public async focusBrowserTab(query: string): Promise<KernelResult> {
    return this.executeAction('focusBrowserTab', query, false, () => browserController.focusTab(query));
  }

  public async closeBrowserTab(query: string): Promise<KernelResult> {
    return this.executeAction('closeBrowserTab', query, false, () => browserController.closeTab(query));
  }

  public async closeCurrentBrowserTab(): Promise<KernelResult> {
    return this.executeAction('closeCurrentBrowserTab', 'active', false, () => browserController.closeActiveTab());
  }

  public async openBrowserUrl(url: string): Promise<KernelResult> {
    return this.executeAction('openBrowserUrl', url, false, () => browserController.openUrl(url));
  }

  public async refreshBrowserTab(query: string): Promise<KernelResult> {
    return this.executeAction('refreshBrowserTab', query, false, () => browserController.refreshTab(query));
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  public async typeText(text: string): Promise<KernelResult> {
    return this.executeAction('typeText', 'keyboard', false, () => keyboardController.typeText(text));
  }

  public async pressKey(key: string): Promise<KernelResult> {
    return this.executeAction('pressKey', key, false, () => keyboardController.pressKey(key));
  }

  public async pressHotkey(keys: string[]): Promise<KernelResult> {
    return this.executeAction('pressHotkey', keys.join('+'), false, () => keyboardController.pressHotkey(keys));
  }

  public async pressEnter(): Promise<KernelResult> {
    return this.executeAction('pressEnter', 'enter', false, () => keyboardController.pressEnter());
  }

  public async pressEscape(): Promise<KernelResult> {
    return this.executeAction('pressEscape', 'escape', false, () => keyboardController.pressEscape());
  }

  public async pressTab(): Promise<KernelResult> {
    return this.executeAction('pressTab', 'tab', false, () => keyboardController.pressTab());
  }

  public async pressCtrlW(): Promise<KernelResult> {
    return this.executeAction('pressCtrlW', 'ctrl+w', false, () => keyboardController.pressCtrlW());
  }

  public async pressAltF4(): Promise<KernelResult> {
    return this.executeAction('pressAltF4', 'alt+f4', false, () => keyboardController.pressAltF4());
  }

  // ── Mouse ──────────────────────────────────────────────────────────────────

  public async moveMouse(x: number, y: number): Promise<KernelResult> {
    return this.executeAction('moveMouse', `${x},${y}`, false, () => mouseController.moveMouse(x, y));
  }

  public async clickMouse(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', double = false): Promise<KernelResult> {
    return this.executeAction('clickMouse', `${x},${y}`, false, () => mouseController.clickMouse(x, y, button, double));
  }

  public async doubleClickMouse(x: number, y: number): Promise<KernelResult> {
    return this.executeAction('doubleClickMouse', `${x},${y}`, false, () => mouseController.clickMouse(x, y, 'left', true));
  }

  public async rightClickMouse(x: number, y: number): Promise<KernelResult> {
    return this.executeAction('rightClickMouse', `${x},${y}`, false, () => mouseController.clickMouse(x, y, 'right', false));
  }

  public async scrollMouse(amount: number): Promise<KernelResult> {
    return this.executeAction('scrollMouse', String(amount), false, () => mouseController.scrollMouse(amount));
  }

  public async dragMouse(fromX: number, fromY: number, toX: number, toY: number): Promise<KernelResult> {
    return this.executeAction('dragMouse', `${fromX},${fromY}->${toX},${toY}`, false, () => mouseController.dragMouse(fromX, fromY, toX, toY));
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  public async searchFiles(query: string): Promise<KernelResult> {
    return this.executeAction('searchFiles', query, true, () => fileController.searchFiles(query));
  }

  public async openFile(filePath: string): Promise<KernelResult> {
    return this.openApp(filePath); // Spawns associated application
  }

  public async revealFile(filePath: string): Promise<KernelResult> {
    return this.executeAction('revealFile', filePath, false, async () => {
      const { spawn } = await import('child_process');
      const proc = spawn('explorer.exe', ['/select,', filePath], { detached: true, stdio: 'ignore' });
      proc.unref();
      return `Revealed ${filePath} in explorer`;
    });
  }

  public async readFile(filePath: string): Promise<KernelResult> {
    return this.executeAction('readFile', filePath, true, () => fileController.readFile(filePath));
  }

  public async writeFile(filePath: string, content: string): Promise<KernelResult> {
    return this.executeAction('writeFile', filePath, false, () => fileController.writeFile(filePath, content));
  }

  public async copyFile(source: string, destination: string): Promise<KernelResult> {
    return this.executeAction('copyFile', `${source}->${destination}`, false, () => fileController.copyFile(source, destination));
  }

  public async moveFile(source: string, destination: string): Promise<KernelResult> {
    return this.executeAction('moveFile', `${source}->${destination}`, false, () => fileController.moveFile(source, destination));
  }

  public async renameFile(source: string, destination: string): Promise<KernelResult> {
    return this.executeAction('renameFile', `${source}->${destination}`, false, () => fileController.renameFile(source, destination));
  }

  public async deleteFile(filePath: string): Promise<KernelResult> {
    return this.executeAction('deleteFile', filePath, false, () => fileController.deleteFile(filePath));
  }

  public async createFolder(folderPath: string): Promise<KernelResult> {
    return this.executeAction('createFolder', folderPath, false, () => fileController.createFolder(folderPath));
  }

  public async deleteFolder(folderPath: string): Promise<KernelResult> {
    return this.executeAction('deleteFolder', folderPath, false, () => fileController.deleteFolder(folderPath));
  }

  // ── Processes ──────────────────────────────────────────────────────────────

  public async listProcesses(): Promise<KernelResult> {
    return this.executeAction('listProcesses', 'processes', true, async () => JSON.stringify(await processController.listProcesses(), null, 2));
  }

  public async findProcess(target: string): Promise<KernelResult> {
    return this.executeAction('findProcess', target, true, async () => JSON.stringify(await processController.findProcess(target), null, 2));
  }

  public async killProcess(target: string): Promise<KernelResult> {
    return this.executeAction('killProcess', target, false, () => processController.killProcess(target));
  }

  public async restartProcess(target: string): Promise<KernelResult> {
    return this.executeAction('restartProcess', target, false, () => processController.restartProcess(target));
  }

  // ── System/Admin ───────────────────────────────────────────────────────────

  public async runShellCommand(command: string): Promise<KernelResult> {
    return this.executeAction('runShellCommand', command, false, () => adminController.runShellCommand(command));
  }

  public async runPowerShell(command: string): Promise<KernelResult> {
    return this.executeAction('runPowerShell', command, false, () => adminController.runPowerShell(command));
  }

  public async checkService(serviceName: string): Promise<KernelResult> {
    return this.executeAction('checkService', serviceName, true, async () => {
      const { stdout } = await execa('powershell', ['-NoProfile', '-Command', `Get-Service -Name ${serviceName} | Select-Object Status | ConvertTo-Json`], { reject: false });
      return stdout.trim();
    });
  }

  public async startService(serviceName: string): Promise<KernelResult> {
    return this.executeAction('startService', serviceName, false, () => adminController.startService(serviceName));
  }

  public async stopService(serviceName: string): Promise<KernelResult> {
    return this.executeAction('stopService', serviceName, false, () => adminController.stopService(serviceName));
  }

  public async restartService(serviceName: string): Promise<KernelResult> {
    return this.executeAction('restartService', serviceName, false, () => adminController.restartService(serviceName));
  }

  public async getNetworkStatus(): Promise<KernelResult> {
    return this.executeAction('getNetworkStatus', 'network', true, () => systemController.getNetworkStatus());
  }

  public async getDiskStatus(): Promise<KernelResult> {
    return this.executeAction('getDiskStatus', 'disk', true, () => systemController.getDiskStatus());
  }

  public async getBatteryStatusIfAvailable(): Promise<KernelResult> {
    return this.executeAction('getBatteryStatus', 'battery', true, async () => {
      const { stdout } = await execa('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining | ConvertTo-Json'], { reject: false });
      return stdout.trim() || 'Battery not available (likely desktop PC)';
    });
  }

  public async getStartupTasks(): Promise<KernelResult> {
    return this.executeAction('getStartupTasks', 'startup', true, () => systemController.getStartupTasks());
  }

  public async openSystemSettings(page: string): Promise<KernelResult> {
    return this.executeAction('openSystemSettings', page, false, () => systemController.openSystemSettings(page));
  }

  public async restartJarvisServices(): Promise<KernelResult> {
    return this.executeAction('restartJarvisServices', 'jarvis', false, () => systemController.restartJarvisServices());
  }
}

export const pcControlKernel = new PcControlKernel();
