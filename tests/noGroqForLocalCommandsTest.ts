import { orchestrator } from '../core/orchestrator.js';
import { modelRouter } from '../bridge/modelRouter.js';
import { agentStateMachine } from '../core/agentStateMachine.js';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';

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
  console.log('\n=== No Groq For Local Commands Test ===\n');

  // Spy/Mock to fail the test if LLM router is called
  let wasCalled = false;
  modelRouter.chat = async (req: any) => {
    wasCalled = true;
    return { content: 'mock reply' };
  };
  modelRouter.streamChat = async function* (req: any) {
    wasCalled = true;
    yield 'mock chunk';
  };

  const originalExecute = toolRegistryV2.execute.bind(toolRegistryV2);
  (toolRegistryV2 as any).execute = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    if (name === 'open_app') {
      return {
        success: true,
        output: `dry-run open_app ${String(args.target ?? '')}`,
        tool: name,
        durationMs: 0,
      };
    }
    return originalExecute(name, args, signal);
  };

  const LOCAL_COMMANDS = [
    'hello',
    'how are you',
    'thanks',
    'what time is it',
    'status',
    'help',
    'stop',
    'open YouTube for me',
    'open notepad',
    'open chrome'
  ];

  for (const cmd of LOCAL_COMMANDS) {
    wasCalled = false;
    // For open_app in tests, the tool might fail if running in headless CI without a window manager,
    // but the route decision and bypassing Groq should still hold.
    try {
      // Transition state machine to IDLE beforehand to ensure clean processing state
      agentStateMachine.reset();
      await orchestrator.process(cmd, 'voice');
      assert(!wasCalled, `Command "${cmd}" did NOT call Groq`);
    } catch (err) {
      assert(false, `Command "${cmd}" failed with error: ${err}`);
    }
  }

  const cmdRoute = orchestrator.matchDeterministicCommand('open cmd');
  assert(cmdRoute?.type === 'open_app', '"open cmd" resolves to direct open_app route');
  assert(cmdRoute?.target === 'cmd', '"open cmd" resolves target="cmd" without invoking Groq');

  (toolRegistryV2 as any).execute = originalExecute;

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('[noGroqForLocalCommandsTest] Unexpected error:', err);
  process.exit(1);
});
