/**
 * tests/voiceNormalizerTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-11: normalizeVoiceInput deleted "can you", "please", "for me" … anywhere
 * in the sentence: "language task can you set" became "language task set",
 * and "what can you do" became "what do", and that is what the planner was
 * asked. Politeness is now removed only at the start or the end.
 */
const { normalizeVoiceInput } = await import('../core/voiceInput.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}
const cases: [string, string][] = [
  ['language task can you set', 'language task can you set'],
  ['what can you do', 'what can you do'],
  ['Jarvis, can you open YouTube for me?', 'open youtube'],
  ['could you please open chrome', 'open chrome'],
  ['open notepad please', 'open notepad'],
  ['please, would you close the window for me please', 'close the window'],
  ['tell me who can you call', 'tell me who can you call'],
  ['you tube', 'youtube'],
];
for (const [input, want] of cases) {
  const got = normalizeVoiceInput(input);
  ok(`"${input}" → "${want}"`, got === want, `got "${got}"`);
}
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
