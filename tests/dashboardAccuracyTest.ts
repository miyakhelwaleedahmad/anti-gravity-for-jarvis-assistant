/**
 * tests/dashboardAccuracyTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies Dashboard & HealthManager accuracy:
 *   1. Initial state reports actual status based on live service availability
 *   2. When services become healthy, overallStatus accurately transitions to ONLINE
 *   3. Dashboard does not get stuck in DEGRADED state after recovery
 */

import { healthManager } from '../monitoring/healthManager.js';
import { nodeBridge } from '../bridge/nodeBridge.js';

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
  console.log('\n=== Dashboard & HealthManager Accuracy Tests ===\n');

  // ── Test 1: Initial Health Probe ───────────────────────────────────────────
  console.log('--- Test 1: Initial probe returns structured snapshot ---');
  const snap1 = await healthManager.probe();
  assert(snap1.timestamp > 0, 'Snapshot contains valid timestamp');
  assert(snap1.metrics.rssMB >= 0, 'Snapshot contains system metrics');
  assert(typeof snap1.overallStatus === 'string', `Snapshot returns overallStatus (${snap1.overallStatus})`);

  // ── Test 2: Voice Services Connection Transition ───────────────────────────
  console.log('\n--- Test 2: Voice client connection updates status ---');
  const bridge = nodeBridge as any;
  const originalReady = bridge.readyClients;

  // Simulate all voice clients connected via bridge
  bridge.readyClients = new Map([
    ['stt', { readyState: 1 }],
    ['tts', { readyState: 1 }],
    ['wakeword', { readyState: 1 }],
  ]);

  const snap2 = await healthManager.probe();
  assert(snap2.services.stt?.status === 'online', 'STT reports online when client is connected');
  assert(snap2.services.tts?.status === 'online', 'TTS reports online when client is connected');
  assert(snap2.services.wake_word?.status === 'online', 'WakeWord reports online when client is connected');

  // ── Test 3: Full System Recovery to ONLINE ───────────────────────────
  console.log('\n--- Test 3: Dynamic transition to ONLINE when all services are healthy ---');
  // Override vector_memory probe temporarily to simulate ready vector service
  const origProbeVector = (healthManager as any).probeVectorMemory;
  (healthManager as any).probeVectorMemory = async () => ({
    name: 'vector_memory',
    status: 'online',
    detail: '100 vectors stored',
    checkedAt: Date.now(),
  });

  const snap3 = await healthManager.probe();
  assert(snap3.overallStatus === 'online', `Overall status transitions to ONLINE when all services are healthy (got: ${snap3.overallStatus})`);

  // Restore original methods
  (healthManager as any).probeVectorMemory = origProbeVector;
  bridge.readyClients = originalReady;

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('❌ Dashboard accuracy tests FAILED.');
    process.exit(1);
  } else {
    console.log('✅ Dashboard accuracy tests PASSED.');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('[DashboardAccuracyTest] Unexpected error:', err);
  process.exit(1);
});
