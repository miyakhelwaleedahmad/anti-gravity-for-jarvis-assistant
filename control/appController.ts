/**
 * control/appController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Launches, closes, and focuses applications.
 * Integrates safety confirmations for protected applications.
 */

import { execFile, spawn } from 'child_process';
import { getWindowsState, type WindowsStateResult } from '../perception/windowsState.js';
import { runAutomateScript } from './helper.js';
import { browserCloseRefusal, browserPageRefusal, hasHandle, matchAppWindows, planAppClose, programFor, programKey } from './appMatch.js';
import { withoutApproval } from '../security/approvalScope.js';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';
import { rollbackManager } from './rollbackManager.js';
import { childEnv } from '../system/childEnv.js';

/** Names `cmd /c start` is given to launch an app. Not for matching windows: see control/appMatch.ts. */
const APP_ALIASES: Record<string, string> = {
  'cmd': 'cmd.exe',
  'command prompt': 'cmd.exe',
  'notepad': 'notepad.exe',
  'calculator': 'calc.exe',
  'chrome': 'chrome.exe',
  'google chrome': 'chrome.exe',
  // A browser named opens that browser, by the program name Windows knows
  // (owner, 2026-10-27); only Chrome goes to JARVIS's own Chrome.
  'edge': 'msedge.exe',
  'microsoft edge': 'msedge.exe',
  'firefox': 'firefox.exe',
  'mozilla firefox': 'firefox.exe',
  'powershell': 'powershell.exe',
};

const PROTECTED_APPS = ['antigravity', 'code', 'windowsterminal', 'powershell', 'cmd'];

/**
 * The target is handed to `cmd /c start`, which treats `&`, `|`, `^`, `<`, `>`
 * and `%` as command syntax: "notepad&calc" also ran calc. Such targets are
 * refused. This includes control_browser's fallback when Chrome's DevTools
 * endpoint is not reachable; through that endpoint such URLs still open.
 */
