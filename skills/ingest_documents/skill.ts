/**
 * skills/ingest_documents/skill.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Adds documents to the searchable document memory.
 *
 * The path is validated by the same workspace containment guard as every other
 * file operation — ingestion reads arbitrary user-named paths, which is exactly
 * what that boundary is for.
 */

import { ingestPath } from '../../rag/ingest.js';

export async function execute(args: Record<string, unknown>): Promise<string> {
  const target = String(args['path'] ?? '').trim();
  if (!target) return 'Error: ingest_documents requires a path.';

  try {
    const result = await ingestPath(target);

    if (!result.ok) {
      return `Error: ${result.error ?? 'nothing could be ingested.'}`;
    }

    const parts = [
      `Ingested ${result.chunksEmbedded} chunk(s) from ${result.filesIngested} file(s), sir.`,
    ];
    if (result.skipped.length > 0) {
      const shown = result.skipped.slice(0, 5).map((s) => `  - ${s.path}: ${s.reason}`);
      parts.push(`Skipped ${result.skipped.length}:`, ...shown);
    }
    return parts.join('\n');
  } catch (err) {
    return `Error: ingestion failed — ${(err as Error).message}`;
  }
}

export default { execute };
