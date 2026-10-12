/**
 * security/protectedTargets.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Where file actions may happen and which services are never stopped (ARCH-04).
 * These lists were defined in control/fileController.ts and
 * control/adminController.ts, and the risk engine, file policy and browser
 * policy imported them from there. Security policy now lives under security/;
 * the controllers import it from here (and re-export it, so other callers are
 * unchanged).
 */

import * as os from 'os';
import * as path from 'path';
import { getWorkspaceRoot } from '../core/workspaceRoot.js';

/**
 * Directories control_file may operate in (also used by the risk engine).
 *
 * Deliberately wider than `workspacePathPolicy`'s workspace-only boundary: a
 * desktop assistant is expected to manage the user's own document folders.
 */
export function approvedFolders(): string[] {
  const home = os.homedir();
  return [
    getWorkspaceRoot(),
    path.resolve(os.tmpdir()),
    path.resolve(path.join(home, 'Desktop')),
    path.resolve(path.join(home, 'Documents')),
    path.resolve(path.join(home, 'Downloads')),
  ];
}

/** Security services never stopped or restarted (as the blocklist's 'stop-service windefend'). */
const PROTECTED_SERVICES = new Set(['windefend', 'mpssvc', 'wscsvc', 'securityhealthservice', 'sense', 'wdnissvc']);

export function isSecurityService(name: string): boolean {
  return PROTECTED_SERVICES.has(String(name ?? '').trim().toLowerCase());
}
