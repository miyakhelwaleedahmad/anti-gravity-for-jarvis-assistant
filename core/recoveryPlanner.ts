/**
 * core/recoveryPlanner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * When a step fails (docs/upgrade/phases/phase-11-error-recovery.md): look
 * again at the part of the PC the step touched, and — for a failure JARVIS
 * knows — propose a repair as ordinary tool calls.
 *
 * Nothing here runs a tool. The orchestrator runs each repair step through the
 * tool registry, so the risk engine, the approval gate (with the failure as
 * WHY) and the after-action check apply to repairs exactly as to any step.
 *
 *   Nothing answers on a port where JARVIS ran a server  → start that server (1)
 *   The port is held by JARVIS's own server                → stop it (2), retry
 *   No tab matches an address                              → open it in a tab (1)
 *   A file does not exist                                  → ask the user; no guess
 *   Anything else                                          → the existing strategies
 */

import * as path from 'path';
import type { TaskNode } from './taskGraphEngine.js';
import { worldState, type ObservedSection } from './worldState.js';
import { jarvisServerOnPort, knownServerOnPort } from '../tools/devTools.js';
import { normalizeUrl, urlProblem } from '../security/browserPolicy.js';

export interface RepairStep {
  tool: string;
  args: Record<string, unknown>;
  /** What JARVIS would do ("start the dev server of web"). */
  says: string;
  /** The same, done ("started the dev server of web"). */
  did: string;
}

export type Diagnosis =
  | { kind: 'repair'; failure: string; steps: RepairStep[] }
  | { kind: 'ask'; failure: string; message: string }
  | { kind: 'none' };

/** At most this many repair rounds per request. */
export const MAX_RECOVERY_ROUNDS = 2;

/** The parts of the world a tool touches, read again when one of its steps fails. */
export function sectionsFor(tool: string): ObservedSection[] {
  if (/^browser_|^control_browser$|^get_browser_tabs$|^is_tab_open$/.test(tool)) return ['browser'];
  if (/^(dev|dev_status|git|git_push|git_overview|run_command)$/.test(tool)) return ['development'];
  if (/^(open_app|control_app|control_window|get_open_apps|get_active_window|is_app_open)$/.test(tool)) return ['apps'];
  if (/^(system_overview|control_system|control_process)$/.test(tool)) return ['system'];
  return [];
}

/** Read again, now, the parts of the world the failed step touched. */
export async function observeFailure(node: TaskNode): Promise<ObservedSection[]> {
  const sections = sectionsFor(node.tool);
  if (sections.length) await worldState.refresh(sections, 0);
  return sections;
}

const REFUSED = /ERR_CONNECTION_REFUSED|ECONNREFUSED|connection refused/i;
const LOCAL_PORT = /(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/i;
const PORT_IN_USE = /Port (\d{2,5}) is already in use/i;
const NO_TAB = /No open tab matches "([^"]+)"/i;
const NO_FILE = /(\S+) does not exist\.?|ENOENT[^']*'([^']+)'/i;

/** What to do about a failed step, from its error. */
export function diagnose(node: TaskNode): Diagnosis {
  const error = String(node.error ?? '').replace(/^[A-Z_]+: /, '');
  if (!error) return { kind: 'none' };

  const refused = REFUSED.test(error) ? LOCAL_PORT.exec(error) : null;
  if (refused) {
    const port = Number(refused[1]);
    const known = knownServerOnPort(port);
    if (known && !jarvisServerOnPort(port)) {
      return {
        kind: 'repair',
        failure: `nothing answers on port ${port}`,
        steps: [{
          tool: 'dev',
          args: { action: 'start_server', project: known.project, script: known.script, port },
          says: `start the ${known.script} server of ${path.basename(known.project)} on port ${port}`,
          did: `started the ${known.script} server of ${path.basename(known.project)} on port ${port}`,
        }],
      };
    }
    return {
      kind: 'ask', failure: `nothing answers on port ${port}`,
      message: `Nothing answers on port ${port}, sir, and I do not know which project serves it. Start it, or tell me which project to start.`,
    };
  }

  const inUse = node.tool === 'dev' ? PORT_IN_USE.exec(error) : null;
  if (inUse) {
    const port = Number(inUse[1]);
    const mine = jarvisServerOnPort(port);
    if (mine) {
      return {
        kind: 'repair',
        failure: `port ${port} is held by a server JARVIS started earlier (process ${mine.pid})`,
        steps: [{
          tool: 'dev', args: { action: 'stop_server', pid: mine.pid },
          says: `stop the old ${mine.script} server (process ${mine.pid}) on port ${port}`,
          did: `stopped the old ${mine.script} server (process ${mine.pid}) on port ${port}`,
        }],
      };
    }
    return {
      kind: 'ask', failure: `port ${port} is in use`,
      message: `Port ${port} is used by a program I did not start, sir. Close it, or choose another port.`,
    };
  }

  const noTab = /^browser_/.test(node.tool) ? NO_TAB.exec(error) : null;
  if (noTab) {
    const wanted = noTab[1]!;
    const url = normalizeUrl(wanted);
    if (/^https?:\/\//i.test(url) && !urlProblem(url)) {
      return {
        kind: 'repair',
        failure: `no tab shows ${wanted}`,
        steps: [{ tool: 'browser_tab', args: { action: 'new', url }, says: `open ${url} in a new tab`, did: `opened ${url} in a new tab` }],
      };
    }
    return { kind: 'none' };
  }

  const noFile = node.tool === 'files' || node.tool === 'read_file' || node.tool === 'control_file' ? NO_FILE.exec(error) : null;
  if (noFile) {
    const missing = noFile[1] ?? noFile[2];
    return {
      kind: 'ask', failure: `${missing} does not exist`,
      message: `I could not find ${missing}, sir. Tell me where it is; I will not guess.`,
    };
  }

  return { kind: 'none' };
}
