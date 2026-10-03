/**
 * control/adminController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Executes administrative functions (shell execution, service controls) under
 * strict human-in-the-loop validation (Level 3).
 */

import { execa } from 'execa';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';

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

  public async runShellCommand(command: string): Promise<string> {
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

    const { stdout, stderr } = await execa('cmd.exe', ['/c', command], { reject: false });
    return `Stdout:\n${stdout}\n\nStderr:\n${stderr}`;
  }

  public async runPowerShell(command: string): Promise<string> {
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

    const { stdout, stderr } = await execa('powershell', ['-NoProfile', '-Command', command], { reject: false });
    return `Stdout:\n${stdout}\n\nStderr:\n${stderr}`;
  }

  public async startService(serviceName: string): Promise<string> {
    if (!permissionSession.checkPermission(2, `Start service ${serviceName}`)) {
      throw new Error('Permission Level 2 required.');
    }

    const approved = await approvalGate.requestApproval('Start Windows Service', `Service: ${serviceName}`);
    if (!approved) {
      throw new Error('Action cancelled by user.');
    }

    const { stdout, stderr } = await execa('powershell', ['-NoProfile', '-Command', `Start-Service -Name ${serviceName}`], { reject: false });
    return `Service "${serviceName}" started. Output: ${stdout} ${stderr}`;
  }

  public async stopService(serviceName: string): Promise<string> {
    if (!permissionSession.checkPermission(2, `Stop service ${serviceName}`)) {
      throw new Error('Permission Level 2 required.');
    }

    const approved = await approvalGate.requestApproval('Stop Windows Service', `Service: ${serviceName}`);
    if (!approved) {
      throw new Error('Action cancelled by user.');
    }

    const { stdout, stderr } = await execa('powershell', ['-NoProfile', '-Command', `Stop-Service -Name ${serviceName}`], { reject: false });
    return `Service "${serviceName}" stopped. Output: ${stdout} ${stderr}`;
  }

  public async restartService(serviceName: string): Promise<string> {
    if (!permissionSession.checkPermission(2, `Restart service ${serviceName}`)) {
      throw new Error('Permission Level 2 required.');
    }

    const approved = await approvalGate.requestApproval('Restart Windows Service', `Service: ${serviceName}`);
    if (!approved) {
      throw new Error('Action cancelled by user.');
    }

    const { stdout, stderr } = await execa('powershell', ['-NoProfile', '-Command', `Restart-Service -Name ${serviceName}`], { reject: false });
    return `Service "${serviceName}" restarted. Output: ${stdout} ${stderr}`;
  }
}

export const adminController = new AdminController();
