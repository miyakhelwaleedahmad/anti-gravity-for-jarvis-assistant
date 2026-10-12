/**
 * tests/remoteAccessTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OPS-02 groundwork (security/remoteAccess.ts). Remote access is not
 * available; this checks that it stays so, and that the policy written for
 * later refuses what a remote request must never do.
 *
 *   1. no listener binds anything but loopback: the shared rule refuses
 *      0.0.0.0, ::, a LAN address; every listen() in the code names a host;
 *      no source binds 0.0.0.0
 *   2. with remote access off (the only state today) every request is refused
 *   3. the policy, switched on in this test only: no TLS, unknown or revoked
 *      device, a wrong key, an old or replayed request are refused
 *   4. a remote request can never approve, change permissions or run a tool
 *      above risk level 1, whatever the device was given
 *   5. no network route reaches the approval gate
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import type { RemoteRequest } from '../security/remoteAccess.js';
const { assertLoopbackBind, decideRemoteRequest, remoteAccessEnabled, REMOTE_MAX_RISK } = await import('../security/remoteAccess.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Remote access groundwork (OPS-02) ===\n');

console.log('--- 1. Loopback only ---');
for (const host of ['0.0.0.0', '::', '192.168.1.20', 'jarvis.example.com', '']) {
  let refused = false;
  try { assertLoopbackBind(host, 'test'); } catch { refused = true; }
  ok(`refuses to bind "${host}"`, refused);
}
for (const host of ['127.0.0.1', '::1', 'localhost']) {
  let accepted = true;
  try { assertLoopbackBind(host, 'test'); } catch { accepted = false; }
  ok(`accepts "${host}"`, accepted);
}

const sources: Array<{ file: string; text: string }> = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'tests', '_legacy', '.git', 'dist', '.venv', 'venv'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|py)$/.test(e.name)) sources.push({ file: path.relative(repo, p), text: fs.readFileSync(p, 'utf8') });
  }
};
walk(repo);
// listen(port) with no host binds every interface; each call must name one.
const noHost = sources.filter(({ file }) => file.endsWith('.ts')).flatMap(({ file, text }) =>
  text.split('\n').filter((line) => /\.listen\(/.test(line))
    .filter((line) => !/\.listen\([^,]+,\s*[A-Za-z_'"`]/.test(line))
    .map((line) => `${file}: ${line.trim().slice(0, 80)}`));
ok('every listen() in the code names a host', noHost.length === 0, noHost.join('; '));
// As a bind address (browserPolicy names 0.0.0.0 as a navigation target it blocks).
const anyHost = sources.filter(({ text }) => /\.listen\([^)\n]*0\.0\.0\.0|host\s*[:=]\s*['"]0\.0\.0\.0|--host\s+0\.0\.0\.0/.test(text))
  .filter(({ file }) => file !== 'security/remoteAccess.ts');
ok('no source binds 0.0.0.0', anyHost.length === 0, anyHost.map((s) => s.file).join(', '));
for (const [f, label] of [['bridge/nodeBridge.ts', 'the voice bridge'], ['core/agents/a2a.ts', 'the A2A endpoint'], ['system/controlCenter.ts', 'the Control Center']] as const) {
  ok(`${label} checks its host with the shared rule`, /assertLoopbackBind\(/.test(fs.readFileSync(path.join(repo, f), 'utf8')));
}

console.log('\n--- 2. Remote access is off ---');
const device = { id: 'phone', keyFingerprint: 'fp-phone', maxRisk: 4, tools: ['get_weather', 'goal_status', 'control_file', 'run_command'] };
const devices = new Map([[device.id, device]]);
const good: RemoteRequest = { tls: true, deviceId: 'phone', signedBy: 'fp-phone', signatureValid: true, sentAt: Date.now(), nonce: 'n1', kind: 'tool', tool: 'get_weather', risk: 0 };
ok('remoteAccessEnabled() is false', remoteAccessEnabled() === false);
ok('a perfectly formed request is still refused', !decideRemoteRequest(good, devices, new Set()).allowed);

console.log('\n--- 3. The policy, switched on in this test ---');
const on = (req: Partial<RemoteRequest>, seen = new Set<string>(), now = Date.now()) => decideRemoteRequest({ ...good, nonce: `n-${Math.random()}`, ...req }, devices, seen, now, true);
ok('a valid low-risk call on the device\'s list is allowed', on({}).allowed);
ok('no TLS: refused', !on({ tls: false }).allowed);
ok('unknown device: refused', !on({ deviceId: 'laptop' }).allowed);
ok('signed by another key: refused', !on({ signedBy: 'fp-other' }).allowed);
ok('bad signature: refused', !on({ signatureValid: false }).allowed);
ok('two minutes old: refused', !on({ sentAt: Date.now() - 120_000 }).allowed);
const seen = new Set<string>();
const first = decideRemoteRequest({ ...good, nonce: 'once' }, devices, seen, Date.now(), true);
const replay = decideRemoteRequest({ ...good, nonce: 'once' }, devices, seen, Date.now(), true);
ok('a replayed nonce: refused', first.allowed && !replay.allowed, replay.reason);
const revoked = new Map([[device.id, { ...device, revokedAt: Date.now() - 1 }]]);
ok('a revoked device: refused', !decideRemoteRequest({ ...good, nonce: 'r' }, revoked, new Set(), Date.now(), true).allowed);

console.log('\n--- 4. Never remotely ---');
ok('approving an action', !on({ kind: 'approve' }).allowed, on({ kind: 'approve' }).reason);
ok('changing permissions or full control', !on({ kind: 'admin' }).allowed);
ok(`a tool above risk ${REMOTE_MAX_RISK}, although the device was given 4`, !on({ tool: 'control_file', risk: 2 }).allowed && !on({ tool: 'run_command', risk: 3 }).allowed);
ok('a tool with no assessed risk', !on({ risk: undefined }).allowed);
ok('a tool not on the device\'s list', !on({ tool: 'browser_navigate', risk: 0 }).allowed);

console.log('\n--- 5. No network route to the approval gate ---');
const gate = fs.readFileSync(path.join(repo, 'security', 'approvalGate.ts'), 'utf8');
ok('the approval gate opens no listener', !/createServer|\.listen\(|WebSocketServer/.test(gate));
const cc = await import('../system/controlCenter.js');
const ccTools = Object.values(cc.CONTROL_CENTER_ACTIONS).map((a) => a.tool);
ok('the Control Center offers no approval and no command action', !ccTools.some((t) => /approv|run_command|terminal|shell/.test(t)), ccTools.join(','));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
