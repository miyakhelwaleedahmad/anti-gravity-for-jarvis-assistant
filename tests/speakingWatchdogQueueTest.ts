/**
 * tests/speakingWatchdogQueueTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * TTS sends speaking_start once and speaking_end only when its queue is empty.
 * With a fixed 12 s SPEAKING watchdog, three queued replies (seen on Windows:
 * startup greeting, a warning, an error message) were cut off mid-sentence and
 * logged as "TTS may have crashed". The watchdog now allows for queued speech;
 * with nothing queued it still fires at the base value, so a crashed TTS is
 * still recovered from.
 *
 * The base is shortened to 300 ms here so the test runs quickly.
 */

process.env['JARVIS_SPEAKING_WATCHDOG_MS'] = '300';
const { AgentStateMachine, AgentState, estimateSpeechMs } = await import('../core/agentStateMachine.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const greeting = 'JARVIS version 2 is online, sir. Autonomous systems are fully operational.';
const warning = "Sir, I've detected a warning in my brain_to_groq system.";
const fallback = "I'm experiencing difficulty reaching my primary reasoning systems, sir. Operating in degraded fallback mode.";

console.log('\n=== Speaking Watchdog Queue Test ===\n');

console.log('--- Estimates ---');
ok('a 14-word reply is estimated at about 6.6 s', estimateSpeechMs(fallback) === 1_000 + 14 * 400, `${estimateSpeechMs(fallback)}ms`);

console.log('\n--- The three queued replies from the log ---');
{
  const sm = new AgentStateMachine();
  for (const t of [greeting, warning, fallback]) sm.noteSpeechQueued(t);
  const total = [greeting, warning, fallback].reduce((n, t) => n + estimateSpeechMs(t), 0);
  ok('the watchdog allows for all queued speech plus a margin', sm.speakingWatchdogMs() === total + 3_000, `${sm.speakingWatchdogMs()}ms for ~${total}ms of speech`);
  ok('which is longer than the old fixed 12 s', sm.speakingWatchdogMs() > 12_000);

  sm.transition(AgentState.SPEAKING);
  await sleep(700); // more than twice the 300 ms base
  ok('still SPEAKING after the base time has passed', sm.currentState === AgentState.SPEAKING, sm.currentState);
  sm.noteSpeechFinished();
  sm.transition(AgentState.IDLE); // speaking_end
}

console.log('\n--- A reply queued while already speaking stretches the deadline ---');
{
  const sm = new AgentStateMachine();
  sm.transition(AgentState.SPEAKING);
  sm.noteSpeechQueued('ok');
  await sleep(700);
  ok('still SPEAKING', sm.currentState === AgentState.SPEAKING, sm.currentState);
  sm.noteSpeechFinished();
  sm.transition(AgentState.IDLE);
}

console.log('\n--- Nothing queued (TTS crashed): the watchdog still fires at the base ---');
{
  const sm = new AgentStateMachine();
  ok('allowance falls back to the base', sm.speakingWatchdogMs() === 300, `${sm.speakingWatchdogMs()}ms`);
  sm.transition(AgentState.SPEAKING);
  await sleep(600);
  ok('reset to IDLE', sm.currentState === AgentState.IDLE, sm.currentState);
}

console.log('\n--- speaking_end clears the estimate ---');
{
  const sm = new AgentStateMachine();
  sm.noteSpeechQueued(fallback);
  sm.noteSpeechFinished();
  ok('back to the base allowance', sm.speakingWatchdogMs() === 300);
  for (let i = 0; i < 100; i++) sm.noteSpeechQueued(fallback);
  ok('capped at 2 minutes however much is queued', sm.speakingWatchdogMs() === 120_000, `${sm.speakingWatchdogMs()}ms`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
