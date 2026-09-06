import { orchestrator } from '../core/orchestrator.js';
import { evaluateEcho } from '../core/voiceEchoFilter.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

console.log('\n=== Echo Filter Command Acceptance Test ===\n');

const lastTts = 'Opening YouTube, sir.';
const commandCases = [
  'open youtube',
  'open YouTube for me',
  'Jarvis open YouTube for me',
  'open you tube',
  'launch youtube',
  'start youtube',
];

for (const raw of commandCases) {
  const decision = evaluateEcho(raw, lastTts, orchestrator);
  ok(`${raw} is accepted`, decision.isEcho === false);
  ok(`${raw} has useful reason`, decision.reason.length > 0 && Number.isFinite(decision.overlapScore));
}

const echoDecision = evaluateEcho('Opening YouTube, sir.', lastTts, orchestrator);
ok('exact TTS echo is rejected', echoDecision.isEcho === true);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
