/**
 * skills/automation/skill.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Automation skill: opens apps, URLs, files on the local OS.
 * Uses platform-native open commands (start on Windows, open on macOS, xdg-open on Linux).
 */

import { spawn } from 'child_process';
import { securityAuditLogger } from '../../security/securityAuditLogger.js';
import { approvalGate } from '../../security/approvalGate.js';

type OpenAppSource = 'voice' | 'text' | 'llm';

interface ResolvedOpenTarget {
  allowed: boolean;
  requestedTarget: string;
  resolvedTarget: string;
  reason?: string;
  requiresApproval?: boolean;
}

const WEBSITE_ALLOWLIST: Record<string, string> = {
  'youtube': 'https://www.youtube.com',
  'https://www.youtube.com': 'https://www.youtube.com',
  'google': 'https://www.google.com',
  'https://www.google.com': 'https://www.google.com',
  'gmail': 'https://mail.google.com',
  'https://mail.google.com': 'https://mail.google.com',
  'github': 'https://github.com',
  'https://github.com': 'https://github.com',
  'whatsapp': 'https://web.whatsapp.com',
  'whats app': 'https://web.whatsapp.com',
  'https://web.whatsapp.com': 'https://web.whatsapp.com',
};

const APP_ALLOWLIST: Record<string, string> = {
  'chrome': 'chrome.exe',
  'notepad': 'notepad.exe',
  'calculator': 'calc.exe',
  'calc': 'calc.exe',
  'vscode': 'code',
  'vs code': 'code',
  'code': 'code',
  'visual studio code': 'code',
  'settings': 'ms-settings:',
  'downloads': 'shell:Downloads',
  // The voice router and this tool's description have always offered these;
  // without entries here every "open spotify / firefox / edge" was refused.
  'spotify': 'spotify:',
  'firefox': 'firefox.exe',
  'edge': 'msedge.exe',
  'microsoft edge': 'msedge.exe',
};

const APPROVAL_REQUIRED_APPS: Record<string, string> = {
  'cmd': 'cmd.exe',
  'command prompt': 'cmd.exe',
};

const BLOCKED_FILE_EXTENSION_RE = /\.(bat|cmd|ps1|vbs|js|exe)$/i;
const SHELL_METACHAR_RE = /[&|^%><;]/;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const POSIX_ABSOLUTE_PATH_RE = /^\//;
const UNC_PATH_RE = /^\\\\/;

export function resolveTargetUrl(target: string): ResolvedOpenTarget {
  const requestedTarget = target.trim();
  const targetLower = target.toLowerCase().trim();

  if (!requestedTarget) {
    return { allowed: false, requestedTarget, resolvedTarget: '', reason: 'Target is empty.' };
  }

  if (
    SHELL_METACHAR_RE.test(requestedTarget) ||
    UNC_PATH_RE.test(requestedTarget) ||
    WINDOWS_ABSOLUTE_PATH_RE.test(requestedTarget) ||
    POSIX_ABSOLUTE_PATH_RE.test(requestedTarget)
  ) {
    return {
      allowed: false,
      requestedTarget,
      resolvedTarget: requestedTarget,
      reason: 'Target contains a path or shell metacharacter blocked by open_app policy.',
    };
  }

  if (BLOCKED_FILE_EXTENSION_RE.test(requestedTarget) && !APP_ALLOWLIST[targetLower] && !APPROVAL_REQUIRED_APPS[targetLower]) {
    return {
      allowed: false,
      requestedTarget,
      resolvedTarget: requestedTarget,
      reason: 'Executable/script targets are blocked unless explicitly allowlisted.',
    };
  }

  if (WEBSITE_ALLOWLIST[targetLower]) {
    return { allowed: true, requestedTarget, resolvedTarget: WEBSITE_ALLOWLIST[targetLower] };
  }

  if (APP_ALLOWLIST[targetLower]) {
    return { allowed: true, requestedTarget, resolvedTarget: APP_ALLOWLIST[targetLower] };
  }

  if (APPROVAL_REQUIRED_APPS[targetLower]) {
    return {
      allowed: false,
      requestedTarget,
      resolvedTarget: APPROVAL_REQUIRED_APPS[targetLower],
      reason: 'Opening Command Prompt requires explicit approval.',
      requiresApproval: true,
    };
  }

  if (/^https?:\/\//i.test(requestedTarget) || /^www\./i.test(requestedTarget)) {
    return {
      allowed: false,
      requestedTarget,
      resolvedTarget: requestedTarget,
      reason: 'Raw URLs are blocked unless they exactly match the open_app allowlist.',
    };
  }

  return {
    allowed: false,
    requestedTarget,
    resolvedTarget: requestedTarget,
    reason: 'Target is not in the open_app allowlist.',
  };
}

