/**
 * control/windowController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Performs window manipulations (focus, minimize, maximize, move, resize, close).
 */

import { freshWindowList, getWindowsState } from '../perception/windowsState.js';
import { runAutomateScript } from './helper.js';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';
import { browserCloseRefusal, browserName, browserPageRefusal, hasHandle, matchAppWindows, planAppClose } from './appMatch.js';
import type { AppWindow } from './appMatch.js';
import { withoutApproval } from '../security/approvalScope.js';
import type { AppControllerDeps } from './appController.js';

const PROTECTED_WINDOWS = ['antigravity', 'code', 'windowsterminal', 'powershell', 'cmd'];

/** What the window controller reads and does; tests give stand-ins. */
export interface WindowControllerDeps extends AppControllerDeps {
  /**
   * Every visible window with its program. The app list above has one main
   * window per program (the first 20 programs), so a second Chrome window's
   * handle is not in it.
   */
  allWindows: () => Promise<AppWindow[]>;
}

const desktopDeps: WindowControllerDeps = {
  windows: () => getWindowsState(),
  automate: runAutomateScript,
  approve: (title, command) => approvalGate.requestApproval(title, command),
  allWindows: async () => (await freshWindowList.read()).map((w) => ({ name: w.process, pid: w.pid, windowTitle: w.title, hwnd: w.hwnd })),
};

/** The same window handle, written in hex or decimal. */
function sameHandle(a: string | undefined, b: string): boolean {
  try { return a !== undefined && BigInt(a) === BigInt(b); } catch { return false; }
}

const isHwnd = (target: string) => /^0x[0-9a-fA-F]+$/.test(target);

/** A window title short enough for a spoken reply (the route speaks errors up to 120 characters). */
function shortTitle(title: string): string {
  const t = title.trim() || 'the window in front';
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
}

export class WindowController {
  constructor(private readonly deps: WindowControllerDeps = desktopDeps) {}

  private async findHwnd(target: string, openApps?: AppWindow[]): Promise<string> {
    // Check if target is already an HWND hex (no window list needed)
    if (isHwnd(target)) {
      return target;
    }

    const apps = openApps ?? (await this.deps.windows()).openApps;
    const match = matchAppWindows(target, apps).windows.find(hasHandle);

    if (!match) {
      throw new Error(`Window matching "${target}" not found.`);
    }

    return match.hwnd;
  }

  public async getActiveWindow(): Promise<string> {
    const state = await this.deps.windows();
    return JSON.stringify(state.activeWindow, null, 2);
  }

  public async listOpenWindows(): Promise<string> {
    const state = await this.deps.windows();
    return JSON.stringify(state.openApps, null, 2);
  }

