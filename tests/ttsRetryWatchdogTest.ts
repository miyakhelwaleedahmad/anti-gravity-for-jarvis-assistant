/**
 * tests/ttsRetryWatchdogTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The SPEAKING watchdog and a TTS synthesis retry (docs/PROVIDER_HEALTH_AUDIT.md
 * §4, item 15).
 *
 * The watchdog is armed when JARVIS sends text to TTS, and speaking_start
 * comes only after synthesis. A first edge-tts attempt that timed out plus a
 * retry outlasted the watchdog: it fired during normal speech, reopened the
 * mic and logged "TTS may have crashed". tts.py now sends `speaking_delay`
 * and the deadline is extended. A TTS that really dies is still caught, and a
 * late speaking_end after a watchdog reset does not leave anything stuck.
 *
 * The base watchdog is 300 ms here so the test runs quickly.
 */

process.env['JARVIS_SPEAKING_WATCHDOG_MS'] = '300';
const { AgentStateMachine, AgentState, agentStateMachine } = await import('../core/agentStateMachine.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { conversationBus } = await import('../core/conversationBus.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log('\n=== TTS retry and the speaking watchdog ===\n');

console.log('--- Without the delay message, a retry outlasts the watchdog (the bug) ---');
{
  const sm = new AgentStateMachine();
  const resets: string[] = [];
  sm.on('watchdog_reset', (d: { reason: string }) => resets.push(d.reason));
  sm.transition(AgentState.SPEAKING);
  await sleep(450); // the "first attempt" times out
  ok('the watchdog fired during synthesis', sm.currentState === AgentState.IDLE && resets.includes('speaking_timeout'), sm.currentState);
}

console.log('\n--- With speaking_delay, the deadline is extended ---');
{
  const sm = new AgentStateMachine();
  const resets: string[] = [];
  sm.on('watchdog_reset', (d: { reason: string }) => resets.push(d.reason));
  sm.transition(AgentState.SPEAKING);
  await sleep(200); // first attempt times out at 200 ms; TTS says so before retrying
  sm.noteSpeechDelayed(500, 'synthesis_retry');
  const allowance = sm.speakingWatchdogMs();
  await sleep(400); // past the old 300 ms deadline
  ok('still SPEAKING after the old deadline', sm.currentState === AgentState.SPEAKING && resets.length === 0, `${sm.currentState}, allowance ${allowance} ms`);
  sm.noteSpeechFinished();
  sm.transition(AgentState.IDLE); // speaking_end after the retry and playback
  ok('speaking_end ends it normally', sm.currentState === AgentState.IDLE && resets.length === 0);
}

console.log('\n--- A TTS that dies after asking for more time is still caught ---');
{
  const sm = new AgentStateMachine();
  const resets: string[] = [];
  sm.on('watchdog_reset', (d: { reason: string }) => resets.push(d.reason));
  sm.transition(AgentState.SPEAKING);
  sm.noteSpeechDelayed(200, 'synthesis_retry');
  const allowance = sm.speakingWatchdogMs();
  ok('the extension is bounded (pending + 3 s margin)', allowance === 3_200, `${allowance} ms`);
  await sleep(allowance + 300);
  ok('the watchdog fires after the extended time', sm.currentState === AgentState.IDLE && resets.includes('speaking_timeout'));
}

console.log('\n--- Bad or unrelated delay messages change nothing ---');
{
  const sm = new AgentStateMachine();
  sm.noteSpeechDelayed(-5);
  sm.noteSpeechDelayed(0);
  ok('zero or negative extra time is ignored', sm.speakingWatchdogMs() === 300);
  sm.noteSpeechDelayed(10_000_000);
  ok('a huge request is capped (30 s + margin)', sm.speakingWatchdogMs() === 33_000, `${sm.speakingWatchdogMs()} ms`);
  const idle = new AgentStateMachine();
  idle.noteSpeechDelayed(500);
  ok('outside SPEAKING it arms nothing', idle.currentState === AgentState.IDLE);
}

console.log('\n--- The bridge passes speaking_delay on ---');
// As jarvis.ts wires it: when speech ends and nothing else runs, the state goes to IDLE.
conversationBus.on('idle', () => { if (!agentStateMachine.is(AgentState.IDLE)) agentStateMachine.transition(AgentState.IDLE); });
{
  agentStateMachine.safeTransitionToSpeaking();
  conversationBus.speakingStarted();
  const before = agentStateMachine.speakingWatchdogMs();
  nodeBridge.handleSpeakingDelay({ reason: 'synthesis_retry', extra_ms: 4000 });
  ok('speaking_delay extends the watchdog', agentStateMachine.speakingWatchdogMs() > before, `${before} → ${agentStateMachine.speakingWatchdogMs()} ms`);
  const mid = agentStateMachine.speakingWatchdogMs();
  nodeBridge.handleSpeakingDelay({ extra_ms: 'lots' });
  nodeBridge.handleSpeakingDelay({});
  ok('a malformed payload is ignored', agentStateMachine.speakingWatchdogMs() === mid);
  nodeBridge.handleSpeakingLifecycleSignal('speaking_end', {});
  ok('speaking_end clears the pending time and ends SPEAKING', agentStateMachine.speakingWatchdogMs() === 300 && !conversationBus.isSpeaking
    && agentStateMachine.currentState === AgentState.IDLE, agentStateMachine.currentState);
}

console.log('\n--- A late speaking_end after a watchdog reset leaves nothing stuck ---');
{
  agentStateMachine.safeTransitionToSpeaking();
  conversationBus.speakingStarted();
  await sleep(450); // watchdog resets to IDLE
  const afterReset = agentStateMachine.currentState;
  nodeBridge.handleSpeakingLifecycleSignal('speaking_end', {}); // arrives late
  nodeBridge.handleSpeakingLifecycleSignal('speaking_end', {}); // and twice
  ok('the late, duplicated speaking_end is harmless', afterReset === AgentState.IDLE && agentStateMachine.currentState === AgentState.IDLE && !conversationBus.isSpeaking, agentStateMachine.currentState);
  agentStateMachine.safeTransitionToSpeaking();
  ok('the next reply can still enter SPEAKING', agentStateMachine.currentState === AgentState.SPEAKING);
  nodeBridge.handleSpeakingLifecycleSignal('speaking_end', {});
  ok('… and leaves it normally', agentStateMachine.currentState === AgentState.IDLE);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
