/**
 * tests/serviceLogLabelTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Startup logs that looked like failures:
 *
 *  1. Every stderr line of the vector memory service printed as
 *     "[VectorAPI:ERR]" — "VectorMemory initialized", "Started server
 *     process", progress bars — because Python logging writes to stderr.
 *  2. stt.py printed one "HTTP Request: GET https://huggingface.co/..." line
 *     per model-file check on every start.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Service Log Label Test ===\n');

const supervisor: any = await import('../memory/vectorMemorySupervisor.js');
const isError: ((line: string) => boolean) | undefined = supervisor.isVectorErrorLine;
ok('the vector service labels lines by what they say', typeof isError === 'function');

if (typeof isError === 'function') {
  console.log('--- 1. Normal startup lines are not errors ---');
  for (const line of [
    '[VectorMemory] VectorMemory initialized (empty).',
    'INFO:     Started server process [7656]',
    'INFO:     Waiting for application startup.',
    '[VectorMemory] Loading embedding model: all-MiniLM-L6-v2',
    'Loading weights:  25%|##5       | 26/103 [00:00<00:00, 79.07it/s]',
    'Warning: You are sending unauthenticated requests to the HF Hub.',
    'vectorMemory.py:543: PydanticDeprecatedSince20: `min_items` is deprecated. See https://errors.pydantic.dev/2.12/migration/',
  ]) {
    ok(`not an error: ${line.slice(0, 50)}`, !isError(line));
  }

  console.log('\n--- 2. Real problems still are ---');
  for (const line of [
    'Traceback (most recent call last):',
    "ModuleNotFoundError: No module named 'fastapi'",
    'RuntimeError: CUDA out of memory',
    '[VectorMemory] ERROR: could not open store',
    '[VectorMemory] Failed to load embedding model',
  ]) {
    ok(`an error: ${line.slice(0, 50)}`, isError(line));
  }
}

console.log('\n--- 3. stt.py does not log every HuggingFace request ---');
const stt = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'voice', 'stt.py'), 'utf8');
ok('httpx, httpcore and huggingface_hub are set to WARNING',
  /for _noisy in \("httpx", "httpcore", "huggingface_hub"[^)]*\):\s*\n\s*logging\.getLogger\(_noisy\)\.setLevel\(logging\.WARNING\)/.test(stt));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
