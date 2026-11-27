/**
 * tests/shutdownStepsTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCH-07: jarvis.ts stopped each subsystem in an empty `catch {}` and then
 * said "JARVIS shut down cleanly", also when the goal runtime or the agent
 * system had failed to stop and save.
 *
 *   1. every step runs, also after one fails
 *   2. a failed step is logged and returned
 *   3. a step that hangs is cut off; the next ones still run
 *   4. jarvis.ts uses it and does not report a clean shutdown after a failure
 *   5. a key in an error message is redacted before it is logged
 *   6. a barge-in listener that throws is logged and the others still run
 *      (before: swallowed in an empty catch)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-shutdown-steps-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runShutdownSteps } = await import('../system/shutdownSteps.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Shutdown steps (ARCH-07) ===\n');
const ran: string[] = [];
const logs: string[] = [];
const failures = await runShutdownSteps([
  { name: 'goal runtime', run: async () => { ran.push('goal runtime'); throw new Error('could not save goals'); } },
  { name: 'agents', run: () => { ran.push('agents'); } },
  { name: 'stuck observer', run: () => new Promise(() => { ran.push('stuck observer'); }) },
  { name: 'bridge', run: () => { ran.push('bridge'); } },
], { stepTimeoutMs: 200, log: (m) => logs.push(m) });

ok('every step ran, in order', ran.join(',') === 'goal runtime,agents,stuck observer,bridge', ran.join(','));
ok('the failed step is returned with its error', failures.some((f) => f.name === 'goal runtime' && /could not save goals/.test(f.error)));
ok('the stuck step is cut off and returned', failures.some((f) => f.name === 'stuck observer' && /did not stop within 200 ms/.test(f.error)));
ok('both are logged', logs.length === 2 && logs.every((l) => /Shutdown step/.test(l)), logs.join(' | '));
ok('the steps that worked are not failures', failures.length === 2);

const source = fs.readFileSync(path.join(repo, 'jarvis.ts'), 'utf8');
ok('jarvis.ts stops its subsystems through runShutdownSteps', /runShutdownSteps\(/.test(source));
ok('…with no empty catch left around a stop', !/try \{ [^}]*\.(stop|shutdown|stopScheduled|stopHealthChecks)\(\);? \} catch \{\}/.test(source));
ok('…and only says "shut down cleanly" when nothing failed', /failures\.length === 0/.test(source));

const fakeKey = 'sk-' + 'x'.repeat(30);
const keyLogs: string[] = [];
const keyFailures = await runShutdownSteps([{ name: 'leaky', run: () => { throw new Error(`bad key ${fakeKey}`); } }], { log: (m) => keyLogs.push(m) });
ok('a key in the error is redacted in the log and the result', !keyLogs.join('').includes(fakeKey) && !keyFailures[0]!.error.includes(fakeKey), keyLogs.join(''));

console.log('\n--- Barge-in listeners ---');
const { orchestrator } = await import('../core/orchestrator.js');
const warned: string[] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
let laterRan = false;
const saved = orchestrator.onBargeIn.splice(0);
orchestrator.onBargeIn.push(() => { throw new Error('voice queue gone'); }, () => { laterRan = true; });
try { (orchestrator as any).runBargeInCallbacks(); } finally { console.warn = realWarn; orchestrator.onBargeIn.splice(0, orchestrator.onBargeIn.length, ...saved); }
ok('a listener that throws is logged', warned.some((w) => /Barge-in listener failed: voice queue gone/.test(w)), warned.join(' | '));
ok('the next listener still runs', laterRan);
const orchSource = fs.readFileSync(path.join(repo, 'core', 'orchestrator.ts'), 'utf8');
ok('no barge-in listener call is left in an empty catch', !/try \{ cb\(\); \} catch \{\}/.test(orchSource));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
