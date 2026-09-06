/**
 * control/systemController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Retrieves OS health stats, network configuration, disk details, and configures settings.
 */

import * as os from 'os';
import { execa } from 'execa';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';

export class SystemController {
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

    try {
      const { stdout } = await execa('powershell', [
        '-NoProfile', '-Command',
        'Get-Volume | Select-Object DriveLetter, FriendlyName, SizeRemaining, Size | ConvertTo-Json'
      ], { reject: false });
      return stdout.trim();
    } catch (err: any) {
      return JSON.stringify({ error: err.message });
    }
  }

  public async getStartupTasks(): Promise<string> {
    if (!permissionSession.checkPermission(0, 'Get startup tasks')) {
      throw new Error('Permission denied.');
    }

    try {
      const { stdout } = await execa('powershell', [
        '-NoProfile', '-Command',
        'Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location | ConvertTo-Json'
      ], { reject: false });
      return stdout.trim();
    } catch (err: any) {
      return JSON.stringify({ error: err.message });
    }
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
    const proc = spawn('cmd.exe', ['/c', 'start', '', uri], { detached: true, stdio: 'ignore' });
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
