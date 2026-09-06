import { pcControlKernel } from '../../control/pcControlKernel.js';

export async function execute(args: Record<string, unknown>): Promise<string> {
  const action = String(args['action'] ?? '').toLowerCase();
  const target = String(args['target'] ?? '');

  let res;
  if (action === 'list') {
    res = await pcControlKernel.listBrowserTabs();
  } else if (action === 'focus') {
    res = await pcControlKernel.focusBrowserTab(target);
  } else if (action === 'close') {
    res = await pcControlKernel.closeBrowserTab(target);
  } else if (action === 'close_current') {
    res = await pcControlKernel.closeCurrentBrowserTab();
  } else if (action === 'open_url') {
    res = await pcControlKernel.openBrowserUrl(target);
  } else if (action === 'refresh') {
    res = await pcControlKernel.refreshBrowserTab(target);
  } else {
    throw new Error(`Unknown browser action: "${action}"`);
  }

  return JSON.stringify(res, null, 2);
}

export default { execute };
