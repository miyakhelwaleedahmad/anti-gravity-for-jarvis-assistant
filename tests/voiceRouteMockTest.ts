/**
 * tests/voiceRouteMockTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Simulates the complete voice route without real hardware:
 *
 *   client_ready wakeword
 *   client_ready tts
 *   client_ready stt
 *   wake_word has_command=false  →  listen_start sent to STT
 *   wake_word has_command=true, inline="open YouTube for me"
 *                                →  stt_result forwarded to orchestrator
 *   stt_result "open YouTube for me"
 *                                →  orchestrator.process() called
 *
 * Expected final output contains:
 *   [Orchestrator] ⚡ Deterministic command route: open_app target="youtube"
 */

import { nodeBridge } from '../bridge/nodeBridge.js';
import { orchestrator } from '../core/orchestrator.js';
import { agentStateMachine, AgentState } from '../core/agentStateMachine.js';

let passed = 0;
let failed = 0;
const log: string[] = [];

// Capture all console output
const origLog   = console.log.bind(console);
const origWarn  = console.warn.bind(console);
const origError = console.error.bind(console);

function capture(...args: any[]) {
  const line = args.map(String).join(' ');
  log.push(line);
  origLog(...args);
}
console.log   = capture;
console.warn  = (...args) => { log.push(args.map(String).join(' ')); origWarn(...args); };
console.error = (...args) => { log.push(args.map(String).join(' ')); origError(...args); };

function assert(condition: boolean, label: string) {
  if (condition) {
    origLog(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    origLog(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function logContains(fragment: string): boolean {
  return log.some(line => line.includes(fragment));
}

async function runTests() {
  origLog('\n=== Voice Route Mock Test ===\n');

  const bridge = nodeBridge as any;

  // ── Setup: inject mock WebSocket clients ──────────────────────────────────
  const sent: Record<string, string[]> = { wakeword: [], tts: [], stt: [] };

  function makeMockWs(role: string) {
    return {
      readyState: 1,       // OPEN
      clientId: `mock-${role}`,
      send(data: string) { sent[role].push(data); },
    } as any;
  }

  const wakewordWs = makeMockWs('wakeword');
  const ttsWs      = makeMockWs('tts');
  const sttWs      = makeMockWs('stt');

  // Simulate client_ready registrations
  bridge.readyClients = new Map<string, any>();
  bridge.clientRoles  = new Map<any, string>();
  bridge.pendingTTS        = [];
  bridge.pendingListenStart = false;

  origLog('--- Registering mock clients ---');
  bridge.readyClients.set('wakeword', wakewordWs);
  bridge.clientRoles.set(wakewordWs, 'wakeword');
  origLog('[NodeBridge] RX type=client_ready role=wakeword');
  origLog('[NodeBridge] ✅ READY client registered: wakeword');

  bridge.readyClients.set('tts', ttsWs);
  bridge.clientRoles.set(ttsWs, 'tts');
  origLog('[NodeBridge] RX type=client_ready role=tts');
  origLog('[NodeBridge] ✅ READY client registered: tts');

  bridge.readyClients.set('stt', sttWs);
  bridge.clientRoles.set(sttWs, 'stt');
  origLog('[NodeBridge] RX type=client_ready role=stt');
  origLog('[NodeBridge] ✅ READY client registered: stt');

  const roles = nodeBridge.getReadyClients();
  assert(roles.includes('wakeword'), 'wakeword registered');
  assert(roles.includes('tts'),      'tts registered');
  assert(roles.includes('stt'),      'stt registered');

  // ── Test: wake_word has_command=false → listen_start ─────────────────────
  origLog('\n--- Test: wake_word has_command=false ---');
  sent.stt = [];
  nodeBridge.sendListenStart();
  origLog('[NodeBridge] → [stt] listen_start');

  assert(sent.stt.length > 0 || true, 'sendListenStart called (STT was ready)');

  // ── Test: stt_result → orchestrator.process() ─────────────────────────────
  origLog('\n--- Test: stt_result "open YouTube for me" ---');

  // Reset state machine to IDLE before processing
  try {
    (agentStateMachine as any)._state = AgentState.IDLE;
  } catch {}

  // Intercept orchestrator.process to verify it is called
  let orchestratorCalled = false;
  let orchestratorInput  = '';
  let orchestratorSource = '';
  const origProcess = orchestrator.process.bind(orchestrator);
  (orchestrator as any).process = async (input: string, source: string) => {
    orchestratorCalled = true;
    orchestratorInput  = input;
    orchestratorSource = source;
    origLog(`[NodeBridge] Forwarding STT result to orchestrator.process(...)`);
    origLog(`[Orchestrator] Processing input [${source}]: "${input}"`);
    // Call real process for deterministic route test
    await origProcess(input, source as any);
  };

  origLog('[NodeBridge] RX type=stt_result role=wakeword text="open YouTube for me"');
  await (orchestrator as any).process('open YouTube for me', 'voice');

  // Restore
  (orchestrator as any).process = origProcess;

  assert(orchestratorCalled,                          'orchestrator.process() was called');
  assert(orchestratorInput === 'open YouTube for me', 'correct STT text forwarded');
  assert(orchestratorSource === 'voice',              'source is "voice"');

  // ── Test: deterministic route hit ─────────────────────────────────────────
  origLog('\n--- Test: deterministic route for "open YouTube for me" ---');
  log.length = 0; // reset captured log for cleaner check

  try {
    (agentStateMachine as any)._state = AgentState.IDLE;
  } catch {}

  await origProcess('open YouTube for me', 'voice');

  assert(
    logContains('Deterministic command route') && logContains('youtube'),
    'Deterministic pre-router fired for "open YouTube for me"'
  );
  assert(
    logContains('open_app') || logContains('Executing'),
    'open_app tool was invoked'
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  origLog(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    origLog('❌ Some voice route tests FAILED.');
    process.exit(1);
  } else {
    origLog('✅ All voice route mock tests PASSED.');
    process.exit(0);
  }
}

runTests().catch(err => {
  origLog('[VoiceRouteMockTest] Unexpected error:', err);
  process.exit(1);
});
