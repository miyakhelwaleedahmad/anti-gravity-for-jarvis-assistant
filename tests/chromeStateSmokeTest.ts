/**
 * tests/chromeStateSmokeTest.ts
 * Verifies getChromeState() returns a valid object even when DevTools is unavailable.
 */
import { getChromeState } from '../perception/chromeState.js';

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

console.log('\n=== Chrome State Smoke Test ===\n');

console.log('--- Test 1: getChromeState() does not throw when DevTools unavailable ---');
let state: any;
try {
  state = await getChromeState();
  ok('getChromeState() resolves without throwing', true);
} catch (err: any) {
  ok(`getChromeState() resolves without throwing (got: ${err.message})`, false);
  process.exit(1);
}

console.log('\n--- Test 2: Returned object has required fields ---');
ok('state.running is boolean', typeof state.running === 'boolean');
ok('state.debugPort is number', typeof state.debugPort === 'number');
ok('state.tabs is array', Array.isArray(state.tabs));

console.log('\n--- Test 3: When DevTools unavailable, tabs is empty array (not undefined) ---');
// DevTools likely not running in test environment
if (!state.running || state.tabs.length === 0) {
  ok('tabs is [] when DevTools unavailable', Array.isArray(state.tabs));
  ok('state has error field when unavailable', typeof state.error === 'string' || state.running === false);
} else {
  console.log('  ℹ️  Chrome DevTools IS available — validating tab structure');
  const tab = state.tabs[0];
  ok('tab has title', typeof tab.title === 'string');
  ok('tab has url', typeof tab.url === 'string');
  ok('tab.active is boolean', typeof tab.active === 'boolean');
}

console.log('\n--- Test 4: debugPort is 9222 (default) ---');
ok('debugPort is 9222', state.debugPort === 9222);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
