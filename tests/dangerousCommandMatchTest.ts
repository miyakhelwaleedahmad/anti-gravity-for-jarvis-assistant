/**
 * tests/dangerousCommandMatchTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * adminController.isDangerousCommand() matched the substring "format", so it
 * refused harmless commands (`Get-Date -Format yyyy`, `| Format-Table`). The
 * fix matches `format` as a command word; this pins that every way of running
 * the disk command is still refused, plus Format-Volume, Stop-Computer and the
 * disk-wiping cmdlets, and that the harmless forms are not.
 *
 * Only the matcher is called — nothing is executed.
 */

import { adminController } from '../control/adminController.js';

const isDangerous = (cmd: string): boolean =>
  (adminController as unknown as { isDangerousCommand(c: string): boolean }).isDangerousCommand(cmd);

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean): void {
  if (condition) { console.log(`  PASS: ${label}`); passed++; }
  else { console.error(`  FAIL: ${label}`); failed++; }
}

console.log('\n=== Dangerous Command Match Test ===\n');

console.log('--- Still refused ---');
for (const cmd of [
  'format C:',
  'FORMAT d: /q /y',
  'format',
  'cmd /c format e:',
  'format.com f: /fs:ntfs',
  'C:\\Windows\\System32\\format.com c:',
  'powershell -c "format c:"',
  'echo y | format c:',
  'Format-Volume -DriveLetter D',
  'Clear-Disk -Number 1 -RemoveData',
  'Initialize-Disk -Number 2',
  'shutdown /s /t 0',
  'Restart-Computer -Force',
  'Stop-Computer -Force',
  'netsh advfirewall set allprofiles state off',
  'sc stop windefend',
  'Set-MpPreference -DisableRealtimeMonitoring $true',
]) ok(`refused: ${cmd}`, isDangerous(cmd));

console.log('\n--- No longer refused ---');
for (const cmd of [
  'Get-Date -Format yyyy-MM-dd',
  'Get-Process | Format-Table Name, CPU',
  'Get-ChildItem | Format-List',
  'dir /w',
  'echo hello',
  'git log --format=%H',
]) ok(`allowed: ${cmd}`, !isDangerous(cmd));

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
