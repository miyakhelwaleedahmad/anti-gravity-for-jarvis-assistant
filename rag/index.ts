/**
 * rag/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The chunk manifest: the durable record of what has been ingested.
 *
 * The vector service stores an embedding and a `fact_id` per entry. For document
 * chunks that id is `doc:<sourceHash>:<chunkIndex>`, and this manifest maps it
 * back to the source path, the chunk index, and the chunk text — so a retrieval
 * hit can be cited rather than returned as an anonymous fragment.
 *
 * Written atomically for the same reason the vector store is: an interrupted
 * write must not leave a manifest that is loaded as truth next time.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { dataRoot, getWorkspaceRoot } from '../core/workspaceRoot.js';

export interface ChunkRecord {
  factId: string;
  source: string;      // path relative to the workspace root
  chunkIndex: number;
  text: string;
  ingestedAt: number;
}

interface Manifest {
  version: 1;
  chunks: Record<string, ChunkRecord>;
}

function manifestPath(): string {
  return path.join(dataRoot(getWorkspaceRoot()), 'data', 'rag', 'manifest.json');
}

export function sourceHash(relativeSource: string): string {
  return crypto.createHash('sha1').update(relativeSource).digest('hex').slice(0, 12);
}

export function makeFactId(relativeSource: string, chunkIndex: number): string {
  return `doc:${sourceHash(relativeSource)}:${chunkIndex}`;
}

export function loadManifest(): Manifest {
  try {
    const raw = fs.readFileSync(manifestPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed?.version === 1 && parsed.chunks) return parsed;
    console.warn('[RAG] Manifest has an unexpected shape; starting a new one.');
  } catch {
    // No manifest yet, or it is unreadable — either way, start clean. Nothing is
    // deleted: the vector store is the other half and is rebuilt by re-ingesting.
  }
  return { version: 1, chunks: {} };
}

export function saveManifest(manifest: Manifest): void {
  const target = manifestPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

export function upsertChunks(records: ChunkRecord[]): void {
  const manifest = loadManifest();
  for (const record of records) manifest.chunks[record.factId] = record;
  saveManifest(manifest);
}

export function getChunk(factId: string): ChunkRecord | undefined {
  return loadManifest().chunks[factId];
}

export function listSources(): { source: string; chunks: number }[] {
  const counts = new Map<string, number>();
  for (const record of Object.values(loadManifest().chunks)) {
    counts.set(record.source, (counts.get(record.source) ?? 0) + 1);
  }
  return [...counts.entries()].map(([source, chunks]) => ({ source, chunks }));
}
