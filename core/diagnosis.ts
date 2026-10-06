/**
 * core/diagnosis.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "Why isn't my application working?" (P13, docs/upgrade/SCENARIOS.md): look
 * at what serves the application and what the browser shows, say what is
 * wrong, and propose repairs as ordinary tool calls.
 *
 * Observed, all real and read-only:
 *   - the servers JARVIS started this session (tools/devTools.ts): running or
 *     not, how they ended, their last output lines (redacted);
 *   - their ports and the development ports: open, HTTP status of "/";
 *   - the browser's tabs: Chrome's error page (ERR_CONNECTION_REFUSED…) and
 *     the HTTP status of each page's last load.
 *
 * Proposed, never run here (the orchestrator runs them through the registry,
 * so the risk engine and the approval gate decide as for any call):
 *   a server JARVIS started that has stopped      → start it again (level 1)
 *   one that runs but does not answer             → stop it (2), start it (1)
 *   a tab that showed an error for that server    → reload it (1)
 * Anything else — an HTTP 500, a port JARVIS did not start, a site that
 * cannot be reached — is reported, with a question where JARVIS cannot tell.
 */

import * as path from 'path';
import type { RepairStep } from './recoveryPlanner.js';
import { knownServers, packageScripts, SERVER_SCRIPTS, type ServerExit } from '../tools/devTools.js';
import { devPorts, httpInfo, portOpen, scanDevPorts } from '../perception/devProbe.js';
import { readBrowserState } from '../perception/browserState.js';
import { projectRoots } from '../perception/gitProbe.js';
import { redact } from '../security/redactor.js';
import * as fs from 'fs';

export interface ServerFinding {
  port: number;
  project: string;
  name: string;
  script: string;
  pid: number;
  /** `taken`: JARVIS's server is gone and another program holds its port. */
  state: 'answers' | 'http_error' | 'not_answering' | 'stopped' | 'taken';
  status?: number;
  exit?: ServerExit;
  /** The output line that says most about a failure (redacted). */
  line?: string;
}

export interface TabFinding {
  id: string;
  title: string;
  url: string;
  /** For a tab on this PC (localhost, 127.0.0.1, [::1]). */
  port?: number;
  status?: number;
  error?: string;
}

export interface AppObservation {
  servers: ServerFinding[];
  tabs: TabFinding[];
  /** Development ports no known server uses. */
  ports: Array<{ port: number; open: boolean; status?: number }>;
  browser: boolean;
}

export interface AppFault {
  text: string;
  /** The server's most telling output line (redacted), when it has one. */
  line?: string;
  repairs: RepairStep[];
  /** Why no repair is proposed. */
  note?: string;
}

