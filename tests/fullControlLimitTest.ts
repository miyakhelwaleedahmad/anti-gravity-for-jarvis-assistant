/**
 * tests/fullControlLimitTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-12: full control lasts at most 30 minutes, as documented. The code
 * allowed 120 on activation, and each extension added up to 120 more with no
 * total limit.
 * SEC-19: the saved session (data/security/permission_session.json) was
 * restored at start whatever expiry it held: a file saying "until 2099" gave
 * full control until 2099.
 *
 *   1. activation: 120, 0, -5, NaN and "abc" minutes are clamped to 1…30
 *   2. extension: never more than 30 minutes left, however often or however much
 *   3. the enable skill: 120 asked → 30 granted
 *   4. restore: a genuine saved session comes back; one claiming more than 30
 *      minutes, or a start in the future, starts at the base level instead
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-full-control-'));
process.env['JARVIS_DATA_ROOT'] = root;
process.env['JARVIS_WORKSPACE_ROOT'] = root;
delete process.env['JARVIS_DEFAULT_PERMISSION_LEVEL'];

const { PermissionSession, permissionSession, MAX_SESSION_MINUTES } = await import('../control/permissionSession.js');
const { approvalGate } = await import('../security/approvalGate.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const minutesLeft = (s: { getRemainingSeconds(): number | null }) => (s.getRemainingSeconds() ?? 0) / 60;

console.log('\n=== Full control limit (SEC-12, SEC-19) ===\n');
ok('the limit is 30 minutes', MAX_SESSION_MINUTES === 30);

console.log('--- 1. Activation ---');
for (const [asked, expect] of [[120, 30], [30, 30], [10, 10], [0, 1], [-5, 1], [NaN, 30], ['abc' as unknown as number, 30]] as Array<[number, number]>) {
  permissionSession.activateFullControl(asked, 'cli');
  const left = minutesLeft(permissionSession);
  ok(`${String(asked)} minutes asked → ${expect}`, Math.abs(left - expect) < 0.1, `${left.toFixed(2)} min`);
}

console.log('\n--- 2. Extension ---');
permissionSession.activateFullControl(10, 'cli');
permissionSession.extendSession(120);
ok('extending by 120 leaves at most 30 minutes', minutesLeft(permissionSession) <= 30.01, `${minutesLeft(permissionSession).toFixed(2)} min`);
for (let i = 0; i < 10; i++) permissionSession.extendSession(30);
ok('ten more extensions still leave at most 30', minutesLeft(permissionSession) <= 30.01, `${minutesLeft(permissionSession).toFixed(2)} min`);
permissionSession.activateFullControl(5, 'cli');
permissionSession.extendSession(10);
ok('a small extension still adds time (5 + 10 = 15)', Math.abs(minutesLeft(permissionSession) - 15) < 0.1, `${minutesLeft(permissionSession).toFixed(2)} min`);
permissionSession.extendSession(-60);
ok('a negative extension does not shorten or break it', Math.abs(minutesLeft(permissionSession) - 15) < 0.1, `${minutesLeft(permissionSession).toFixed(2)} min`);
permissionSession.deactivateFullControl('limit test');

console.log('\n--- 3. The enable skill ---');
(approvalGate as any).requestApproval = async () => true;
const skill = await import('../skills/enable_full_control_session/skill.js');
await skill.execute({ action: 'enable', durationMinutes: 120, source: 'cli' });
ok('asked for 120 minutes, granted 30', Math.abs(minutesLeft(permissionSession) - 30) < 0.1, `${minutesLeft(permissionSession).toFixed(2)} min`);
await skill.execute({ action: 'renew', durationMinutes: 120, source: 'cli' });
ok('renewed by 120, at most 30 left', minutesLeft(permissionSession) <= 30.01, `${minutesLeft(permissionSession).toFixed(2)} min`);
permissionSession.deactivateFullControl('limit test');

console.log('\n--- 4. Restoring the saved session ---');
const file = path.join(root, 'data', 'security', 'permission_session.json');
const save = (state: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
};
const now = Date.now();

save({ level: 2, fullControlExpiresAt: now + 12 * 60_000, activatedAt: now - 3 * 60_000, activatedBy: 'cli', sessionId: 'genuine' });
let restored = new PermissionSession();
ok('a genuine session (12 minutes left) is restored', restored.getCurrentLevel() === 2 && Math.abs(minutesLeft(restored) - 12) < 0.2, `level ${restored.getCurrentLevel()}`);
restored.shutdown?.();

save({ level: 2, fullControlExpiresAt: Date.parse('2099-01-01T00:00:00Z'), activatedAt: now, activatedBy: 'cli', sessionId: 'edited' });
restored = new PermissionSession();
ok('a file claiming full control until 2099 is not restored', restored.getCurrentLevel() !== 2 && restored.getRemainingSeconds() === null, `level ${restored.getCurrentLevel()}`);
const after = JSON.parse(fs.readFileSync(file, 'utf8'));
ok('…and the file is rewritten at the base level', after.level !== 2, JSON.stringify(after).slice(0, 80));
restored.shutdown?.();

save({ level: 2, fullControlExpiresAt: now + 25 * 60_000, activatedAt: now - 60 * 60_000, activatedBy: 'cli', sessionId: 'long' });
restored = new PermissionSession();
ok('a session that would have lasted 85 minutes is not restored', restored.getCurrentLevel() !== 2, `level ${restored.getCurrentLevel()}`);
restored.shutdown?.();

save({ level: 2, fullControlExpiresAt: now + 20 * 60_000, activatedAt: now + 10 * 60_000, activatedBy: 'cli', sessionId: 'future' });
restored = new PermissionSession();
ok('a session started in the future is not restored', restored.getCurrentLevel() !== 2, `level ${restored.getCurrentLevel()}`);
restored.shutdown?.();

save({ level: 2, fullControlExpiresAt: 'tomorrow', activatedBy: 'cli', sessionId: 'bad' });
restored = new PermissionSession();
ok('an expiry that is not a number is not restored', restored.getCurrentLevel() !== 2, `level ${restored.getCurrentLevel()}`);
restored.shutdown?.();

permissionSession.shutdown?.();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
