import { pcControlKernel } from '../../control/pcControlKernel.js';

export async function execute(args: Record<string, unknown>): Promise<string> {
  const action = String(args['action'] ?? '').toLowerCase();
  const target = String(args['target'] ?? '');

  let res;
  if (action === 'open') {
    res = await pcControlKernel.openApp(target);
  } else if (action === 'close') {
    res = await pcControlKernel.closeApp(target);
  } else if (action === 'focus') {
    res = await pcControlKernel.focusApp(target);
  } else if (action === 'restart') {
    res = await pcControlKernel.restartApp(target);
  } else {
    throw new Error(`Unknown app action: "${action}"`);
  }

  return JSON.stringify(res, null, 2);
}

export default { execute };
