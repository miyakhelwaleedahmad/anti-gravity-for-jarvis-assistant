/**
 * control/keyboardController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Simulates keyboard keystrokes and hotkeys.
 * Enforces Level 2 permissions and prompts for confirmation on dangerous hotkeys.
 */

import { runAutomateScript } from './helper.js';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';

const DANGEROUS_HOTKEYS = [
  'alt+f4', 'alt,f4', 'f4,alt',
  'ctrl+w', 'ctrl,w', 'w,ctrl',
  'win+r', 'win,r', 'r,win',
  'ctrl+shift+esc',
  'shift+delete',
  'ctrl+a,delete', 'ctrl+a+delete'
];

export class KeyboardController {
  private ensurePermission(action: string): void {
    if (!permissionSession.checkPermission(2, action)) {
      throw new Error(`Permission Level 2 required for keyboard action: "${action}". Enable full control mode first.`);
    }
  }

  private isDangerous(keys: string | string[]): boolean {
    const serialized = (Array.isArray(keys) ? keys.join('+') : keys).toLowerCase().replace(/\s+/g, '');
    return DANGEROUS_HOTKEYS.some(dangerous => serialized.includes(dangerous) || dangerous.includes(serialized));
  }

  public async typeText(text: string): Promise<string> {
    this.ensurePermission(`typeText "${text.substring(0, 20)}..."`);
    // Escape SendKeys characters if any
    const escaped = text.replace(/([+^%~{}()\[\]])/g, '{$1}');
    return runAutomateScript(['-Action', 'type-text', '-Text', escaped]);
  }

  public async pressKey(key: string): Promise<string> {
    this.ensurePermission(`pressKey "${key}"`);
    return runAutomateScript(['-Action', 'press-key', '-Key', key]);
  }

  public async pressHotkey(keys: string[]): Promise<string> {
    const actionDesc = `pressHotkey [${keys.join('+')}]`;
    this.ensurePermission(actionDesc);

    if (this.isDangerous(keys)) {
      const approved = await approvalGate.requestApproval('Execute Dangerous Keyboard Shortcut', `Shortcut: ${keys.join('+')}`);
      if (!approved) {
        throw new Error(`Dangerous shortcut requires explicit confirmation and was denied: ${keys.join('+')}`);
      }
    }

    // Map modifiers and key
    const modifiers = keys.filter(k => ['ctrl', 'alt', 'shift', 'win'].includes(k.toLowerCase())).join(',');
    const mainKey = keys.find(k => !['ctrl', 'alt', 'shift', 'win'].includes(k.toLowerCase())) || '';

    return runAutomateScript(['-Action', 'press-key', '-Key', mainKey, '-Modifiers', modifiers]);
  }

  public async pressEnter(): Promise<string> {
    return this.pressKey('enter');
  }

  public async pressEscape(): Promise<string> {
    return this.pressKey('escape');
  }

  public async pressTab(): Promise<string> {
    return this.pressKey('tab');
  }

  public async pressCtrlW(): Promise<string> {
    return this.pressHotkey(['ctrl', 'w']);
  }

  public async pressAltF4(): Promise<string> {
    return this.pressHotkey(['alt', 'f4']);
  }
}

export const keyboardController = new KeyboardController();
