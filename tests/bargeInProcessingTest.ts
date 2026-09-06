import { orchestrator } from '../core/orchestrator.js';
import { nodeBridge } from '../bridge/nodeBridge.js';
import { agentStateMachine, AgentState } from '../core/agentStateMachine.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n=== Barge-In Processing Test ===\n');

  // Spy on sendToRole to verify stop action
  let sentStop: boolean = false;
  const originalSendToRole = nodeBridge.sendToRole;
  nodeBridge.sendToRole = function(role: string, msg: any) {
    if (role === 'tts' && msg.type === 'command' && msg.payload?.action === 'stop') {
      sentStop = true;
    }
    return originalSendToRole.apply(this, arguments as any);
  };

  // Set the state to SPEAKING
  agentStateMachine.reset();
  agentStateMachine.safeTransitionToSpeaking();
  assert(agentStateMachine.currentState === AgentState.SPEAKING, 'Initial state set to SPEAKING');

  // Track transitions
  const transitions: AgentState[] = [];
  const onTransition = (ev: { from: AgentState; to: AgentState }) => {
    transitions.push(ev.to);
  };
  agentStateMachine.on('transition', onTransition);

  // Send a new command during SPEAKING state (barge-in)
  await orchestrator.process('hello', 'voice');

  // Verify transitions and effects
  assert(sentStop, 'Barge-in triggered TTS stop command');
  
  console.log('Transitions recorded:', transitions);

  // The state transition path should include INTERRUPTED then PROCESSING_STT
  assert(transitions.includes(AgentState.INTERRUPTED), 'State machine transitioned to INTERRUPTED');
  assert(transitions.includes(AgentState.PROCESSING_STT), 'State machine transitioned to PROCESSING_STT');

  // Clean up
  agentStateMachine.off('transition', onTransition);
  nodeBridge.sendToRole = originalSendToRole;

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('[bargeInProcessingTest] Unexpected error:', err);
  process.exit(1);
});
