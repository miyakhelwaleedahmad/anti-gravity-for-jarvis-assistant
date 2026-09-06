import { orchestrator } from '../core/orchestrator.js';
import { conversationBus } from '../core/conversationBus.js';
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
  console.log('\n=== TTS Lifecycle State Test ===\n');

  agentStateMachine.reset();
  
  let endedCallCount = 0;
  const originalConversationEnded = conversationBus.conversationEnded;
  conversationBus.conversationEnded = function() {
    endedCallCount++;
    return originalConversationEnded.apply(this);
  };

  // 1. Verify speak() puts state into SPEAKING
  assert(agentStateMachine.currentState === AgentState.IDLE, 'Initial state is IDLE');
  orchestrator.speak('Testing state transition to speaking, sir.');
  assert(agentStateMachine.currentState === AgentState.SPEAKING, 'State is SPEAKING after speak()');

  // 2. Reset state to IDLE and process a deterministic command that speaks
  agentStateMachine.reset();
  endedCallCount = 0;

  // Process a command that outputs speech
  await orchestrator.process('hello', 'voice');

  // State should be SPEAKING, and conversationEnded should NOT have been called yet
  assert(agentStateMachine.currentState === AgentState.SPEAKING, 'State remains SPEAKING immediately after process() finishes');
  assert(endedCallCount === 0, 'conversationEnded() was NOT called because state is SPEAKING');

  // 3. Trigger speaking end via conversationBus.speakingEnded()
  conversationBus.speakingEnded();

  // Reset to IDLE should now have happened, and conversationEnded should be called
  assert(agentStateMachine.currentState === AgentState.IDLE, 'State returned to IDLE after speakingEnded()');
  assert(endedCallCount === 1, 'conversationEnded() was called after speakingEnded()');

  // Clean up
  conversationBus.conversationEnded = originalConversationEnded;

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('[ttsLifecycleStateTest] Unexpected error:', err);
  process.exit(1);
});
