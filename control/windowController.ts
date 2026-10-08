/**
 * control/windowController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Performs window manipulations (focus, minimize, maximize, move, resize, close).
 */

import { getWindowsState } from '../perception/windowsState.js';
import { runAutomateScript } from './helper.js';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';

const PROTECTED_WINDOWS = ['antigravity', 'code', 'windowsterminal', 'powershell', 'cmd'];

export class WindowController {
  private async findHwnd(target: string): Promise<string> {
    // Check if target is already an HWND hex (no window list needed)
    if (/^0x[0-9a-fA-F]+$/.test(target)) {
      return target;
    }

    const winState = await getWindowsState();
    const lower = target.toLowerCase().trim();
    const match = winState.openApps.find(app => 
      app.windowTitle.toLowerCase().includes(lower) || 
      app.name.toLowerCase().includes(lower)
    );

    if (!match || !match.hwnd) {
      throw new Error(`Window matching "${target}" not found.`);
    }

    return match.hwnd;
  }

  public async getActiveWindow(): Promise<string> {
    const state = await getWindowsState();
    return JSON.stringify(state.activeWindow, null, 2);
  }

  public async listOpenWindows(): Promise<string> {
    const state = await getWindowsState();
    return JSON.stringify(state.openApps, null, 2);
  }

  public async focusWindow(target: string): Promise<string> {
    if (!permissionSession.checkPermission(1, `Focus window ${target}`)) {
      return 'Permission denied.';
    }
    try {
      const hwnd = await this.findHwnd(target);
      return runAutomateScript(['-Action', 'control-window', '-ActionType', 'focus', '-Hwnd', hwnd]);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  public async closeWindow(target: string): Promise<string> {
    if (!permissionSession.checkPermission(2, `Close window ${target}`)) {
      throw new Error('Permission Level 2 required.');
    }

    const hwnd = await this.findHwnd(target);
    const winState = await getWindowsState();
    const match = winState.openApps.find(app => app.hwnd === hwnd);
    
    if (match) {
      const isProtected = PROTECTED_WINDOWS.some(p => match.name.toLowerCase().includes(p) || match.windowTitle.toLowerCase().includes(p));
      if (isProtected) {
        const approved = await approvalGate.requestApproval('Close Protected Window', `Close: ${match.windowTitle}`);
        if (!approved) {
          throw new Error('Close window cancelled by user.');
        }
      }
    }

    return runAutomateScript(['-Action', 'control-window', '-ActionType', 'close', '-Hwnd', hwnd]);
  }

  public async closeCurrentWindow(): Promise<string> {
    const winState = await getWindowsState();
    const active = winState.activeWindow;
    if (!active.hwnd || active.hwnd === '0x0') {
      throw new Error('No active window to close.');
    }
    return this.closeWindow(active.hwnd);
  }

  public async minimizeWindow(target: string): Promise<string> {
    if (!permissionSession.checkPermission(1, `Minimize window ${target}`)) {
      throw new Error('Permission denied.');
    }
    const hwnd = await this.findHwnd(target);
    return runAutomateScript(['-Action', 'control-window', '-ActionType', 'minimize', '-Hwnd', hwnd]);
  }

  public async maximizeWindow(target: string): Promise<string> {
    if (!permissionSession.checkPermission(1, `Maximize window ${target}`)) {
      throw new Error('Permission denied.');
    }
    const hwnd = await this.findHwnd(target);
    return runAutomateScript(['-Action', 'control-window', '-ActionType', 'maximize', '-Hwnd', hwnd]);
  }

  public async moveWindow(target: string, x: number, y: number): Promise<string> {
    if (!permissionSession.checkPermission(2, `Move window ${target}`)) {
      throw new Error('Permission Level 2 required.');
    }
    const hwnd = await this.findHwnd(target);
    // Find current size to preserve it
    const winState = await getWindowsState();
    // Default size if we can't fetch it
    const width = 800;
    const height = 600;
    return runAutomateScript([
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
    return runAutomateScript([
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
