import { orchestrator } from '../core/orchestrator.js';
import { goalManager } from '../core/goalManager.js';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { agentStateMachine } from '../core/agentStateMachine.js';
import { conversationBus } from '../core/conversationBus.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

console.log('\n=== Simple/Deterministic No Goal Test ===\n');

let createGoalCalls = 0;
const originalCreateGoal = goalManager.createGoal.bind(goalManager);
(goalManager as any).createGoal = async (...args: any[]) => {
  createGoalCalls++;
  return originalCreateGoal(args[0], args[1]);
};

toolRegistryV2.register({
  name: 'open_app',
  description: 'Mock open_app for no-goal test.',
  riskLevel: 'medium',
  inputSchema: {
    target: { type: 'string', description: 'Target app.', required: true },
    source: { type: 'string', description: 'Source.', required: false },
  },
  fallbacks: [],
  async execute() {
    return JSON.stringify({ success: true, dryRun: true });
  },
});

agentStateMachine.reset();
await orchestrator.process('hello', 'voice');
conversationBus.speakingEnded();
agentStateMachine.reset();
ok('hello did not create a goal', createGoalCalls === 0);

await orchestrator.process('open youtube', 'voice');
conversationBus.speakingEnded();
agentStateMachine.reset();
ok('open youtube did not create a goal', createGoalCalls === 0);

(goalManager as any).createGoal = originalCreateGoal;

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
