/**
 * control/inputController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * High-level wrapper for mouse and keyboard actions, ensuring serialization
 * and cancellation through the actionQueue.
 */

import { mouseController } from './mouseController.js';
import { keyboardController } from './keyboardController.js';
import { actionQueue } from './actionQueue.js';

export class InputController {
  public async typeText(text: string): Promise<string> {
    return actionQueue.enqueue('typeText', () => keyboardController.typeText(text));
  }

  public async pressHotkey(keys: string[]): Promise<string> {
    return actionQueue.enqueue(`pressHotkey [${keys.join('+')}]`, () => keyboardController.pressHotkey(keys));
  }

  public async clickCoordinates(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', double = false): Promise<string> {
    return actionQueue.enqueue(`clickCoordinates at ${x},${y}`, () => mouseController.clickMouse(x, y, button, double));
  }

  public async scroll(amount: number): Promise<string> {
    return actionQueue.enqueue(`scrollMouse ${amount}`, () => mouseController.scrollMouse(amount));
  }

  public cancelInputAction(): void {
    actionQueue.cancelCurrent();
  }
}

export const inputController = new InputController();
