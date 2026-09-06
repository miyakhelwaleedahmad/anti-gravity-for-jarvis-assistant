import { systemStateObserver } from '../../perception/systemStateObserver.js';

export async function execute(): Promise<string> {
  return JSON.stringify(systemStateObserver.getState().activeWindow, null, 2);
}

export default { execute };