export interface AppDiagnosis {
  faults: AppFault[];
  healthy: string[];
  question?: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Chrome's error codes in words. */
const CHROME_ERRORS: Record<string, string> = {
  ERR_CONNECTION_REFUSED: 'connection refused',
  ERR_CONNECTION_RESET: 'connection reset',
  ERR_CONNECTION_TIMED_OUT: 'connection timed out',
  ERR_TIMED_OUT: 'timed out',
  ERR_EMPTY_RESPONSE: 'empty response',
  ERR_NAME_NOT_RESOLVED: 'address not found',
  ERR_ADDRESS_UNREACHABLE: 'address unreachable',
  ERR_INTERNET_DISCONNECTED: 'no internet connection',
  ERR_CERT_AUTHORITY_INVALID: 'certificate not trusted',
};

function errorPage(code: string): string {
  return `an error page (${CHROME_ERRORS[code] ?? code.replace(/^(?:NET::)?ERR_/, '').toLowerCase().replace(/_/g, ' ')})`;
}

function clip(text: unknown, max: number): string {
  const s = redact(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The output line that says most about a failure: the last error line that is not the package manager's own, if any. */
export function tellingLine(lines: string[]): string | undefined {
  const own = (l: string) => /^\s*(?:npm|pnpm|yarn|ELIFECYCLE)\b|^\s*>\s|^\s+at\s/i.test(l);
  const error = [...lines].reverse().find((l) => l.trim() && !own(l)
    && /error|exception|fatal|cannot|failed|refused|denied|EADDRINUSE|ECONN|ENOENT|panic/i.test(l));
  return error ? clip(error, 160) : undefined;
}

function portOf(url: string): number | undefined {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || !LOCAL_HOSTS.has(u.hostname)) return undefined;
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return undefined;
  }
}

/** Read everything the diagnosis needs, now. */
export async function observeApp(): Promise<AppObservation> {
  const known = knownServers();
  const servers = await Promise.all(known.map(async (k): Promise<ServerFinding> => {
    const base = { port: k.port, project: k.project, name: path.basename(k.project), script: k.script, pid: k.pid };
    const line = tellingLine(k.lastLines);
    const open = await portOpen(k.port);
    if (!k.running) {
      if (open) {
        const other = await httpInfo(k.port);
        return { ...base, state: 'taken', ...(other ? { status: other.status } : {}), ...(k.exit ? { exit: k.exit } : {}) };
      }
      return { ...base, state: 'stopped', ...(k.exit ? { exit: k.exit } : {}), ...(line ? { line } : {}) };
    }
    const http = open ? await httpInfo(k.port) : undefined;
    if (!http) return { ...base, state: 'not_answering', ...(line ? { line } : {}) };
    return { ...base, state: http.status >= 500 ? 'http_error' : 'answers', status: http.status, ...(http.status >= 500 && line ? { line } : {}) };
  }));

  let tabs: TabFinding[] = [];
  let browser = false;
  try {
    const state = await readBrowserState();
    browser = true;
    tabs = state.tabs.filter((t) => /^https?:\/\//i.test(t.url)).map((t) => {
      const port = portOf(t.url);
      return {
        id: t.id, title: clip(t.title, 60), url: clip(t.url, 160),
        ...(port ? { port } : {}), ...(t.status ? { status: t.status } : {}), ...(t.error ? { error: t.error } : {}),
      };
    });
  } catch {
    // No browser JARVIS can reach: the servers alone.
  }

  const knownPorts = new Set(servers.map((s) => s.port));
  const ports = (await scanDevPorts(devPorts().filter((p) => !knownPorts.has(p)).slice(0, 20)))
    .map((p) => ({ port: p.port, open: p.open, ...(p.http ? { status: p.http.status } : {}) }));
  return { servers, tabs, ports, browser };
}

function how(exit: ServerExit | undefined): string {
  if (!exit) return 'stopped';
  if (exit.by === 'jarvis') return 'was stopped by me earlier';
  if (exit.signal) return `was stopped from outside (signal ${exit.signal})`;
  return `stopped by itself (exit code ${exit.code})`;
}

/** Projects JARVIS could start, by name: the ones with a server script. */
export function startableProjects(): string[] {
  const names: string[] = [];
  for (const root of projectRoots()) {
    const candidates = [root, ...safeDirs(root)];
    for (const dir of candidates) {
      if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
      if (Object.keys(packageScripts(dir)).some((s) => SERVER_SCRIPTS.test(s))) names.push(path.basename(dir));
    }
  }
  return [...new Set(names)].slice(0, 5);
}

function safeDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .slice(0, 50).map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
}

