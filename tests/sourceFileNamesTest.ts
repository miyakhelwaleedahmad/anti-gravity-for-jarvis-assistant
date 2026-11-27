/**
 * tests/sourceFileNamesTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCH-02: two source files with the same name and different jobs.
 *
 * core/recoveryPlanner.ts proposes repairs when a task step fails;
 * self_healing/recoveryPlanner.ts plans restarts of failed services. With one
 * name, "recoveryPlanner" in a log, a search or a review meant either. The
 * step one is now core/stepRecovery.ts.
 *
 * The check: no two source files share a name, apart from the folder-entry
 * conventions (index.ts, and skill.ts in each skill folder).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '_legacy', 'tests', '.git', 'data', 'logs', 'scratchpad']);
const CONVENTIONS = new Set(['index.ts', 'skill.ts']);

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  const line = `  ${condition ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`;
  if (condition) { console.log(line); passed++; } else { console.error(line); failed++; }
}

const byName = new Map<string, string[]>();
(function walk(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name)); continue; }
    if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts') || CONVENTIONS.has(e.name)) continue;
    const rel = path.relative(repo, path.join(dir, e.name)).split(path.sep).join('/');
    byName.set(e.name, [...(byName.get(e.name) ?? []), rel]);
  }
})(repo);

console.log('\n=== Source file names (ARCH-02) ===\n');
const dupes = [...byName.entries()].filter(([, files]) => files.length > 1);
ok('(setup) source files found', byName.size > 100, `${byName.size}`);
ok('no two source files share a name', dupes.length === 0, dupes.map(([, f]) => f.join(' + ')).join('; '));
ok('step recovery is core/stepRecovery.ts', fs.existsSync(path.join(repo, 'core', 'stepRecovery.ts')));
ok('service recovery keeps self_healing/recoveryPlanner.ts', fs.existsSync(path.join(repo, 'self_healing', 'recoveryPlanner.ts')));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
