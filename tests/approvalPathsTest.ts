/**
 * tests/approvalPathsTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-102: one way to approve an action, through security/approvalGate.ts.
 *
 * bridge/nodeBridge.ts kept two old approval helpers that nothing called:
 * askForConfirmation() resolved true when "yes" was typed into the console,
 * with no approval record and none of approvalGate's rules;
 * waitForTextConfirmation() did the same for any STT text. One call from new
 * code would have been a second, weaker approval path. With them went dead
 * bridge code: sendToClient() (unused), an "ack" branch for a pendingAcks map
 * that was never created, and a pendingListen flag that was never set.
 *
 * The checks: only approvalGate.ts and jarvis.ts (the command line) read the
 * console; the bridge has none of the removed members; ts-node (unused; tsx
 * runs everything) is not a dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', '_legacy', 'tests', 'scripts', '.git', 'data', 'logs', 'scratchpad']);
const CONSOLE_READERS = new Set(['security/approvalGate.ts', 'jarvis.ts']);

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  const line = `  ${condition ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`;
  if (condition) { console.log(line); passed++; } else { console.error(line); failed++; }
}

console.log('\n=== Approval paths (SEC-102) ===\n');
const readers: string[] = [];
(function walk(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name)); continue; }
    if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) continue;
    const rel = path.relative(repo, path.join(dir, e.name)).split(path.sep).join('/');
    const src = fs.readFileSync(path.join(dir, e.name), 'utf8');
    if (/process\.stdin\.(on|once|addListener|read)\b|createInterface\(\s*\{\s*input:\s*process\.stdin/.test(src) && !CONSOLE_READERS.has(rel)) readers.push(rel);
  }
})(repo);
ok('only approvalGate.ts and jarvis.ts read the console', readers.length === 0, readers.join(', '));

const bridge = fs.readFileSync(path.join(repo, 'bridge', 'nodeBridge.ts'), 'utf8');
for (const name of ['askForConfirmation', 'waitForTextConfirmation', 'sendToClient', 'pendingAcks', 'pendingListen\\b']) {
  ok(`the bridge has no ${name.replace('\\b', '')}`, !new RegExp(`\\b${name}`).test(bridge));
}
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
ok('ts-node is not a dependency', !pkg.dependencies?.['ts-node'] && !pkg.devDependencies?.['ts-node']);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
