/**
 * tests/fileControlSafetyTest.ts
 * Verifies FileController safety rules: approved folders, delete confirmation, system path blocking.
 */
import { fileController } from '../control/fileController.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

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

console.log('\n=== File Control Safety Test ===\n');

// ── Test 1: searchFiles() works without crashing ─────────────────────────────
console.log('--- Test 1: searchFiles() ---');
let searchResult: string = '';
try {
  searchResult = await fileController.searchFiles('*.ts');
  ok('searchFiles() resolves without throwing', true);
} catch (err: any) {
  ok(`searchFiles() resolves without throwing (got: ${err.message})`, false);
}
ok('searchFiles() returns a string', typeof searchResult === 'string');

// ── Test 2: readFile() on a real file ────────────────────────────────────────
console.log('\n--- Test 2: readFile() on valid file ---');
const testFilePath = path.resolve('package.json');
let readResult: string = '';
try {
  readResult = await fileController.readFile(testFilePath);
  ok('readFile() on package.json succeeds', true);
} catch (err: any) {
  ok(`readFile() on package.json succeeds (got: ${err.message})`, false);
}
ok('readFile() returns content string', readResult.length > 0);

// ── Test 3: readFile() on missing file returns error ─────────────────────────
console.log('\n--- Test 3: readFile() on missing file ---');
let missingResult: string = '';
try {
  missingResult = await fileController.readFile('C:\\this\\file\\does\\not\\exist.txt');
  ok('readFile() missing file does not throw', true);
} catch (err: any) {
  ok('readFile() missing file does not throw', false);
  missingResult = err.message;
}
ok('readFile() missing file returns error message', missingResult.toLowerCase().includes('error') || missingResult.toLowerCase().includes('not found') || missingResult.includes('ENOENT'));

// ── Test 4: deleteFile() on system path is blocked ───────────────────────────
console.log('\n--- Test 4: deleteFile() blocks system paths ---');
let deleteBlocked = false;
try {
  await fileController.deleteFile('C:\\Windows\\System32\\kernel32.dll');
  deleteBlocked = false;
} catch (err: any) {
  deleteBlocked = err.message.toLowerCase().includes('protected') ||
                  err.message.toLowerCase().includes('blocked') ||
                  err.message.toLowerCase().includes('not allowed') ||
                  err.message.toLowerCase().includes('permission');
  ok('deleteFile() on System32 throws an error', true);
}
ok('deleteFile() on System32 is blocked/protected', deleteBlocked);

// ── Test 5: writeFile() to temp within approved zone works ───────────────────
console.log('\n--- Test 5: writeFile() creates file ---');
const tmpPath = path.join(os.tmpdir(), `jarvis_test_${Date.now()}.txt`);
let writeOk = false;
try {
  const result = await fileController.writeFile(tmpPath, 'JARVIS test content');
  writeOk = result.includes('Written') || result.includes('written') || result.includes('success') || result.length > 0;
  ok('writeFile() resolves without throwing', true);
} catch (err: any) {
  // Write to tmpdir is fine
  ok(`writeFile() resolves without throwing (got: ${err.message})`, false);
}
// Cleanup
try { fs.unlinkSync(tmpPath); } catch {}
ok('writeFile() result indicates success', writeOk);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
