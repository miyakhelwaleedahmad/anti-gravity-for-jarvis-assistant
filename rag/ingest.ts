/**
 * rag/ingest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * source → parse → chunk → embed → manifest
 *
 * Ingestion paths go through the same workspace containment guard as every other
 * file operation. Ingesting is a read of arbitrary user-named paths, so it is
 * exactly the kind of operation that boundary exists for.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from '../core/workspaceRoot.js';
import { resolveWorkspacePath } from '../security/workspacePathPolicy.js';
import { memoryManager } from '../memory/memoryManager.js';
import { chunkText } from './chunk.js';
import { isSupported, parseFile } from './parse.js';
import { makeFactId, upsertChunks, type ChunkRecord } from './index.js';

export interface IngestResult {
  ok: boolean;
  filesIngested: number;
  chunksEmbedded: number;
  skipped: { path: string; reason: string }[];
  error?: string;
}

function collectFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];

  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (isSupported(full)) found.push(full);
    }
  };
  walk(target);
  return found;
}

export async function ingestPath(rawPath: string): Promise<IngestResult> {
  const skipped: { path: string; reason: string }[] = [];

  const check = resolveWorkspacePath(rawPath, 'read', 'ingest_documents');
  if (!check.allowed || !check.resolvedPath) {
    return { ok: false, filesIngested: 0, chunksEmbedded: 0, skipped, error: check.reason ?? 'Path refused.' };
  }
  const resolved = check.resolvedPath;

  if (!fs.existsSync(resolved)) {
    return { ok: false, filesIngested: 0, chunksEmbedded: 0, skipped, error: `Nothing at "${rawPath}".` };
  }

  const files = collectFiles(resolved);
  if (files.length === 0) {
    return { ok: false, filesIngested: 0, chunksEmbedded: 0, skipped, error: 'No supported documents found (.txt, .md, .json, .csv, .log).' };
  }

  const root = getWorkspaceRoot();
  let filesIngested = 0;
  let chunksEmbedded = 0;

  for (const file of files) {
    const parsed = parseFile(file);
    if (!parsed.ok || !parsed.text) {
      skipped.push({ path: path.relative(root, file), reason: parsed.reason ?? 'unreadable' });
      continue;
    }

    const relative = path.relative(root, file).replace(/\\/g, '/');
    const chunks = chunkText(parsed.text);
    if (chunks.length === 0) {
      skipped.push({ path: relative, reason: 'empty after parsing' });
      continue;
    }

    const records: ChunkRecord[] = [];
    for (const chunk of chunks) {
      const factId = makeFactId(relative, chunk.index);
      try {
        // Embedded through memoryManager so the existing Redis embedding cache,
        // circuit breaker and health checks all apply.
        await memoryManager.embed(chunk.text, factId);
        records.push({ factId, source: relative, chunkIndex: chunk.index, text: chunk.text, ingestedAt: Date.now() });
        chunksEmbedded++;
      } catch (err) {
        skipped.push({ path: `${relative}#${chunk.index}`, reason: `embedding failed: ${(err as Error).message}` });
      }
    }

    if (records.length > 0) {
      upsertChunks(records);
      filesIngested++;
    }
  }

  return { ok: chunksEmbedded > 0, filesIngested, chunksEmbedded, skipped };
}
