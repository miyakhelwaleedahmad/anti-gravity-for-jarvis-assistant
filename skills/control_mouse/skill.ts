import { pcControlKernel } from '../../control/pcControlKernel.js';

export async function execute(args: Record<string, unknown>): Promise<string> {
  const action = String(args['action'] ?? '').toLowerCase();
  const x = Number(args['x'] ?? 0);
  const y = Number(args['y'] ?? 0);
  const amount = Number(args['amount'] ?? 0);
  const fromX = Number(args['fromX'] ?? 0);
  const fromY = Number(args['fromY'] ?? 0);
  const toX = Number(args['toX'] ?? 0);
  const toY = Number(args['toY'] ?? 0);

  let res;
  if (action === 'move') {
    res = await pcControlKernel.moveMouse(x, y);
  } else if (action === 'click') {
    res = await pcControlKernel.clickMouse(x, y, 'left', false);
  } else if (action === 'right_click') {
    res = await pcControlKernel.clickMouse(x, y, 'right', false);
  } else if (action === 'double_click') {
    res = await pcControlKernel.doubleClickMouse(x, y);
  } else if (action === 'scroll') {
    res = await pcControlKernel.scrollMouse(amount);
  } else if (action === 'drag') {
    res = await pcControlKernel.dragMouse(fromX, fromY, toX, toY);
  } else {
    throw new Error(`Unknown mouse action: "${action}"`);
  }

  return JSON.stringify(res, null, 2);
}

export default { execute };