function openTarget(target: string, resolvedTarget: string): Promise<string> {
  return new Promise((resolve) => {
    const platform = process.platform;

    console.log(`[open_app] target="${target}" resolved="${resolvedTarget}"`);

    let cmd: string;
    let args: string[];
    let method = 'spawn';

    if (platform === 'win32') {
      cmd = 'cmd.exe';
      args = ['/c', 'start', '', resolvedTarget];
      method = 'cmd-start';
    } else if (platform === 'darwin') {
      cmd = 'open';
      args = [resolvedTarget];
      method = 'open';
    } else {
      cmd = 'xdg-open';
      args = [resolvedTarget];
      method = 'xdg-open';
    }

    console.log(`[open_app] platform=${platform} command=${cmd} args=${args.join(',')}`);

    try {
      const proc = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        shell: false,
        ...(platform === 'win32' ? { windowsHide: true } : {})
      });

      let errorOccurred = false;
      proc.on('error', (err) => {
        errorOccurred = true;
        resolve(JSON.stringify({
          success: false,
          target,
          resolvedTarget,
          platform,
          method,
          error: err.message
        }));
      });

      proc.unref();

      // Give Node event loop a tick to register immediate spawn failures
      setTimeout(() => {
        if (!errorOccurred) {
          resolve(JSON.stringify({
            success: true,
            target,
            resolvedTarget,
            platform,
            method
          }));
        }
      }, 50);
    } catch (err: any) {
      resolve(JSON.stringify({
        success: false,
        target,
        resolvedTarget,
        platform,
        method,
        error: String(err)
      }));
    }
  });
}

export async function execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const target = String(args['target'] ?? '').trim();
  const source = (['voice', 'text', 'llm'].includes(String(args['source'] ?? ''))
    ? String(args['source'])
    : 'llm') as OpenAppSource;
  if (!target) {
    return JSON.stringify({
      success: false,
      error: 'Error: target is required to open an application or URL.'
    });
  }
  if (signal?.aborted) throw new Error('ABORTED');

  const resolved = resolveTargetUrl(target);
  const dryRun = !!args['dryRun'];

  if (resolved.requiresApproval && !dryRun) {
    const approved = await approvalGate.requestApproval(
      'Open Command Prompt',
      resolved.resolvedTarget,
      'HIGH_RISK',
      resolved.reason ?? 'Opening Command Prompt requires explicit approval.',
      source,
      source === 'voice' ? 10 : undefined,
    );
    if (approved) {
      resolved.allowed = true;
      resolved.reason = undefined;
    }
  }

  securityAuditLogger.openAppAttempt(
    resolved.requestedTarget,
    resolved.resolvedTarget,
    resolved.allowed,
    source,
    resolved.reason,
  );

  if (!resolved.allowed) {
    return JSON.stringify({
      success: false,
      target,
      resolvedTarget: resolved.resolvedTarget,
      dryRun,
      error: resolved.reason ?? 'Target rejected by open_app policy.'
    });
  }

  if (dryRun) {
    return JSON.stringify({
      success: true,
      target,
      resolvedTarget: resolved.resolvedTarget,
      dryRun: true
    });
  }

  return openTarget(target, resolved.resolvedTarget);
}

export default { execute };
