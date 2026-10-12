/**
 * tests/serverExitRaceTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * On the owner's PC the crash diagnosis said "stopped" without the exit code:
 * the server's process had already ended (running=false) but JARVIS had not
 * yet handled its exit (exit=undefined), and the diagnosis ran in that gap.
 *
 * Reproduced here without timing luck: the server is crashed while JARVIS's
 * event loop is blocked, and the test waits (still blocked) until the process
 * is gone. When the loop runs again the exit has happened but has not been
 * handled yet.
 *
 *   1. in that gap, the record has no exit (what the PC showed; on Linux the
 *      unreaped process even reads as running)
 *   2. the diagnosis waits for the exit: it names the exit code and the
 *      server's own error line
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as net from 'net';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-exit-race-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
const project = path.join(root, 'projects', 'api');
fs.mkdirSync(project, { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = root;
process.env['JARVIS_DATA_ROOT'] = root;
process.env['JARVIS_PROJECT_ROOTS'] = path.join(root, 'projects');
process.env['JARVIS_DEV_SERVER_START_MS'] = '30000';
process.env['JARVIS_CDP_PORT'] = '1';

fs.writeFileSync(path.join(project, 'server.js'), `
const http = require('http');
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  if (req.url === '/crash') {
    res.end('bye');
    console.error('Error: lost the connection to the database');
    setTimeout(() => process.exit(1), 20);
    return;
  }
  res.end('ok');
}).listen(port, '127.0.0.1', () => console.log('api ready on http://localhost:' + port));
`);
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'api', private: true, scripts: { start: 'node server.js' } }, null, 2));

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const blockFor = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Linux: ended but not yet reaped. */
const isZombie = (pid: number) => { try { return /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return !alive(pid); } };

const { registerAllTools } = await import('../core/tools/index.js');
const { toolRegistryV2 } = await import('../core/toolRegistryV2.js');
const devTools = await import('../tools/devTools.js');
const { observeApp, diagnoseApp } = await import('../core/diagnosis.js');
registerAllTools();

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== A crashed server, diagnosed before its exit is handled ===\n');
const port = await freePort();
const started = await toolRegistryV2.execute('dev', { action: 'start_server', project, script: 'start', port });
const pid = JSON.parse(started.output)?.pid as number | undefined;
ok('(setup) the server started', started.success && !!pid, started.output.slice(0, 120));
await new Promise((r) => setTimeout(r, 300));

// Crash it while this process's event loop is blocked, then stay blocked
// long enough for the server and its package manager to exit. (On Windows the
// ended process no longer looks alive; on Linux it does until it is reaped,
// so there the gap reads "running" instead of "stopped".)
execFileSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${port}/crash').then(r => r.text()).catch(() => {})`], { timeout: 10_000 });
for (let i = 0; i < 60 && alive(pid!) && !isZombie(pid!); i++) blockFor(50);
blockFor(500);

const inGap = devTools.knownServers().find((k) => k.port === port);
ok('in the gap the exit is not recorded yet (what the PC showed)', !!inGap && inGap.exit === undefined, JSON.stringify({ running: inGap?.running, exit: inGap?.exit }));

const diagnosis = diagnoseApp(await observeApp());
const text = JSON.stringify(diagnosis);
ok('the diagnosis names the exit code', /exit code 1/.test(text), text.slice(0, 300));
ok('…and the server\'s own error line', /lost the connection to the database/.test(text), text.slice(0, 300));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
