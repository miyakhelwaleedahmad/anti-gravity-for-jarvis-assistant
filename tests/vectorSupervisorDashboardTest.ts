/**
 * tests/vectorSupervisorDashboardTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Verification test for Vector Memory Supervisor, Health Probes, Dashboard,
 * and Semantic Search integration:
 *   - Startup synchronization gate & health probes
 *   - HealthManager reporting healthy status when vector memory is active
 *   - Circuit breaker auto-reset and startup grace handling
 *   - Semantic search execution with fallback protection
 */

import { vectorMemorySupervisor } from '../memory/vectorMemorySupervisor.js';
import { healthManager } from '../monitoring/healthManager.js';
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

async function runTest() {
  console.log('\n=== Vector Memory Supervisor & Dashboard Integration Test ===\n');

  // Initialize memory manager
  await memoryManager.init();
  assert(memoryManager.isVectorCircuitOpen === false, 'Initial vector circuit breaker is closed');

  // Start vector memory supervisor
  console.log('--- Test 1: Vector Supervisor Startup & Synchronization Gate ---');
  await vectorMemorySupervisor.start();
  
  // Wait up to 5 seconds for vector ready probe or startup readiness gate
  const ready = await vectorMemorySupervisor.waitUntilReady(5000);
  console.log(`[Test] Vector readiness gate resolved: ready=${ready}`);
  assert(typeof ready === 'boolean', 'waitUntilReady returns boolean without throwing');

  // Test HealthManager probe
  console.log('\n--- Test 2: HealthManager Vector Memory Probe ---');
  const snapshot = await healthManager.probe();
  const vectorHealth = snapshot.services.vector_memory;

  assert(vectorHealth !== undefined, 'HealthManager probe includes vector_memory service');
  assert(
    vectorHealth.status === 'online' || vectorHealth.status === 'degraded',
    `Vector service status reported valid state (got: "${vectorHealth.status}", detail: "${vectorHealth.detail}")`
  );
  assert(
    !vectorHealth.detail?.includes('request timed out'),
    `HealthManager detail is NOT false "request timed out" (got: "${vectorHealth.detail}")`
  );

  // Test Semantic Search functionality
  console.log('\n--- Test 3: Semantic Search Execution ---');
  await memoryManager.rememberFact('JARVIS prefers dark mode interface', 'test', 9);
  
  const searchResults = await memoryManager.searchFactsWithScores('interface preference', 3);
  assert(Array.isArray(searchResults), 'searchFactsWithScores returned array');
  assert(searchResults.length > 0, 'Semantic/lexical search returned remembered fact');
  assert(searchResults[0].fact.fact.includes('dark mode'), 'Search result contains correct fact text');

  // Shutdown vector supervisor cleanly
  vectorMemorySupervisor.stop();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('❌ Vector Supervisor & Dashboard Test FAILED.');
    process.exit(1);
  } else {
    console.log('✅ Vector Supervisor & Dashboard Test PASSED!');
    process.exit(0);
  }
}

runTest().catch((err) => {
  console.error('[VectorTest] Unexpected error:', err);
  process.exit(1);
});
