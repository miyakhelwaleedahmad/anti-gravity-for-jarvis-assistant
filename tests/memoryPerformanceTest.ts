import { memoryManager } from '../memory/memoryManager.js';
import { unifiedContextBuilder } from '../memory/unifiedContextBuilder.js';
import { goalManager } from '../core/goalManager.js';
import { graphMemory } from '../memory/graphMemory.js';

async function runMemoryPerformanceTest() {
  console.log('=== JARVIS MEMORY PERFORMANCE AUDIT & TEST ===\n');

  // 1. Initialize subsystem managers
  const initStart = Date.now();
  await memoryManager.init();
  await goalManager.init();
  const initMs = Date.now() - initStart;
  console.log(`[Init] Memory & Goal Managers initialized in ${initMs}ms.`);

  // 2. Test Goal Retrieval Performance
  const goalStart = performance.now();
  for (let i = 0; i < 50; i++) {
    goalManager.getRecentGoalContext(5);
  }
  const goalMs = (performance.now() - goalStart) / 50;
  console.log(`[Goal Retrieval] Average latency: ${goalMs.toFixed(3)}ms per call`);

  // 3. Test Graph Memory Short-circuit Performance
  const graphStart = performance.now();
  for (let i = 0; i < 50; i++) {
    await graphMemory.traverseGraphContext(['User', 'JARVIS'], 2);
  }
  const graphMs = (performance.now() - graphStart) / 50;
  console.log(`[Graph Memory] Disabled/Available traversal latency: ${graphMs.toFixed(3)}ms per call`);

  // 4. Test Memory Retrieval (Vector / Lexical / Short-Circuit)
  const vectorStart = performance.now();
  const facts = await memoryManager.searchFacts('user preferences', 5);
  const vectorMs = performance.now() - vectorStart;
  console.log(`[Memory Search] Fact search returned ${facts.length} facts in ${vectorMs.toFixed(2)}ms`);

  // 5. Test Unified Context Building Latency (Target: < 300 ms)
  const contextBuildColdStart = performance.now();
  const coldContext = await unifiedContextBuilder.buildContext('How can JARVIS improve memory speed?', 'perf-test-session', { includeHeavy: true });
  const contextBuildColdMs = performance.now() - contextBuildColdStart;
  console.log(`[Context Build — Cold/Uncached] Latency: ${contextBuildColdMs.toFixed(2)}ms`);

  const contextBuildHotStart = performance.now();
  const hotContext = await unifiedContextBuilder.buildContext('How can JARVIS improve memory speed?', 'perf-test-session', { includeHeavy: true });
  const contextBuildHotMs = performance.now() - contextBuildHotStart;
  console.log(`[Context Build — Hot/Cached] Latency: ${contextBuildHotMs.toFixed(2)}ms`);

  // 6. Assertions
  const TARGET_LATENCY_MS = 300;
  if (contextBuildColdMs > TARGET_LATENCY_MS) {
    console.error(`❌ FAIL: Context build latency (${contextBuildColdMs.toFixed(2)}ms) exceeded target (${TARGET_LATENCY_MS}ms)`);
    process.exit(1);
  } else {
    console.log(`✅ SUCCESS: Context build latency (${contextBuildColdMs.toFixed(2)}ms) is well under target (${TARGET_LATENCY_MS}ms)!`);
  }

  process.exit(0);
}

runMemoryPerformanceTest().catch((err) => {
  console.error('Fatal error during performance test:', err);
  process.exit(1);
});
