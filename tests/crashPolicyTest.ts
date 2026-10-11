/**
 * tests/crashPolicyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * REL-02: jarvis.ts only logged uncaught exceptions and unhandled rejections,
 * and JARVIS went on in a state nobody knew.
 *
 *   1. a real child process with the policy installed: an uncaught exception
 *      runs the shutdown (state saved) and exits with code 1
 *   2. a shutdown that hangs is cut off; the process still exits with code 1
 *   3. one unhandled rejection is logged and the process goes on; repeated
 *      ones within a minute end it like an exception
 *   4. the supervisor restarts after a crash, stops after a normal exit, and
 *      gives up after too many crashes
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-crash-'));
process.env['JARVIS_DATA_ROOT'] = root;

const { createCrashPolicy } = await import('../system/crashPolicy.js');
const { supervise } = await import('../scripts/superviseJarvis.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const tsx = path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
function child(body: string): { code: number | null; out: string; saved: boolean; ms: number } {
  const marker = path.join(root, `saved-${Math.random().toString(36).slice(2)}.txt`);
  const script = path.join(root, `child-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(script, `
import * as fs from 'fs';
import { createCrashPolicy } from ${JSON.stringify(path.join(repo, 'system', 'crashPolicy.ts'))};
const MARKER = ${JSON.stringify(marker)};
${body}
`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [tsx, script], { encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, saved: fs.existsSync(marker), ms: Date.now() - t0 };
}

console.log('\n=== After an error nothing caught (REL-02) ===\n');

console.log('--- 1. An uncaught exception ---');
let r = child(`
const policy = createCrashPolicy({ shutdown: async () => { fs.writeFileSync(MARKER, 'saved'); } });
process.on('uncaughtException', (e) => policy.onUncaughtException(e));
setTimeout(() => { throw new Error('boom'); }, 10);
setInterval(() => {}, 1000); // would keep running for ever
`);
ok('the shutdown ran (state saved)', r.saved, r.out.slice(-160));
ok('the process exited with code 1', r.code === 1, `code ${r.code}`);

console.log('\n--- 2. A shutdown that hangs ---');
r = child(`
const policy = createCrashPolicy({ shutdown: () => new Promise(() => {}), forceExitMs: 500 });
process.on('uncaughtException', (e) => policy.onUncaughtException(e));
setTimeout(() => { throw new Error('boom'); }, 10);
setInterval(() => {}, 1000);
`);
ok('it is cut off and the process exits with code 1', r.code === 1 && r.ms < 15_000, `code ${r.code}, ${r.ms} ms`);

console.log('\n--- 3. Unhandled rejections ---');
const exits: number[] = [];
let shutdowns = 0;
const logs: string[] = [];
let clock = 0;
const policy = createCrashPolicy({
  shutdown: () => { shutdowns++; },
  exit: (code) => exits.push(code),
  log: (m) => logs.push(m),
  maxRejections: 3,
  windowMs: 60_000,
  now: () => clock,
});
policy.onUnhandledRejection(new Error('a'));
clock += 40_000;
policy.onUnhandledRejection(new Error('b'));
clock += 40_000; // the first is now more than a minute old
policy.onUnhandledRejection(new Error('c'));
await new Promise((res) => setTimeout(res, 20));
ok('isolated rejections are logged, the process goes on', shutdowns === 0 && exits.length === 0 && logs.length === 3, `${logs.length} logged`);
policy.onUnhandledRejection(new Error('d'));
await new Promise((res) => setTimeout(res, 20));
ok('three within a minute: shutdown and exit code 1', shutdowns === 1 && exits[0] === 1, `shutdowns ${shutdowns}, exits ${exits}`);
policy.onUncaughtException(new Error('again'));
await new Promise((res) => setTimeout(res, 20));
ok('a second fatal error does not start a second shutdown', shutdowns === 1);

console.log('\n--- 4. The supervisor ---');
const node = (code: number) => () => spawn(process.execPath, ['-e', `process.exit(${code})`]);
let starts = 0;
let codes = [1, 1, 0];
let end = await supervise({ start: () => { starts++; return node(codes.shift() ?? 0)(); }, baseDelayMs: 10, log: () => {} });
ok('restarts after crashes and stops after a normal exit', starts === 3 && end === 0, `${starts} starts, ended ${end}`);
starts = 0;
end = await supervise({ start: () => { starts++; return node(1)(); }, baseDelayMs: 10, maxRestarts: 2, log: () => {} });
ok('gives up after too many crashes', starts === 3 && end === 1, `${starts} starts, ended ${end}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
