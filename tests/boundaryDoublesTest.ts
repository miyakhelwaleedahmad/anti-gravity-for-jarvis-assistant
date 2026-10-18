/**
 * tests/boundaryDoublesTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-healing Phase 5 guard: a test may replace a speech or tool-registry
 * boundary only if tests/boundary-doubles.json lists it, with what it replaces
 * and why.
 *
 * Stand-ins replaced exactly the boundary that was broken before: eleven tests
 * stubbed speak() and hid BUG-02, and tests/fakeTts.ts replaced
 * speakToClients() and hid VOICE-001. This check does not forbid stand-ins;
 * it makes each one visible and argued, and keeps the tests that cross the
 * real boundary in place.
 *
 *   1. Every test file that assigns speak, speakToClients, sendToRole or a
 *      toolRegistryV2 method, or calls installFakeTts, is listed, with
 *      exactly the boundaries it replaces and a reason.
 *   2. No listed entry is stale (the file still exists and still replaces
 *      what is listed).
 *   3. The tests that cross the real boundaries exist.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

/** The boundaries, as the source text that replaces them. */
const PATTERNS: [string, RegExp][] = [
  ['speak', /\.speak\s*=(?!=)/g],
  ['speakToClients', /speakToClients\s*=(?!=)/g],
  ['sendToRole', /sendToRole\s*=(?!=)/g],
  ['installFakeTts', /installFakeTts\(/g],
];
const REGISTRY = /(?:\(toolRegistryV2 as any\)|toolRegistryV2)\.(\w+)\s*=(?!=)/g;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fixtures' && e.name !== 'node_modules') out.push(...testFiles(p)); }
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** What a file replaces, from its source (comments removed so a mention is not a replacement). */
export function replacedIn(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const found = new Set<string>();
  for (const [name, re] of PATTERNS) if (code.match(re)) found.add(name);
  for (const m of code.matchAll(REGISTRY)) found.add(`registry:${m[1]}`);
  return [...found].sort();
}

const allow = JSON.parse(fs.readFileSync(path.join(here, 'boundary-doubles.json'), 'utf8')) as {
  files: Record<string, { replaces: string[]; reason: string }>;
  realBoundaryTests: Record<string, string[]>;
};

// ── 0. The detector itself ───────────────────────────────────────────────────
console.log('\n--- 0. The detector ---');
ok('finds a replaced speakToClients', replacedIn('nodeBridge.speakToClients = () => {};').join() === 'speakToClients');
ok('finds a replaced registry method', replacedIn('(toolRegistryV2 as any).execute = async () => ({});').join() === 'registry:execute');
ok('ignores a comparison and a comment', replacedIn('if (a.speak === b) {}\n// nodeBridge.speakToClients = x').length === 0);

// ── 1. Every replacement is listed ───────────────────────────────────────────
console.log('\n--- 1. Every replacement is listed, with a reason ---');
const self = path.join(here, 'boundaryDoublesTest.ts');
const seen = new Map<string, string[]>();
for (const file of testFiles(here)) {
  if (file === self) continue;
  const rel = path.relative(repo, file).split(path.sep).join('/');
  const replaces = replacedIn(fs.readFileSync(file, 'utf8'));
  if (replaces.length) seen.set(rel, replaces);
}
for (const [rel, replaces] of [...seen.entries()].sort()) {
  const entry = allow.files[rel];
  ok(`${rel} (${replaces.join(', ')}) is listed with a reason`,
    !!entry && entry.replaces.slice().sort().join() === replaces.join() && entry.reason.trim().length >= 30,
    entry ? `listed as ${entry.replaces.join(', ')}; found ${replaces.join(', ')}` : 'not in tests/boundary-doubles.json');
}

// ── 2. No stale entries ──────────────────────────────────────────────────────
console.log('\n--- 2. No stale entries ---');
const stale = Object.keys(allow.files).filter((rel) => !seen.has(rel));
ok('every listed file exists and still replaces a boundary', stale.length === 0, stale.join(', '));

// ── 3. The real boundaries are still tested ─────────────────────────────────
console.log('\n--- 3. The real boundaries are still tested ---');
for (const [kind, tests] of Object.entries(allow.realBoundaryTests)) {
  for (const t of tests) {
    const file = path.join(here, `${t}.ts`);
    const replaces = fs.existsSync(file) ? replacedIn(fs.readFileSync(file, 'utf8')) : ['(missing)'];
    // A speech test replaces nothing; a registry test may stand in for tts.py, never for the registry.
    const crossesIt = kind === 'speech' ? replaces.length === 0 : !replaces.some((r) => r.startsWith('registry:') || r === '(missing)');
    ok(`${kind}: ${t} exists and crosses the real boundary`, crossesIt, replaces.join(', '));
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
