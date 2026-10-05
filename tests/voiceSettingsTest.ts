/**
 * tests/voiceSettingsTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Voice-loop settings:
 *
 *  1. A command heard while JARVIS was busy got "One moment, sir. I will get
 *     to that right after this." and was then dropped in silence once it was
 *     6 s old — shorter than one request on a slow PC. Now it waits 30 s, and
 *     a skipped one is announced.
 *  2. The follow-up window (15 s without the wake word) could not be changed.
 *  3. The Vision service always started, though nothing ever activates it.
 *
 * jarvis.ts starts the whole assistant when imported, so its use of these
 * settings is checked in its source.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

console.log('\n=== Voice Settings Test ===\n');

let settings: typeof import('../core/voiceSettings.js') | null = null;
try {
  settings = await import('../core/voiceSettings.js');
} catch (err) {
  ok('core/voiceSettings.ts loads', false, (err as Error).message);
}

if (settings) {
  const { queuedCommandMaxAgeMs, DROPPED_COMMAND_NOTICE, followUpSeconds, visionEnabled } = settings;

  console.log('--- 1. Queued commands ---');
  ok('a queued command may wait 30 s by default', queuedCommandMaxAgeMs({}) === 30_000);
  ok('JARVIS_QUEUED_COMMAND_MAX_AGE_MS sets it', queuedCommandMaxAgeMs({ JARVIS_QUEUED_COMMAND_MAX_AGE_MS: '45000' }) === 45_000);
  ok('a nonsense value keeps the default', queuedCommandMaxAgeMs({ JARVIS_QUEUED_COMMAND_MAX_AGE_MS: 'soon' }) === 30_000);
  ok('it never drops below 1 s', queuedCommandMaxAgeMs({ JARVIS_QUEUED_COMMAND_MAX_AGE_MS: '0' }) === 1_000);
  ok('a dropped command is announced', /skipped it\. Please say it again/.test(DROPPED_COMMAND_NOTICE), DROPPED_COMMAND_NOTICE);
  ok('without command words the mic could take as a new command',
    !/\b(open|launch|start|close|run|play|search|stop)\b/i.test(DROPPED_COMMAND_NOTICE));

  console.log('\n--- 2. Follow-up window ---');
  ok('15 s by default', followUpSeconds({}) === 15);
  ok('JARVIS_FOLLOWUP_SECONDS=0 turns it off', followUpSeconds({ JARVIS_FOLLOWUP_SECONDS: '0' }) === 0);
  ok('JARVIS_FOLLOWUP_SECONDS=8 sets 8 s', followUpSeconds({ JARVIS_FOLLOWUP_SECONDS: '8' }) === 8);

  console.log('\n--- 3. Vision switch ---');
  ok('on by default', visionEnabled({}) === true);
  ok('JARVIS_VISION=off turns it off', visionEnabled({ JARVIS_VISION: 'off' }) === false && visionEnabled({ JARVIS_VISION: 'FALSE' }) === false);
  ok('anything else leaves it on', visionEnabled({ JARVIS_VISION: 'on' }) === true);
}

console.log('\n--- jarvis.ts uses them ---');
const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'jarvis.ts'), 'utf8');
ok('the queue limit is the setting, not a fixed 6000 ms',
  source.includes('queuedCommandMaxAgeMs()') && !/item\.timestamp\s*>\s*6000/.test(source));
ok('a dropped command is announced', source.includes('nodeBridge.speakToClients(DROPPED_COMMAND_NOTICE)'));
ok('the follow-up window is the setting', source.includes('followUpSeconds()') && !/duration:\s*15\b/.test(source));
ok('Vision starts only when enabled', /if \(visionEnabled\(\)\)\s*\{\s*launchPythonServiceStaggered\('\.\.\/vision\/screen_capture\.py'/.test(source));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
