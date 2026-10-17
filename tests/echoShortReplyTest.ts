/**
 * tests/echoShortReplyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE-008: the echo filter dropped short things the user said.
 *
 * core/voiceEchoFilter.ts compared characters, not words, and accepted any
 * fragment: "phrase.includes(stt)" and "lastTts.includes(stt)". So "no" was
 * JARVIS's own echo after "I don't know that one, sir." ("know"), "here" after
 * any reply (the common phrase "here are"), and "yes" after a question that
 * offered "yes or no". The user's answer was thrown away.
 *
 * Now a fragment counts as echo only when it is whole words of the phrase,
 * in order, and either most of the phrase (60%) or at least four words, or
 * two or more words of something JARVIS just stated. After a question, a short
 * fragment is the user's answer ("the second one").
 */
import { evaluateEcho } from '../core/voiceEchoFilter.js';

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  const line = `  ${condition ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`;
  if (condition) { console.log(line); passed++; } else { console.error(line); failed++; }
}
const echo = (stt: string, tts: string) => evaluateEcho(stt, tts, undefined, Date.now());

console.log('\n=== Short user replies are not echo (VOICE-008) ===\n');
console.log('--- The user, not JARVIS ---');
for (const [stt, tts] of [
  ['no', "I don't know that one, sir."],
  ['here', 'Opening Chrome, sir.'],
  ['yes', 'Shall I close it, sir? Say yes or no.'],
  ['the second one', 'The first one or the second one, sir?'],
  ['no thanks', 'Is there anything else, sir? I know a few more.'],
  ['would you', 'Done, sir.'],
] as const) {
  const d = echo(stt, tts);
  ok(`"${stt}" after "${tts}" is kept`, !d.isEcho, d.reason);
}

console.log('\n--- Still JARVIS\'s own voice ---');
for (const [stt, tts] of [
  ['one moment sir', 'Opening Chrome, sir.'],
  ['would you like me to', 'Done, sir.'],
  ['done sir', 'Done, sir.'],
  ['the weather in paris is twelve degrees', 'The weather in Paris is twelve degrees and cloudy, sir.'],
  ['jarvis version 2 is online', 'Done, sir.'],
  ['opening chrome sir and then', 'Opening Chrome, sir.'],
  ['opening google', 'I am opening google for you'],
] as const) {
  const d = echo(stt, tts);
  ok(`"${stt}" after "${tts}" is echo`, d.isEcho, d.reason);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
