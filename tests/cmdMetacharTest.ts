/**
 * tests/cmdMetacharTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-20: run_command passes an allow-listed command to the shell, on Windows
 * cmd.exe. The allow-list blocked & | ; < > ` $ but not cmd.exe's own:
 *   %NAME%, %NAME:~0,5%   insert an environment variable (`git log
 *                         --format=%OPENAI_API_KEY%` printed the key before
 *                         SEC-06 took keys out of the child's environment)
 *   ^                     escapes the next character, so the allow-list reads
 *                         one command and cmd.exe runs another
 *   !NAME!                variables again, with delayed expansion
 *
 *   1. commands with them are refused by the allow-list and the risk engine
 *   2. the usual developer commands still pass (git log --format=%h %s too)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cmd-meta-'));
process.env['JARVIS_DATA_ROOT'] = workspace;

const { validateDeveloperCommand } = await import('../tools/terminalTool.js');
const { assessRisk } = await import('../security/riskEngine.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== cmd.exe escapes and variables in run_command (SEC-20) ===\n');

console.log('--- 1. Refused ---');
const REFUSED = [
  'git log --format=%OPENAI_API_KEY%',
  'git log -1 --format=%PATH:~0,20%',
  'git log --grep=%USERPROFILE%',
  'git show HEAD^',
  'git log --grep=!TEMP!',
  'npx tsx tests/a^b.ts',
];
for (const c of REFUSED) {
  const v = validateDeveloperCommand(c);
  ok(`allow-list refuses: ${c}`, !v.allowed && /cmd\.exe reads \^, ! and %NAME%/.test(v.reason), v.reason);
  const a = assessRisk({ tool: 'run_command', args: { command: c }, baseRisk: 3 });
  ok(`…and the risk engine does not treat it as an allow-listed command`, !!a.refused || a.level >= 3, a.refused ?? `level ${a.level}`);
}

console.log('\n--- 2. Still allowed ---');
for (const c of ['git status', 'git log --oneline -5', 'git log -3 --format=%h %s', 'git show HEAD~1', 'git diff', 'npx tsc --noEmit', 'npm run test']) {
  const v = validateDeveloperCommand(c);
  ok(`allowed: ${c}`, v.allowed, v.reason);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
