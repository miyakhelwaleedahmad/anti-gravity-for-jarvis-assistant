/**
 * tests/speechTimingUrlsTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner's PC, 2026-11-14 12:23: JARVIS said "Opening YouTube, sir. I checked:
 * JARVIS's Chrome has the tab https://www.youtube.com/." The SPEAKING watchdog,
 * armed when the reply was queued at 12:23:00, fired at 12:23:12 while it was
 * still being read: synthesis took 4 s (playback began 12:23:04), and the
 * address counted as one 0.4 s word in the speech estimate.
 *
 *   1. F1: what JARVIS says names a site ("youtube.com"), never a full address
 *   2. F2: the watchdog is timed from when playback starts (speaking_start)
 *   3. F2: a TTS that never starts, or never ends, is still caught, once
 *   4. F2: a late speaking_start after an interruption changes nothing
 *   5. F3: long tokens, addresses and numbers are estimated by their length
 *
 * The "I checked: …" note no longer being spoken is checked in
 * tests/verifyAfterActTest.ts, on a real write.
 *
 * No stand-ins: the text JARVIS would say is read from nodeBridge.lastTtsText,
 * and speaking_start goes through nodeBridge's own handler. The base SPEAKING
 * watchdog is 300 ms here so the test runs quickly.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-speech-timing-'));
for (const dir of ['memory', 'data']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;
process.env['JARVIS_CHROME_AUTOSTART'] = 'off';
process.env['JARVIS_SPEAKING_WATCHDOG_MS'] = '300';
process.chdir(workspace);

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { agentStateMachine, AgentState, estimateSpeechMs } = await import('../core/agentStateMachine.js');
const { nodeBridge } = await import('../bridge/nodeBridge.js');
const { orchestrator } = await import('../core/orchestrator.js');

const resets: string[] = [];
agentStateMachine.on('watchdog_reset', (d: { reason: string }) => resets.push(d.reason));

/** What JARVIS would say for `text` (the text sent to tts.py). */
function said(text: string): string {
  agentStateMachine.reset();
  nodeBridge.lastTtsText = '';
  orchestrator.speak(text);
  const out = nodeBridge.lastTtsText;
  agentStateMachine.reset();
  return out;
}

console.log('\n=== Speech: no addresses read out; the watchdog times the playback ===\n');

