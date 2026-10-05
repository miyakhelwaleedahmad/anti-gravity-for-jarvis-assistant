/**
 * core/workspaceRoot.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single authority for "where is the project, and is this path inside it?".
 *
 * Replaces the hard-coded `W:\anti gravity for jarvis assistant` literal that
 * previously sat in `security/workspacePathPolicy.ts` (JARVIS-001), and supplies
 * the host-independent path predicates that the containment checks need
 * (JARVIS-001b).
 *
 * WHY THE PREDICATES EXIST
 * ------------------------
 * Node's `path` module is platform-native. On a POSIX host:
 *
 *     path.isAbsolute('C:\\Windows\\win.ini')            === false
 *     path.resolve(root, 'C:\\Windows\\win.ini')         === '<root>/C:\Windows\win.ini'
 *
 * A Windows drive path is therefore silently demoted to a *relative* path and
 * lands **inside** the workspace, so both `path.relative()` containment checks
 * and `^c:\windows`-anchored system-folder patterns fail to fire. Correcting the
 * workspace root alone does not fix this — the guard must recognise Windows-style
 * absolute paths on every host.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Workspace root ──────────────────────────────────────────────────────────

/**
 * Absolute path to the project root.
 *
 * Resolution order:
 *   1. `JARVIS_WORKSPACE_ROOT` environment variable, when set and non-empty.
 *   2. The directory containing this module's parent (`core/..`).
 *
 * Deliberately not cached: the environment variable is read on every call so
 * that tests can relocate the root without reloading the module graph.
 */
export function getWorkspaceRoot(): string {
  const override = process.env['JARVIS_WORKSPACE_ROOT']?.trim();
  if (override) return path.resolve(override);
  return path.resolve(__dirname, '..');
}

// ─── Data root ───────────────────────────────────────────────────────────────

/**
 * Where a module keeps its data files (memory, goals, permission session,
 * audit logs), given the location it has always used.
 *
 * `JARVIS_DATA_ROOT` moves all of them at once: the test runner points it at
 * a temporary folder, so a test run never writes into the real memory, goals
 * or permission files. Unset, every module keeps its own location.
 */
export function dataRoot(defaultRoot: string): string {
  const override = process.env['JARVIS_DATA_ROOT']?.trim();
  return override ? path.resolve(override) : defaultRoot;
}

// ─── Host-independent path predicates ────────────────────────────────────────

/** `C:\foo`, `c:/foo`, or a bare drive root `D:\` / `D:`. */
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:(?:[\\/]|$)/;

/** UNC share: `\\server\share`. */
const UNC_PATTERN = /^\\\\[^\\/]+/;

/**
 * True when `p` is absolute on *any* supported platform — POSIX (`/etc`),
 * Windows drive (`C:\Windows`), or UNC (`\\server\share`) — regardless of the
 * host this process happens to be running on.
 */
export function isAbsoluteAnyPlatform(p: string): boolean {
  const t = p.trim();
  if (!t) return false;
  return path.isAbsolute(t) || WINDOWS_DRIVE_PATTERN.test(t) || UNC_PATTERN.test(t);
}

/**
 * True when `p` is a Windows-style absolute path that the *current* host's
 * `path` module would not recognise as absolute. This is the exact case that
 * causes a drive path to be treated as relative on Linux.
 */
export function isForeignWindowsAbsolute(p: string): boolean {
  const t = p.trim();
  if (!t) return false;
  return !path.isAbsolute(t) && (WINDOWS_DRIVE_PATTERN.test(t) || UNC_PATTERN.test(t));
}

/**
 * Normalise a path for pattern matching: backslashes to forward slashes,
 * collapsed repeats, lower-cased, trailing separator stripped.
 *
 * Produces a stable form so that a single set of patterns matches whether the
 * caller wrote `C:\Windows\Temp`, `c:/windows/temp/`, or `C:\\Windows\\Temp`.
 */
export function toComparablePath(p: string): string {
  const trimmed = p.trim();
  const isUnc = /^[\\/]{2}[^\\/]/.test(trimmed);
  let unified = trimmed.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (isUnc) unified = `/${unified}`; // restore the leading `//` the collapse removed
  const lowered = unified.toLowerCase();
  return lowered.length > 1 && lowered.endsWith('/') ? lowered.slice(0, -1) : lowered;
}

/**
 * Protected Windows system locations, expressed against {@link toComparablePath}
 * output. Each matches the directory itself **and** anything beneath it, so a
 * bare `C:\Windows` is caught as well as `C:\Windows\Temp\x.txt`.
 *
 * (The previous per-file patterns required a trailing separator and so missed a
 * bare directory even on Windows.)
 */
const SYSTEM_PATH_PATTERNS: readonly RegExp[] = [
  /^[a-z]:\/windows(?:\/|$)/,
  /^[a-z]:\/system32(?:\/|$)/,
  /^[a-z]:\/program files(?:\/|$)/,
  /^[a-z]:\/program files \(x86\)(?:\/|$)/,
  /^[a-z]:\/programdata(?:\/|$)/,
  /^[a-z]:\/users\/[^/]+\/appdata(?:\/|$)/,
  /^\/(?:etc|sys|proc|boot)(?:\/|$)/,
];

/**
 * True when `p` names a protected operating-system location. Evaluated against
 * the **raw** input rather than a host-resolved path, so a Windows system path
 * is still recognised when the guard runs on Linux.
 */
export function isProtectedSystemPath(p: string): boolean {
  const c = toComparablePath(p);
  return SYSTEM_PATH_PATTERNS.some((pattern) => pattern.test(c));
}

/**
 * True when `child` is `parent` or lies beneath it.
 *
 * Uses `path.relative`, so comparison follows the host platform's own casing
 * rules. Unlike a `startsWith` prefix test it is boundary-aware: `/home/u/Desktop`
 * does not contain `/home/u/Desktop-evil`.
 */
export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).includes('..');
}
