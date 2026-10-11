/**
 * control/adminController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Executes administrative functions (shell execution, service controls) under
 * strict human-in-the-loop validation (Level 3).
 */

import { runProcess, stoppedReason } from '../system/processRunner.js';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';

/**
 * Service names were pasted into a PowerShell command line, so a "name" such
 * as `spooler; Remove-Item ...` ran a second command, and none of these paths
 * went through the command blocklist. Allow only what a service name can
 * contain; the name is also single-quoted, which quotes cannot escape here.
 */
const SERVICE_NAME_RE = /^[A-Za-z0-9_.\- ]{1,100}$/;

/** Security services never stopped or restarted (as the blocklist's 'stop-service windefend'). */
const PROTECTED_SERVICES = new Set(['windefend', 'mpssvc', 'wscsvc', 'securityhealthservice', 'sense', 'wdnissvc']);

export function checkServiceName(serviceName: string): string {
  const name = String(serviceName ?? '').trim();
  if (!SERVICE_NAME_RE.test(name)) {
    throw new Error(
      `Service name "${name.slice(0, 60)}" rejected by policy: only letters, digits, spaces, '.', '_' and '-' are allowed.`,
    );
  }
  return name;
}

export function isSecurityService(name: string): boolean {
  return PROTECTED_SERVICES.has(String(name ?? '').trim().toLowerCase());
}

function checkNotSecurityService(name: string): void {
  if (isSecurityService(name)) {
    throw new Error(`Blocked by safety policy: JARVIS does not stop or restart the security service "${name}".`);
  }
}

/**
 * Runs an admin command that the caller's signal can stop, with its whole
 * process tree (REL-01). A stopped command is an error, never a success, and
 * the action queue does not retry it (it may have done part of its work).
 */
async function runStoppable(what: string, file: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const r = await runProcess(file, args, { signal });
  const stopped = stoppedReason(r, what);
  if (stopped) throw new Error(`TIMEOUT: ${stopped}`);
  return r;
}

export class AdminController {
  private isDangerousCommand(command: string): boolean {
    const lower = command.toLowerCase();
    // Block disabling security features
    const blocks = [
      'disable-netfirewallrule',
      'netsh advfirewall set',
      'set-mppreference', // Windows Defender config
      'stop-service windefend',
      'sc config windefend',
      'sc stop windefend',
      'format-volume',
      'clear-disk',
      'initialize-disk',
      'shutdown',
      'restart-computer',
      'stop-computer',
    ];
    if (blocks.some(b => lower.includes(b))) return true;
    // `format` the disk command — as a word on its own, also as format.com or
    // with a path. A bare substring match also refused harmless commands such
    // as `Get-Date -Format yyyy` and `Get-Process | Format-Table`.
    return /(^|[\s;&|()'"`\\/])format(\.com|\.exe)?(?=$|[\s;&|()'"`])/.test(lower);
  }

  public async runShellCommand(command: string, signal?: AbortSignal): Promise<string> {
    if (!permissionSession.checkPermission(2, `Run shell command: ${command}`)) {
      throw new Error('Permission Level 2 required to run commands.');
    }

    if (this.isDangerousCommand(command)) {
      throw new Error(`Command Blocked: Execution of security-compromising or destructive commands is forbidden.`);
    }

    const approved = await approvalGate.requestApproval('Run Shell Command', `Command: ${command}`);
    if (!approved) {
      throw new Error('Command execution cancelled by user.');
    }

    const { stdout, stderr } = await runStoppable('The command', 'cmd.exe', ['/c', command], signal);
    return `Stdout:\n${stdout}\n\nStderr:\n${stderr}`;
  }

  public async runPowerShell(command: string, signal?: AbortSignal): Promise<string> {
    if (!permissionSession.checkPermission(2, `Run PowerShell command: ${command}`)) {
      throw new Error('Permission Level 2 required to run commands.');
    }

    if (this.isDangerousCommand(command)) {
      throw new Error(`Command Blocked: Execution of security-compromising or destructive commands is forbidden.`);
    }

    const approved = await approvalGate.requestApproval('Run PowerShell Command', `PowerShell: ${command}`);
    if (!approved) {
      throw new Error('Command execution cancelled by user.');
    }

    const { stdout, stderr } = await runStoppable('The PowerShell command', 'powershell', ['-NoProfile', '-Command', command], signal);
    return `Stdout:\n${stdout}\n\nStderr:\n${stderr}`;
  }

  public async startService(serviceName: string, signal?: AbortSignal): Promise<string> {
    const name = checkServiceName(serviceName);
    if (!permissionSession.checkPermission(2, `Start service ${name}`)) {
      throw new Error('Permission Level 2 required.');
    }

    const approved = await approvalGate.requestApproval('Start Windows Service', `Service: ${name}`);
    if (!approved) {
      throw new Error('Action cancelled by user.');
    }

    const { stdout, stderr } = await runStoppable(`Start-Service ${name}`, 'powershell', ['-NoProfile', '-Command', `Start-Service -Name '${name}'`], signal);
    return `Service "${name}" started. Output: ${stdout} ${stderr}`;
  }

  public async stopService(serviceName: string, signal?: AbortSignal): Promise<string> {
    const name = checkServiceName(serviceName);
    checkNotSecurityService(name);
    if (!permissionSession.checkPermission(2, `Stop service ${name}`)) {
      throw new Error('Permission Level 2 required.');
    }

    const approved = await approvalGate.requestApproval('Stop Windows Service', `Service: ${name}`);
    if (!approved) {
      throw new Error('Action cancelled by user.');
    }

    const { stdout, stderr } = await runStoppable(`Stop-Service ${name}`, 'powershell', ['-NoProfile', '-Command', `Stop-Service -Name '${name}'`], signal);
    return `Service "${name}" stopped. Output: ${stdout} ${stderr}`;
  }

  public async restartService(serviceName: string, signal?: AbortSignal): Promise<string> {
    const name = checkServiceName(serviceName);
    checkNotSecurityService(name);
    if (!permissionSession.checkPermission(2, `Restart service ${name}`)) {
      throw new Error('Permission Level 2 required.');
    }

    const approved = await approvalGate.requestApproval('Restart Windows Service', `Service: ${name}`);
    if (!approved) {
      throw new Error('Action cancelled by user.');
    }

    const { stdout, stderr } = await runStoppable(`Restart-Service ${name}`, 'powershell', ['-NoProfile', '-Command', `Restart-Service -Name '${name}'`], signal);
    return `Service "${name}" restarted. Output: ${stdout} ${stderr}`;
  }
}

export const adminController = new AdminController();
