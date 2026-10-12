/**
 * control/adminController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Executes administrative functions (shell execution, service controls) under
 * strict human-in-the-loop validation (Level 3).
 */

import { runProcess, stoppedReason } from '../system/processRunner.js';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';
import { obfuscationReason, obfuscationRefusal, readableCommand } from '../security/commandObfuscation.js';
import { isSecurityService } from '../security/protectedTargets.js';

/**
 * Service names were pasted into a PowerShell command line, so a "name" such
 * as `spooler; Remove-Item ...` ran a second command, and none of these paths
 * went through the command blocklist. Allow only what a service name can
 * contain; the name is also single-quoted, which quotes cannot escape here.
 */
const SERVICE_NAME_RE = /^[A-Za-z0-9_.\- ]{1,100}$/;


export function checkServiceName(serviceName: string): string {
  const name = String(serviceName ?? '').trim();
  if (!SERVICE_NAME_RE.test(name)) {
    throw new Error(
      `Service name "${name.slice(0, 60)}" rejected by policy: only letters, digits, spaces, '.', '_' and '-' are allowed.`,
    );
  }
  return name;
}

export { isSecurityService };

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
  /** Why a command must not run at all, or null. Checked before anyone is asked. */
  private refusal(command: string): string | null {
    // Written to hide what it runs (SEC-10): the checks below could not read it.
    const hidden = obfuscationReason(command);
    if (hidden) return obfuscationRefusal(command, hidden);
    if (this.isDangerousCommand(command)) {
      return 'Command Blocked: Execution of security-compromising or destructive commands is forbidden.';
    }
    return null;
  }

  /** Checked on the command as written and as the shell reads it (escapes and quotes removed). */
  private isDangerousCommand(command: string): boolean {
    const forms = [command.toLowerCase().replace(/\s+/g, ' '), readableCommand(command)];
    // Block disabling security features. Whitespace and parameter names vary;
    // spsv is Stop-Service's alias.
    const blocks: RegExp[] = [
      /disable-netfirewallrule/,
      /netsh(\.exe)? advfirewall set/,
      /(set|add)-mppreference/, // Windows Defender config and exclusions
      /\b(stop-service|spsv)\b[^;|&]*\bwindefend\b/,
      /\bsc(\.exe)? (config|stop|delete) windefend\b/,
      /format-volume/,
      /clear-disk/,
      /initialize-disk/,
      /shutdown/,
      /restart-computer/,
      /stop-computer/,
    ];
    if (forms.some((f) => blocks.some((b) => b.test(f)))) return true;
    // `format` the disk command — as a word on its own, also as format.com or
    // with a path. A bare substring match also refused harmless commands such
    // as `Get-Date -Format yyyy` and `Get-Process | Format-Table`.
    return forms.some((f) => /(^|[\s;&|()'"`\\/])format(\.com|\.exe)?(?=$|[\s;&|()'"`])/.test(f));
  }

  public async runShellCommand(command: string, signal?: AbortSignal): Promise<string> {
    if (!permissionSession.checkPermission(2, `Run shell command: ${command}`)) {
      throw new Error('Permission Level 2 required to run commands.');
    }

    const refused = this.refusal(command);
    if (refused) throw new Error(refused);

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

    const refused = this.refusal(command);
    if (refused) throw new Error(refused);

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
