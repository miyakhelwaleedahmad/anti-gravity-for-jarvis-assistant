/**
 * tests/ragPipelineTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS-026 — document RAG: ingestion, parsing, chunking, and the manifest join
 * that lets a retrieved passage cite its source.
 *
 * Embedding itself needs the running vector service, so this covers everything
 * around it: chunk boundaries and overlap, parser support and refusal, the
 * fact-id scheme, manifest round-tripping, and — importantly — that ingestion
 * honours the workspace containment boundary.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chunkText, estimateTokens } from '../rag/chunk.js';
import { isSupported, parseFile } from '../rag/parse.js';
import { makeFactId, upsertChunks, getChunk, listSources } from '../rag/index.js';
import { ingestPath } from '../rag/ingest.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`);
    failed++;
  }
}

console.log('\n=== RAG Pipeline Test ===\n');

console.log('--- Chunking ---');
{
  ok('empty text yields no chunks', chunkText('').length === 0);

  const short = chunkText('One short paragraph.');
  ok('a short document is one chunk', short.length === 1, `${short.length}`);
  ok('chunk text is preserved', short[0]?.text === 'One short paragraph.');

  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with enough words in it to take up a reasonable amount of space.`).join('\n\n');
  const many = chunkText(paragraphs, { targetTokens: 64, overlapTokens: 16 });
  ok('a long document is split', many.length > 1, `${many.length} chunks`);
  ok('chunk indices are sequential from 0',
     many.every((c, i) => c.index === i), many.map((c) => c.index).join(','));
  ok('every chunk has content', many.every((c) => c.text.trim().length > 0));
  ok('chunks respect the target size',
     many.every((c) => estimateTokens(c.text) <= 64 * 1.6), 'within tolerance');

  // Overlap: consecutive chunks should share a tail/head.
  const overlapped = chunkText(paragraphs, { targetTokens: 64, overlapTokens: 24 });
  const sharesText = overlapped.length > 1 &&
    overlapped.slice(1).some((c, i) => {
      const prevTail = overlapped[i]!.text.slice(-40);
      return prevTail.length > 0 && c.text.includes(prevTail.slice(0, 20));
    });
  ok('consecutive chunks overlap', sharesText);

  const huge = chunkText('x'.repeat(20_000), { targetTokens: 128, overlapTokens: 16 });
  ok('an oversized single paragraph is hard-split', huge.length > 1, `${huge.length} chunks`);
}

console.log('\n--- Parsing ---');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rag-parse-'));
  try {
    const txt = path.join(dir, 'notes.txt');
    fs.writeFileSync(txt, 'The entry camera sits at the north door.');
    ok('.txt is supported', isSupported(txt));
    const parsedTxt = parseFile(txt);
    ok('.txt parses', parsedTxt.ok && parsedTxt.text?.includes('north door') === true);

    const md = path.join(dir, 'doc.md');
    fs.writeFileSync(md, '# Heading\n\nProse body.\n\n```\ncode block\n```\n');
    const parsedMd = parseFile(md);
    ok('.md parses', parsedMd.ok === true);
    ok('markdown heading markers are stripped', parsedMd.text?.includes('# Heading') === false);
    ok('fenced code is stripped', parsedMd.text?.includes('code block') === false);
    ok('prose survives', parsedMd.text?.includes('Prose body.') === true);

    const pdf = path.join(dir, 'manual.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4 binary');
    ok('.pdf is not silently accepted', isSupported(pdf) === false);
    const parsedPdf = parseFile(pdf);
    ok('.pdf is refused with a clear reason',
       parsedPdf.ok === false && /not supported/i.test(parsedPdf.reason ?? ''),
       parsedPdf.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n--- Fact ids and the manifest ---');
{
  const idA = makeFactId('docs/notes.md', 0);
  const idB = makeFactId('docs/notes.md', 1);
  const idC = makeFactId('docs/other.md', 0);
  ok('fact ids are namespaced to documents', idA.startsWith('doc:'), idA);
  ok('chunk index distinguishes ids', idA !== idB);
  ok('source distinguishes ids', idA !== idC);
  ok('ids are stable', makeFactId('docs/notes.md', 0) === idA);

  upsertChunks([{ factId: idA, source: 'docs/notes.md', chunkIndex: 0, text: 'chunk zero', ingestedAt: Date.now() }]);
  const back = getChunk(idA);
  ok('a chunk round-trips through the manifest', back?.text === 'chunk zero', back?.text);
  ok('provenance is retained', back?.source === 'docs/notes.md');
  ok('sources can be listed', listSources().some((s) => s.source === 'docs/notes.md'));
}

console.log('\n--- Ingestion honours the workspace boundary ---');
{
  const outside = await ingestPath('C:\\Windows\\System32\\drivers\\etc\\hosts');
  ok('a Windows system path is refused', outside.ok === false, outside.error);
  ok('nothing was ingested from it', outside.chunksEmbedded === 0);

  const traversal = await ingestPath('../../../etc/passwd');
  ok('path traversal is refused', traversal.ok === false, traversal.error);

  const missing = await ingestPath('does/not/exist.txt');
  ok('a missing path reports clearly', missing.ok === false && /Nothing at/.test(missing.error ?? ''));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
