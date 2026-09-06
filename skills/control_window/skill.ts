import { pcControlKernel } from '../../control/pcControlKernel.js';

export async function execute(args: Record<string, unknown>): Promise<string> {
  const action = String(args['action'] ?? '').toLowerCase();
  const target = String(args['target'] ?? '');
  const x = Number(args['x'] ?? 0);
  const y = Number(args['y'] ?? 0);
  const width = Number(args['width'] ?? 800);
  const height = Number(args['height'] ?? 600);

  let res;
  if (action === 'focus') {
    res = await pcControlKernel.focusWindow(target);
  } else if (action === 'close') {
    res = await pcControlKernel.closeWindow(target);
  } else if (action === 'close_current') {
    res = await pcControlKernel.closeCurrentWindow();
  } else if (action === 'minimize') {
    res = await pcControlKernel.minimizeWindow(target);
  } else if (action === 'maximize') {
    res = await pcControlKernel.maximizeWindow(target);
  } else if (action === 'move') {
    res = await pcControlKernel.moveWindow(target, x, y);
  } else if (action === 'resize') {
    res = await pcControlKernel.resizeWindow(target, width, height);
  } else {
    throw new Error(`Unknown window action: "${action}"`);
  }

  return JSON.stringify(res, null, 2);
}

export default { execute };
