import * as path from 'path';
import { securityAuditLogger } from './securityAuditLogger.js';
import {
  getWorkspaceRoot,
  isForeignWindowsAbsolute,
  isPathInside,
  isProtectedSystemPath,
} from '../core/workspaceRoot.js';

/**
 * The containment boundary for all agent file I/O.
 *
 * Previously a hard-coded `W:\anti gravity for jarvis assistant` literal, which
 * resolved to a nonsense path relative to the CWD on any other host — so the
 * guard silently failed open (JARVIS-001). Now derived once, portably, from
 * `JARVIS_WORKSPACE_ROOT` or the module's own location.
 *
 * Exposed as a function rather than a `const` so that the environment variable
 * is honoured even when it is set after this module is first imported.
 */
export function getWorkspaceRootPath(): string {
  return getWorkspaceRoot();
}

const UNSAFE_EXECUTABLE_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.ps1',
  '.vbs',
  '.js',
  '.jse',
  '.msi',
  '.scr',
  '.com',
]);

export interface WorkspacePathCheck {
  allowed: boolean;
  resolvedPath?: string;
  reason?: string;
}

export function resolveWorkspacePath(
  rawPath: string,
  operation: 'read' | 'write',
  toolName: string,
): WorkspacePathCheck {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { allowed: false, reason: 'Path is empty.' };
  }

  const segments = trimmed.split(/[\\/]+/);
  if (segments.includes('..')) {
    const reason = 'Path traversal using ".." is blocked.';
    securityAuditLogger.denied(trimmed, 'HIGH_RISK', reason, toolName);
    return { allowed: false, reason };
  }

  // Protected system locations are tested against the RAW input, before any
  // host-native resolution. On Linux, `path.resolve()` would turn
  // `C:\Windows\Temp\x` into a path *inside* the workspace and these patterns —
  // which are anchored at the start — would never fire (JARVIS-001b).
  if (isProtectedSystemPath(trimmed)) {
    const reason = 'Windows system folder access is blocked.';
    securityAuditLogger.denied(trimmed, 'CRITICAL_RISK', reason, toolName);
    return { allowed: false, reason };
  }

  // A path that is absolute for a *different* platform than the host cannot be
  // meaningfully resolved here, and is by definition not inside this workspace.
  // Without this, `path.isAbsolute('C:\\x')` is false on POSIX and the path is
  // silently treated as relative to the workspace root.
  if (isForeignWindowsAbsolute(trimmed)) {
    const reason = 'Path is outside the project workspace.';
    securityAuditLogger.denied(trimmed, 'HIGH_RISK', reason, toolName);
    return { allowed: false, reason };
  }

  const workspaceRoot = getWorkspaceRoot();
  const resolvedPath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspaceRoot, trimmed);

  // Re-check after resolution: catches host-native system paths (e.g. `/etc`)
  // and anything resolution turned into one.
  if (isProtectedSystemPath(resolvedPath)) {
    const reason = 'Windows system folder access is blocked.';
    securityAuditLogger.denied(resolvedPath, 'CRITICAL_RISK', reason, toolName);
    return { allowed: false, reason };
  }

  if (!isPathInside(workspaceRoot, resolvedPath)) {
    const reason = 'Path is outside the project workspace.';
    securityAuditLogger.denied(resolvedPath, 'HIGH_RISK', reason, toolName);
    return { allowed: false, reason };
  }

  if (operation === 'write' && UNSAFE_EXECUTABLE_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) {
    const reason = 'Writing executable/script file extensions is blocked.';
    securityAuditLogger.denied(resolvedPath, 'HIGH_RISK', reason, toolName);
    return { allowed: false, reason };
  }

  return { allowed: true, resolvedPath };
}

export function isEnvFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return base === '.env' || base.startsWith('.env.');
}
