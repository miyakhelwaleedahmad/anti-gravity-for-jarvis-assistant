/**
 * security/fsPolicy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Where the file tools may work and how risky a change is
 * (docs/upgrade/PERMISSION_MODEL.md, P10). Shared by the risk engine, which
 * decides before anything runs, and tools/fsTools.ts, which checks again.
 *
 * Containment is the approved folders (control/fileController.ts) compared by
 * real path: a link inside an approved folder cannot lead outside it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { approvedFolders } from '../control/fileController.js';
import { getWorkspaceRoot, isForeignWindowsAbsolute, isPathInside, isProtectedSystemPath, realPathOf } from '../core/workspaceRoot.js';

export type PathCheck = { ok: true; path: string; real: string } | { ok: false; reason: string };

export const OUTSIDE_APPROVED =
  'JARVIS works with files only in the approved folders (the JARVIS folder, Desktop, Documents, Downloads, temp).';

/** Files that run when opened: never created or changed by the file tools. */
const EXECUTABLE = /\.(exe|dll|bat|cmd|ps1|psm1|vbs|vbe|jse|wsf|wsh|msi|msp|scr|com|lnk|reg|hta|cpl)$/i;
/** Source and configuration files: changes are approved each time (as control_file does). */
const SOURCE_OR_CONFIG = /\.(ts|tsx|js|jsx|mjs|cjs|json|py|yml|yaml|toml|ini|cfg|config)$|(^|[\\/])(package\.json|tsconfig[^\\/]*)$/i;
/** Keys and credentials: changed only with approval, searched by name only. */
const SECRET_FILE = /(^|[\\/])(\.env(\.[^\\/]*)?|id_[a-z0-9]+(\.pub)?|credentials(\.json)?|[^\\/]*\.(pem|key|p12|pfx|kdbx|ppk))$/i;

export function realApprovedFolders(): string[] {
  return approvedFolders().map((root) => {
    try { return fs.realpathSync(root); } catch { return path.resolve(root); }
  });
}

export { realPathOf };

/** `raw` resolved against the JARVIS folder, if it is inside an approved folder. */
export function checkFilePath(raw: unknown): PathCheck {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, reason: 'No path was given.' };
  if (isProtectedSystemPath(text) || isForeignWindowsAbsolute(text)) return { ok: false, reason: OUTSIDE_APPROVED };
  const resolved = path.resolve(getWorkspaceRoot(), text);
  const real = realPathOf(resolved);
  if (isProtectedSystemPath(resolved) || isProtectedSystemPath(real)) return { ok: false, reason: OUTSIDE_APPROVED };
  if (!realApprovedFolders().some((root) => isPathInside(root, real))) return { ok: false, reason: OUTSIDE_APPROVED };
  return { ok: true, path: resolved, real };
}

/** An approved folder itself (deleting or moving it is refused). */
export function isApprovedRoot(real: string): boolean {
  return realApprovedFolders().some((root) => path.resolve(root).toLowerCase() === path.resolve(real).toLowerCase());
}

export function isExecutable(p: string): boolean {
  return EXECUTABLE.test(p);
}

export function isSecretFile(p: string): boolean {
  return SECRET_FILE.test(p);
}

/** Risk of creating or changing `p`: temp .txt 1, other files 2, source/config/keys 3. */
export function changeLevel(p: string, tmpRoot: string): 1 | 2 | 3 {
  if (SECRET_FILE.test(p) || SOURCE_OR_CONFIG.test(p)) return 3;
  const real = realPathOf(p);
  if (path.extname(p).toLowerCase() === '.txt' && isPathInside(realPathOf(tmpRoot), real)) return 1;
  return 2;
}
