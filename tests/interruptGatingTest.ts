import { agentStateMachine, AgentState } from "../core/agentStateMachine.js";
import { conversationBus } from "../core/conversationBus.js";

// Mock nodeBridge for the test
const mockNodeBridge = {
  ttsStopped: false,
  sendToRole(role: string, msg: any) {
    if (role === 'tts' && msg.payload?.action === 'stop') {
      this.ttsStopped = true;
    }
  }
};

// The exact logic from jarvis.ts:
function handleSpeechDetected() {
  if (conversationBus.isSpeaking || agentStateMachine.is(AgentState.SPEAKING)) {
    console.log('[JARVIS] speech_detected accepted as barge-in during SPEAKING');
    mockNodeBridge.sendToRole('tts', { type: 'command', payload: { action: 'stop' } });
    agentStateMachine.interrupt();
  } else {
    console.log(`[JARVIS] speech_detected ignored because assistant is not speaking. state=${agentStateMachine.currentState}`);
  }
}

async function runTest() {
  console.log("=== Interrupt Gating Unit Test ===");

  // --- Test Case 1: PLANNING state ---
  console.log("\n--- Test Case 1: Triggering speech_detected during PLANNING ---");
  agentStateMachine["_state"] = AgentState.PLANNING;
  mockNodeBridge.ttsStopped = false;
  handleSpeechDetected();
  const state1 = agentStateMachine.currentState as any;
  console.log(`State: ${state1}, TTS Stopped: ${mockNodeBridge.ttsStopped}`);
  if (state1 === AgentState.PLANNING && !mockNodeBridge.ttsStopped) {
    console.log("PASS: Ignored during PLANNING.");
  } else {
    console.error("FAIL: Should be ignored during PLANNING!");
    process.exit(1);
  }

  // --- Test Case 2: EXECUTING state ---
  console.log("\n--- Test Case 2: Triggering speech_detected during EXECUTING ---");
  agentStateMachine["_state"] = AgentState.EXECUTING;
  mockNodeBridge.ttsStopped = false;
  handleSpeechDetected();
  const state2 = agentStateMachine.currentState as any;
  console.log(`State: ${state2}, TTS Stopped: ${mockNodeBridge.ttsStopped}`);
  if (state2 === AgentState.EXECUTING && !mockNodeBridge.ttsStopped) {
    console.log("PASS: Ignored during EXECUTING.");
  } else {
    console.error("FAIL: Should be ignored during EXECUTING!");
    process.exit(1);
  }

  // --- Test Case 3: SPEAKING state ---
  console.log("\n--- Test Case 3: Triggering speech_detected during SPEAKING ---");
  agentStateMachine["_state"] = AgentState.SPEAKING;
  mockNodeBridge.ttsStopped = false;
  handleSpeechDetected();
  const state3 = agentStateMachine.currentState as any;
  console.log(`State: ${state3}, TTS Stopped: ${mockNodeBridge.ttsStopped}`);
  if (state3 === AgentState.INTERRUPTED && mockNodeBridge.ttsStopped) {
    console.log("PASS: Interrupted successfully during SPEAKING.");
  } else {
    console.error("FAIL: Should interrupt during SPEAKING!");
    process.exit(1);
  }

  console.log("\n=== All Unit Gating Tests Passed Successfully ===");
  process.exit(0);
}

runTest().catch(err => {
  console.error(err);
  process.exit(1);
});
