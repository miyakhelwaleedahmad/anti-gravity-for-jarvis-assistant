import { systemStateObserver } from '../../perception/systemStateObserver.js';

export async function execute(): Promise<string> {
  const state = systemStateObserver.getState();
  return JSON.stringify(state.chrome?.tabs || [], null, 2);
}

export default { execute };
