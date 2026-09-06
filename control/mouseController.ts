/**
 * control/mouseController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Performs cursor positioning, clicks, drags, and scrolling.
 * Enforces Permission Level 2 and supports emergency aborts.
 */

import { runAutomateScript } from './helper.js';
import { permissionSession } from './permissionSession.js';

export class MouseController {
  private ensurePermission(action: string): void {
    if (!permissionSession.checkPermission(2, action)) {
      throw new Error(`Permission Level 2 required for mouse action: "${action}". Enable full control mode first.`);
    }
  }

  public async moveMouse(x: number, y: number): Promise<string> {
    this.ensurePermission(`moveMouse to ${x},${y}`);
    return runAutomateScript(['-Action', 'move-mouse', '-X', String(x), '-Y', String(y)]);
  }

  public async clickMouse(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', double = false): Promise<string> {
    this.ensurePermission(`clickMouse ${button} at ${x},${y} (double: ${double})`);
    return runAutomateScript([
      '-Action', 'click-mouse',
      '-X', String(x),
      '-Y', String(y),
      '-Button', button,
      '-Double', double ? '$true' : '$false'
    ]);
  }

  public async dragMouse(fromX: number, fromY: number, toX: number, toY: number): Promise<string> {
    this.ensurePermission(`dragMouse from ${fromX},${fromY} to ${toX},${toY}`);
    return runAutomateScript([
      '-Action', 'drag-mouse',
      '-FromX', String(fromX),
      '-FromY', String(fromY),
      '-ToX', String(toX),
      '-ToY', String(toY)
    ]);
  }

  public async scrollMouse(amount: number): Promise<string> {
    this.ensurePermission(`scrollMouse amount ${amount}`);
    return runAutomateScript(['-Action', 'scroll-mouse', '-Amount', String(amount)]);
  }
}

export const mouseController = new MouseController();
