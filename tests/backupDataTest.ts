/**
 * tests/backupDataTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * `pnpm backup` (backup.ts) copies memory/ and data/ outside the project.
 * Runs it as a separate process against a throwaway project folder
 * (JARVIS_WORKSPACE_ROOT) — never the real one.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { getWorkspaceRoot } from '../core/workspaceRoot.js';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const script = path.join(getWorkspaceRoot(), 'backup.ts');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-backup-'));
const project = path.join(sandbox, 'project');
const files: Record<string, string> = {
  'memory/jarvis_memory.json': '{"longTerm":[{"fact":"favourite food is biryani"}]}',
  'data/runtime/goals.json': '{"goals":[1,2,3]}',
  'data/vector/texts.json': '["a","b"]',
  'data/logs/today.log': 'noise',
};
for (const [rel, body] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
  fs.writeFileSync(path.join(project, rel), body);
}

function runBackup(...args: string[]) {
  return spawnSync(process.execPath, [tsxCli, script, ...args], {
    env: { ...process.env, JARVIS_WORKSPACE_ROOT: project },
    encoding: 'utf8',
  });
}

console.log('\n=== Backup Data Test ===\n');

const run = runBackup();
ok('exits 0', run.status === 0, (run.stderr || run.stdout).trim().slice(0, 120));
const base = path.join(sandbox, 'jarvis-backups');
const stamps = fs.existsSync(base) ? fs.readdirSync(base) : [];
ok('lands next to the project, in jarvis-backups/<timestamp>', stamps.length === 1 && /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/.test(stamps[0]!), stamps.join(','));
const dest = path.join(base, stamps[0] ?? '');
for (const rel of ['memory/jarvis_memory.json', 'data/runtime/goals.json', 'data/vector/texts.json']) {
  const copy = path.join(dest, rel);
  ok(`${rel} copied byte for byte`, fs.existsSync(copy) && fs.readFileSync(copy, 'utf8') === files[rel]);
}
ok('data/logs is skipped', !fs.existsSync(path.join(dest, 'data', 'logs')));
ok('the project itself is untouched', Object.entries(files).every(([rel, body]) => fs.readFileSync(path.join(project, rel), 'utf8') === body));
ok('the report names the destination', run.stdout.includes(dest));

const custom = path.join(sandbox, 'elsewhere');
const run2 = runBackup(custom);
ok('a destination folder can be given', run2.status === 0 && fs.readdirSync(custom).length === 1);

const inside = runBackup(path.join(project, 'backups'));
ok('backing up into the project itself is refused', inside.status === 1 && inside.stderr.includes('Refusing'));

try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use by a child process; the runner clears its temp folder */ }
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
