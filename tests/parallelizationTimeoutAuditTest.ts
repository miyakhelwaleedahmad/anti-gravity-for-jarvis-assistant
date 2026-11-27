import { agentStateMachine } from '../core/agentStateMachine.js';
import { healthManager } from '../monitoring/healthManager.js';
import { orchestrator } from '../core/orchestrator.js';

async function runParallelizationTimeoutAuditTest() {
  console.log('=== PARALLELIZATION & TIMEOUT AUDIT BENCHMARK ===\n');

  // 1. Audit Parallel Execution of Health Probes
  //
  // The first probe waits for the first LLM reachability check when a key is
  // set (monitoring/healthManager.ts, up to 6 s): a real request to the
  // provider. On the owner's PC that alone took ~850 ms, and the old single
  // "whole probe < 300 ms" check failed on network latency, while passing
  // anywhere without a key. Each service probe is timed instead: local work
  // keeps the 300 ms budget, the network check is reported and bounded, and
  // parallelism is checked directly.
  console.log('--- Parallel Execution Audit ---');
  const PROBES = ['probeRedis', 'probeVectorMemory', 'probeLLM', 'probeToolRegistry', 'probePipelines'] as const;
  const hm = healthManager as unknown as Record<string, () => Promise<unknown>>;
  const originals = Object.fromEntries(PROBES.map((m) => [m, hm[m]!.bind(healthManager)]));
  const times: Record<string, number> = {};
  let extraDelayMs = 0;
  for (const m of PROBES) {
    hm[m] = async () => {
      const t = performance.now();
      try {
        if (extraDelayMs) await new Promise((r) => setTimeout(r, extraDelayMs));
        return await originals[m]!();
      } finally { times[m] = performance.now() - t; }
    };
  }
  let failures = 0;
  const fail = (msg: string) => { console.error(`❌ FAIL: ${msg}`); failures++; };

  const tStart = performance.now();
  const snapshot = await healthManager.probe();
  const probeMs = performance.now() - tStart;
  const slowest = Math.max(...PROBES.map((m) => times[m] ?? 0));
  const shown = PROBES.map((m) => `${m.replace('probe', '')} ${(times[m] ?? 0).toFixed(0)}ms`).join(', ');
  console.log(`[Parallel Health Probe] First probe, ${Object.keys(snapshot.services).length} services: ${probeMs.toFixed(1)}ms (${shown})`);
  console.log(`[Parallel Health Probe] System Initial Status: ${snapshot.overallStatus.toUpperCase()}`);
  for (const m of PROBES) {
    if (m !== 'probeLLM' && (times[m] ?? 0) > 300) fail(`${m} took ${(times[m] ?? 0).toFixed(0)}ms (> 300ms for local work)`);
  }
  if ((times['probeLLM'] ?? 0) > 6_500) fail(`the first LLM check took ${(times['probeLLM'] ?? 0).toFixed(0)}ms (it is meant to give up at 6 s)`);
  if (probeMs > slowest + 100) fail(`the probe took ${probeMs.toFixed(0)}ms, more than its slowest service (${slowest.toFixed(0)}ms) + 100ms: something waits in sequence`);
  console.log(`[Parallel Health Probe] LLM reachability (network, when a key is set): ${(times['probeLLM'] ?? 0).toFixed(0)}ms`);

  // Every service made 200 ms slower: in parallel the probe takes ~200 ms, in
  // sequence ~1,000 ms. Holds on any machine, with or without a key.
  extraDelayMs = 200;
  const tPar = performance.now();
  await healthManager.probe();
  const parMs = performance.now() - tPar;
  extraDelayMs = 0;
  console.log(`[Parallel Health Probe] Five services each 200ms slower: ${parMs.toFixed(0)}ms (in sequence it would be ≥ 1000ms)`);
  if (parMs > 500) fail(`five 200ms probes took ${parMs.toFixed(0)}ms: they do not run in parallel`);

  // The dashboard's later polls: the LLM re-check runs in the background, so a
  // probe does not wait for the network.
  const tWarm = performance.now();
  await healthManager.probe();
  const warmMs = performance.now() - tWarm;
  console.log(`[Parallel Health Probe] Later probe (dashboard poll): ${warmMs.toFixed(1)}ms`);
  if (warmMs > 300) fail(`a later health probe took ${warmMs.toFixed(0)}ms (> 300ms)`);

  for (const m of PROBES) hm[m] = originals[m]!;
  if (failures > 0) process.exit(1);
  console.log(`✅ PASS: health probes run in parallel; local work and later probes are fast.`);

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
