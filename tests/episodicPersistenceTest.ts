/**
 * tests/episodicPersistenceTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * JARVIS-009 — episodes (including every failure episode that reflection and
 * repair reason over) were RAM-only and vanished on restart.
 *
 * A restart is simulated by relocating the workspace root, writing a log there,
 * and re-importing the module with a fresh cache.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

/**
 * Re-import the module with a cache-busting query so each call yields a fresh
 * singleton, simulating a process restart. The specifier is built at runtime so
 * it is not statically resolvable — that is deliberate.
 */
async function importFreshAgentMemory(version: number): Promise<{
  agentMemory: {
    pushEpisode(type: string, summary: string, data?: Record<string, unknown>, importance?: number): unknown;
    getEpisodeCount(): number;
    getEpisodesByType?(type: string): unknown[];
  };
}> {
  const specifier = `../memory/agentMemory.js?v=${version}`;
  return import(specifier);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-episodes-'));
const original = process.env['JARVIS_WORKSPACE_ROOT'];
process.env['JARVIS_WORKSPACE_ROOT'] = root;
const logPath = path.join(root, 'data', 'episodes.jsonl');

console.log('\n=== Episodic Persistence Test ===\n');

try {
  // ── Session 1 ────────────────────────────────────────────────────────────
  const { agentMemory: mem1 } = await importFreshAgentMemory(1);
  mem1.pushEpisode('task_failure', 'open_app failed for Notepad', { tool: 'open_app' }, 9);
  mem1.pushEpisode('task_success', 'screenshot captured', { tool: 'screenshot' }, 4);
  mem1.pushEpisode('task_failure', 'control_browser timed out', { tool: 'control_browser' }, 8);

  ok('episode log written to disk', fs.existsSync(logPath));

  const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
  ok('one JSONL line per episode', lines.length === 3, `${lines.length} lines`);
  ok('each line is valid JSON', lines.every((l) => {
    try { JSON.parse(l); return true; } catch { return false; }
  }));

  // ── Session 2: fresh module instance = restart ──────────────────────────
  const { agentMemory: mem2 } = await importFreshAgentMemory(2);
  const count = mem2.getEpisodeCount();
  ok('episodes survive a restart', count === 3, `${count} restored`);

  const failures = mem2.getEpisodesByType?.('task_failure') ?? [];
  ok('failure episodes specifically survived',
     Array.isArray(failures) ? failures.length === 2 : true,
     `${Array.isArray(failures) ? failures.length : 'n/a'}`);

  // ── A truncated final line must not lose the rest ───────────────────────
  fs.appendFileSync(logPath, '{"id":"ep_trunc","timesta');
  const { agentMemory: mem3 } = await importFreshAgentMemory(3);
  const count3 = mem3.getEpisodeCount();
  ok('a truncated trailing line is skipped, earlier episodes kept',
     count3 === 3, `${count3} restored`);

  // ── Appending after a restart does not clobber history ──────────────────
  mem3.pushEpisode('task_success', 'post-restart episode', {}, 5);
  const linesAfter = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
  ok('log is append-only — nothing rewritten away',
     linesAfter.length >= 4, `${linesAfter.length} lines`);
  ok('the original first episode is still on disk',
     fs.readFileSync(logPath, 'utf-8').includes('open_app failed for Notepad'));
} finally {
  if (original === undefined) delete process.env['JARVIS_WORKSPACE_ROOT'];
  else process.env['JARVIS_WORKSPACE_ROOT'] = original;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
