/**
 * tests/browserControlTest.ts
 * Verifies BrowserController handles missing DevTools gracefully.
 */
import { browserController } from '../control/browserController.js';

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

console.log('\n=== Browser Control Test ===\n');

// ── Test 1: listTabs() does not crash when Chrome is not running ─────────────
console.log('--- Test 1: listTabs() fallback ---');
let tabsResult: string = '';
try {
  tabsResult = await browserController.listTabs();
  ok('listTabs() resolves without throwing', true);
} catch {
  ok('listTabs() resolves without throwing', false);
}
ok('listTabs() returns a string', typeof tabsResult === 'string');
// When DevTools unavailable, should mention it or return empty list
const isExpected = tabsResult.includes('unavailable') ||
                   tabsResult.includes('not running') ||
                   tabsResult.includes('[]') ||
                   tabsResult.includes('[') ||
                   tabsResult.startsWith('{');
ok('listTabs() returns meaningful response', isExpected || tabsResult.length > 0);

// ── Test 2: findTab() returns null gracefully ────────────────────────────────
console.log('\n--- Test 2: findTab() when Chrome unavailable ---');
let foundTab: any = 'not-called';
try {
  foundTab = await browserController.findTab('youtube');
  ok('findTab() resolves without throwing', true);
} catch {
  ok('findTab() resolves without throwing', false);
  foundTab = null;
}
ok('findTab() returns null or object (not undefined)', foundTab === null || typeof foundTab === 'object');

// ── Test 3: isTabOpen() returns boolean-like ---────────────────────────────────
console.log('\n--- Test 3: isTabOpen() when Chrome unavailable ---');
let isOpen: boolean = true;
try {
  isOpen = await browserController.isTabOpen('youtube');
  ok('isTabOpen() resolves without throwing', true);
} catch {
  ok('isTabOpen() resolves without throwing', false);
  isOpen = false;
}
ok('isTabOpen() returns a boolean', typeof isOpen === 'boolean');
ok('isTabOpen() returns false when Chrome not reachable', isOpen === false);

// ── Test 4: closeTab() with no DevTools gives useful error ─────────────────
console.log('\n--- Test 4: closeTab() fallback message ---');
let closeResult: string = '';
try {
  closeResult = await browserController.closeTab('youtube');
  ok('closeTab() resolves without throwing', true);
} catch (err: any) {
  closeResult = err.message ?? '';
  ok('closeTab() resolves without throwing', false);
}
ok('closeTab() result mentions DevTools or returns message', closeResult.length > 0);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
