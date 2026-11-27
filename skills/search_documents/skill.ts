/**
 * skills/search_documents/skill.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Retrieval over ingested documents.
 *
 * Every passage is returned with the file it came from, so an answer built on
 * it can be attributed. Passages with no manifest entry are dropped upstream
 * rather than returned uncited.
 */

import { retrieveDocuments } from '../../rag/retrieve.js';
import { listSources } from '../../rag/index.js';

export async function execute(args: Record<string, unknown>): Promise<string> {
  const query = String(args['query'] ?? '').trim();
  if (!query) return 'Error: search_documents requires a query.';

  const topK = Number(args['topK'] ?? 4);

  try {
    const passages = await retrieveDocuments(query, Number.isFinite(topK) && topK > 0 ? topK : 4);

    if (passages.length === 0) {
      const sources = listSources();
      if (sources.length === 0) {
        return 'No documents have been ingested yet, sir. Use ingest_documents with a file or folder path first.';
      }
      return `Nothing in the ${sources.length} ingested document(s) matched that, sir.`;
    }

    const rendered = passages
      .map((p, i) => `[${i + 1}] ${p.source} (chunk ${p.chunkIndex}, score ${p.score.toFixed(2)})\n${p.text}`)
      .join('\n\n');

    return `Found ${passages.length} relevant passage(s):\n\n${rendered}`;
  } catch (err) {
    // Typically the vector memory service is not running (it is started and
    // restarted by the supervisor). Saying "nothing matched" here would be false.
    return `Error: document search is unavailable right now — ${(err as Error).message}. Try again in a moment, sir.`;
  }
}

export default { execute };
