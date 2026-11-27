import { systemStateObserver } from '../../perception/systemStateObserver.js';
import { windowsFailure } from '../../perception/readTools.js';

export async function execute(): Promise<string> {
  const state = systemStateObserver.getState();
  // Not read is not "no window" (A5a, TRA-07).
  return windowsFailure(state) ?? JSON.stringify(state.activeWindow, null, 2);
}

export default { execute };
