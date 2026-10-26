/**
 * control/processController.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Inspects and manages running OS processes.
 * Ensures Level 3 confirmation before termination.
 */

import { execa } from 'execa';
import { permissionSession } from './permissionSession.js';
import { approvalGate } from '../security/approvalGate.js';
import { childEnv } from '../system/childEnv.js';
import { browserCloseRefusal, browserName, programKey } from './appMatch.js';
import { spawn } from 'child_process';

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

/** How often, and how far apart, a kill checks that the process is gone. */
const GONE_CHECKS = 3;
const GONE_CHECK_INTERVAL_MS = 300;

export interface PowerShellResult {
  exitCode?: number;
  stdout: string;
  stderr: string;
}

/** What the controller runs; tests give stand-ins. */
export interface ProcessControllerDeps {
  /** Runs one Windows PowerShell command (`-NoProfile -Command`). */
  powershell: (script: string) => Promise<PowerShellResult>;
  /** Asks the owner (the approval gate). */
  approve: (title: string, command: string) => Promise<boolean>;
  /** Starts a program by name; rejects when it cannot start. */
  start: (name: string) => Promise<void>;
}

/** Starts `name` detached; resolves once it has started, rejects when it could not (no uncaught "spawn ENOENT"). */
function startDetached(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(name, [], { detached: true, stdio: 'ignore', env: childEnv() });
    proc.once('spawn', () => { proc.unref(); resolve(); });
    proc.once('error', (err) => reject(new Error(`Could not start ${name}: ${err.message}`)));
  });
}

/** The process meant by `target` among those found: the exact name first ("notepad" is not "notepad++"). */
function chooseProcess(matches: ProcessInfo[], target: string): ProcessInfo {
  const wanted = programKey(target);
  return matches.find((p) => programKey(p.name) === wanted) ?? matches[0]!;
}

const systemDeps: ProcessControllerDeps = {
  powershell: async (script) => {
    const r = await execa('powershell', ['-NoProfile', '-Command', script], { reject: false, env: childEnv(), extendEnv: false });
    return { exitCode: r.exitCode, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
  },
  approve: (title, command) => approvalGate.requestApproval(title, command),
  start: startDetached,
};

export class ProcessController {
  constructor(private readonly deps: ProcessControllerDeps = systemDeps) {}

  public async listProcesses(): Promise<ProcessInfo[]> {
    if (!permissionSession.checkPermission(0, 'List processes')) {
      throw new Error('Permission denied.');
    }

    try {
      const { stdout } = await this.deps.powershell('Get-Process | Select-Object ProcessName, Id, CPU, WorkingSet | ConvertTo-Json');

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
    const lower = programKey(target);
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

    // The exact name first: "notepad" is not "notepad++" (TRA-06).
    return this.terminate(chooseProcess(matches, target));
  }

  /** Ends one process the user chose, after the checks and the question; success only when it is gone. */
  private async terminate(match: ProcessInfo): Promise<string> {
    const isProtected = PROTECTED_PROCESSES.some(p => match.name.toLowerCase().includes(p));

    // Refuse before asking: the user used to approve a kill that was then blocked.
    if (isProtected && match.name.toLowerCase() !== 'antigravity') {
      throw new Error(`Execution Blocked: Terminating critical system process "${match.name}" is forbidden.`);
    }

    // A browser process is one of the owner's browser windows' (D3): killing it is not done here.
    const browser = browserName(match.name);
    if (browser) throw new Error(browserCloseRefusal(browser));

    // Terminating processes ALWAYS requires Level 3 confirmation
    const approved = await this.deps.approve('Terminate Process', `Kill process: ${match.name} (PID: ${match.pid})`);
    if (!approved) {
      throw new Error(`Process termination cancelled by user: ${match.name}`);
    }

    // Success only when the process is gone: Stop-Process's result used to be ignored (TRA-06).
    const pid = Math.trunc(Number(match.pid));
    const stopped = await this.deps.powershell(`Stop-Process -Id ${pid} -Force`);
    if (stopped.exitCode !== 0) {
      const reason = (stopped.stderr || stopped.stdout).trim().split(/\r?\n/)[0]?.slice(0, 200) || `exit code ${stopped.exitCode ?? 'unknown'}`;
      throw new Error(`Could not terminate ${match.name} (PID: ${pid}): ${reason}`);
    }
    // A process may take a moment to leave the list once terminated. The check
    // prints an answer: an empty output is a check that did not run, not "gone".
    for (let attempt = 1; ; attempt++) {
      const check = await this.deps.powershell(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'running' } else { 'gone' }`);
      const answer = check.stdout.trim();
      if (answer === 'gone') break;
      if (answer !== 'running') {
        throw new Error(`Stop-Process ran for ${match.name} (PID: ${pid}), but I could not confirm it ended: the check gave no answer (${(check.stderr.trim() || `exit code ${check.exitCode ?? 'unknown'}`).slice(0, 120)}).`);
      }
      if (attempt >= GONE_CHECKS) throw new Error(`${match.name} (PID: ${pid}) is still running after Stop-Process.`);
      await new Promise((r) => setTimeout(r, GONE_CHECK_INTERVAL_MS));
    }
    return `Successfully terminated process: ${match.name} (PID: ${pid}); it is no longer running.`;
  }

  public async restartProcess(target: string): Promise<string> {
    const matches = await this.findProcess(target);
    if (matches.length === 0) {
      throw new Error(`No process found matching "${target}" to restart.`);
    }
    
    if (!permissionSession.checkPermission(2, `Restart process ${target}`)) {
      throw new Error('Permission Level 2 required to kill processes.');
    }
    // The process chosen once, ended and started again.
    const chosen = chooseProcess(matches, target);
    await this.terminate(chosen);
    await new Promise(r => setTimeout(r, 1000));

    try {
      await this.deps.start(chosen.name);
    } catch (err) {
      throw new Error(`Ended ${chosen.name}, but could not start it again: ${err instanceof Error ? err.message : String(err)}`);
    }
    return `Restarted process: ${chosen.name}`;
  }
}

export const processController = new ProcessController();
