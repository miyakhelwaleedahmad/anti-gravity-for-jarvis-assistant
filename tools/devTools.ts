/**
 * tools/devTools.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The `dev` tool (P10), for projects in the project folders
 * (JARVIS_PROJECT_DIRS): list package scripts; run test, build, lint,
 * typecheck or check scripts (level 1) and report the exit code; start a
 * development server (dev, start, serve, preview — level 1) and confirm it
 * answers on its port; stop a server (level 2) — only one JARVIS started.
 *
 * The package manager (npm, pnpm or yarn, from the lock file) runs the
 * script; the script name is checked against package.json and an allowlist,
 * so nothing typed reaches a shell.
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentTool } from '../core/toolRegistryV2.js';
import type { Verifier } from '../core/verifiers.js';
import { projectRoots } from '../perception/gitProbe.js';
import { devPorts, httpInfo, portOpen } from '../perception/devProbe.js';
import { isPathInside } from '../core/workspaceRoot.js';
import { realPathOf } from '../security/fsPolicy.js';
import { redact } from '../security/redactor.js';

type CheckStatus = 'verified' | 'failed' | 'unverifiable';
interface Check { status: CheckStatus; evidence: string }

class NotDone extends Error {}

/** Scripts JARVIS runs and waits for. */
export const RUN_SCRIPTS = /^(test|build|lint|typecheck|type-check|check)(:[\w.-]+)?$/i;
/** Scripts that start a server. */
export const SERVER_SCRIPTS = /^(dev|start|serve|preview)(:[\w.-]+)?$/i;
const SAFE_NAME = /^[\w:.-]{1,60}$/;

const RUN_MS = Number(process.env['JARVIS_DEV_RUN_TIMEOUT_MS'] ?? 10 * 60_000);
const SERVER_START_MS = Number(process.env['JARVIS_DEV_SERVER_START_MS'] ?? 30_000);
const OUTPUT_LINES = 40;

