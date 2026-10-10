/**
 * tests/goalManagerInitTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * goalManager.init() runs once (docs/PROVIDER_HEALTH_AUDIT.md §4, item 17).
 *
 * jarvis.ts and the Orchestrator constructor both call goalManager.init() at
 * startup ("[GoalManager] ✅ Initialized" appeared twice in the log). init()
 * had no guard: each call opened a new database object on the same file,
 * re-read it and wrote it, so a goal created after the first call but before
 * the second was dropped from memory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-goals-'));
process.env['JARVIS_DATA_ROOT'] = tmp;
process.env['JARVIS_WORKSPACE_ROOT'] = tmp;

const { GoalManager } = await import('../core/goalManager.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const lines: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { lines.push(a.join(' ')); realLog(...a); };

console.log('\n=== GoalManager init ===\n');

console.log('--- Two callers at startup, at the same time ---');
{
  const gm = new GoalManager();
  lines.length = 0;
  await Promise.all([gm.init(), gm.init()]);
  const inits = lines.filter((l) => /\[GoalManager\] ✅ Initialized/.test(l)).length;
  ok('initialised once, not twice', inits === 1, `${inits} time(s)`);
}

console.log('\n--- A goal created between the two calls ---');
{
  const gm = new GoalManager();
  await gm.init();
  const g = await gm.createGoal('remember to back up the project', 'cli');
  await gm.init(); // the second caller
  ok('the goal is still there after the second init()', gm.getStats().total === 1 && !!gm.getGoal?.(g.id), `${gm.getStats().total} goal(s)`);
}

console.log = realLog;
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
