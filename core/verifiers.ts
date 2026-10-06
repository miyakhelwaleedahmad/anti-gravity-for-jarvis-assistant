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

/** Windows actions are checked against the desktop in P14, which needs the PC itself. */
const ON_WINDOWS = 'checked on Windows only (phase P14); not checked here';

export const VERIFIERS: Readonly<Record<string, Verifier | { reason: string }>> = {
  write_file: verifyWriteFile,
  control_file: verifyControlFile,
  save_relation: verifySaveRelation,
  ingest_documents: verifyIngest,
  enable_full_control_session: verifyFullControl(true),
  disable_full_control_session: verifyFullControl(false),
  run_command: { reason: "a command's effect cannot be checked in general; its exit code is reported" },
  open_app: { reason: ON_WINDOWS },
  control_app: { reason: ON_WINDOWS },
  control_window: { reason: ON_WINDOWS },
  control_browser: { reason: 'checked once the browser can be read (phase P8)' },
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
 * The check for `tool`'s successful call, cut off after 5 s. A check that
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
    timer = setTimeout(() => resolve(unverifiable(`the check took longer than ${LIMIT_MS / 1000} s`)), LIMIT_MS);
  });
  try {
    return await Promise.race([
      entry(args, output).catch((err: unknown) => unverifiable(`the check failed to run: ${err instanceof Error ? err.message : String(err)}`)),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
