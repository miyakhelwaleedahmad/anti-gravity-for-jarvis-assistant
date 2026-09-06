import { execa, ExecaError } from "execa";
import os from "os";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  command: string;
  duration: number; // ms
}

export interface CommandOptions {
  cwd?: string;
  timeout?: number;   // ms, default 30_000
  shell?: boolean;
  env?: Record<string, string>;
}

// ─── Terminal Tools ───────────────────────────────────────────────────────────

export class TerminalTools {
  private readonly defaultTimeout = 30_000;
  private readonly defaultCwd = os.homedir();

  /**
   * Run a shell command and return its output.
   */
  async run(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    const startTime = Date.now();
    const cwd = options.cwd ?? this.defaultCwd;
    const timeout = options.timeout ?? this.defaultTimeout;

    console.log(`[Terminal] Running: ${command} (cwd: ${cwd})`);

    try {
      const result = await execa(command, {
        shell: options.shell ?? true,
        cwd,
        timeout,
        env: { ...process.env, ...(options.env ?? {}) },
        reject: false, // don't throw on non-zero exit
        windowsHide: false, // CRITICAL: Allows 'start cmd' to pop open visibly
      });

      const duration = Date.now() - startTime;

      return {
        success: result.exitCode === 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? null,
        command,
        duration,
      };
    } catch (err) {
      const duration = Date.now() - startTime;
      const execaErr = err as ExecaError;

      return {
        success: false,
        stdout: execaErr.stdout?.toString() ?? "",
        stderr: execaErr.stderr?.toString() ?? String(err),
        exitCode: execaErr.exitCode ?? null,
        command,
        duration,
      };
    }
  }

  /**
   * Run and return only stdout (throws on error).
   */
  async output(command: string, options: CommandOptions = {}): Promise<string> {
    const result = await this.run(command, options);
    if (!result.success) {
      throw new Error(`Command failed: ${command}\n${result.stderr}`);
    }
    return result.stdout.trim();
  }

  /**
   * Open a URL or file in default application.
   */
  async openInBrowser(url: string): Promise<CommandResult> {
    const cmd = process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;

    return this.run(cmd, { shell: true });
  }

  /**
   * Get system info.
   */
  async getSystemInfo(): Promise<Record<string, string>> {
    const platform = process.platform;
    const arch = process.arch;
    const nodeVersion = process.version;
    const uptime = os.uptime();
    const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
    const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
    const hostname = os.hostname();
    const username = os.userInfo().username;

    return {
      platform,
      arch,
      nodeVersion,
      uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      totalMemGB: `${totalMem} GB`,
      freeMemGB: `${freeMem} GB`,
      hostname,
      username,
      cwd: process.cwd(),
    };
  }

  /**
   * List running processes (top 20 by CPU).
   */
  async listProcesses(): Promise<string> {
    if (process.platform === "win32") {
      const result = await this.run("tasklist /fo csv /nh", { shell: true });
      return result.stdout.split("\n").slice(0, 20).join("\n");
    }
    const result = await this.run("ps aux --sort=-%cpu | head -20", { shell: true });
    return result.stdout;
  }

  /**
   * Get current directory listing.
   */
  async ls(dirPath?: string): Promise<string> {
    const target = dirPath ?? process.cwd();
    const cmd = process.platform === "win32"
      ? `dir "${target}" /b`
      : `ls -la "${target}"`;
    return this.output(cmd, { shell: true });
  }

  /**
   * Execute a Python script.
   */
  async runPython(scriptPath: string, args: string[] = []): Promise<CommandResult> {
    const pythonBin = process.platform === "win32" ? "python" : "python3";
    const fullCmd = [pythonBin, scriptPath, ...args].join(" ");
    return this.run(fullCmd, { cwd: path.dirname(scriptPath), shell: true });
  }

  /**
   * Kill a process by name.
   */
  async killProcess(name: string): Promise<CommandResult> {
    const cmd = process.platform === "win32"
      ? `taskkill /f /im "${name}"`
      : `pkill -f "${name}"`;
    return this.run(cmd, { shell: true });
  }
}

export const terminalTools = new TerminalTools();
