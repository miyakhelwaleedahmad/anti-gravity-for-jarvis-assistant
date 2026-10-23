/**
 * tests/pythonUtf8Test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-21: the Python services' log lines arrived garbled: "�", "✔",
 * "\U0001f3a4". On Windows Python writes to a pipe in the ANSI code page;
 * NodeBridge reads UTF-8.
 *
 *   1. The voice services and the vector service start with PYTHONUTF8=1
 *      and PYTHONIOENCODING=utf-8 (PYTHON_UTF8).
 *   2. A real Python with a non-UTF-8 locale (as on Windows) prints ✔ and 🎤
 *      through a pipe intact with those settings, and not without them.
 * Part 2 is skipped if no python3 is installed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const { PYTHON_UTF8, childEnv } = await import('../system/childEnv.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

console.log('\n--- 1. The Python services get UTF-8 output ---');
ok('PYTHON_UTF8 sets PYTHONUTF8=1 and PYTHONIOENCODING=utf-8', PYTHON_UTF8.PYTHONUTF8 === '1' && PYTHON_UTF8.PYTHONIOENCODING === 'utf-8');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['self_healing/selfHealingManager.ts', 'memory/vectorMemorySupervisor.ts']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  ok(`${f} starts Python with it`, /spawn\([\s\S]{0,300}env: childEnv\(\{ \.\.\.PYTHON_UTF8,/.test(src));
}

console.log('\n--- 2. A real Python, non-UTF-8 locale ---');
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
if (!python) {
  console.log('  SKIP: no python3 here');
} else {
  const text = 'Wake word ✔ \u{1F3A4}';
  const script = `import sys; print(${JSON.stringify(text)})`;
  // An ASCII locale with no coercion: Python's pipe encoding is not UTF-8, as on Windows.
  const base = { LC_ALL: 'C', LANG: 'C', PYTHONCOERCECLOCALE: '0', PYTHONUTF8: '0' };
  const run = (extra: Record<string, string>) => spawnSync(python, ['-c', script], { env: childEnv({ ...base, ...extra }), encoding: 'utf8' });
  const without = run({});
  ok('(setup) without the settings the text does not arrive intact', without.stdout.trim() !== text, JSON.stringify(without.stdout || without.stderr).slice(0, 120));
  const withIt = run({ ...PYTHON_UTF8 });
  ok('with PYTHON_UTF8 it arrives intact', withIt.stdout.trim() === text, JSON.stringify(withIt.stdout || withIt.stderr).slice(0, 120));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
