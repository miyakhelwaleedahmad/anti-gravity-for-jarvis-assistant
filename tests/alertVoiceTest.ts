/**
 * tests/alertVoiceTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-18: "Sir, I've detected a warning in my resource::gc pause system" was
 * spoken in the middle of a conversation. Warnings were spoken, and a GC
 * pause over 100 ms (ordinary on a busy PC) raised one.
 *
 *   1. Only critical alerts are spoken by default; JARVIS_VOICE_ALERT_LEVEL
 *      = warning restores speaking warnings, = off speaks none. Every alert
 *      is still logged and emitted.
 *   2. The GC pause threshold is 500 ms by default (JARVIS_GC_WARN_MS).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-alerts-'));
fs.mkdirSync(path.join(workspace, 'data', 'logs'), { recursive: true });
process.env['JARVIS_DATA_ROOT'] = workspace;
delete process.env['JARVIS_VOICE_ALERT_LEVEL'];

const { alertManager, spokenAlertLevel } = await import('../self_healing/alertManager.js');
const { gcWarnMs } = await import('../monitoring/resourceMonitor.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 20));

const said: string[] = [];
const am = alertManager as any;
am._bridge = { speakToClients: (t: string) => said.push(t) };
const emitted: string[] = [];
alertManager.on('alert', (a: { severity: string }) => emitted.push(a.severity));
let n = 0;
async function raise(severity: 'warning' | 'critical'): Promise<boolean> {
  am.lastVoiceAlertAt = 0;              // not held back by the 30 s voice cooldown
  const before = said.length;
  alertManager.raise(severity, 'resource::gc_pause', `GC pause ${130 + n++}ms`, 'test');
  await tick();
  return said.length > before;
}

console.log('\n--- 1. Which alerts are spoken ---');
ok('default level: critical', spokenAlertLevel({}) === 'critical' && spokenAlertLevel({ JARVIS_VOICE_ALERT_LEVEL: 'nonsense' }) === 'critical');
ok('a warning (a GC pause) is not spoken', !(await raise('warning')), said.join(' | '));
ok('…but it is still emitted for the dashboard and log', emitted.includes('warning'));
ok('a critical alert is spoken', await raise('critical'), said.join(' | '));
process.env['JARVIS_VOICE_ALERT_LEVEL'] = 'warning';
ok('JARVIS_VOICE_ALERT_LEVEL=warning: warnings are spoken again', await raise('warning'));
process.env['JARVIS_VOICE_ALERT_LEVEL'] = 'off';
ok('JARVIS_VOICE_ALERT_LEVEL=off: not even critical ones', !(await raise('critical')));
delete process.env['JARVIS_VOICE_ALERT_LEVEL'];

console.log('\n--- 2. GC pause threshold ---');
ok('500 ms by default', gcWarnMs({}) === 500);
ok('JARVIS_GC_WARN_MS sets it; nonsense keeps 500', gcWarnMs({ JARVIS_GC_WARN_MS: '800' }) === 800 && gcWarnMs({ JARVIS_GC_WARN_MS: 'x' }) === 500 && gcWarnMs({ JARVIS_GC_WARN_MS: '5' }) === 500);

process.chdir(os.tmpdir());   // Windows will not remove the current directory
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
