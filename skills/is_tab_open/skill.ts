import { liveTabList } from '../../perception/readTools.js';

/** "true" / "false" from every tab of JARVIS's Chrome, read now; a failure with the reason when it cannot be read (A5a). */
export async function execute(args: Record<string, unknown>): Promise<string> {
  const query = String(args['tabNameOrUrl'] ?? '').toLowerCase().trim();
  if (!query) return 'false';

  const read = await liveTabList();
  if ('failure' in read) return read.failure;

  const found = read.tabs.some((tab) =>
    (tab.title && tab.title.toLowerCase().includes(query)) ||
    (tab.url && tab.url.toLowerCase().includes(query))
  );

  return String(found);
}

export default { execute };
