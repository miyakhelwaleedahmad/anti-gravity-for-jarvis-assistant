/**
 * control/appController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Launches, closes, and focuses applications.
 * Integrates safety confirmations for protected applications.
 */

import { execFile, spawn } from 'child_process';
import { getWindowsState } from '../perception/windowsState.js';
import { runAutomateScript } from './helper.js';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';
import { rollbackManager } from './rollbackManager.js';

const APP_ALIASES: Record<string, string> = {
  'cmd': 'cmd.exe',
  'command prompt': 'cmd.exe',
  'notepad': 'notepad.exe',
  'calculator': 'calc.exe',
  'chrome': 'chrome.exe',
  'powershell': 'powershell.exe',
};

const PROTECTED_APPS = ['antigravity', 'code', 'windowsterminal', 'powershell', 'cmd'];

export class AppController {
  private resolveTarget(target: string): string {
    const lower = target.toLowerCase().trim();
    if (APP_ALIASES[lower]) {
      return APP_ALIASES[lower];
    }
    return target;
  }

  public async openApp(target: string): Promise<string> {
    // Level 1: Safe control is allowed to open safe apps
    if (!permissionSession.checkPermission(1, `Open app ${target}`)) {
      throw new Error('Permission denied.');
    }

    const resolved = this.resolveTarget(target);
    const isUrl = /^https?:\/\//i.test(resolved) || /^www\./i.test(resolved);
    const finalTarget = isUrl && !resolved.startsWith('http') ? `https://${resolved}` : resolved;

    console.log(`[AppController] Opening target: "${target}" (resolved: "${finalTarget}")`);

    return new Promise((resolve, reject) => {
      let proc;
      if (process.platform === 'win32') {
        proc = spawn('cmd.exe', ['/c', 'start', '', finalTarget], {
          detached: true,
          stdio: 'ignore',
          shell: false,
          windowsHide: true
        });
      } else {
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        proc = spawn(cmd, [finalTarget], {
          detached: true,
          stdio: 'ignore',
          shell: false
        });
      }

      proc.on('error', (err) => reject(new Error(`Failed to open "${target}": ${err.message}`)));
      proc.unref();

      // Register rollback
      rollbackManager.register('open_app', `Close opened app: ${target}`, async () => {
        await this.closeApp(target);
        return true;
      });

      resolve(`Opened "${target}" successfully.`);
    });
  }

  public async closeApp(target: string): Promise<string> {
    // Level 2 required to close apps
    if (!permissionSession.checkPermission(2, `Close app ${target}`)) {
      throw new Error('Permission Level 2 required to close apps.');
    }

    const resolved = this.resolveTarget(target).toLowerCase();
    const isProtected = PROTECTED_APPS.some(app => resolved.includes(app) || target.toLowerCase().includes(app));

    if (isProtected) {
      const approved = await approvalGate.requestApproval('Close Protected App', `Close app: ${target}`);
      if (!approved) {
        throw new Error(`Close action cancelled by user for protected app: ${target}`);
      }
    }

    const winState = await getWindowsState();
    const matches = winState.openApps.filter(app => 
      app.name.toLowerCase().includes(resolved) || 
      app.windowTitle.toLowerCase().includes(resolved)
    );

    if (matches.length === 0) {
      return `No open application matches "${target}".`;
    }

    let closedCount = 0;
    for (const match of matches) {
      if (match.hwnd) {
        await runAutomateScript(['-Action', 'control-window', '-ActionType', 'close', '-Hwnd', match.hwnd]);
        closedCount++;
      }
    }

    return `Closed ${closedCount} window(s) matching "${target}".`;
  }

  public async focusApp(target: string): Promise<string> {
    if (!permissionSession.checkPermission(1, `Focus app ${target}`)) {
      return 'Permission denied.';
    }

    const resolved = this.resolveTarget(target).toLowerCase();
    const winState = await getWindowsState();
    const match = winState.openApps.find(app => 
      app.name.toLowerCase().includes(resolved) || 
      app.windowTitle.toLowerCase().includes(resolved)
    );

    if (!match || !match.hwnd) {
      return `No running window found for app "${target}".`;
    }

    await runAutomateScript(['-Action', 'control-window', '-ActionType', 'focus', '-Hwnd', match.hwnd]);
    return `Focused window: "${match.windowTitle}"`;
  }

  public async isAppOpen(target: string): Promise<boolean> {
    const resolved = this.resolveTarget(target).toLowerCase();
    const winState = await getWindowsState();
    const hasWindow = winState.openApps.some(app => 
      app.name.toLowerCase().includes(resolved) || 
      app.windowTitle.toLowerCase().includes(resolved)
    );
    if (hasWindow) return true;

    if (process.platform === 'win32') {
      return this.isProcessRunningWin32(resolved);
    }

    return false;
  }

  private async isProcessRunningWin32(resolvedTarget: string): Promise<boolean> {
    const target = resolvedTarget.endsWith('.exe') ? resolvedTarget : `${resolvedTarget}.exe`;
    return new Promise<boolean>((resolve) => {
      execFile('tasklist.exe', ['/fo', 'csv', '/nh'], { windowsHide: true }, (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(stdout.toLowerCase().includes(`"${target.toLowerCase()}"`));
      });
    });
  }

  public async listApps(): Promise<string> {
    const winState = await getWindowsState();
    const apps = winState.openApps.map(app => `${app.name} (PID: ${app.pid}) - ${app.windowTitle}`);
    return JSON.stringify(apps, null, 2);
  }

  public async restartApp(target: string): Promise<string> {
    await this.closeApp(target);
    await new Promise(r => setTimeout(r, 1000));
    return this.openApp(target);
  }
}

export const appController = new AppController();
