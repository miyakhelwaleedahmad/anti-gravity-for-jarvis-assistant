/**
 * tests/dataRootIsolationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests wrote into the real memory/jarvis_memory.json, data/runtime/goals.json,
 * data/episodes.jsonl, the saved permission session and the audit logs.
 * JARVIS_DATA_ROOT now moves all of them, and the test runner gives every test
 * its own temporary one.
 *
 * Here JARVIS_DATA_ROOT points at a temporary folder; each module writes, and
 * the files must land there while the project's own files stay as they were.
 * (A JARVIS instance running at the same time can change the project's files
 * itself; run this with JARVIS stopped.)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'memory/jarvis_memory.json',
  'data/runtime/goals.json',
  'data/episodes.jsonl',
  'data/security/permission_session.json',
  'data/logs/permission_session_log.json',
  'data/logs/security_audit.log',
  'data/logs/tool_audit.log',
  'data/backups',
];

function fingerprint(base: string, rel: string): string {
  const p = path.join(base, rel);
  if (!fs.existsSync(p)) return 'absent';
  if (fs.statSync(p).isDirectory()) return `dir:${fs.readdirSync(p).sort().join(',')}`;
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}

const before = new Map(FILES.map((f) => [f, fingerprint(project, f)]));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dataroot-'));
fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
const original = process.env['JARVIS_DATA_ROOT'];
process.env['JARVIS_DATA_ROOT'] = root;

console.log('\n=== Data Root Isolation Test ===\n');

console.log('--- dataRoot() ---');
const workspaceRoot: any = await import('../core/workspaceRoot.js');
if (typeof workspaceRoot.dataRoot === 'function') {
  ok('JARVIS_DATA_ROOT moves the data', workspaceRoot.dataRoot('/usual/place') === path.resolve(root));
  delete process.env['JARVIS_DATA_ROOT'];
  ok('unset, a module keeps its usual place', workspaceRoot.dataRoot('/usual/place') === '/usual/place');
  process.env['JARVIS_DATA_ROOT'] = root;
} else {
  ok('core/workspaceRoot.ts exports dataRoot()', false);
}

console.log('\n--- Every writer lands in the data root ---');
const { securityAuditLogger } = await import('../security/securityAuditLogger.js');
const { permissionSession } = await import('../control/permissionSession.js');
const { memoryManager } = await import('../memory/memoryManager.js');
const { goalManager } = await import('../core/goalManager.js');
const { agentMemory } = await import('../memory/agentMemory.js');
const { backupRestore } = await import('../system/backupRestore.js');
const { toolExecutionSandbox } = await import('../core/toolExecutionSandbox.js');

securityAuditLogger.denied('isolation-probe', 'HIGH_RISK', 'data root isolation check', 'isolation-probe');
permissionSession.activateFullControl(1, 'cli');
permissionSession.deactivateFullControl('isolation test');
await memoryManager.init();
await memoryManager.flush();
await goalManager.init();
await goalManager.createGoal('data root isolation check', 'cli');
await goalManager.flush();
agentMemory.pushEpisode('user_input', 'data root isolation check', {}, 3);
await toolExecutionSandbox.run(
  { name: 'isolation_probe', description: '', riskLevel: 'high', inputSchema: {}, fallbacks: [], execute: async () => 'ok' } as any,
  {},
);
await backupRestore.createBackup();
await new Promise((r) => setTimeout(r, 300)); // the tool audit line is appended asynchronously

for (const file of FILES) {
  ok(`${file} is written under the data root`, fingerprint(root, file) !== 'absent');
}

console.log('\n--- The project\'s own files did not change ---');
for (const file of FILES) {
  const after = fingerprint(project, file);
  ok(`${file} unchanged`, after === before.get(file), after === before.get(file) ? '' : 'changed by this test run');
}

permissionSession.shutdown?.();
if (original === undefined) delete process.env['JARVIS_DATA_ROOT'];
else process.env['JARVIS_DATA_ROOT'] = original;
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
