/**
 * tests/testScriptIsolationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * TEST-01 (leftover): every package.json script that runs tests runs them
 * through tests/runAll.ts, which gives each test its own empty data folder.
 *
 * `test:voice-core`, `test:pc-control` and `test:all` ran `npx tsx
 * tests/<name>.ts` one after another. None of those tests sets its own data
 * folder, so they used JARVIS's real one: run that way, noThinkMemoryTest
 * wrote memory/jarvis_memory.json, data/runtime/goals.json and
 * data/episodes.jsonl in the JARVIS folder (the owner's memory and goals).
 *
 *   1. no script runs a test file directly
 *   2. `runAll --only=a,b` runs exactly those tests, each in its own folder
 *   3. an unknown name in --only is an error, not a run of nothing
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = createRequire(import.meta.url).resolve('tsx/cli');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Test scripts run in their own data folders (TEST-01) ===\n');

const scripts: Record<string, string> = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).scripts ?? {};
const direct = Object.entries(scripts).filter(([, cmd]) => /tests[\\/](?!runAll\.ts)[\w.-]+\.ts/.test(cmd)).map(([name]) => name);
ok('no package.json script runs a test file directly (only through tests/runAll.ts)', direct.length === 0, direct.join(', '));

const runAll = (...args: string[]) => spawnSync(process.execPath, [tsx, path.join(repo, 'tests', 'runAll.ts'), ...args], {
  cwd: repo, encoding: 'utf8', timeout: 240_000, env: { ...process.env, JARVIS_TEST_FULL_OUTPUT: '' },
});

const two = runAll('--ci', '--only=toolNameListsTest,redactionTest');
const ran = (two.stdout.match(/^\s+(PASS|FAIL|SKIP)\s+(\w+)/gm) ?? []).map((l) => l.trim().split(/\s+/)[1]).sort();
ok('--only runs exactly the named tests', ran.join(',') === 'redactionTest,toolNameListsTest' && /2 file\(s\)/.test(two.stdout), `${ran.join(',')} | exit ${two.status}`);
ok('…and they pass there', two.status === 0, (two.stdout + two.stderr).slice(-200));

const typo = runAll('--ci', '--only=toolNameListsTest,noSuchTest');
ok('an unknown name is an error, not a run of nothing', typo.status !== 0 && /noSuchTest/.test(typo.stdout + typo.stderr), `exit ${typo.status}: ${(typo.stdout + typo.stderr).trim().split('\n').slice(-1)[0]}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