const verified = (evidence: string): Check => ({ status: 'verified', evidence });
const failed = (evidence: string): Check => ({ status: 'failed', evidence });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A folder with a package.json inside the project folders, or the reason it is not. */
export function projectProblem(raw: unknown): { project?: string; refused?: string } {
  const roots = projectRoots();
  const requested = typeof raw === 'string' && raw.trim() ? raw.trim() : roots[0] ?? '';
  if (/[\u0000-\u001f;|&<>`$]/.test(requested)) return { refused: 'The project path holds characters a folder name does not need.' };
  const resolved = path.resolve(roots[0] ?? process.cwd(), requested);
  const real = realPathOf(resolved);
  if (!roots.map((r) => realPathOf(r)).some((root) => isPathInside(root, real))) {
    return { refused: 'JARVIS runs scripts only in the project folders (JARVIS_PROJECT_DIRS).' };
  }
  if (!fs.existsSync(path.join(resolved, 'package.json'))) return { refused: `${resolved} has no package.json.` };
  return { project: resolved };
}

function needProject(raw: unknown): string {
  const { project, refused } = projectProblem(raw);
  if (!project) throw new NotDone(refused ?? 'No project.');
  return project;
}

export function packageScripts(project: string): Record<string, string> {
  try {
    const scripts = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'))?.scripts;
    return scripts && typeof scripts === 'object' ? scripts : {};
  } catch {
    return {};
  }
}

/** Why `script` cannot be run (`kind` run) or started as a server, or undefined. */
export function scriptProblem(project: string, script: unknown, kind: 'run' | 'server'): string | undefined {
  const name = typeof script === 'string' ? script.trim() : '';
  if (!name) return 'Say which script.';
  if (!SAFE_NAME.test(name)) return `"${name.slice(0, 40)}" is not a script name.`;
  if (!(name in packageScripts(project))) return `package.json has no "${name}" script.`;
  const allowed = kind === 'run' ? RUN_SCRIPTS : SERVER_SCRIPTS;
  if (!allowed.test(name)) {
    return kind === 'run'
      ? `JARVIS runs only test, build, lint, typecheck and check scripts, not "${name}".`
      : `JARVIS starts only dev, start, serve and preview scripts as servers, not "${name}".`;
  }
  return undefined;
}

function packageManager(project: string): string {
  if (fs.existsSync(path.join(project, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(project, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/** How to start `<pm> run <script>` without a shell (on Windows the package managers are .cmd files). */
function scriptCommand(project: string, script: string): { file: string; args: string[] } {
  const pm = packageManager(project);
  return process.platform === 'win32'
    ? { file: process.env['ComSpec'] || 'cmd.exe', args: ['/d', '/s', '/c', `${pm} run ${script}`] }
    : { file: pm, args: ['run', script] };
}

function tail(text: string, lines = OUTPUT_LINES): string {
  return redact(text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join('\n')).slice(-6_000);
}

// ── Scripts ──────────────────────────────────────────────────────────────────

function scripts(project: string): Record<string, unknown> {
  return {
    project,
    scripts: Object.entries(packageScripts(project)).slice(0, 60).map(([name, command]) => ({
      name, command: redact(String(command)).slice(0, 160),
      jarvis: RUN_SCRIPTS.test(name) ? 'runs it' : SERVER_SCRIPTS.test(name) ? 'starts it as a server' : 'does not run it',
    })),
  };
}

function runScript(project: string, script: string): Promise<Record<string, unknown>> {
  const { file, args } = scriptCommand(project, script);
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(file, args, { cwd: project, timeout: RUN_MS, windowsHide: true, shell: false, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: process.env['CI'] ?? '1', FORCE_COLOR: '0' } },
      (err, stdout, stderr) => {
        const timedOut = !!err && (err as any).killed === true;
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : null) : 0;
        const seconds = Math.round((Date.now() - started) / 100) / 10;
        resolve({
          project, script, exitCode: code, seconds, timedOut,
          output: tail(`${stdout}\n${stderr}`),
          did: `ran "${script}" in ${path.basename(project)}`,
          check: timedOut
            ? failed(`the script was stopped after ${Math.round(RUN_MS / 1000)} seconds`)
            : verified(`the script ran for ${seconds} s and exited with code ${code}${code === 0 ? '' : ' (it reported a failure)'}`),
        });
      });
  });
}

// ── Servers ──────────────────────────────────────────────────────────────────

interface Server {
  pid: number; project: string; script: string; port?: number; startedAt: string; child: ChildProcess; output: string[];
  /** JARVIS is stopping it (stop_server): its exit is not a crash. */
  stopping?: boolean;
}

const servers = new Map<number, Server>();

/** Servers JARVIS started (the risk engine uses this to refuse other PIDs). */
export function isJarvisServer(pid: unknown): boolean {
  return typeof pid === 'number' && servers.has(pid);
}

export function jarvisServersIn(project: string): number[] {
  return [...servers.values()].filter((s) => s.project === project).map((s) => s.pid);
}

/** How a server JARVIS started ended: stopped by JARVIS (stop_server), or by itself — a crash, or a signal from elsewhere. */
export interface ServerExit { code: number | null; signal: string | null; at: string; by: 'jarvis' | 'itself' }

interface KnownServer { project: string; script: string; pid: number; exit?: ServerExit; lastLines: string[] }

/**
 * Servers JARVIS started at least once, by port, kept after they stop — with
 * how they ended and their last output lines (redacted): the error recovery
 * (core/recoveryPlanner.ts) and the diagnosis (core/diagnosis.ts) restart one
 * when its port stops answering, and say why it stopped. In memory only.
 */
const known = new Map<number, KnownServer>();

export function knownServerOnPort(port: number): { project: string; script: string } | undefined {
  const entry = known.get(port);
  return entry ? { project: entry.project, script: entry.script } : undefined;
}

/** Every server JARVIS started this session, by port: running or not, how it ended, its last lines. */
export function knownServers(): Array<{ port: number; project: string; script: string; pid: number; running: boolean; exit?: ServerExit; lastLines: string[] }> {
  return [...known].map(([port, k]) => {
    const live = servers.get(k.pid);
    return {
      port, project: k.project, script: k.script, pid: k.pid,
      running: !!live && alive(k.pid),
      ...(k.exit ? { exit: k.exit } : {}),
      lastLines: live ? lastLines(live.output) : k.lastLines,
    };
  });
}

/** The last few output lines, redacted and cut short. */
function lastLines(output: string[], n = 6): string[] {
  return tail(output.join('\n'), n).split('\n').filter(Boolean).map((l) => l.slice(0, 200));
}

/** The running server JARVIS started on `port`, if any. */
export function jarvisServerOnPort(port: number): { pid: number; project: string; script: string } | undefined {
  const server = [...servers.values()].find((s) => s.port === port && alive(s.pid));
  return server ? { pid: server.pid, project: server.project, script: server.script } : undefined;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, shell: false }, () => resolve());
      return;
    }
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    resolve();
  });
}

async function stopAndWait(pid: number): Promise<boolean> {
  await killTree(pid);
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
  if (alive(pid) && process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
  }
  return !alive(pid);
}

const URL_PORT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/g;

async function startServer(project: string, script: string, portArg: unknown): Promise<Record<string, unknown>> {
  const requested = Number.isInteger(portArg) && (portArg as number) > 0 && (portArg as number) < 65536 ? (portArg as number) : undefined;
  if (requested && await portOpen(requested)) throw new NotDone(`Port ${requested} is already in use.`);
  const watched = devPorts();
  const before = new Set((await Promise.all(watched.map(async (p) => ((await portOpen(p)) ? p : 0)))).filter(Boolean));
  const { file, args } = scriptCommand(project, script);
  const child = spawn(file, args, {
    cwd: project, detached: true, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(requested ? { PORT: String(requested) } : {}), BROWSER: 'none', FORCE_COLOR: '0' },
  });
  if (!child.pid) throw new NotDone('The server process did not start.');
  const server: Server = { pid: child.pid, project, script, startedAt: new Date().toISOString(), child, output: [] };
  const keep = (data: Buffer) => {
    server.output.push(...data.toString().split(/\r?\n/).filter((l) => l.trim()));
    if (server.output.length > 200) server.output.splice(0, server.output.length - 200);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let exitCode: number | null | undefined;
  // How it ended is kept for the diagnosis; the last lines again on 'close',
  // when the output written just before the exit has arrived.
  const noteExit = (code: number | null, signal: NodeJS.Signals | null) => {
    const entry = server.port !== undefined ? known.get(server.port) : undefined;
    if (!entry || entry.pid !== server.pid) return;
    entry.exit ??= { code, signal, at: new Date().toISOString(), by: server.stopping ? 'jarvis' : 'itself' };
    entry.lastLines = lastLines(server.output);
  };
  child.on('exit', (code, signal) => { exitCode = code; servers.delete(server.pid); noteExit(code, signal); });
  child.on('close', (code, signal) => noteExit(code, signal));
  servers.set(server.pid, server);

  const deadline = Date.now() + SERVER_START_MS;
  let port: number | undefined;
  while (Date.now() < deadline && exitCode === undefined && port === undefined) {
    await sleep(250);
    const mentioned = [...server.output.join('\n').matchAll(URL_PORT)].map((m) => Number(m[1]));
    const candidates = [...new Set([...(requested ? [requested] : []), ...mentioned, ...watched.filter((p) => !before.has(p))])];
    for (const candidate of candidates) {
      if (await portOpen(candidate)) { port = candidate; break; }
    }
  }
  const did = `started "${script}" in ${path.basename(project)} (process ${server.pid})`;
  if (exitCode !== undefined) {
    return { project, script, pid: server.pid, did, output: tail(server.output.join('\n')), check: failed(`the server stopped at once (exit code ${exitCode})`) };
  }
  if (port === undefined) {
    await stopAndWait(server.pid);
    servers.delete(server.pid);
    return { project, script, pid: server.pid, did, output: tail(server.output.join('\n')), check: failed(`no port answered within ${SERVER_START_MS / 1000} seconds; JARVIS stopped it`) };
  }
  server.port = port;
  known.set(port, { project, script, pid: server.pid, lastLines: [] });
  const http = await httpInfo(port);
  return {
    project, script, pid: server.pid, port, did,
    check: verified(`it answers on port ${port}${http ? ` (HTTP ${http.status})` : ''}`),
  };
}

async function stopServer(pidArg: unknown, projectArg: unknown): Promise<Record<string, unknown>> {
  let pids: number[];
  if (typeof pidArg === 'number') {
    if (!isJarvisServer(pidArg)) throw new NotDone(`JARVIS stops only servers it started; process ${pidArg} is not one of them.`);
    pids = [pidArg];
  } else {
    const project = needProject(projectArg);
    pids = jarvisServersIn(project);
    if (!pids.length) throw new NotDone(`JARVIS started no server in ${project}.`);
  }
  const results: string[] = [];
  let allStopped = true;
  for (const pid of pids) {
    const server = servers.get(pid);
    if (server) server.stopping = true;
    const stopped = await stopAndWait(pid);
    const portClosed = server?.port ? !(await portOpen(server.port)) : true;
    if (stopped) servers.delete(pid);
    allStopped &&= stopped && portClosed;
    results.push(`process ${pid}${server?.port ? ` (port ${server.port})` : ''}: ${stopped ? 'stopped' : 'still running'}${server?.port ? `, port ${portClosed ? 'closed' : 'still open'}` : ''}`);
  }
  return {
    stopped: pids, did: `stopped ${pids.length} server${pids.length === 1 ? '' : 's'}`,
    check: allStopped ? verified(results.join('; ')) : failed(results.join('; ')),
  };
}

async function listServers(): Promise<Record<string, unknown>> {
  return {
    servers: await Promise.all([...servers.values()].map(async (s) => ({
      pid: s.pid, project: s.project, script: s.script, port: s.port, startedAt: s.startedAt,
      running: alive(s.pid), answering: s.port ? await portOpen(s.port) : false,
    }))),
    // Servers JARVIS started that have stopped since: how, and their last lines.
    stopped: knownServers().filter((k) => !k.running).map(({ running: _running, ...k }) => k),
  };
}

// ── The tool ─────────────────────────────────────────────────────────────────

export const DEV_ACTIONS = ['scripts', 'run', 'start_server', 'stop_server', 'servers'] as const;

const ownCheck: Verifier = async (_args, output) => {
  try {
    const parsed = JSON.parse(output) as { check?: Check };
    if (parsed.check) return parsed.check;
  } catch {
    // not a report
  }
  return { status: 'unverifiable', evidence: 'reading changes nothing' };
};

export const devTool: AgentTool = {
  name: 'dev',
  description:
    'Use for a project in the project folders: scripts (lists package.json scripts), run (script: test, build, lint, ' +
    'typecheck or check — reports the exit code and the last output lines), start_server (script: dev, start, serve or ' +
    'preview; optional port — JARVIS confirms it answers), stop_server (pid, or project: only servers JARVIS started), ' +
    'servers (lists them). project: the folder (default: the first project folder).',
  riskLevel: 'medium',
  inputSchema: {
    action: { type: 'string', description: DEV_ACTIONS.join(', '), required: true, enum: [...DEV_ACTIONS] },
    project: { type: 'string', description: 'The project folder.', required: false },
    script: { type: 'string', description: 'run / start_server: the package.json script.', required: false },
    port: { type: 'number', description: 'start_server: the port to ask for (PORT).', required: false },
    pid: { type: 'number', description: 'stop_server: the process JARVIS started.', required: false },
  },
  fallbacks: [],
  verify: ownCheck,
  async execute(args) {
    const action = typeof args['action'] === 'string' ? args['action'].toLowerCase() : '';
    try {
      let body: Record<string, unknown>;
      switch (action) {
        case 'scripts': body = scripts(needProject(args['project'])); break;
        case 'run': {
          const project = needProject(args['project']);
          const problem = scriptProblem(project, args['script'], 'run');
          if (problem) throw new NotDone(problem);
          body = await runScript(project, String(args['script']).trim());
          break;
        }
        case 'start_server': {
          const project = needProject(args['project']);
          const script = typeof args['script'] === 'string' && args['script'].trim() ? args['script'].trim() : 'dev';
          const problem = scriptProblem(project, script, 'server');
          if (problem) throw new NotDone(problem);
          body = await startServer(project, script, args['port']);
          break;
        }
        case 'stop_server': body = await stopServer(args['pid'], args['project']); break;
        case 'servers': body = await listServers(); break;
        default: throw new NotDone(`Unknown dev action "${action}".`);
      }
      return JSON.stringify({ success: true, action, ...body }, null, 2);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, action, error: err instanceof NotDone ? message : `dev ${action} failed: ${message}` }, null, 2);
    }
  },
};
