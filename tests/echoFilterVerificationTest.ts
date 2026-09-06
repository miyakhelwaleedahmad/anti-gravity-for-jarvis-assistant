import { evaluateEcho } from '../core/voiceEchoFilter.js';

async function runEchoFilterVerificationTest() {
  console.log('=== ECHO FILTER & SPEECH OVERLAP VERIFICATION TEST ===\n');

  const now = Date.now();
  const ttsTimeRecent = now - 1000; // 1 second ago
  const ttsTimeExpired = now - 10_000; // 10 seconds ago

  const recentTtsText = "JARVIS version 2 is online, sir. Autonomous systems are fully operational.";

  // Test 1: Real TTS Echo should be rejected
  const decision1 = evaluateEcho(recentTtsText, recentTtsText, undefined, ttsTimeRecent);
  console.log(`[Test 1] Echo check on recent TTS: isEcho=${decision1.isEcho} (reason: ${decision1.reason})`);
  if (!decision1.isEcho) {
    console.error('❌ FAIL: Recent TTS echo was not detected!');
    process.exit(1);
  }

  // Test 2: Common Phrase Echo should be rejected
  const decision2 = evaluateEcho("one moment sir", recentTtsText, undefined, ttsTimeRecent);
  console.log(`[Test 2] Common phrase check: isEcho=${decision2.isEcho} (reason: ${decision2.reason})`);
  if (!decision2.isEcho) {
    console.error('❌ FAIL: Common TTS phrase echo was not detected!');
    process.exit(1);
  }

  // Test 3: Legitimate user command (Command-like) should NEVER be rejected
  const decision3 = evaluateEcho("open google chrome", recentTtsText, undefined, ttsTimeRecent);
  console.log(`[Test 3] Legitimate command 'open google chrome': isEcho=${decision3.isEcho} (reason: ${decision3.reason})`);
  if (decision3.isEcho) {
    console.error('❌ FAIL: Legitimate command was incorrectly flagged as echo!');
    process.exit(1);
  }

  // Test 4: Legitimate user command with search verb
  const decision4 = evaluateEcho("search for weather forecast", recentTtsText, undefined, ttsTimeRecent);
  console.log(`[Test 4] Legitimate command 'search for weather forecast': isEcho=${decision4.isEcho} (reason: ${decision4.reason})`);
  if (decision4.isEcho) {
    console.error('❌ FAIL: Legitimate search command was incorrectly flagged as echo!');
    process.exit(1);
  }

  // Test 5: Expired TTS text (>8s) should not block new user commands
  const decision5 = evaluateEcho("autonomous systems are operational", recentTtsText, undefined, ttsTimeExpired);
  console.log(`[Test 5] Expired TTS check (>8s): isEcho=${decision5.isEcho} (reason: ${decision5.reason})`);
  if (decision5.isEcho) {
    console.error('❌ FAIL: Expired TTS caused false positive echo rejection!');
    process.exit(1);
  }

  console.log('\n✅ ALL ECHO FILTER VERIFICATION TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

runEchoFilterVerificationTest().catch(err => {
  console.error('Fatal error during echo filter test:', err);
  process.exit(1);
});
