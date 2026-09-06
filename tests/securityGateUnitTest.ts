/**
 * Safe unit tests for command risk classification.
 */

import { permissionManager } from '../security/permissionManager.js';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

console.log('\n=== JARVIS Security Gate Unit Tests ===\n');

console.log('--- Group 1: exact SAFE_READ_ONLY commands ---');
for (const cmd of ['dir', 'ls', 'type package.json', 'cat package.json', 'git status', 'git diff']) {
  const r = permissionManager.assessRisk(cmd);
  ok(`${cmd} is SAFE_READ_ONLY`, r.riskLevel === 'SAFE_READ_ONLY' && !r.isBlocked && !r.requiresApproval);
}

console.log('\n--- Group 2: broad dev tools are not SAFE_READ_ONLY ---');
for (const cmd of ['npm -v', 'pnpm -v', 'npx tsx tests/securityGateUnitTest.ts', 'python --version', 'node -v', 'tsx tests/securityGateUnitTest.ts']) {
  const r = permissionManager.assessRisk(cmd);
  ok(`${cmd} is MEDIUM_RISK`, r.riskLevel === 'MEDIUM_RISK' && !r.isBlocked && !r.requiresApproval);
}

console.log('\n--- Group 3: CRITICAL_RISK commands are blocked ---');
for (const cmd of [
  'format C:',
  'diskpart',
  'mimikatz',
  'sekurlsa::logonpasswords',
  'sc config windefend start= disabled',
  'netsh advfirewall set allprofiles state off',
  'Set-MpPreference -DisableRealtimeMonitoring $true',
  'reg delete HKLM\\SYSTEM\\CurrentControlSet',
]) {
  const r = permissionManager.assessRisk(cmd);
  ok(`${cmd} is CRITICAL_RISK and blocked`, r.isBlocked && r.riskLevel === 'CRITICAL_RISK');
}

console.log('\n--- Group 4: HIGH_RISK commands require approval ---');
for (const cmd of [
  'del /f /s important.txt',
  'taskkill /F /PID 1234',
  'shutdown /s /t 0',
  'restart-computer',
  'reg add HKLM\\Software\\Test /v key /d val',
  'icacls C:\\MyFolder /grant Everyone:F',
  'net user hacker password123 /add',
  'powershell -enc aGVsbG8=',
  'Remove-Item C:\\Temp -Recurse',
]) {
  const r = permissionManager.assessRisk(cmd);
  ok(`${cmd} is HIGH_RISK and requires approval`, r.riskLevel === 'HIGH_RISK' && r.requiresApproval && !r.isBlocked);
}

console.log('\n--- Group 5: unknown commands fail closed ---');
for (const cmd of ['frobnicateSystem', 'xyz --destroy-all', 'strangeutil.exe']) {
  const r = permissionManager.assessRisk(cmd);
  ok(`${cmd} defaults to HIGH_RISK`, r.riskLevel === 'HIGH_RISK' && r.requiresApproval);
}

console.log('\n--- Group 6: isBlocked compatibility ---');
ok('isBlocked("format C:") = true', permissionManager.isBlocked('format C:'));
ok('isBlocked("dir") = false', !permissionManager.isBlocked('dir'));
ok('isBlocked("mimikatz") = true', permissionManager.isBlocked('mimikatz'));
ok('isBlocked("git status") = false', !permissionManager.isBlocked('git status'));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
