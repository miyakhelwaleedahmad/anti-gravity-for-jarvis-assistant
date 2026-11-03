import { pcControlKernel } from '../../control/pcControlKernel.js';

export async function execute(): Promise<string> {
  const res = await pcControlKernel.getPcState();
  // A failure carries its reason; its message is empty (phase A5c, review C2).
  return res.success ? res.message : JSON.stringify(res);
}

export default { execute };
