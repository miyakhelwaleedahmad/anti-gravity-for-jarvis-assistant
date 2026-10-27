/**
 * security/openAppPolicy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What `open_app` may open: the website and app allow-lists, the apps that
 * need approval, and the paths, file types and shell characters it refuses.
 * The automation skill opens what this allows; the risk engine rates calls by
 * it. Moved here unchanged from skills/automation/skill.ts (ARCH-04): a skill
 * folder is trusted by its description's hash, not its code, and security
 * policy should not live in the module it governs.
 */

export interface ResolvedOpenTarget {
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
  'mozilla firefox': 'firefox.exe',
  'google chrome': 'chrome.exe',
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
