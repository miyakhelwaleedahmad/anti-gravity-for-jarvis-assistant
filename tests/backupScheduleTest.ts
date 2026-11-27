/**
 * tests/backupScheduleTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Goal Runtime phase 6: scheduled backups (system/backupRestore.ts), which
 * jarvis.ts now starts. Backups include the goal store; two in the same
 * second get their own folders; restore puts a file back and keeps the
 * replaced one as .bak; the schedule runs and stops; the interval setting.
 * In a throwaway data folder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-backup-schedule-'));
process.env['JARVIS_DATA_ROOT'] = root;
for (const dir of ['memory', path.join('data', 'runtime'), path.join('data', 'logs')]) fs.mkdirSync(path.join(root, dir), { recursive: true });
const goalsFile = path.join(root, 'data', 'runtime', 'goals.json');
fs.writeFileSync(goalsFile, JSON.stringify({ goals: [{ id: 'g1', description: 'keep tests green' }], activeGoalId: null, lessons: [] }));
fs.writeFileSync(path.join(root, 'memory', 'jarvis_memory.json'), JSON.stringify({ shortTerm: [], longTerm: [] }));

const { backupRestore, backupIntervalMs } = await import('../system/backupRestore.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log('\n=== Scheduled backups ===\n');

const m1 = await backupRestore.createBackup();
const goals = m1.files.find((f) => f.src === 'data/runtime/goals.json');
ok('the goal store is backed up', !!goals && goals.ok && goals.sizeBytes > 0, JSON.stringify(goals));
const m2 = await backupRestore.createBackup();
ok('two backups in the same second get their own folders', m1.snapshotId !== m2.snapshotId, `${m1.snapshotId} / ${m2.snapshotId}`);

fs.writeFileSync(goalsFile, JSON.stringify({ goals: [], activeGoalId: null }));
const restored = await backupRestore.restore(m1.snapshotId);
ok('restore puts the goal store back', restored.success && JSON.parse(fs.readFileSync(goalsFile, 'utf8')).goals[0]?.id === 'g1');
ok('… and keeps the replaced file as .bak', JSON.parse(fs.readFileSync(`${goalsFile}.bak`, 'utf8')).goals.length === 0);

const before = backupRestore.listBackups().length;
backupRestore.startScheduled(1_100);
ok('the schedule starts', backupRestore.isScheduled);
backupRestore.startScheduled(1_100);
await sleep(2_500);
const during = backupRestore.listBackups().length;
ok('it made backups on its own', during > before, `${before} → ${during}`);
ok('old backups are rotated (at most 5 kept)', during <= 5);
backupRestore.stopScheduled();
ok('it stops', !backupRestore.isScheduled);
const after = backupRestore.listBackups().map((b) => b.snapshotId).join();
await sleep(1_500);
ok('no backups after it stopped', backupRestore.listBackups().map((b) => b.snapshotId).join() === after);

console.log('\n--- The interval setting ---');
ok('default: every 6 hours', backupIntervalMs({}) === 6 * 3_600_000);
ok('JARVIS_BACKUP_INTERVAL_HOURS=0 turns it off', backupIntervalMs({ JARVIS_BACKUP_INTERVAL_HOURS: '0' }) === 0);
ok('JARVIS_BACKUP_INTERVAL_HOURS=12', backupIntervalMs({ JARVIS_BACKUP_INTERVAL_HOURS: '12' }) === 12 * 3_600_000);
ok('nonsense falls back to the default', backupIntervalMs({ JARVIS_BACKUP_INTERVAL_HOURS: 'often' }) === 6 * 3_600_000);
ok('a tiny value is at least a minute', backupIntervalMs({ JARVIS_BACKUP_INTERVAL_HOURS: '0.0001' }) === 60_000);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
