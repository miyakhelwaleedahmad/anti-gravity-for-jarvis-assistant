import { pcControlKernel } from '../../control/pcControlKernel.js';

export async function execute(args: Record<string, unknown>): Promise<string> {
  const action = String(args['action'] ?? '').toLowerCase();
  const target = String(args['target'] ?? '');

  let res;
  if (action === 'list') {
    res = await pcControlKernel.listProcesses();
  } else if (action === 'find') {
    res = await pcControlKernel.findProcess(target);
  } else if (action === 'kill') {
    res = await pcControlKernel.killProcess(target);
  } else if (action === 'restart') {
    res = await pcControlKernel.restartProcess(target);
  } else {
    throw new Error(`Unknown process action: "${action}"`);
  }

  return JSON.stringify(res, null, 2);
}

export default { execute };
