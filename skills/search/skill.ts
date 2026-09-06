import { toolRegistryV2 } from '../../core/toolRegistryV2.js';

export async function execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const topic = String(args['topic'] ?? '').trim();

  if (!topic) return 'Error: topic is required for deep_search.';

  console.log(`[DeepSearch] Running queries for: "${topic}"`);

  if (signal?.aborted) throw new Error('ABORTED');
  try {
    const response = await toolRegistryV2.execute('web_search', { query: topic }, signal);
    return response.output;
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    console.warn(`[DeepSearch] Query failed:`, err);
    return `No results found for "${topic}".`;
  }
}

export default { execute };
