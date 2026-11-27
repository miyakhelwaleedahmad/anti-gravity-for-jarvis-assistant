/**
 * tests/startScriptTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * `pnpm start` must start JARVIS from a fresh clone.
 *
 * It ran `node dist/jarvis.js`: dist/ is git-ignored, so after a pull it did
 * not exist ("Cannot find module …\dist\jarvis.js"). Built, it still was not
 * JARVIS: the workspace root became dist/ (an empty memory and data folder)
 * and the skills and PowerShell scripts are not compiled into dist/.
 *
 *   1. start and dev run a file that is in the repository, through tsx.
 *   2. That file is the entry point that exists in the checkout (jarvis.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

const scripts = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).scripts as Record<string, string>;
const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).split(/\r?\n/));
const ignored = (f: string): boolean => {
  try { execFileSync('git', ['check-ignore', '-q', f], { cwd: repo }); return true; } catch { return false; }
};

for (const name of ['start', 'dev']) {
  const cmd = scripts[name] ?? '';
  const entry = /^tsx\s+(\S+\.ts)$/.exec(cmd)?.[1];
  ok(`${name} runs a TypeScript entry with tsx (got "${cmd}")`, !!entry);
  if (!entry) continue;
  ok(`${name}: ${entry} is in the repository (present after a fresh clone)`, tracked.has(entry) && fs.existsSync(path.join(repo, entry)));
  ok(`${name}: ${entry} is not in an ignored build folder`, !ignored(entry));
}
ok('start and dev start the same entry point', scripts['start'] === scripts['dev'], `${scripts['start']} / ${scripts['dev']}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