function list(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** What is wrong, and the repairs JARVIS may propose. */
export function diagnoseApp(obs: AppObservation): AppDiagnosis {
  const faults: AppFault[] = [];
  const healthy: string[] = [];
  const reloadFor = (port: number): RepairStep[] => obs.tabs
    .filter((t) => t.port === port && t.error)
    .map((t) => ({
      tool: 'browser_navigate', args: { action: 'reload', tab: t.id },
      says: 'reload the tab that showed the error', did: 'reloaded the tab',
    }));

  for (const s of obs.servers) {
    const server = `the ${s.name} server`;
    const start: RepairStep = {
      tool: 'dev', args: { action: 'start_server', project: s.project, script: s.script, port: s.port },
      says: `start ${server} on port ${s.port} again`, did: 'started it again',
    };
    const errorTabs = obs.tabs.filter((t) => t.port === s.port && t.error);
    const tabNote = errorTabs.length ? `, so the tab for it shows ${errorPage(errorTabs[0]!.error!)}` : '';
    const line = s.line ? { line: s.line } : {};
    if (s.state === 'stopped') {
      faults.push({
        text: `${server} on port ${s.port} ${how(s.exit)}${tabNote}`, ...line,
        repairs: [start, ...reloadFor(s.port)],
      });
    } else if (s.state === 'not_answering') {
      faults.push({
        text: `${server} (process ${s.pid}) runs but does not answer on port ${s.port}${tabNote}`, ...line,
        repairs: [
          { tool: 'dev', args: { action: 'stop_server', pid: s.pid }, says: 'stop it and start it again', did: 'stopped it' },
          start,
          ...reloadFor(s.port),
        ],
      });
    } else if (s.state === 'taken') {
      // Not JARVIS's server any more: reported, never stopped.
      const answer = s.status ? `answers HTTP ${s.status}` : 'is open but does not answer HTTP';
      if (s.status && s.status < 500) healthy.push(`port ${s.port} answers ${s.status}, from a program I did not start`);
      else faults.push({ text: `${server} on port ${s.port} ${how(s.exit)}, and port ${s.port} now ${answer} from a program I did not start`, repairs: [] });
    } else if (s.state === 'http_error') {
      faults.push({
        text: `${server} on port ${s.port} answers with HTTP ${s.status}`, ...line,
        repairs: [],
        note: 'That needs a fix in the code; I changed nothing.',
      });
    } else {
      const tabProblem = obs.tabs.find((t) => t.port === s.port && (t.error || (t.status ?? 0) >= 500));
      if (tabProblem) {
        faults.push({
          text: `${server} on port ${s.port} answers, but the tab ${tabProblem.title || tabProblem.url} shows ${tabProblem.error ? errorPage(tabProblem.error) : `HTTP ${tabProblem.status}`}`,
          repairs: tabProblem.error ? reloadFor(s.port) : [],
          ...(tabProblem.error ? {} : { note: 'That page needs a fix in the code; I changed nothing.' }),
        });
      } else {
        healthy.push(`port ${s.port} (${s.name}) answers ${s.status}`);
      }
    }
  }

  const knownPorts = new Set(obs.servers.map((s) => s.port));
  let question: string | undefined;
  for (const t of obs.tabs) {
    if (t.port !== undefined && knownPorts.has(t.port)) continue;
    if (t.error) {
      if (t.port !== undefined) {
        const projects = startableProjects();
        faults.push({
          text: `the tab ${t.title || t.url} shows ${errorPage(t.error)}: nothing answers on port ${t.port}, and I did not start what serves it`,
          repairs: [],
        });
        question ??= projects.length
          ? `Which project should I start: ${list(projects)}?`
          : 'Which project serves it?';
      } else {
        faults.push({ text: `the tab ${t.title || t.url} shows ${errorPage(t.error)}`, repairs: [], note: 'Check the address and the internet connection.' });
      }
    } else if ((t.status ?? 0) >= 500) {
      faults.push({ text: `the tab ${t.title || t.url} got HTTP ${t.status}`, repairs: [], note: 'That page needs a fix in the code; I changed nothing.' });
    }
  }
  for (const p of obs.ports) {
    if (p.open && (p.status ?? 0) >= 500) faults.push({ text: `port ${p.port} answers with HTTP ${p.status}`, repairs: [], note: 'That needs a fix in the code; I changed nothing.' });
    else if (p.open && p.status) healthy.push(`port ${p.port} answers ${p.status}`);
  }

  if (!faults.length && !healthy.length) {
    const projects = startableProjects();
    question = projects.length
      ? `I do not know which application you mean, sir. I can start ${list(projects)}; which one?`
      : 'I do not know which application you mean, sir. Start it, or tell me which project it is.';
  }
  return { faults, healthy, ...(question ? { question } : {}) };
}
