/**
 * control/systemController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Retrieves OS health stats, network configuration, disk details, and configures settings.
 */

import * as os from 'os';
import { execa } from 'execa';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';
import { childEnv } from '../system/childEnv.js';

/** One Windows PowerShell command; tests give a stand-in (A5c). */
export interface SystemControllerDeps {
  powershell: (script: string) => Promise<{ exitCode?: number; stdout: string; stderr: string }>;
}

const systemDeps: SystemControllerDeps = {
  powershell: async (script) => {
    const r = await execa('powershell', ['-NoProfile', '-Command', script], { reject: false, env: childEnv(), extendEnv: false });
    if (r.failed && r.exitCode === undefined) throw new Error(`PowerShell could not start: ${r.shortMessage ?? r.message ?? 'no reason given'}`);
    return { exitCode: r.exitCode, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
  },
};

/**
 * A PowerShell list, or why it could not be read: never an empty answer as
 * success when PowerShell failed (A5c, owner Q2). Exit 0 with nothing printed
 * is a list that is really empty.
 */
async function powershellList(deps: SystemControllerDeps, what: string, script: string): Promise<string> {
  const r = await deps.powershell(script);
  if (r.exitCode !== 0) throw new Error(`PowerShell could not read the ${what}: ${r.stderr.trim().slice(0, 300) || `exit ${r.exitCode ?? 'unknown'}`}`);
  return r.stdout.trim() || '[]';
}

export class SystemController {
  constructor(private readonly deps: SystemControllerDeps = systemDeps) {}

  public async getSystemStatus(): Promise<string> {
    if (!permissionSession.checkPermission(0, 'Get system status')) {
      throw new Error('Permission denied.');
    }

    const freeMem = os.freemem() / 1024 / 1024;
    const totalMem = os.totalmem() / 1024 / 1024;
    
    return JSON.stringify({
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptime: os.uptime(),
      freeMemoryMb: Math.round(freeMem),
      totalMemoryMb: Math.round(totalMem),
      cpuCount: os.cpus().length
    }, null, 2);
  }

  public async getNetworkStatus(): Promise<string> {
    if (!permissionSession.checkPermission(0, 'Get network status')) {
      throw new Error('Permission denied.');
    }

    const interfaces = os.networkInterfaces();
    return JSON.stringify(interfaces, null, 2);
  }

  public async getDiskStatus(): Promise<string> {
    if (!permissionSession.checkPermission(0, 'Get disk status')) {
      throw new Error('Permission denied.');
    }

    return powershellList(this.deps, 'disks', 'Get-Volume | Select-Object DriveLetter, FriendlyName, SizeRemaining, Size | ConvertTo-Json');
  }

  public async getStartupTasks(): Promise<string> {
    if (!permissionSession.checkPermission(0, 'Get startup tasks')) {
      throw new Error('Permission denied.');
    }

    return powershellList(this.deps, 'startup programs', 'Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location | ConvertTo-Json');
  }

  public async openSystemSettings(page: string): Promise<string> {
    if (!permissionSession.checkPermission(2, `Open system settings page: ${page}`)) {
      throw new Error('Permission Level 2 required.');
    }

    // Windows ms-settings pages
    const pageMap: Record<string, string> = {
      'display': 'ms-settings:display',
      'network': 'ms-settings:network',
      'wifi': 'ms-settings:network-wifi',
      'bluetooth': 'ms-settings:bluetooth',
      'apps': 'ms-settings:appsfeatures',
      'update': 'ms-settings:windowsupdate',
    };

    const uri = pageMap[page.toLowerCase()] || 'ms-settings:';
    
    const { spawn } = await import('child_process');
    const proc = spawn('cmd.exe', ['/c', 'start', '', uri], { detached: true, stdio: 'ignore', env: childEnv() });
    proc.unref();

    return `Opened system settings page: ${page}`;
  }

  public async restartJarvisServices(): Promise<string> {
    // Level 3 action (restarting JARVIS/services)
    const approved = await approvalGate.requestApproval('Restart JARVIS Services', 'Restart NodeBridge, STT, TTS, and other modules.');
    if (!approved) {
      throw new Error('Restart cancelled by user.');
    }

    console.log('[SystemController] Restarting services...');
    // We can interact with NodeBridge to stop/start them or execute child restarts
    const { nodeBridge } = await import('../bridge/nodeBridge.js');
    if (nodeBridge) {
      nodeBridge.broadcast({
        type: 'command',
        payload: { action: 'restart' }
      });
    }

    return 'Successfully triggered restart of JARVIS services.';
  }
}

export const systemController = new SystemController();
