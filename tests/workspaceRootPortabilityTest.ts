/**
 * tests/workspaceRootPortabilityTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS-001 / JARVIS-001b regression test.
 *
 * Proves that the file-containment boundary:
 *   1. follows the workspace root wherever it is (no hard-coded drive path);
 *   2. blocks Windows-style absolute paths on a POSIX host, where
 *      `path.isAbsolute()` reports them as relative;
 *   3. still ALLOWS legitimate in-workspace paths — i.e. the fix did not simply
 *      turn every decision into a denial.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getWorkspaceRoot,
  isForeignWindowsAbsolute,
  isPathInside,
  isProtectedSystemPath,
} from '../core/workspaceRoot.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

console.log('\n=== Workspace Root Portability Test ===\n');

// ── 1. No hard-coded developer path survives ────────────────────────────────
const policySource = fs.readFileSync(
  path.join(getWorkspaceRoot(), 'security', 'workspacePathPolicy.ts'),
  'utf8',
);
ok('workspacePathPolicy contains no hard-coded W:\\ literal', !/W:\\\\/.test(policySource));

// ── 2. The root follows JARVIS_WORKSPACE_ROOT ───────────────────────────────
const original = process.env['JARVIS_WORKSPACE_ROOT'];
const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-root-a-'));
const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-root-b-'));

try {
  process.env['JARVIS_WORKSPACE_ROOT'] = rootA;
  ok('root honours JARVIS_WORKSPACE_ROOT (root A)', getWorkspaceRoot() === path.resolve(rootA));

  process.env['JARVIS_WORKSPACE_ROOT'] = rootB;
  ok('root honours JARVIS_WORKSPACE_ROOT (root B)', getWorkspaceRoot() === path.resolve(rootB));

  // ── 3. Containment is evaluated against whichever root is active ──────────
  ok(
    'containment holds from root A',
    isPathInside(rootA, path.join(rootA, 'data', 'x.txt')) && !isPathInside(rootA, path.join(rootB, 'x.txt')),
  );
  ok(
    'containment holds from root B',
    isPathInside(rootB, path.join(rootB, 'data', 'x.txt')) && !isPathInside(rootB, path.join(rootA, 'x.txt')),
  );

  // ── 4. Prefix confusion is rejected ──────────────────────────────────────
  ok(
    'sibling directory sharing a name prefix is NOT contained',
    !isPathInside(path.join(rootA, 'Desktop'), path.join(rootA, 'Desktop-evil', 'x.txt')),
  );
} finally {
  if (original === undefined) delete process.env['JARVIS_WORKSPACE_ROOT'];
  else process.env['JARVIS_WORKSPACE_ROOT'] = original;
  fs.rmSync(rootA, { recursive: true, force: true });
  fs.rmSync(rootB, { recursive: true, force: true });
}

// ── 5. Windows-absolute paths are recognised on this host ───────────────────
for (const p of ['C:\\Windows\\win.ini', 'c:/windows/system32', 'D:\\data\\x.txt', '\\\\server\\share\\x']) {
  ok(`"${p}" is recognised as a foreign absolute path`, isForeignWindowsAbsolute(p) || path.isAbsolute(p));
}

// ── 6. Protected system locations, with and without trailing separators ─────
for (const p of [
  'C:\\Windows',
  'C:\\Windows\\',
  'C:\\Windows\\Temp\\jarvis.txt',
  'c:/program files/app',
  'C:\\Users\\bob\\AppData\\Roaming',
  '/etc/passwd',
]) {
  ok(`"${p}" is a protected system path`, isProtectedSystemPath(p));
}

// ── 7. NEGATIVE CONTROLS — the fix must not deny everything ─────────────────
for (const p of ['data/goals.json', 'memory/userMemory.json', 'README.md', 'skills/automation/skill.ts']) {
  ok(`"${p}" is NOT wrongly flagged as a system path`, !isProtectedSystemPath(p));
  ok(`"${p}" is NOT wrongly flagged as foreign-absolute`, !isForeignWindowsAbsolute(p));
}
ok(
  'a normal relative file resolves inside the real workspace',
  isPathInside(getWorkspaceRoot(), path.resolve(getWorkspaceRoot(), 'data/goals.json')),
);
// "C:" as a substring of a filename must not trigger the drive-letter rule.
ok('"notes-C:whatever.txt" is not treated as a drive path', !isForeignWindowsAbsolute('notes-C:whatever.txt'));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
