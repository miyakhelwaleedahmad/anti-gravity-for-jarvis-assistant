/**
 * tests/listeningRecoveryTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG-1: JARVIS went deaf after "Jarvis" alone. STT rejected the audio and
 * said nothing, so the state stayed LISTENING, STT kept the mic and the wake
 * word stayed paused for 15 minutes.
 *
 *   1. The LISTENING watchdog: a session that nobody ends returns to IDLE
 *      (watchdog_reset from LISTENING); a session that moves on in time does not.
 *   2. endListening (stt_no_speech or the watchdog): the STT mic is freed,
 *      the state goes to IDLE and the wake word is resumed. The wake word's
 *      own mic is left alone; a late message during another state does not
 *      change that state.
 *   3. jarvis.ts calls it for stt_no_speech and for a LISTENING watchdog reset.
 *
 * The other half (stt.py sends stt_no_speech on every exit) is
 * tests/python/test_stt_session_end.py.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

process.env['JARVIS_LISTENING_WATCHDOG_MS'] = '1200';
const { agentStateMachine, AgentState, listeningWatchdogMs } = await import('../core/agentStateMachine.js');
const { endListening } = await import('../core/listenSession.js');

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function toIdle(): void {
  if (!agentStateMachine.is(AgentState.IDLE)) {
    try { agentStateMachine.transition(AgentState.IDLE); } catch { agentStateMachine.interrupt(); try { agentStateMachine.transition(AgentState.IDLE); } catch { /* best effort */ } }
  }
}

// ── 1. LISTENING watchdog ────────────────────────────────────────────────────
console.log('\n--- 1. LISTENING watchdog ---');
{
  ok('the allowance is read from JARVIS_LISTENING_WATCHDOG_MS', listeningWatchdogMs() === 1200);
  ok('default 35 s; a nonsense or tiny value keeps the default', listeningWatchdogMs({}) === 35_000 && listeningWatchdogMs({ JARVIS_LISTENING_WATCHDOG_MS: 'x' }) === 35_000 && listeningWatchdogMs({ JARVIS_LISTENING_WATCHDOG_MS: '10' }) === 35_000);
  toIdle();
  const resets: Array<{ fromState: string; reason: string }> = [];
  const onReset = (d: { fromState: string; reason: string }) => resets.push(d);
  agentStateMachine.on('watchdog_reset', onReset);
  agentStateMachine.transition(AgentState.LISTENING);
  await sleep(1600);
  ok('a session nobody ends returns to IDLE', agentStateMachine.is(AgentState.IDLE), agentStateMachine.currentState);
  ok('…and says so (watchdog_reset from LISTENING, listening_timeout)', resets.some((r) => r.fromState === AgentState.LISTENING && r.reason === 'listening_timeout'), JSON.stringify(resets));

  resets.length = 0;
  agentStateMachine.transition(AgentState.LISTENING);
  await sleep(300);
  agentStateMachine.transition(AgentState.PROCESSING_STT);
  await sleep(1300);
  ok('a session that moves on in time is not reset', agentStateMachine.is(AgentState.PROCESSING_STT) && resets.length === 0, `${agentStateMachine.currentState} ${JSON.stringify(resets)}`);
  agentStateMachine.off('watchdog_reset', onReset);
  toIdle();
}

// ── 2. endListening ──────────────────────────────────────────────────────────
console.log('\n--- 2. endListening ---');
function deps(owner: string) {
  const calls: string[] = [];
  let listening = true;
  return {
    calls,
    listening: () => listening,
    d: {
      micOwner: () => owner,
      releaseSttMic: (r: string) => { calls.push(`release:${r}`); },
      setListening: (on: boolean) => { listening = on; },
      resumeWakeWord: () => { calls.push('resume'); },
      log: (e: string, r: string) => { calls.push(`log:${e}:${r}`); },
    },
  };
}
{
  toIdle();
  agentStateMachine.transition(AgentState.LISTENING);
  const t = deps('STT');
  endListening('stt_vad_rejected', t.d);
  ok('the STT mic is freed', t.calls.includes('release:stt_vad_rejected'), t.calls.join(', '));
  ok('the state goes back to IDLE', agentStateMachine.is(AgentState.IDLE), agentStateMachine.currentState);
  ok('the wake word is resumed and listening is off', t.calls.includes('resume') && !t.listening());
  ok('the reason is logged', t.calls.includes('log:STT_NO_SPEECH:stt_vad_rejected'));

  const w = deps('WAKE_WORD');
  endListening('stt_timeout', w.d);
  ok('a mic the wake word holds is not released', !w.calls.some((c) => c.startsWith('release')) && w.calls.includes('resume'));

  agentStateMachine.transition(AgentState.PLANNING);
  const late = deps('NONE');
  endListening('stt_timeout', late.d);
  ok('a late stt_no_speech while planning leaves PLANNING alone', agentStateMachine.is(AgentState.PLANNING), agentStateMachine.currentState);
  toIdle();
}

// ── 3. jarvis.ts wiring ──────────────────────────────────────────────────────
console.log('\n--- 3. jarvis.ts wiring ---');
{
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'jarvis.ts'), 'utf8');
  ok('stt_no_speech from STT ends the session', /nodeBridge\.on\('stt_no_speech'[\s\S]{0,300}endListening\(/.test(src));
  ok('a LISTENING watchdog reset ends the session (mic freed, not only the wake word resumed)', /on\('watchdog_reset'[\s\S]{0,300}AgentState\.LISTENING\) endListening\(/.test(src));
}

// ── 4. Health sees a stuck session (BUG-4) ───────────────────────────────────
console.log('\n--- 4. Health ---');
{
  const { healthLedger, LEDGER_PIPELINES } = await import('../monitoring/healthLedger.js');
  const { healthManager } = await import('../monitoring/healthManager.js');
  const { nodeBridge } = await import('../bridge/nodeBridge.js');
  const bridge = nodeBridge as any;
  const realReady = bridge.readyClients;
  bridge.readyClients = new Map([['stt', { readyState: 1 }], ['tts', { readyState: 1 }], ['wakeword', { readyState: 1 }]]);
  healthLedger.record(LEDGER_PIPELINES.stt, true, 'transcript produced');
  toIdle();
  agentStateMachine.transition(AgentState.LISTENING);
  endListening('stt_vad_rejected', deps('STT').d);
  { const s0 = healthLedger.status(LEDGER_PIPELINES.stt, ['stt', 'wakeword']); ok('the owner staying silent is not a fault', s0.state === 'healthy', `${s0.state}: ${s0.detail}`); }
  agentStateMachine.transition(AgentState.LISTENING);
  endListening('listening_watchdog', deps('STT').d, true);
  const st = healthLedger.status(LEDGER_PIPELINES.stt, ['stt', 'wakeword']);
  ok('a session STT never answered is recorded as a failed STT outcome', st.state === 'degraded' || st.state === 'failing', `${st.state}: ${st.detail}`);
  const snap = await healthManager.probe();
  ok('…and the dashboard shows STT degraded, not online', snap.services.stt?.status === 'degraded', `${snap.services.stt?.status}: ${snap.services.stt?.detail}`);
  bridge.readyClients = realReady;
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'jarvis.ts'), 'utf8');
  ok('jarvis.ts frees a stale STT mic whenever JARVIS goes IDLE', /state === AgentState\.IDLE[\s\S]{0,400}_micOwner === MicOwner\.STT && !isSttListening\) releaseMic/.test(src));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
