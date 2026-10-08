/**
 * core/verifiers.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * After an action reports success, a check of its real effect
 * (docs/upgrade/JARVIS_PHASES.md, P5: observe → act → verify).
 *
 * Every action tool has an entry: a check, or the reason there is none. A
 * check only reads, and only the paths or state the action itself touched.
 * `failed` turns the step into a failure; `unverifiable` makes no claim.
 */

import * as fs from 'fs';
import * as path from 'path';

export type VerificationStatus = 'verified' | 'failed' | 'unverifiable';

export interface Verification {
  status: VerificationStatus;
  /** What was looked at, in a few words that can be spoken. */
  evidence: string;
}

export type Verifier = (args: Record<string, unknown>, output: string) => Promise<Verification>;

const verified = (evidence: string): Verification => ({ status: 'verified', evidence });
const failed = (evidence: string): Verification => ({ status: 'failed', evidence });
const unverifiable = (evidence: string): Verification => ({ status: 'unverifiable', evidence });

function text(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? (args[key] as string) : '';
}

function exists(p: string): boolean {
  try { fs.statSync(p); return true; } catch { return false; }
}

/** The file holds exactly `content` (size first, so a large file is not read for nothing). */
function holds(p: string, content: string): Verification {
  let stat: fs.Stats;
  try { stat = fs.statSync(p); } catch { return failed(`${path.basename(p)} is not there`); }
  if (!stat.isFile()) return failed(`${path.basename(p)} is not a file`);
  if (stat.size !== Buffer.byteLength(content, 'utf8')) {
    return failed(`${path.basename(p)} has ${stat.size} bytes, not the ${Buffer.byteLength(content, 'utf8')} written`);
  }
  return fs.readFileSync(p, 'utf8') === content
    ? verified(`${path.basename(p)} holds the ${content.length} characters written`)
    : failed(`${path.basename(p)} holds different text`);
}

const verifyWriteFile: Verifier = async (args) => {
  const { resolveWorkspacePath } = await import('../security/workspacePathPolicy.js');
  const check = resolveWorkspacePath(text(args, 'filePath'), 'write', 'write_file');
  if (!check.allowed || !check.resolvedPath) return unverifiable('the path could not be resolved again');
  return holds(check.resolvedPath, String(args['content'] ?? ''));
};

/** FileController resolves paths against the working folder; so does this. */
const verifyControlFile: Verifier = async (args) => {
  const action = text(args, 'action').toLowerCase();
  const source = path.resolve(text(args, 'path'));
  const destination = text(args, 'destination') ? path.resolve(text(args, 'destination')) : '';
  const name = path.basename(source);
  switch (action) {
    case 'write':
      return holds(source, String(args['content'] ?? ''));
    case 'copy':
      if (!destination || !exists(destination)) return failed(`the copy ${path.basename(destination)} is not there`);
      return exists(source) ? verified(`the copy is there and ${name} is still there`) : failed(`${name} is gone after a copy`);
    case 'move':
    case 'rename':
      if (!destination || !exists(destination)) return failed(`${path.basename(destination)} is not there`);
      return exists(source) ? failed(`${name} is still there`) : verified(`${path.basename(destination)} is there and ${name} is gone`);
    case 'create_folder':
      try {
        return fs.statSync(source).isDirectory() ? verified(`the folder ${name} is there`) : failed(`${name} is not a folder`);
      } catch {
        return failed(`the folder ${name} is not there`);
      }
    case 'delete':
    case 'delete_folder':
      return exists(source) ? failed(`${name} is still there`) : verified(`${name} is gone`);
    default:
      return unverifiable('reading or searching changes nothing');
  }
};

const verifySaveRelation: Verifier = async (args) => {
  const { memoryManager } = await import('../memory/memoryManager.js');
  const fact = relationFact(args);
  return memoryManager.getLongTermFacts(500).some((f) => f.fact === fact)
    ? verified('it is in long-term memory')
    : failed('it is not in long-term memory');
};

/** How save_relation stores a relation as a fact (core/tools/memoryTool.ts). */
export function relationFact(args: Record<string, unknown>): string {
  return `${text(args, 'entity1').trim()} ${text(args, 'relation').trim().toUpperCase()} ${text(args, 'entity2').trim()}`;
}

const verifyIngest: Verifier = async (args, output) => {
  if (/Ingested 0 chunk/.test(output)) return failed('nothing was added');
  const { loadManifest } = await import('../rag/index.js');
  const { getWorkspaceRoot } = await import('./workspaceRoot.js');
  const target = path.resolve(text(args, 'path'));
  const relative = path.relative(getWorkspaceRoot(), target).replace(/\\/g, '/');
  const sources = Object.values(loadManifest().chunks).map((c) => c.source);
  const listed = sources.filter((s) => s === relative || s.startsWith(`${relative}/`) || relative === '');
  return listed.length > 0
    ? verified(`the index lists ${listed.length} chunk(s) from it`)
    : failed('the index does not list it');
};

