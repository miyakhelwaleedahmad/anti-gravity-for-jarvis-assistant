/**
 * tests/echoWindowFromPlaybackEndTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Replays a Windows log: JARVIS said "Opening chrome, sir.", the wake-word
 * microphone caught the tail of it, and the echo filter accepted
 * "opening chrome sir" as a new command (similarity 1.00) because its 4 s
 * window was measured from when the text was SENT to TTS (6.5 s earlier), not
 * from when playback ENDED (about 3 s earlier). The bogus command cost an LLM
 * request and an error reply.
 */

import { evaluateEcho } from '../core/voiceEchoFilter.js';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const now = Date.now();
const sentAt = now - 6_461;    // text sent to TTS (from the log: age=6461ms)
const startedAt = now - 5_800; // playback started
const endedAt = now - 2_800;   // speaking_end

console.log('\n=== Echo Window From Playback End Test ===\n');

console.log('--- The case from the log ---');
{
  const d = evaluateEcho('opening Chrome sir', 'Opening chrome, sir.', undefined, sentAt, startedAt, endedAt);
  ok('JARVIS hearing its own reply is rejected', d.isEcho === true, d.reason);
  const old = evaluateEcho('opening Chrome sir', 'Opening chrome, sir.', undefined, sentAt, startedAt);
  ok('(without the playback-end time, the old behaviour: accepted)', old.isEcho === false, old.reason);
}

console.log('\n--- A command-like reply heard back verbatim ---');
{
  const d = evaluateEcho('open chrome sir', 'Open Chrome, sir.', undefined, sentAt, startedAt, endedAt);
  ok('rejected, not run as a command', d.isEcho === true, d.reason);
}

console.log('\n--- Real commands are still accepted ---');
{
  for (const cmd of ['open youtube', 'search for the weather in Lahore', 'close chrome']) {
    const d = evaluateEcho(cmd, 'Opening chrome, sir.', undefined, sentAt, startedAt, endedAt);
    ok(`"${cmd}" accepted right after a reply`, d.isEcho === false, d.reason);
  }
  const later = evaluateEcho('opening chrome sir', 'Opening chrome, sir.', undefined, now - 20_000, now - 19_000, now - 10_000);
  ok('the same words 10 s after playback ended are taken as the user\'s', later.isEcho === false, later.reason);
}

console.log('\n--- No speaking_end yet (TTS crashed or still playing) ---');
{
  const d = evaluateEcho('something unrelated entirely', 'Opening chrome, sir.', undefined, now - 1_000, now - 900, 0);
  ok('falls back to the send time, as before', d.reason !== '' && !d.reason.startsWith('tts_expired'), d.reason);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