  public async focusWindow(target: string): Promise<string> {
    if (!permissionSession.checkPermission(1, `Focus window ${target}`)) {
      return 'Permission denied.';
    }
    try {
      const hwnd = await this.findHwnd(target);
      return this.deps.automate(['-Action', 'control-window', '-ActionType', 'focus', '-Hwnd', hwnd]);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  public async closeWindow(target: string): Promise<string> {
    return this.close(target, false);
  }

  /**
   * Closes one window. A browser window is refused by name or by a handle
   * from a window list (TRA-18, D3); as the current window it is closed only
   * after the owner confirms that window.
   */
  private async close(target: string, currentWindow: boolean, active?: { processName: string; title: string }): Promise<string> {
    if (!permissionSession.checkPermission(2, `Close window ${target}`)) {
      throw new Error('Permission Level 2 required.');
    }

    const openApps = (await this.deps.windows()).openApps;
    let hwnd: string;
    /** The window being closed, with its program, when known. */
    let owner: AppWindow | undefined;
    if (isHwnd(target)) {
      hwnd = target;
      owner = openApps.find((w) => sameHandle(w.hwnd, hwnd))
        // The window in front may be no program's main window (JARVIS's own terminal): its reading still names it (R4-4).
        ?? (active?.processName ? { name: active.processName, pid: 0, windowTitle: active.title, hwnd } : undefined);
      if (!owner?.name) {
        // Not a main window (a second Chrome window), or the window in front
        // with no program name: its program is read from every visible window.
        try {
          owner = (await this.deps.allWindows()).find((w) => sameHandle(w.hwnd, hwnd)) ?? owner;
        } catch (err) {
          if (!currentWindow) throw new Error(`Window ${hwnd} was not closed: which program owns it could not be read (${err instanceof Error ? err.message : String(err)}).`);
        }
        if (!owner && !currentWindow) throw new Error(`Window ${hwnd} was not closed: no visible window has that handle.`);
      }
      const title = shortTitle(owner?.windowTitle || active?.title || '');
      const browser = browserName(owner?.name ?? '');
      if (browser && !currentWindow) throw new Error(browserCloseRefusal(browser));
      if (browser || !owner?.name) {
        // "close current window" alone does not close a browser window (owner's
        // decision, 2026-10-26), nor one whose program is unknown (it may be a
        // browser): the owner confirms that window, even inside an approved call.
        const what = browser ? `the ${browser} window "${title}" and all its tabs` : `the window "${title}" (its program could not be read)`;
        const approved = await withoutApproval(() => this.deps.approve(browser ? 'Close Browser Window' : 'Close Unknown Window', `Close ${what}`));
        if (!approved) {
          throw new Error(`Not closed: the ${browser ? `${browser} window` : 'window'} "${title}" was not approved.`);
        }
      }
    } else {
      const plan = planAppClose(target, openApps);
      if (plan.kind === 'browser') throw new Error(browserCloseRefusal(plan.browser));
      if (plan.kind === 'browser-page') throw new Error(browserPageRefusal(target, plan.browser));
      // The window comes from the plan, which has no browser window in it.
      const chosen = plan.kind === 'close' ? plan.windows.find(hasHandle) : undefined;
      if (!chosen) throw new Error(`Window matching "${target}" not found.`);
      hwnd = chosen.hwnd;
      owner = chosen;
    }
    const match = owner;

    if (match) {
      const isProtected = PROTECTED_WINDOWS.some(p => match.name.toLowerCase().includes(p) || match.windowTitle.toLowerCase().includes(p));
      if (isProtected) {
        // Outside an approved call, as for apps: the approved request did not show which program this is (R5-1).
        const approved = await withoutApproval(() => this.deps.approve('Close Protected Window', `Close: ${match.windowTitle} (${match.name})`));
        if (!approved) {
          throw new Error('Close window cancelled by user.');
        }
      }
    }

    return this.deps.automate(['-Action', 'control-window', '-ActionType', 'close', '-Hwnd', hwnd]);
  }

  public async closeCurrentWindow(): Promise<string> {
    // Permission first, as closeWindow does: without it the refusal depended on
    // whether a window list could be read (a busy PowerShell gave none).
    if (!permissionSession.checkPermission(2, 'Close the current window')) {
      throw new Error('Permission Level 2 required.');
    }
    const winState = await this.deps.windows();
    const active = winState.activeWindow;
    if (!active.hwnd || active.hwnd === '0x0') {
      throw new Error('No active window to close.');
    }
    return this.close(active.hwnd, true, active);
  }

  public async minimizeWindow(target: string): Promise<string> {
    if (!permissionSession.checkPermission(1, `Minimize window ${target}`)) {
      throw new Error('Permission denied.');
    }
    const hwnd = await this.findHwnd(target);
    return this.deps.automate(['-Action', 'control-window', '-ActionType', 'minimize', '-Hwnd', hwnd]);
  }

  public async maximizeWindow(target: string): Promise<string> {
    if (!permissionSession.checkPermission(1, `Maximize window ${target}`)) {
      throw new Error('Permission denied.');
    }
    const hwnd = await this.findHwnd(target);
    return this.deps.automate(['-Action', 'control-window', '-ActionType', 'maximize', '-Hwnd', hwnd]);
  }

  public async moveWindow(target: string, x: number, y: number): Promise<string> {
    if (!permissionSession.checkPermission(2, `Move window ${target}`)) {
      throw new Error('Permission Level 2 required.');
    }
    const hwnd = await this.findHwnd(target);
    // Default size if we can't fetch it
    const width = 800;
    const height = 600;
    return this.deps.automate([
      '-Action', 'control-window',
      '-ActionType', 'move',
      '-Hwnd', hwnd,
      '-X', String(x),
      '-Y', String(y),
      '-Width', String(width),
      '-Height', String(height)
    ]);
  }

  public async resizeWindow(target: string, width: number, height: number): Promise<string> {
    if (!permissionSession.checkPermission(2, `Resize window ${target}`)) {
      throw new Error('Permission Level 2 required.');
    }
    const hwnd = await this.findHwnd(target);
    // Preserve X, Y position if possible, otherwise center/default
    const x = 100;
    const y = 100;
    return this.deps.automate([
      '-Action', 'control-window',
      '-ActionType', 'move',
      '-Hwnd', hwnd,
      '-X', String(x),
      '-Y', String(y),
      '-Width', String(width),
      '-Height', String(height)
    ]);
  }
}

export const windowController = new WindowController();
