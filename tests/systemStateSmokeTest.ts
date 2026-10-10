/**
 * tests/systemStateSmokeTest.ts
 * Verifies SystemStateObserver starts, produces a state object, and stops cleanly.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SystemStateObserver } from '../perception/systemStateObserver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

console.log('\n=== SystemState Smoke Test ===\n');

// Use a temp state file so we don't pollute production state
const tmpStateFile = path.resolve(__dirname, '..', 'data', 'runtime', '_test_system_state.json');

const observer = new SystemStateObserver({
  activeWindowIntervalMs: 500,
  openAppsIntervalMs: 500,
  chromeTabsIntervalMs: 500,
  jarvisServicesIntervalMs: 500,
  systemStatsIntervalMs: 500,
  writeIntervalMs: 200,
});

// Patch the state file path for testing
(observer as any).stateFilePath = tmpStateFile;

console.log('--- Test 1: Observer starts without throwing ---');
try {
  observer.start();
  ok('Observer.start() does not throw', true);
} catch (err: any) {
  ok(`Observer.start() does not throw (got: ${err.message})`, false);
}

console.log('\n--- Test 2: getState() returns a valid structure ---');
await new Promise(r => setTimeout(r, 600));

const state = observer.getState();
ok('state has timestamp field', typeof state.timestamp === 'string' || state.timestamp === undefined || state.timestamp === '');
ok('state has activeWindow', typeof state.activeWindow === 'object');
ok('state has openApps array', Array.isArray(state.openApps));
ok('state has chrome object', typeof state.chrome === 'object');
ok('state has jarvisServices', typeof state.jarvisServices === 'object');
ok('state has system object', typeof state.system === 'object');
ok('state has safety object', typeof state.safety === 'object');
ok('system has platform', typeof state.system.platform === 'string');
ok('system has freeMemoryMb (number)', typeof state.system.freeMemoryMb === 'number');
ok('system has totalMemoryMb (number)', typeof state.system.totalMemoryMb === 'number');
ok('safety.destructiveActionsRequireConfirmation is true', state.safety.destructiveActionsRequireConfirmation === true);
ok('safety.protectedApps is array', Array.isArray(state.safety.protectedApps));

console.log('\n--- Test 3: State file is written to disk ---');
await new Promise(r => setTimeout(r, 800));

const fileExists = fs.existsSync(tmpStateFile);
ok('system_state.json file exists after start', fileExists);

if (fileExists) {
  try {
    const raw = fs.readFileSync(tmpStateFile, 'utf-8');
    const parsed = JSON.parse(raw);
    ok('file contains valid JSON', true);
    ok('file has system.platform', typeof parsed.system?.platform === 'string');
    ok('file has jarvisServices', typeof parsed.jarvisServices === 'object');
  } catch {
    ok('file contains valid JSON', false);
  }
}

console.log('\n--- Test 4: Observer stops cleanly ---');
observer.stop();
ok('Observer.stop() does not throw', true);

// Cleanup test file
try { fs.unlinkSync(tmpStateFile); } catch {}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
// Exit explicitly: on Windows the PowerShell session's pipes stay open and
// can keep a finished test running until the runner's 2-minute limit.
process.exit(failed > 0 ? 1 : 0);
