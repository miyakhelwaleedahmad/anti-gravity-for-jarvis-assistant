/**
 * rag/retrieve.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * query → embed → vector search → manifest join → cited passages.
 *
 * Results are joined to the manifest by fact id, so every passage can name its
 * source file and chunk. A hit with no manifest entry is dropped rather than
 * returned uncited.
 */

import { memoryManager } from '../memory/memoryManager.js';
import { getChunk } from './index.js';

export interface RetrievedPassage {
  source: string;
  chunkIndex: number;
  text: string;
  score: number;
}

export async function retrieveDocuments(query: string, topK = 4, minScore = 0.25): Promise<RetrievedPassage[]> {
  const hits = await memoryManager.searchVector(query, topK * 3);
  const passages: RetrievedPassage[] = [];

  for (const hit of hits ?? []) {
    const factId = (hit as { fact_id?: string }).fact_id;
    if (!factId || !factId.startsWith('doc:')) continue; // not a document chunk
    if (hit.score < minScore) continue;

    const record = getChunk(factId);
    if (!record) continue; // no provenance — do not return it uncited

    passages.push({
      source: record.source,
      chunkIndex: record.chunkIndex,
      text: record.text,
      score: hit.score,
    });
    if (passages.length >= topK) break;
  }

  return passages;
}
