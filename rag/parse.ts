/**
 * rag/parse.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns a file into plain text for chunking.
 *
 * Plain text and Markdown are supported with no dependencies. PDF is recognised
 * and refused with a clear message rather than silently returning binary noise —
 * adding a PDF parser is a dependency decision for the project owner, not
 * something to smuggle in here.
 */

import * as fs from 'fs';
import * as path from 'path';

export const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log']);
const RECOGNISED_BUT_UNSUPPORTED = new Set(['.pdf', '.docx', '.doc', '.pptx', '.xlsx']);

export interface ParseResult {
  ok: boolean;
  text?: string;
  reason?: string;
}

export function isSupported(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function parseFile(filePath: string): ParseResult {
  const ext = path.extname(filePath).toLowerCase();

  if (RECOGNISED_BUT_UNSUPPORTED.has(ext)) {
    return {
      ok: false,
      reason: `${ext} is not supported — no parser for it is installed. Convert the file to .txt or .md first.`,
    };
  }
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `Unsupported file type "${ext || '(none)'}".` };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    // Markdown: strip code fences and heading markers so retrieval matches prose
    // rather than syntax.
    const text = ext === '.md' || ext === '.markdown'
      ? raw.replace(/```[\s\S]*?```/g, ' ').replace(/^#{1,6}\s+/gm, '')
      : raw;
    return { ok: true, text };
  } catch (err) {
    return { ok: false, reason: `Could not read the file: ${(err as Error).message}` };
  }
}
