/**
 * control/processController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Inspects and manages running OS processes.
 * Ensures Level 3 confirmation before termination.
 */

import { execa } from 'execa';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';

const PROTECTED_PROCESSES = [
  'explorer', 'lsass', 'csrss', 'smss', 'svchost', 'wininit', 'services', 'winlogon',
  'antigravity', 'code', 'powershell', 'cmd', 'windowsterminal',
  'msmpeng' // Windows Defender
];

export interface ProcessInfo {
  name: string;
  pid: number;
  cpu?: number;
  workingSet?: number;
}

export class ProcessController {
  public async listProcesses(): Promise<ProcessInfo[]> {
    if (!permissionSession.checkPermission(0, 'List processes')) {
      throw new Error('Permission denied.');
    }

    try {
      const { stdout } = await execa('powershell', [
        '-NoProfile', '-Command',
        'Get-Process | Select-Object ProcessName, Id, CPU, WorkingSet | ConvertTo-Json'
      ], { reject: false });
      
      const parsed = JSON.parse(stdout);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map((p: any) => ({
        name: p.ProcessName || '',
        pid: p.Id || 0,
        cpu: p.CPU || 0,
        workingSet: p.WorkingSet || 0
      }));
    } catch {
      return [];
    }
  }

  public async findProcess(target: string): Promise<ProcessInfo[]> {
    const list = await this.listProcesses();
    const lower = target.toLowerCase().trim();
    return list.filter(p => p.name.toLowerCase().includes(lower) || String(p.pid) === lower);
  }

  public async killProcess(target: string): Promise<string> {
    if (!permissionSession.checkPermission(2, `Kill process ${target}`)) {
      throw new Error('Permission Level 2 required to kill processes.');
    }

    const matches = await this.findProcess(target);
    if (matches.length === 0) {
      // Thrown, not returned: a returned message was reported as a success.
      throw new Error(`No process found matching "${target}".`);
    }

    const match = matches[0];
    const isProtected = PROTECTED_PROCESSES.some(p => match.name.toLowerCase().includes(p));

    // Refuse before asking: the user used to approve a kill that was then blocked.
    if (isProtected && match.name.toLowerCase() !== 'antigravity') {
      throw new Error(`Execution Blocked: Terminating critical system process "${match.name}" is forbidden.`);
    }

    // Terminating processes ALWAYS requires Level 3 confirmation
    const approved = await approvalGate.requestApproval('Terminate Process', `Kill process: ${match.name} (PID: ${match.pid})`);
    if (!approved) {
      throw new Error(`Process termination cancelled by user: ${match.name}`);
    }

    await execa('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${match.pid} -Force`], { reject: false });
    return `Successfully terminated process: ${match.name} (PID: ${match.pid})`;
  }

  public async restartProcess(target: string): Promise<string> {
    const matches = await this.findProcess(target);
    if (matches.length === 0) {
      throw new Error(`No process found matching "${target}" to restart.`);
    }
    
    const name = matches[0].name;
    await this.killProcess(target);
    await new Promise(r => setTimeout(r, 1000));
    
    // Spawn back
    const { spawn } = await import('child_process');
    const proc = spawn(name, [], { detached: true, stdio: 'ignore' });
    proc.unref();
    
    return `Restarted process: ${name}`;
  }
}

export const processController = new ProcessController();
