/**
 * tests/goalRuntimeMigrationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DATA-01 — live goals must never be written to a git-tracked file.
 *
 * data/goals.json is tracked. The app used to rewrite it on every startup, so
 * live state was part of the repository, and untracking it recorded a deletion
 * that removed it from every working copy that merged it. Goals now live in
 * data/runtime/goals.json (gitignored), seeded once from data/goals.json by a
 * copy that can never overwrite.
 *
 * Hermetic: every scenario runs in a temporary JARVIS_WORKSPACE_ROOT, so real
 * data is never read or written.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GoalManager } from '../core/goalManager.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`);
    failed++;
  }
}

function syntheticGoals(n: number, tag: string): string {
  const now = Date.UTC(2026, 0, 1);
  const goals = Array.from({ length: n }, (_, i) => ({
    id: `${tag}_${String(i + 1).padStart(3, '0')}`,
    description: `synthetic goal ${i + 1}`,
    status: i % 3 === 0 ? 'pending' : 'completed',
    source: 'test',
    retries: 0,
    maxRetries: 3,
    createdAt: now + i,
    updatedAt: now + i,
    metadata: {},
    completedAt: i % 3 === 0 ? null : now + i,
  }));
  return JSON.stringify({ goals, activeGoalId: null }, null, 2);
}

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const count = (file: string) => (JSON.parse(fs.readFileSync(file, 'utf8')) as { goals: unknown[] }).goals.length;

function workspace(): { root: string; legacy: string; live: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-goals-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  return {
    root,
    legacy: path.join(root, 'data', 'goals.json'),
    live: path.join(root, 'data', 'runtime', 'goals.json'),
  };
}

const originalRoot = process.env['JARVIS_WORKSPACE_ROOT'];
const cleanup: string[] = [];

console.log('\n=== Goal Runtime Migration Test ===\n');

try {
  console.log('--- 100 legacy records migrate into the runtime file ---');
  {
    const ws = workspace(); cleanup.push(ws.root);
    fs.writeFileSync(ws.legacy, syntheticGoals(100, 'legacy'));
    const legacyBefore = sha(ws.legacy);
    process.env['JARVIS_WORKSPACE_ROOT'] = ws.root;

    const gm = new GoalManager();
    await gm.init();

    ok('runtime file created', fs.existsSync(ws.live));
    ok('runtime file holds all 100 records', count(ws.live) === 100, `${count(ws.live)}`);
    ok('GoalManager sees 100 records', gm.getStats().total === 100, `${gm.getStats().total}`);
    ok('legacy file is byte-identical after startup', sha(ws.legacy) === legacyBefore);

    // A new goal must land in the runtime file only.
    await gm.createGoal('added after migration', 'cli');
    await gm.flush(); // writes are debounced — force this one to disk
    // MAX_STORED_GOALS is a 100-goal rolling window, so the count stays at 100
    // and the oldest record is evicted. Check the write by content instead.
    const liveText = fs.readFileSync(ws.live, 'utf8');
    ok('new goal written to the runtime file', liveText.includes('added after migration'));
    ok('rolling window held at 100 (oldest evicted)',
       count(ws.live) === 100 && !liveText.includes('"legacy_001"'), `${count(ws.live)}`);
    ok('legacy file still byte-identical after a write', sha(ws.legacy) === legacyBefore);
  }

  console.log('\n--- an existing runtime file is never overwritten ---');
  {
    const ws = workspace(); cleanup.push(ws.root);
    fs.writeFileSync(ws.legacy, syntheticGoals(100, 'legacy'));
    fs.mkdirSync(path.dirname(ws.live), { recursive: true });
    fs.writeFileSync(ws.live, syntheticGoals(7, 'live'));
    const liveBefore = sha(ws.live);

    ok('migration reports skipped', GoalManager.migrateLegacyGoals(ws.legacy, ws.live) === 'skipped');
    ok('runtime file untouched by the migration', sha(ws.live) === liveBefore);

    process.env['JARVIS_WORKSPACE_ROOT'] = ws.root;
    const gm = new GoalManager();
    await gm.init();
    ok('GoalManager loads the 7 live records, not the 100 legacy', gm.getStats().total === 7, `${gm.getStats().total}`);
  }

  console.log('\n--- a fresh clone with no legacy file still starts ---');
  {
    const ws = workspace(); cleanup.push(ws.root);
    process.env['JARVIS_WORKSPACE_ROOT'] = ws.root;
    ok('migration reports skipped', GoalManager.migrateLegacyGoals(ws.legacy, ws.live) === 'skipped');
    const gm = new GoalManager();
    await gm.init();
    ok('starts with an empty store', gm.getStats().total === 0);
    ok('runtime directory created on demand', fs.existsSync(path.dirname(ws.live)));
    ok('no legacy file invented', !fs.existsSync(ws.legacy));
  }

  console.log('\n--- the runtime location is what git ignores ---');
  {
    const src = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8');
    ok('.gitignore ignores data/runtime/', /^data\/runtime\/$/m.test(src));
    ok('.gitignore no longer lists data/goals.json', !/^data\/goals\.json$/m.test(src));
  }
} finally {
  if (originalRoot === undefined) delete process.env['JARVIS_WORKSPACE_ROOT'];
  else process.env['JARVIS_WORKSPACE_ROOT'] = originalRoot;
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
