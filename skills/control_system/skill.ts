import { pcControlKernel } from '../../control/pcControlKernel.js';

export async function execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const action = String(args['action'] ?? '').toLowerCase();
  const target = String(args['target'] ?? '');

  let res;
  if (action === 'network_status') {
    res = await pcControlKernel.getNetworkStatus();
  } else if (action === 'disk_status') {
    res = await pcControlKernel.getDiskStatus();
  } else if (action === 'settings') {
    res = await pcControlKernel.openSystemSettings(target);
  } else if (action === 'restart_jarvis') {
    res = await pcControlKernel.restartJarvisServices();
  } else if (action === 'shell') {
    res = await pcControlKernel.runShellCommand(target, signal);
  } else if (action === 'powershell') {
    res = await pcControlKernel.runPowerShell(target, signal);
  } else if (action === 'start_service') {
    res = await pcControlKernel.startService(target, signal);
  } else if (action === 'stop_service') {
    res = await pcControlKernel.stopService(target, signal);
  } else if (action === 'restart_service') {
    res = await pcControlKernel.restartService(target, signal);
  } else {
    throw new Error(`Unknown system action: "${action}"`);
  }

  return JSON.stringify(res, null, 2);
}

export default { execute };