const CMD_METACHARACTERS = /[&|^<>%"\r\n]/;

/** What the controller reads and does on the desktop; tests give stand-ins. */
export interface AppControllerDeps {
  /** The current window list (an action never uses an old one). */
  windows: () => Promise<WindowsStateResult>;
  /** win_automate.ps1, for one window action. */
  automate: (args: string[]) => Promise<string>;
  /** Asks the owner (the approval gate). */
  approve: (title: string, command: string) => Promise<boolean>;
}

const desktopDeps: AppControllerDeps = {
  windows: () => getWindowsState(),
  automate: runAutomateScript,
  approve: (title, command) => approvalGate.requestApproval(title, command),
};

export class AppController {
  constructor(private readonly deps: AppControllerDeps = desktopDeps) {}

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
    if (CMD_METACHARACTERS.test(resolved)) {
      throw new Error(`Refused by safety policy: "${target}" contains characters Command Prompt would run as a command.`);
    }
    const isUrl = /^https?:\/\//i.test(resolved) || /^www\./i.test(resolved);
    const finalTarget = isUrl && !resolved.startsWith('http') ? `https://${resolved}` : resolved;

    // Web pages and Chrome itself: JARVIS's own Chrome, never the default
    // browser (owner decision D1, answers Q1 and Q2; phase A2 review R1).
    const program = finalTarget.split(/[\\/]/).pop()!.toLowerCase();
    if (isUrl || program === 'chrome.exe' || program === 'chrome') {
      const { showInJarvisChrome } = await import('./jarvisChrome.js');
      const shown = await showInJarvisChrome(isUrl ? finalTarget : undefined);
      return `Opened "${target}" in JARVIS's Chrome (port ${shown.port}, tab ${shown.tabId}).`;
    }

    console.log(`[AppController] Opening target: "${target}" (resolved: "${finalTarget}")`);

    return new Promise((resolve, reject) => {
      let proc;
      if (process.platform === 'win32') {
        proc = spawn('cmd.exe', ['/c', 'start', '', finalTarget], {
          detached: true,
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
          env: childEnv(),
        });
      } else {
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        proc = spawn(cmd, [finalTarget], {
          detached: true,
          stdio: 'ignore',
          shell: false,
          env: childEnv(),
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

    const program = programFor(target);
    const isProtected = PROTECTED_APPS.some(app => program.includes(app) || target.toLowerCase().includes(app));

    // What would close is worked out first: the question names those windows,
    // and nothing is asked for a close that is refused anyway (R4-5).
    const winState = await this.deps.windows();
    const plan = planAppClose(target, winState.openApps);

    if (plan.kind === 'none') {
      // Thrown, not returned: a returned message counted as success, and the
      // "close notepad" route answered "Closing Notepad, sir." with nothing open.
      throw new Error(`No open application matches "${target}".`);
    }
    if (plan.kind === 'browser') throw new Error(browserCloseRefusal(plan.browser));
    if (plan.kind === 'browser-page') throw new Error(browserPageRefusal(target, plan.browser));

    const windows = plan.windows.filter(hasHandle);
    if (windows.length === 0) {
      throw new Error(`No window of "${target}" can be closed: the window list gave none a handle.`);
    }
    // A protected app by name ("close cmd") or by a matched window ("close
    // terminal" → WindowsTerminal). Asked outside an approved call: the approved
    // request did not show which windows (R4-1, R2-4).
    const protectedWindow = isProtected || windows.some((w) => PROTECTED_APPS.some((app) => programKey(w.name).includes(app)));
    if (protectedWindow) {
      const titles = windows.map((w) => `"${w.windowTitle}"`).join(', ').slice(0, 240);
      const approved = await withoutApproval(() => this.deps.approve('Close Protected App', `Close app: ${target} (${windows.map((w) => w.name).join(', ')}): ${titles}`));
      if (!approved) {
        throw new Error(`Close action cancelled by user for protected app: ${target}`);
      }
    }
    // Several windows, or a name that is not quite the program's: the owner sees
    // the list first. Asked outside an approved call: the registry's approval of
    // "close notepad" did not show which windows (approvalScope.coversNested).
    if ((windows.length > 1 || !plan.exact) && !protectedWindow) {
      const titles = windows.map((w) => `"${w.windowTitle}"`).join(', ').slice(0, 240);
      const what = windows.length > 1 ? `${windows.length} windows` : '1 window';
      const approved = await withoutApproval(() => this.deps.approve('Close Matching Windows', `Close ${what} matching ${target}: ${titles}`));
      if (!approved) {
        throw new Error(`Close cancelled: closing ${what} matching "${target}" was not approved.`);
      }
    }

    let closedCount = 0;
    for (const match of windows) {
      await this.deps.automate(['-Action', 'control-window', '-ActionType', 'close', '-Hwnd', match.hwnd]);
      closedCount++;
    }

    // The handles let the check look at exactly these windows (core/verifiers.ts).
    return `Closed ${closedCount} window(s) matching "${target}" (windows ${windows.map((w) => w.hwnd).join(', ')}).`;
  }

  public async focusApp(target: string): Promise<string> {
    if (!permissionSession.checkPermission(1, `Focus app ${target}`)) {
      return 'Permission denied.';
    }

    const winState = await this.deps.windows();
    const match = matchAppWindows(target, winState.openApps).windows.find(hasHandle);

    if (!match) {
      return `No running window found for app "${target}".`;
    }

    await this.deps.automate(['-Action', 'control-window', '-ActionType', 'focus', '-Hwnd', match.hwnd]);
    return `Focused window: "${match.windowTitle}"`;
  }

  public async isAppOpen(target: string): Promise<boolean> {
    const winState = await this.deps.windows();
    if (matchAppWindows(target, winState.openApps).windows.length > 0) return true;

    if (process.platform === 'win32') {
      return this.isProcessRunningWin32(this.resolveTarget(target).toLowerCase());
    }

    return false;
  }

  private async isProcessRunningWin32(resolvedTarget: string): Promise<boolean> {
    const target = resolvedTarget.endsWith('.exe') ? resolvedTarget : `${resolvedTarget}.exe`;
    return new Promise<boolean>((resolve) => {
      execFile('tasklist.exe', ['/fo', 'csv', '/nh'], { windowsHide: true, env: childEnv() }, (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(stdout.toLowerCase().includes(`"${target.toLowerCase()}"`));
      });
    });
  }

  public async listApps(): Promise<string> {
    const winState = await this.deps.windows();
    const apps = winState.openApps.map(app => `${app.name} (PID: ${app.pid}) - ${app.windowTitle}`);
    return JSON.stringify(apps, null, 2);
  }

  public async restartApp(target: string): Promise<string> {
    try {
      await this.closeApp(target);
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      // Not running: restarting it is just opening it, as before closeApp threw.
      if (!/No open application matches/.test((err as Error).message)) throw err;
    }
    return this.openApp(target);
  }
}

export const appController = new AppController();
