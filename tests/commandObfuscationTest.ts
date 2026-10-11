/**
 * tests/commandObfuscationTest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SEC-10: shell commands written so the text checks cannot read them.
 *
 * The blocklist and the risk rules match text; cmd.exe and PowerShell run
 * `shut^down`, `Stop-Comp`uter`, `sh""utdown`, `'Stop-'+'Computer'`, encoded
 * commands and `iex` the same as the plain command. They were rated like
 * `echo` and offered for approval as if harmless.
 *
 *   1. disguised commands are recognised; ordinary ones are not
 *   2. the risk engine refuses them before anyone is asked
 *   3. the admin controller refuses them too (and Defender stopped through an
 *      alias or extra spacing), and nothing runs
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-obfuscation-'));
process.env['JARVIS_WORKSPACE_ROOT'] = workspace;
process.env['JARVIS_DATA_ROOT'] = workspace;

const { obfuscationReason, readableCommand } = await import('../security/commandObfuscation.js');
const { assessRisk } = await import('../security/riskEngine.js');
const { adminController } = await import('../control/adminController.js');
const { approvalGate } = await import('../security/approvalGate.js');
const { permissionSession } = await import('../control/permissionSession.js');

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  PASS: ${label}${detail ? ` (${detail})` : ''}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`); failed++; }
}

const DISGUISED = [
  'shut^down /s /t 0',
  's^h^u^t^d^o^w^n -r',
  'Stop-Comp`uter -Force',
  'sh""utdown /s',
  'sh"ut"down /s',
  "& ('Stop-'+'Computer')",
  'iex (Get-Content run.txt -Raw)',
  'Invoke-Expression $payload',
  'powershell -enc UwB0AG8AcAAtAEMAbwBtAHAAdQB0AGUAcgA=',
  'powershell.exe -EncodedCommand UwB0AG8AcAAtAEMAbwBtAHAAdQB0AGUAcgA=',
  '[char]83+[char]116+[char]111+[char]112',
  '%COMSPEC:~0,1%md /c shutdown',
  "[ScriptBlock]::Create('Stop-Computer').Invoke()",
  "[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('UwB0AG8AcAA='))",
];
const PLAIN = [
  'dir C:\\Users',
  'ipconfig /all',
  'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5',
  'Write-Host "Line1`nLine2"',
  "echo 'it''s fine'",
  'git commit -m"fix bug"',
  'Get-Date -Format yyyy',
  'findstr "^abc" notes.txt',
  'Get-ChildItem -Path "C:\\Program Files" -Filter *.exe',
  'tasklist /fi "imagename eq notepad.exe"',
  'Get-Service -Name "Spooler" | Format-List',
];

console.log('\n=== Disguised shell commands (SEC-10) ===\n');

console.log('--- 1. Recognised ---');
for (const c of DISGUISED) ok(`disguised: ${c}`, obfuscationReason(c) !== null, obfuscationReason(c) ?? 'not recognised');
for (const c of PLAIN) ok(`plain: ${c}`, obfuscationReason(c) === null, obfuscationReason(c) ?? '');
ok('read plainly, shut^down is shutdown', readableCommand('shut^down /s') === 'shutdown /s');
ok('read plainly, Stop-Comp`uter is stop-computer', readableCommand('Stop-Comp`uter') === 'stop-computer');

console.log('\n--- 2. The risk engine refuses them before anyone is asked ---');
for (const action of ['shell', 'powershell']) {
  for (const c of DISGUISED.slice(0, 7)) {
    const a = assessRisk({ tool: 'control_system', args: { action, target: c }, baseRisk: 3 });
    ok(`${action}: ${c}`, !!a.refused && /hides what it runs/.test(a.refused), a.refused ?? `level ${a.level}`);
  }
}
const plain = assessRisk({ tool: 'control_system', args: { action: 'shell', target: 'ipconfig /all' }, baseRisk: 3 });
ok('a plain command is not refused (asked as before)', !plain.refused, plain.refused ?? `level ${plain.level}`);
const critical = assessRisk({ tool: 'control_system', args: { action: 'shell', target: 'bcd^edit /set safeboot' }, baseRisk: 3 });
ok('a critical command with escapes is not rated like echo', !!critical.refused || critical.level === 4, critical.refused ?? `level ${critical.level}`);

console.log('\n--- 3. The admin controller refuses them, nothing runs ---');
let asked = 0;
(approvalGate as any).requestApproval = async () => { asked++; return false; };
permissionSession.activateFullControl(5, 'cli');
async function refusedBy(fn: () => Promise<string>): Promise<string> {
  try { await fn(); return ''; } catch (err) { return err instanceof Error ? err.message : String(err); }
}
for (const c of ['shut^down /s', 'Stop-Comp`uter', "& ('Stop-'+'Computer')", 'iex $x']) {
  const shell = await refusedBy(() => adminController.runShellCommand(c));
  const ps = await refusedBy(() => adminController.runPowerShell(c));
  ok(`refused in cmd and PowerShell: ${c}`, /hides what it runs/.test(shell) && /hides what it runs/.test(ps), `${shell.slice(0, 50)} | ${ps.slice(0, 50)}`);
}
for (const c of ['spsv windefend', 'Stop-Service -Name WinDefend -Force', 'sc.exe   stop   windefend', 'Add-MpPreference -ExclusionPath C:\\']) {
  const msg = await refusedBy(() => adminController.runPowerShell(c));
  ok(`Defender changes blocked however written: ${c}`, /Command Blocked/.test(msg), msg.slice(0, 60));
}
ok('no approval was asked for any of them', asked === 0, `${asked} asked`);
const msg = await refusedBy(() => adminController.runShellCommand('shut^down /s'));
ok('the refusal shows the command read plainly', /read plainly it is: shutdown \/s/.test(msg), msg);
permissionSession.deactivateFullControl('obfuscation test');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed > 0 ? 1 : 0);
