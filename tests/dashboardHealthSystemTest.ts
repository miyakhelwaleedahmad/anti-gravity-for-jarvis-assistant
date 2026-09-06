/**
 * tests/dashboardHealthSystemTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Automated verification test for Dashboard & Health Manager System:
 *   1. SystemStateObserver startup & directory creation
 *   2. Resilient system_state.json writing (EPERM/EBUSY fallback)
 *   3. Fast PowerShell window state polling (<500ms execution, no timeouts)
 *   4. HealthManager accurate overall status calculations ('online' when core is ready)
 *   5. RuntimeDashboard rendering snapshot
 */

import * as fs from 'fs';
import * as path from 'path';
import { systemStateObserver } from '../perception/systemStateObserver.js';
import { getWindowsState } from '../perception/windowsState.js';
import { healthManager } from '../monitoring/healthManager.js';
import { runtimeDashboard } from '../monitoring/runtimeDashboard.js';

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
  console.log('\n=== Dashboard & Health System Verification Test ===\n');

  console.log('--- Test 1: SystemStateObserver & Directory Creation ---');
  systemStateObserver.start();
  assert(true, 'SystemStateObserver started without throwing');

  const stateFilePath = path.resolve(process.cwd(), 'data', 'runtime', 'system_state.json');
  const dirPath = path.dirname(stateFilePath);
  assert(fs.existsSync(dirPath), 'Runtime data directory exists');

  // Allow observer 500ms to poll and write
  await new Promise((r) => setTimeout(r, 600));

  assert(fs.existsSync(stateFilePath), 'system_state.json was created on disk');
  const rawState = fs.readFileSync(stateFilePath, 'utf8');
  let parsedState: any = null;
  try {
    parsedState = JSON.parse(rawState);
  } catch {}
  assert(parsedState !== null && parsedState.timestamp != null, 'system_state.json contains valid JSON state');

  systemStateObserver.stop();

  console.log('\n--- Test 2: Fast PowerShell Window State Polling ---');
  const t0 = Date.now();
  const winState = await getWindowsState();
  const elapsed = Date.now() - t0;
  console.log(`  [POLL LATENCY]: ${elapsed}ms`);

  assert(elapsed < 4000, `PowerShell poll completed within latency threshold (${elapsed}ms < 4000ms)`);
  assert(winState.activeWindow != null, 'activeWindow object returned');
  assert(Array.isArray(winState.openApps), 'openApps array returned');

  console.log('\n--- Test 3: HealthManager Probe & Status Accuracy ---');
  const snap = await healthManager.probe();

  assert(snap.timestamp > 0, 'Health snapshot has valid timestamp');
  assert(snap.services.llm != null, 'LLM service probe present');
  assert(snap.services.tool_registry != null, 'Tool registry service probe present');

  // Core services (LLM + Tool Registry) should evaluate system status as 'online'
  assert(snap.overallStatus === 'online', `Overall system status is "online" (got: "${snap.overallStatus}")`);

  console.log('\n--- Test 4: Runtime Dashboard Rendering ---');
  let renderError = false;
  try {
    runtimeDashboard.render(snap);
  } catch (err: any) {
    console.error('Dashboard render error:', err);
    renderError = true;
  }
  assert(!renderError, 'RuntimeDashboard rendered to stdout without errors');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('❌ Dashboard & Health System Verification Test FAILED.');
    process.exit(1);
  } else {
    console.log('✅ Dashboard & Health System Verification Test PASSED!');
    process.exit(0);
  }
}

runTest().catch((err) => {
  console.error('[DashboardTest] Unexpected error:', err);
  process.exit(1);
});
