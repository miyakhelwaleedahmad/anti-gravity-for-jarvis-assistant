import { actionQueue } from '../../control/actionQueue.js';

export async function execute(): Promise<string> {
  actionQueue.cancelCurrent();
  return "Cancelled current running action.";
}

export default { execute };
