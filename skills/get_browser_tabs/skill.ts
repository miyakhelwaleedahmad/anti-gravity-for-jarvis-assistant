import { liveTabs } from '../../perception/readTools.js';

/** The tabs of JARVIS's Chrome, read now; a failure with the reason when they cannot be read (A5a). */
export async function execute(): Promise<string> {
  const read = await liveTabs();
  if ('failure' in read) return read.failure;
  return JSON.stringify(read.tabs, null, 2);
}

export default { execute };
