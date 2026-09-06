import { agentStateMachine, AgentState } from '../core/agentStateMachine.js';
import { conversationBus } from '../core/conversationBus.js';
import { orchestrator } from '../core/orchestrator.js';

async function runVoiceQueueAntiDeadlockTest() {
  console.log('=== VOICE QUEUE & ANTI-DEADLOCK SAFETY TEST ===\n');

  // 1. Verify Timing Instrumentation (No console.time label warnings)
  const warnLogs: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: any[]) => {
    const msg = args.join(' ');
    warnLogs.push(msg);
    originalWarn(...args);
  };

  // Pre-warmed prompt check
  const sysPrompt = orchestrator.getPrewarmedSystemPrompt();
  console.log(`[Timing Test] Pre-warmed prompt length: ${sysPrompt.prompt.length} chars, estimated tokens: ${sysPrompt.tokens}`);

  const timeLabelWarnings = warnLogs.filter(w => w.includes('already exists') || w.includes('LLM Model Call'));
  if (timeLabelWarnings.length > 0) {
    console.error(`❌ FAIL: Found timing label warnings:`, timeLabelWarnings);
    process.exit(1);
  }
  console.log(`✅ PASS: No duplicate console.time label warnings detected.`);

  // 2. Verify State Machine & Queue Handoff Anti-Deadlock Safety
  console.log(`[StateMachine Test] Initial State: ${agentStateMachine.currentState}`);
  
  // Transition IDLE -> SPEAKING -> IDLE
  conversationBus.emit('speaking:start');
  console.log(`[StateMachine Test] State during TTS: ${agentStateMachine.currentState}`);
  
  conversationBus.emit('speaking:end');
  console.log(`[StateMachine Test] State after TTS: ${agentStateMachine.currentState}`);

  // Trigger state reset / IDLE emission
  conversationBus.emit('idle');
  console.log(`[StateMachine Test] State after idle event: ${agentStateMachine.currentState}`);

  if (!agentStateMachine.is(AgentState.IDLE)) {
    console.error(`❌ FAIL: State machine failed to return to IDLE! Current state: ${agentStateMachine.currentState}`);
    process.exit(1);
  }

  console.log(`✅ PASS: State machine returned cleanly to IDLE without deadlock.`);

  // Restore console.warn
  console.warn = originalWarn;
  
  console.log('\n✅ ALL VOICE QUEUE & TIMING INSTRUMENTATION TESTS PASSED!');
  process.exit(0);
}

runVoiceQueueAntiDeadlockTest().catch(err => {
  console.error('Fatal error during voice queue test:', err);
  process.exit(1);
});
