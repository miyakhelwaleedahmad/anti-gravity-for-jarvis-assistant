import { pcControlKernel } from '../../control/pcControlKernel.js';

export async function execute(args: Record<string, unknown>): Promise<string> {
  const action = String(args['action'] ?? '').toLowerCase();
  const text = String(args['text'] ?? '');
  const key = String(args['key'] ?? '');
  const keys = Array.isArray(args['keys']) ? args['keys'].map(String) : [];

  let res;
  if (action === 'type') {
    res = await pcControlKernel.typeText(text);
  } else if (action === 'press_key') {
    res = await pcControlKernel.pressKey(key);
  } else if (action === 'press_hotkey') {
    res = await pcControlKernel.pressHotkey(keys);
  } else {
    throw new Error(`Unknown keyboard action: "${action}"`);
  }

  return JSON.stringify(res, null, 2);
}

export default { execute };
