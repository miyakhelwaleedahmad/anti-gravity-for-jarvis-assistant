import { pcControlKernel } from '../../control/pcControlKernel.js';

export async function execute(): Promise<string> {
  const res = await pcControlKernel.getPcState();
  return res.message;
}

export default { execute };
