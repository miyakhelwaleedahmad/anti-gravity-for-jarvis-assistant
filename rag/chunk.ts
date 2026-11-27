/**
 * rag/chunk.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Splits document text into overlapping chunks for embedding.
 *
 * Chunking is paragraph-aware: it packs whole paragraphs up to the target size
 * rather than cutting mid-sentence, because a chunk that begins halfway through
 * a sentence retrieves poorly. Only a single paragraph larger than the target is
 * hard-split.
 */

/** Rough token estimate. The embedding model is not a BPE tokenizer we can call
 *  cheaply, and ~4 characters per token is close enough for sizing chunks. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Chunk {
  text: string;
  index: number;
}

export interface ChunkOptions {
  /** Target chunk size in estimated tokens. */
  targetTokens?: number;
  /** Overlap between consecutive chunks, in estimated tokens. */
  overlapTokens?: number;
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const targetTokens = options.targetTokens ?? 512;
  const overlapTokens = options.overlapTokens ?? 64;
  const targetChars = targetTokens * 4;
  const overlapChars = Math.min(overlapTokens * 4, Math.floor(targetChars / 2));

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: Chunk[] = [];
  let buffer = '';

  const flush = (): void => {
    const body = buffer.trim();
    if (!body) return;
    chunks.push({ text: body, index: chunks.length });
    // Carry the tail of this chunk into the next so a fact spanning a boundary
    // is still retrievable.
    buffer = overlapChars > 0 ? body.slice(-overlapChars) : '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > targetChars) {
      flush();
      // A single oversized paragraph is hard-split; nothing better is available.
      for (let i = 0; i < paragraph.length; i += targetChars - overlapChars) {
        chunks.push({ text: paragraph.slice(i, i + targetChars).trim(), index: chunks.length });
      }
      buffer = '';
      continue;
    }
    if (buffer && buffer.length + paragraph.length + 2 > targetChars) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();

  return chunks.filter((c) => c.text.length > 0).map((c, i) => ({ text: c.text, index: i }));
}