const verifyFullControl = (on: boolean): Verifier => async () => {
  const { permissionSession } = await import('../control/permissionSession.js');
  const level = permissionSession.getCurrentLevel();
  return (level >= 2) === on
    ? verified(on ? 'full control mode is on' : 'full control mode is off')
    : failed(on ? 'full control mode is still off' : 'full control mode is still on');
};

/**
 * control_browser, checked in the Chrome JARVIS reads (P8/P9): the tab the
 * action names in its message — "(tab <id>)" — is gone, on screen or open.
 */
const verifyControlBrowser: Verifier = async (args, output) => {
  const action = text(args, 'action').toLowerCase();
  if (action === 'list') return unverifiable('listing tabs changes nothing');
  let message = output;
  try { message = String(JSON.parse(output)?.message ?? ''); } catch { /* plain text */ }
  if (action === 'refresh') {
    if (/\(checked: /.test(message)) return verified(/\(checked: (.*)\)$/.exec(message)?.[1] ?? 'the page loaded again');
    const found = /but the check found that (.*)$/.exec(message)?.[1];
    return found ? failed(found) : unverifiable('the refresh was a key press, which cannot be checked');
  }
  const id = /\(tab ([A-Za-z0-9]+)\)/.exec(message)?.[1];
  if (!id) {
    if (action === 'open_url') return unverifiable('it was opened outside the Chrome JARVIS reads');
    if (/Ctrl\+W/.test(message)) return unverifiable('the tab was closed with a key press, which cannot be checked');
    return failed(/is not open/.test(message) ? 'no open tab matched' : 'no tab was named in the result');
  }
  const { listPages, withPage, evaluateFixed, cdpPort } = await import('../perception/cdpClient.js');
  let pages;
  try { pages = await listPages(cdpPort()); } catch { return unverifiable('Chrome is not reachable for JARVIS, so the tabs could not be checked'); }
  const page = pages.find((p) => p.id === id);
  switch (action) {
    case 'close':
    case 'close_current':
      return page ? failed('the tab is still open') : verified('the tab is gone');
    case 'focus': {
      if (!page) return failed('the tab is not open');
      const { VISIBILITY_SCRIPT } = await import('../perception/cdpScripts.js');
      const visibility = await withPage(page, (s) => evaluateFixed<string>(s, VISIBILITY_SCRIPT, 2_000), cdpPort()).catch(() => 'unknown');
      return visibility === 'visible' ? verified('the tab is on screen') : failed('the tab is not on screen');
    }
    case 'open_url':
      return page ? verified('the new tab is open') : failed('the new tab is not open');
    default:
      return unverifiable('nothing to check');
  }
};

/** Windows actions are checked against the desktop in P14, which needs the PC itself. */
const ON_WINDOWS = 'checked on Windows only (phase P14); not checked here';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask `look` until it answers true, for up to `ms` — but at least `minLooks`
 * times. Each look at the desktop starts a fresh Windows PowerShell; on a
 * slow PC (the owner's 2010 iMac) one look can take longer than `ms`, and a
 * window that closed or appeared while it ran was then never seen.
 */
export async function keepLooking(look: () => Promise<boolean>, ms: number, minLooks = 2, pauseMs = 300): Promise<boolean> {
  const until = Date.now() + ms;
  for (let looks = 1; ; looks++) {
    if (await look()) return true;
    if (looks >= minLooks && Date.now() >= until) return false;
    await pause(pauseMs);
  }
}

/** The result's message: kernel results carry it in JSON, others are plain text. */
function messageOf(output: string): string {
  try { return String(JSON.parse(output)?.message ?? output); } catch { return output; }
}

/** What the window checks read from the desktop; tests put stand-ins here. */
export const windowChecks = {
  onWindows: (): boolean => process.platform === 'win32',
  windowState: async (hwnd: string) => (await import('../perception/windowsProbe.js')).windowState(hwnd),
};

/** The same window handle, written in hex or decimal. */
function sameHandle(a: string, b: string): boolean {
  try { return BigInt(a) === BigInt(b); } catch { return false; }
}

const CLOSING = new Set(['close', 'close_current']);

/** A control_window close: never taken on trust, so a close that cannot be checked is not done. */
function isWindowClose(tool: string, args: Record<string, unknown>): boolean {
  return tool === 'control_window' && CLOSING.has(text(args, 'action').toLowerCase());
}

/**
 * control_window (P14), asked of Windows by the window's handle: a closed
 * window is gone (looked for up to 3 s; one asking whether to save stays,
 * which is said), a focused one is in front, a minimised or maximised one is
 * so. A move or resize is not read back.
 *
 * A close is checked strictly (Step C; on the owner's seventh Windows run the
 * close did nothing, said nothing, and "not checked" let it pass as done): no
 * result naming the window, another window than the handle asked for, or a
 * window that could not be read is a failed close. The window checked is the
 * one asked for when the request gave its handle.
 */
const verifyControlWindow: Verifier = async (args, output) => {
  const action = text(args, 'action').toLowerCase();
  const closing = CLOSING.has(action);
  if (!windowChecks.onWindows()) return closing ? failed('windows are closed, and the close checked, only on Windows') : unverifiable(ON_WINDOWS);
  const named = /window (0x[0-9a-f]+)/i.exec(messageOf(output))?.[1];
  const target = text(args, 'target').trim();
  const asked = /^0x[0-9a-f]{1,16}$/i.test(target) ? target : undefined;
  if (closing) {
    if (!named) return failed('the close gave no result naming a window, so nothing shows it was done');
    if (asked && !sameHandle(named, asked)) return failed(`it acted on window ${named}, not on ${asked}, the window asked for`);
    const hwnd = asked ?? named;
    try {
      return (await keepLooking(async () => !(await windowChecks.windowState(hwnd)).exists, 3_000))
        ? verified('the window is gone')
        : failed('the window is still open; it may be asking whether to save');
    } catch (err) {
      return failed(`whether the window closed could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const hwnd = named ?? asked;
  if (!hwnd) return unverifiable('the result did not name the window');
  const state = await windowChecks.windowState(hwnd);
  if (!state.exists) return failed('the window is gone');
  if (action === 'focus') return state.foreground ? verified('the window is in front') : failed('another window is in front');
  if (action === 'minimize') return state.minimized ? verified('the window is minimised') : failed('the window is not minimised');
  if (action === 'maximize') return state.maximized ? verified('the window is maximised') : failed('the window is not maximised');
  return unverifiable('its new position or size is not read back');
};

/**
 * How an app's window is recognised, by its title or program. calc.exe
 * exits once Calculator is up (its window belongs to ApplicationFrameHost),
 * and VS Code's program is "Code": the name asked for is not always the
 * program's.
 */
const APP_WINDOWS: Readonly<Record<string, RegExp>> = {
  calculator: /calculator/i, calc: /calculator/i,
  vscode: /visual studio code|^code$/i, 'vs code': /visual studio code|^code$/i, code: /visual studio code|^code$/i,
  cmd: /command prompt|^cmd$|windowsterminal/i, 'command prompt': /command prompt|^cmd$|windowsterminal/i,
  settings: /^settings$/i, 'ms-settings': /^settings$/i,
};

export function appWindowMatcher(target: string): RegExp {
  const key = target.toLowerCase().trim();
  return APP_WINDOWS[key] ?? new RegExp(key.replace(/\.exe$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/** A visible window of the app, or (for `open`) its process, asked again for up to `ms`. */
async function appState(target: string, wanted: boolean, ms: number): Promise<boolean> {
  const { probeWindows } = await import('../perception/windowsProbe.js');
  const { appController } = await import('../control/appController.js');
  const matcher = appWindowMatcher(target);
  return keepLooking(async () => {
    const windows = await probeWindows('windows') as Array<{ title: string; process: string }>;
    const visible = windows.some((w) => matcher.test(w.title) || matcher.test(w.process));
    // Closing closes windows: a process left in the background counts as closed.
    const open = visible || (wanted && (await appController.isAppOpen(target)));
    return open === wanted;
  }, ms);
}

/** An app that was opened may need a while to show its window on a slow PC. */
const APP_OPEN_WAIT_MS = 15_000;

/** control_app (P14), on the desktop: an opened or restarted app runs, a closed one has no window left, a focused one is in front. */
const verifyControlApp: Verifier = async (args) => {
  if (process.platform !== 'win32') return unverifiable(ON_WINDOWS);
  const action = text(args, 'action').toLowerCase();
  const target = text(args, 'target');
  if (!target) return unverifiable('no app was named');
  if (action === 'open' || action === 'restart') {
    return (await appState(target, true, APP_OPEN_WAIT_MS)) ? verified(`${target} is running`) : failed(`${target} is not running`);
  }
  if (action === 'close') {
    return (await appState(target, false, 3_000)) ? verified(`no window of ${target} is open`) : failed(`a window of ${target} is still open`);
  }
  if (action === 'focus') {
    const { getWindowsState } = await import('../perception/windowsState.js');
    const active = (await getWindowsState({ waitMs: 1_000 })).activeWindow;
    const matcher = appWindowMatcher(target);
    return matcher.test(active.processName) || matcher.test(active.title)
      ? verified(`${target} is in front`) : failed(`${active.processName || 'another window'} is in front`);
  }
  return unverifiable('nothing to check');
};

/** open_app (P14): an app runs afterwards; a web page opens in the default browser, which is not checked. */
const verifyOpenApp: Verifier = async (args, output) => {
  if (process.platform !== 'win32') return unverifiable(ON_WINDOWS);
  if (args['dryRun']) return unverifiable('a dry run opens nothing');
  let resolved = '';
  try { resolved = String(JSON.parse(output)?.resolvedTarget ?? ''); } catch { /* plain text */ }
  const target = text(args, 'target');
  if (/^(https?:|www\.)|^ms-settings:/i.test(resolved) || /^(https?:|www\.)/i.test(target)) {
    return unverifiable('a web page or a Windows page opened, which is not checked');
  }
  if (!target) return unverifiable('no app was named');
  return (await appState(target, true, APP_OPEN_WAIT_MS)) ? verified(`${target} is running`) : failed(`${target} is not running`);
};

export const VERIFIERS: Readonly<Record<string, Verifier | { reason: string }>> = {
  write_file: verifyWriteFile,
  control_file: verifyControlFile,
  save_relation: verifySaveRelation,
  ingest_documents: verifyIngest,
  enable_full_control_session: verifyFullControl(true),
  disable_full_control_session: verifyFullControl(false),
  run_command: { reason: "a command's effect cannot be checked in general; its exit code is reported" },
  open_app: verifyOpenApp,
  control_app: verifyControlApp,
  control_window: verifyControlWindow,
  control_browser: verifyControlBrowser,
  control_keyboard: { reason: ON_WINDOWS },
  control_mouse: { reason: ON_WINDOWS },
  control_process: { reason: ON_WINDOWS },
  control_system: { reason: ON_WINDOWS },
  cancel_current_action: { reason: 'it stops work in progress; there is nothing left to look at' },
};

/** What JARVIS says when an action reported success but its check failed. */
export function verificationFailedReply(text: string): string {
  const evidence = /the check found that (.*?)\.?$/.exec(text.trim())?.[1];
  return evidence
    ? `I tried, sir, but I could not confirm it worked: ${evidence}.`
    : 'I tried, sir, but I could not confirm it worked.';
}

/** A reply with what was checked added, when it was. */
export function withCheck(reply: string, verification: Verification | undefined): string {
  if (verification?.status !== 'verified') return reply;
  return `${reply.trim().replace(/[.!]?$/, '.')} I checked: ${verification.evidence}.`;
}

const LIMIT_MS = 5_000;
/**
 * Checks that look at the Windows desktop start a fresh PowerShell per look,
 * which on a slow PC takes many seconds (the owner's 2010 iMac): they get
 * longer before they count as not checked.
 */
const DESKTOP_LIMIT_MS = 60_000;
const DESKTOP_CHECKS = new Set(['control_window', 'control_app', 'open_app']);

/**
 * The check for `tool`'s successful call, cut off after 5 s (60 s for the
 * Windows desktop checks). A check that
 * throws or runs out of time is `unverifiable`, never a pass. Undefined when
 * the tool has no entry (it only reads).
 */
export async function verifyCall(
  tool: string,
  args: Record<string, unknown>,
  output: string,
  own?: Verifier,
): Promise<Verification | undefined> {
  const entry = own ?? VERIFIERS[tool];
  if (!entry) return undefined;
  if (typeof entry !== 'function') return unverifiable(entry.reason);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Verification>((resolve) => {
    const limit = process.platform === 'win32' && DESKTOP_CHECKS.has(tool) ? DESKTOP_LIMIT_MS : LIMIT_MS;
    timer = setTimeout(() => resolve(unverifiable(`the check took longer than ${limit / 1000} s`)), limit);
  });
  try {
    const result = await Promise.race([
      entry(args, output).catch((err: unknown) => unverifiable(`the check failed to run: ${err instanceof Error ? err.message : String(err)}`)),
      timeout,
    ]);
    // A window close whose check did not run, or took too long, is not done.
    return isWindowClose(tool, args) && result.status === 'unverifiable' ? failed(`the close could not be checked: ${result.evidence}`) : result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
