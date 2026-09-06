import * as path from 'path';
import { securityAuditLogger } from './securityAuditLogger.js';

export const WORKSPACE_ROOT = path.resolve('W:\\anti gravity for jarvis assistant');

const WINDOWS_SYSTEM_FOLDERS = [
  /^c:\\windows(?:\\|$)/i,
  /^c:\\program files(?:\\|$)/i,
  /^c:\\program files \(x86\)(?:\\|$)/i,
  /^c:\\users\\[^\\]+\\appdata(?:\\|$)/i,
];

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

  const resolvedPath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(WORKSPACE_ROOT, trimmed);

  const normalized = resolvedPath.toLowerCase();
  if (WINDOWS_SYSTEM_FOLDERS.some((pattern) => pattern.test(normalized))) {
    const reason = 'Windows system folder access is blocked.';
    securityAuditLogger.denied(resolvedPath, 'CRITICAL_RISK', reason, toolName);
    return { allowed: false, reason };
  }

  const relative = path.relative(WORKSPACE_ROOT, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
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