console.log('--- 1. F1: site names, not addresses ---');
{
  const s = said("Opening YouTube, sir. JARVIS's Chrome has the tab https://www.youtube.com/.");
  ok('1. the reply from the PC log names the site', s.includes('youtube.com') && !/https?:|www\.|\//.test(s), s);
  ok('1. …and keeps the sentence and its full stop', /has the tab youtube\.com\.$/.test(s), s);
}
{
  const s = said('Here are the results: https://www.youtube.com/results?search_query=lofi+music, sir.');
  ok('1. an address with a path and a query: only the site is said', s === 'Here are the results: youtube.com, sir.', s);
}
{
  const s = said('You can read it at www.github.com/anthropics/claude-code.');
  ok('1. a "www." address without the scheme: the site', s === 'You can read it at github.com.', s);
}
{
  const s = said('The health check is at http://localhost:3000/health right now.');
  ok('1. a local address with a port: the host only', s === 'The health check is at localhost right now.', s);
}
{
  const s = said('See [the release notes](https://example.com/notes/v2) for details.');
  ok('1. a Markdown link: its text', s === 'See the release notes for details.', s);
}
{
  const s = said('(https://docs.python.org/3/library/asyncio.html)');
  ok('1. an address in brackets: the site, brackets kept', s === '(docs.python.org)', s);
}
// Without a scheme: shortened only when a port or a path follows the host.
for (const [t, want] of [
  ['I opened 127.0.0.1 in a new tab first, because no tab shows 127.0.0.1:34759/about, sir.',
    'I opened 127.0.0.1 in a new tab first, because no tab shows 127.0.0.1, sir.'],
  ['It runs at localhost:3000/health now.', 'It runs at localhost now.'],
  ['The server is on localhost:5173.', 'The server is on localhost.'],
  ['The code is at github.com/anthropics/claude-code, sir.', 'The code is at github.com, sir.'],
] as const) {
  const s = said(t);
  ok(`1. no scheme, with a port or a path: "${t}"`, s === want, s);
}
for (const t of ['Opening YouTube, sir.', 'I saved it to notes.txt, sir.', 'GitHub is at github.com, sir.',
  'It is 10:30, sir.', 'The ratio is 1.5/2 today.', 'File written: /tmp/work/app.config/settings.json.',
  'Write to me at owner@example.com, sir.', 'Version 2.5 is out, e.g. today.']) {
  const s = said(t);
  ok(`1. text without a full address is unchanged: "${t}"`, s === t, s);
}

console.log('\n--- 2. F2: the watchdog is timed from playback start ---');
{
  agentStateMachine.reset(); resets.length = 0;
  agentStateMachine.transition(AgentState.SPEAKING);           // the text is sent to tts.py
  await sleep(200);                                             // synthesis
  nodeBridge.handleSpeakingLifecycleSignal('speaking_start');   // playback begins
  await sleep(200);                                             // 400 ms after sending: past the 300 ms allowance
  ok('2. still SPEAKING after the allowance counted from sending', agentStateMachine.currentState === AgentState.SPEAKING && resets.length === 0,
    `${agentStateMachine.currentState}, resets: [${resets}]`);
  nodeBridge.handleSpeakingLifecycleSignal('speaking_end');
  // jarvis.ts's "idle" handler moves JARVIS to IDLE on speaking_end; done here as it does.
  if (agentStateMachine.currentState === AgentState.SPEAKING) agentStateMachine.transition(AgentState.IDLE);
  await sleep(450);
  ok('2. speaking_end ends it normally: no watchdog fires afterwards', agentStateMachine.currentState === AgentState.IDLE && resets.length === 0,
    `${agentStateMachine.currentState}, resets: [${resets}]`);
  agentStateMachine.reset();
}

console.log('\n--- 3. F2: a TTS that never starts or never ends is still caught, once ---');
{
  agentStateMachine.reset(); resets.length = 0;
  agentStateMachine.transition(AgentState.SPEAKING);           // sent; tts.py never starts playing
  await sleep(450);
  ok('3. playback never started: the watchdog fires at the allowance from sending', agentStateMachine.currentState === AgentState.IDLE && resets.join() === 'speaking_timeout',
    `${agentStateMachine.currentState}, resets: [${resets}]`);
}
{
  agentStateMachine.reset(); resets.length = 0;
  agentStateMachine.transition(AgentState.SPEAKING);
  await sleep(150);
  const startedAt = Date.now();
  nodeBridge.handleSpeakingLifecycleSignal('speaking_start');   // playback starts; speaking_end never comes
  nodeBridge.handleSpeakingLifecycleSignal('speaking_start');   // a repeated start must not add a second timer
  while (agentStateMachine.currentState === AgentState.SPEAKING && Date.now() - startedAt < 2_000) await sleep(10);
  const firedAfter = Date.now() - startedAt;
  await sleep(500);                                             // room for a second, conflicting timer to fire
  ok('3. speaking_end never came: the watchdog fires about 300 ms after playback started', resets.join() === 'speaking_timeout' && firedAfter >= 250 && firedAfter < 700,
    `fired ${firedAfter} ms after speaking_start, resets: [${resets}]`);
  ok('3. …exactly once', resets.length === 1, `resets: [${resets}]`);
  agentStateMachine.reset();
}

console.log('\n--- 4. F2: an interruption is not undone by a late speaking_start ---');
{
  agentStateMachine.reset(); resets.length = 0;
  agentStateMachine.transition(AgentState.SPEAKING);
  agentStateMachine.interrupt();
  const stateAfterInterrupt = agentStateMachine.currentState;
  nodeBridge.handleSpeakingLifecycleSignal('speaking_start');   // arrives after the interruption
  await sleep(500);
  ok('4. still interrupted, and no SPEAKING watchdog fired', agentStateMachine.currentState === stateAfterInterrupt && resets.length === 0,
    `${stateAfterInterrupt} → ${agentStateMachine.currentState}, resets: [${resets}]`);
  agentStateMachine.reset();
}

console.log('\n--- 5. F3: speech estimate for long tokens ---');
ok('5. ordinary words keep 1 s + 0.4 s each', estimateSpeechMs('Opening YouTube, sir.') === 1_000 + 3 * 400, `${estimateSpeechMs('Opening YouTube, sir.')} ms`);
ok('5. a short number is an ordinary word', estimateSpeechMs('JARVIS version 2 is online, sir.') === 1_000 + 6 * 400, `${estimateSpeechMs('JARVIS version 2 is online, sir.')} ms`);
ok('5. nothing to say: 1 s', estimateSpeechMs('') === 1_000, `${estimateSpeechMs('')} ms`);
{
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const withUrl = estimateSpeechMs(`Opening ${url}, sir.`);
  ok('5. an address is not one 0.4 s word: at least 0.15 s per character', withUrl >= 1_000 + 2 * 400 + url.length * 150, `${withUrl} ms for a ${url.length}-character address`);
  const tab = estimateSpeechMs("Opening YouTube, sir. I checked: JARVIS's Chrome has the tab https://www.youtube.com/.");
  ok('5. the reply from the PC log is estimated at more than its 11 words', tab > 1_000 + 11 * 400 + 2_000, `${tab} ms`);
}
{
  const n = estimateSpeechMs('Your code is 4815162342.');
  ok('5. a long number is estimated by its digits', n >= 1_000 + 3 * 400 + 10 * 150, `${n} ms`);
}
{
  const w = estimateSpeechMs('It is internationalization.');
  ok('5. a long word (over 12 letters) by its letters', w >= 1_000 + 2 * 400 + 20 * 150, `${w} ms`);
}

agentStateMachine.reset();
process.chdir(repoRoot);
try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows: still in use */ }
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
