import { orchestrator } from '../core/orchestrator.js';
import { nodeBridge } from '../bridge/nodeBridge.js';
import { agentStateMachine } from '../core/agentStateMachine.js';

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
  console.log('\n=== Stop Clears TTS Queue Test ===\n');

  // Queue up some fake TTS messages
  (nodeBridge as any).pendingTTS = ['Sentence 1', 'Sentence 2'];
  assert((nodeBridge as any).pendingTTS.length === 2, 'Pending TTS queue contains 2 messages initially');

  // Mock nodeBridge.sendToRole
  let sentStop: boolean = false;
  const originalSendToRole = nodeBridge.sendToRole;
  nodeBridge.sendToRole = function(role: string, msg: any) {
    if (role === 'tts' && msg.type === 'command' && msg.payload?.action === 'stop') {
      sentStop = true;
    }
    return originalSendToRole.apply(this, arguments as any);
  };

  // Run the stop command
  agentStateMachine.reset();
  await orchestrator.process('stop', 'voice');

  // Assertions
  assert(sentStop, 'Sent TTS stop command to TTS role');
  const queue = (nodeBridge as any).pendingTTS;
  assert(!queue.includes('Sentence 1') && !queue.includes('Sentence 2'), 'Stale TTS queue entries were cleared');
  assert(queue.length <= 1, 'TTS queue has at most the new stop reply');

  // Restore mock
  nodeBridge.sendToRole = originalSendToRole;

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('[stopClearsTtsQueueTest] Unexpected error:', err);
  process.exit(1);
});
