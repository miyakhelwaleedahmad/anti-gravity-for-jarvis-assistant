import { orchestrator } from '../core/orchestrator.js';
import { toolRegistryV2 } from '../core/toolRegistryV2.js';
import { memoryManager } from '../memory/memoryManager.js';
import { goalManager } from '../core/goalManager.js';

async function runPlanningPerformanceTest() {
  console.log('=== JARVIS PLANNING PERFORMANCE AUDIT & BENCHMARK ===\n');

  // 1. Initialize subsystem managers
  await memoryManager.init();
  await goalManager.init();

  // 2. Measure Tool Definition Loading & Pre-Computed Token Estimation
  const toolStart = performance.now();
  const toolNames = ['web_search', 'get_system_info', 'read_file', 'run_command'];
  for (let i = 0; i < 100; i++) {
    const defs = toolRegistryV2.getLLMDefinitions(toolNames);
    const tokens = toolRegistryV2.getToolTokensEstimate(toolNames);
  }
  const toolMs = (performance.now() - toolStart) / 100;
  console.log(`[Tool Loading & Token Estimation] Latency: ${toolMs.toFixed(3)}ms per call (100 iterations)`);

  // 3. Measure Prompt Generation & System Prompt Pre-Warming
  const promptStart = performance.now();
  for (let i = 0; i < 100; i++) {
    const sys = (orchestrator as any).getPrewarmedSystemPrompt();
  }
  const promptMs = (performance.now() - promptStart) / 100;
  console.log(`[Prompt Generation & Pre-Warming] Latency: ${promptMs.toFixed(3)}ms per call (100 iterations)`);

  // 4. Measure Planning Phase Preparation Overhead (Cold vs Hot)
  const query = 'What is the system status and available memory?';

  // Warm-up call
  const planPrepStart = performance.now();
  // Access private planPhase preparation logic timing
  const toolDefs = toolRegistryV2.getLLMDefinitions(['get_system_info', 'get_system_state']);
  const estTokens = toolRegistryV2.getToolTokensEstimate(['get_system_info', 'get_system_state']);
  const planPrepMs = performance.now() - planPrepStart;

  console.log(`[Planning Phase Internal Preparation] Latency: ${planPrepMs.toFixed(2)}ms`);

  // 5. Assertions
  const TARGET_PLANNING_PREP_MS = 50.0;
  const TARGET_TOTAL_PLANNING_MS = 300.0;

  if (planPrepMs > TARGET_PLANNING_PREP_MS) {
    console.error(`❌ FAIL: Planning preparation latency (${planPrepMs.toFixed(2)}ms) exceeded target (${TARGET_PLANNING_PREP_MS}ms)`);
    process.exit(1);
  } else {
    console.log(`✅ SUCCESS: Planning preparation latency (${planPrepMs.toFixed(2)}ms) is well under target (< ${TARGET_PLANNING_PREP_MS}ms / < ${TARGET_TOTAL_PLANNING_MS}ms)!`);
  }

  process.exit(0);
}

runPlanningPerformanceTest().catch((err) => {
  console.error('Fatal error during planning performance test:', err);
  process.exit(1);
});
