/**
 * tests/adminControlTest.ts
 * Verifies AdminController blocks shell/PowerShell at Level 0, and dangerous commands always.
 */
import { adminController } from '../control/adminController.js';
import { permissionSession } from '../control/permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';

// ── Fail-safe approval gate ───────────────────────────────────────────────────
// adminController's order is: permission → isDangerousCommand() → approval gate
// → execa (OS execution). The real gate PROMPTS when stdin is a TTY, so run
// interactively it would ask a human to approve whatever reached it.
//
// This spy replaces it for the whole test: it records every command that reaches
// the gate and approves ONLY the exact harmless probe below. Nothing dangerous
// can therefore execute here in any environment, even if the blocklist were
// broken — and a command reaching the gate at all proves it got past the
// validator, which is what the dangerous-command checks assert against.
const HARMLESS_PROBE = 'echo hello';
const reachedGate: string[] = [];
const realRequestApproval = approvalGate.requestApproval.bind(approvalGate);
approvalGate.requestApproval = async (_action: string, command: string): Promise<boolean> => {
  reachedGate.push(command);
  return command === `Command: ${HARMLESS_PROBE}`;
};
const isDangerous = (cmd: string): boolean =>
  (adminController as unknown as { isDangerousCommand(c: string): boolean }).isDangerousCommand(cmd);

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail = '') {
  const suffix = detail ? ` (${detail})` : '';
  if (condition) { console.log(`  ✅ PASS: ${label}${suffix}`); passed++; }
  else { console.error(`  ❌ FAIL: ${label}${suffix}`); failed++; }
}

console.log('\n=== Admin Control Safety Test ===\n');

// Ensure Level 0 (Read Only)
permissionSession.deactivateFullControl();

// ── Test 1: runShellCommand blocked at Level 0 ────────────────────────────────
console.log('--- Test 1: runShellCommand() blocked at Level 0 ---');
let shellBlocked = false;
try {
  await adminController.runShellCommand('echo test');
} catch (err: any) {
  shellBlocked = err.message.toLowerCase().includes('permission') ||
                 err.message.toLowerCase().includes('level') ||
                 err.message.toLowerCase().includes('blocked');
}
ok('runShellCommand() blocked at Level 0', shellBlocked);

// ── Test 2: runPowerShell blocked at Level 0 ─────────────────────────────────
console.log('\n--- Test 2: runPowerShell() blocked at Level 0 ---');
let psBlocked = false;
try {
  await adminController.runPowerShell('Get-Date');
} catch (err: any) {
  psBlocked = err.message.toLowerCase().includes('permission') ||
              err.message.toLowerCase().includes('level') ||
              err.message.toLowerCase().includes('blocked');
}
ok('runPowerShell() blocked at Level 0', psBlocked);

// ── Test 3: Dangerous commands are intercepted before OS execution ───────────
console.log('\n--- Test 3: Dangerous commands intercepted by the validator ---');
// Even at Level 2 these must be refused by isDangerousCommand() itself — not by
// the permission check, and not by the approval gate.
const dangerousCommands = [
  'shutdown /r /t 0',
  'format C:',
  'netsh advfirewall set allprofiles state off',
  'sc stop windefend',
];
const VALIDATOR_MESSAGE = 'command blocked: execution of security-compromising or destructive commands is forbidden';

permissionSession.activateFullControl(1);
try {
  for (const [label, run] of [
    ['runShellCommand', (c: string) => adminController.runShellCommand(c)],
    ['runPowerShell', (c: string) => adminController.runPowerShell(c)],
  ] as const) {
    for (const cmd of dangerousCommands) {
      ok(`isDangerousCommand("${cmd}") is true`, isDangerous(cmd));

      const gateCallsBefore = reachedGate.length;
      let message = '';
      try {
        await run(cmd);
      } catch (err: any) {
        message = String(err?.message ?? '').toLowerCase();
      }
      const reached = reachedGate.slice(gateCallsBefore);

      // Pass only on the validator's own refusal. "cancelled by user" (the gate)
      // or "permission level" (the session check) would mean the validator did
      // NOT intercept it — so those now fail instead of being accepted.
      ok(`${label}("${cmd}") refused by the validator`, message.startsWith(VALIDATOR_MESSAGE), message || 'no error thrown');
      ok(`${label}("${cmd}") never reached the approval gate (so never reached execa)`, reached.length === 0,
         reached.length ? `reached with: ${reached.join(', ')}` : '');
    }
  }

  // ── Test 3b: harmless commands stay allowed ──────────────────────────────────
  console.log('\n--- Test 3b: harmless command is still allowed ---');
  ok(`isDangerousCommand("${HARMLESS_PROBE}") is false`, !isDangerous(HARMLESS_PROBE));

  const gateCallsBefore = reachedGate.length;
  let output = '';
  let message = '';
  try {
    output = await adminController.runShellCommand(HARMLESS_PROBE);
  } catch (err: any) {
    message = String(err?.message ?? '').toLowerCase();
  }
  ok(`"${HARMLESS_PROBE}" is not refused by the validator`, !message.startsWith(VALIDATOR_MESSAGE), message);
  ok(`"${HARMLESS_PROBE}" passes the validator and reaches the approval gate`,
     reachedGate.slice(gateCallsBefore).includes(`Command: ${HARMLESS_PROBE}`));
  if (process.platform === 'win32') {
    ok(`"${HARMLESS_PROBE}" executes and prints hello`, output.toLowerCase().includes('hello'), output.trim().slice(0, 60));
  } else {
    console.log(`  ℹ️  Skipping execution check: cmd.exe exists only on Windows (platform: ${process.platform}).`);
  }
} finally {
  permissionSession.deactivateFullControl();
}

// ── Test 4: Service control blocked at Level 0 ───────────────────────────────
console.log('\n--- Test 4: Service control blocked at Level 0 ---');
let svcBlocked = false;
try {
  await adminController.startService('spooler');
} catch (err: any) {
  svcBlocked = err.message.toLowerCase().includes('permission') ||
               err.message.toLowerCase().includes('level') ||
               err.message.toLowerCase().includes('blocked');
}
ok('startService() blocked at Level 0', svcBlocked);

approvalGate.requestApproval = realRequestApproval;

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
