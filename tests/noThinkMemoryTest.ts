import { orchestrator } from '../core/orchestrator.js';
import { modelRouter } from '../bridge/modelRouter.js';
import { agentMemory } from '../memory/agentMemory.js';
import { nodeBridge } from '../bridge/nodeBridge.js';
import { agentStateMachine } from '../core/agentStateMachine.js';
import { memoryManager } from '../memory/memoryManager.js';

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
  console.log('\n=== No Think Memory Test ===\n');

  // Initialize memory
  await memoryManager.init();

  // Clear memory
  agentMemory.clearWorkingContext();

  // Mock streamChat to return a stream with <think> tag
  modelRouter.streamChat = async function* (req: any) {
    yield '<think>';
    yield 'hidden reasoning ';
    yield 'about tasks';
    yield '</think>';
    yield 'Hello sir.';
  };

  // Capture spoken output
  let spokenTexts: string[] = [];
  const originalSpeakToClients = nodeBridge.speakToClients;
  nodeBridge.speakToClients = function(text: string) {
    spokenTexts.push(text);
    return originalSpeakToClients.apply(this, arguments as any);
  };

  agentStateMachine.reset();
  await (orchestrator as any).streamDirectChat('are you happy');

  // Verify memory messages
  const history = agentMemory.getConversationHistory(5);
  const assistantMsg = [...history].reverse().find(h => h.role === 'assistant');
  
  assert(assistantMsg !== undefined, 'Assistant reply was saved in memory');
  if (assistantMsg) {
    assert(!assistantMsg.content.includes('<think>'), 'Memory content does NOT contain <think>');
    assert(!assistantMsg.content.includes('hidden reasoning'), 'Memory content does NOT contain hidden reasoning');
    assert(assistantMsg.content.trim() === 'Hello sir.', `Memory content is exactly "${assistantMsg.content}"`);
  }

  // Verify spoken output
  const allSpoken = spokenTexts.join(' ');
  assert(!allSpoken.includes('<think>'), 'Spoken output does NOT contain <think>');
  assert(!allSpoken.includes('hidden reasoning'), 'Spoken output does NOT contain hidden reasoning');
  assert(allSpoken.includes('Hello sir'), `Spoken output contains "Hello sir" (got: ${allSpoken})`);

  // Restore mock
  nodeBridge.speakToClients = originalSpeakToClients;

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('[noThinkMemoryTest] Unexpected error:', err);
  process.exit(1);
});
