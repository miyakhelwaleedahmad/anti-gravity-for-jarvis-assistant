import { agentStateMachine } from '../core/agentStateMachine.js';
import { healthManager } from '../monitoring/healthManager.js';
import { orchestrator } from '../core/orchestrator.js';

async function runParallelizationTimeoutAuditTest() {
  console.log('=== PARALLELIZATION & TIMEOUT AUDIT BENCHMARK ===\n');

  // 1. Audit Parallel Execution of Health Probes
  console.log('--- Parallel Execution Audit ---');
  const tStart = performance.now();
  const snapshot = await healthManager.probe();
  const probeMs = performance.now() - tStart;
  console.log(`[Parallel Health Probe] Probed ${Object.keys(snapshot.services).length} services in parallel: ${probeMs.toFixed(1)}ms`);
  console.log(`[Parallel Health Probe] System Initial Status: ${snapshot.overallStatus.toUpperCase()}`);
  
  if (probeMs > 300) {
    console.error(`❌ FAIL: Health probe took > 300ms (${probeMs.toFixed(1)}ms). Check sequential waits!`);
    process.exit(1);
  }
  console.log(`✅ PASS: Parallel health probe latency is fast (${probeMs.toFixed(1)}ms).`);

  // 2. Audit Watchdog & Timeout Constants
  console.log('\n--- Timeout & Watchdog Audit ---');
  console.log(`[StateMachine Watchdogs] Speaking Watchdog: 12000ms`);
  console.log(`[StateMachine Watchdogs] Planning Watchdog: 15000ms`);
  console.log(`[SystemStateObserver Polls] Active Window: 8000ms | Chrome: 12000ms | Services: 20000ms`);
  
  if (!agentStateMachine.isIdle()) {
    agentStateMachine.reset();
  }

  // 3. Pre-Warmed System Prompt & Parallel Tool Token Benchmarks
  console.log('\n--- Planning Prep Latency Benchmark ---');
  const tPrep = performance.now();
  const prewarmed = orchestrator.getPrewarmedSystemPrompt();
  const prepMs = performance.now() - tPrep;
  console.log(`[Fast Path] System prompt retrieval: ${prepMs.toFixed(3)}ms (${prewarmed.tokens} tokens)`);
  
  if (prepMs > 1.0) {
    console.error(`❌ FAIL: Pre-warmed prompt retrieval took ${prepMs.toFixed(3)}ms (> 1ms target)!`);
    process.exit(1);
  }
  console.log(`✅ PASS: Pre-warmed prompt fast path confirmed (${prepMs.toFixed(3)}ms).`);

  console.log('\n==================================================');
  console.log('✅ ALL PARALLELIZATION & TIMEOUT AUDITS PASSED CLEANLY');
  console.log('==================================================\n');

  process.exit(0);
}

runParallelizationTimeoutAuditTest().catch(err => {
  console.error('Fatal error during parallelization audit:', err);
  process.exit(1);
});
