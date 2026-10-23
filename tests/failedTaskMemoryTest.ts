/**
 * tests/failedTaskMemoryTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-15: long-term memory filled up with "Failed task: …" facts.
 *
 * Each aborted request stored one at importance 7 (source agent_failure).
 * Planning retrieved them for similar requests, and every retrieval added 0.5
 * importance, so they rose to 10 and crowded out what the owner had said.
 *
 *   1. Planning for a similar request gets the owner's fact, not the failure.
 *   2. The failure fact is not reinforced, and it stays on disk.
 *   3. An aborted request no longer stores one (the task_failed episode and
 *      the goal's reason record it).
 *
 * The vector service is down here, so the keyword search is what runs.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-failfacts-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(workspace);

const { memoryManager } = await import('../memory/memoryManager.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

await memoryManager.init();
(memoryManager as any).vectorRequest = async () => { throw new Error('connect ECONNREFUSED'); };

console.log('\n=== Failed tasks are not planning knowledge (BUG-15) ===\n');

const db = (memoryManager as any).db.data;
const now = Date.now();
db.longTerm.push(
  { id: 'fail-1', fact: 'Failed task: "open youtube and play sanam re" — tool_error', source: 'agent_failure', timestamp: now, importance: 9, lastAccessed: now, accessCount: 4, confidence: 0.8, version: 1 },
  { id: 'fail-2', fact: 'Failed task: "play sanam re on youtube" — planning_error', source: 'agent_failure', timestamp: now, importance: 9.5, lastAccessed: now, accessCount: 6, confidence: 0.8, version: 1 },
  { id: 'own-1', fact: 'The owner likes Sanam Re by Arijit Singh on YouTube', source: 'conversation', timestamp: now - 86_400_000, importance: 5, lastAccessed: now - 86_400_000, accessCount: 0, confidence: 0.9, version: 1 },
);

const ctx = await memoryManager.retrieveForPlanning('play sanam re on youtube', 5);
ok('planning gets the owner\'s fact', ctx.includes('The owner likes Sanam Re'), ctx);
ok('…and no "Failed task" note', !ctx.includes('Failed task'), ctx);

const byId = (id: string) => db.longTerm.find((f: any) => f.id === id);
ok('the failure notes are not reinforced by searches', byId('fail-1').importance === 9 && byId('fail-2').importance === 9.5 && byId('fail-1').accessCount === 4, `${byId('fail-1').importance}, ${byId('fail-2').importance}`);
ok('…and stay on disk (nothing of the owner\'s data is deleted)', memoryManager.getLongTermFacts(100).filter((f) => f.source === 'agent_failure').length === 2);

const orch = fs.readFileSync(path.join(repo, 'core', 'orchestrator.ts'), 'utf8');
ok('an aborted request no longer stores a "Failed task" fact', !/rememberFact\([\s\S]{0,200}'agent_failure'/.test(orch) && !/Failed task: "\$\{input/.test(orch));

fs.rmSync(workspace, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
