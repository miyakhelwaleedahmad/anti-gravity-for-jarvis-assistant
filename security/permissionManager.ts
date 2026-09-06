/**
 * security/permissionManager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Classifies commands into risk categories and enforces access control.
 * Replaces the original 2-string blocklist with structured risk detection.
 *
 * Risk levels (ascending danger):
 *   SAFE_READ_ONLY  → Always allowed, no approval needed
 *   LOW_RISK        → Allowed, logged
 *   MEDIUM_RISK     → Allowed, logged with warning
 *   HIGH_RISK       → Requires explicit approval before execution
 *   CRITICAL_RISK   → Blocked by default; never auto-executed
 */

import { securityAuditLogger } from './securityAuditLogger.js';

export type RiskLevel =
  | 'SAFE_READ_ONLY'
  | 'LOW_RISK'
  | 'MEDIUM_RISK'
  | 'HIGH_RISK'
  | 'CRITICAL_RISK';

export interface RiskAssessment {
  riskLevel: RiskLevel;
  reason: string;
  requiresApproval: boolean;
  isBlocked: boolean;
}

// ─── Safe allow-list: always permitted without approval ───────────────────────
const SAFE_READ_ONLY_COMMANDS = new Set([
  'dir',
  'ls',
  'type',
  'cat',
  'git status',
  'git diff',
]);

// ─── Patterns that indicate CRITICAL risk (blocked by default) ────────────────
const CRITICAL_PATTERNS: readonly RegExp[] = [
  // Disk / storage destruction
  /format\s+[a-z]:/i,
  /diskpart/i,
  /dd\s+if=/i,
  // Credential dumping
  /mimikatz/i,
  /sekurlsa/i,
  /lsadump/i,
  /procdump\s+.*lsass/i,
  /comsvcs.*minidump/i,
  // Full registry destruction
  /reg\s+delete\s+hklm\\system/i,
  /reg\s+delete\s+hklm\\software\\microsoft\\windows\s+nt/i,
  // Complete recursive deletion of system-critical paths
  /remove-item\s+.*-recurse.*c:\\windows/i,
  /rd\s+\/s\s+\/q\s+c:\\windows/i,
  /del\s+\/s\s+\/f\s+.*c:\\windows/i,
  // Disable core security services permanently
  /sc\s+config\s+windefend\s+start=\s*disabled/i,
  /set-mppreference\s+.*-disablerealtimemonitoring\s+\$true/i,
  /netsh\s+advfirewall\s+set\s+allprofiles\s+state\s+off/i,
];

// ─── Patterns that indicate HIGH risk (require approval) ──────────────────────
const HIGH_RISK_PATTERNS: readonly RegExp[] = [
  // File/directory deletion
  /\bdel\b|\bdelete\b/i,
  /\brm\s/i,
  /remove-item/i,
  /rmdir/i,
  /rd\s+\/s/i,
  // Shutdown / restart
  /shutdown/i,
  /restart-computer/i,
  /stop-computer/i,
  // Process killing
  /taskkill/i,
  /kill\s+\-/i,
  /stop-process/i,
  // Registry modifications
  /\breg\s+(add|delete|import|export|load|unload)\b/i,
  /set-itemproperty.*hklm/i,
  /new-itemproperty.*hklm/i,
  // Permission changes
  /icacls/i,
  /cacls/i,
  /takeown/i,
  /set-acl/i,
  /attrib\s+.*[-+][rhs]/i,
  // Network exposure
  /netsh\s+portproxy/i,
  /enable-netfirewallrule/i,
  /disable-netfirewallrule/i,
  /new-netfirewallrule/i,
  // Service manipulation
  /sc\s+(start|stop|config|delete)/i,
  /start-service/i,
  /stop-service/i,
  /restart-service/i,
  // Writing to system folders
  />\s*['""]?c:\\windows\\/i,
  /copy\s+.*c:\\windows\\/i,
  /move\s+.*c:\\windows\\/i,
  /xcopy\s+.*c:\\windows\\/i,
  />\s*['""]?c:\\program files\\/i,
  />\s*['""]?c:\\system32\\/i,
  // Schtasks / scheduled task creation
  /schtasks\s+\/create/i,
  // User account management
  /net\s+user\s+.+\s+\/add/i,
  /net\s+localgroup\s+administrators/i,
  /add-localGroupmember/i,
  // Encoded / obfuscated PowerShell
  /powershell.*-enc\b/i,
  /powershell.*-encodedcommand/i,
  /invoke-expression/i,
  /iex\s*[(\[]/i,
  /downloadstring/i,
  /webclient.*download/i,
];

// ─── Patterns that indicate MEDIUM risk (allowed but logged) ──────────────────
const MEDIUM_RISK_PATTERNS: readonly RegExp[] = [
  /^(npm|pnpm|npx|python|python3|node|tsx)(\s|$)/i,
  /npm\s+(install|uninstall|update|publish|run\s+build)/i,
  /pnpm\s+(install|remove|update|publish|run\s+build)/i,
  /pip\s+(install|uninstall)/i,
  /git\s+(commit|push|merge|rebase|reset|clean)/i,
  /powershell/i,
  /cmd\s*\/c/i,
  /start\s+cmd/i,
  /invoke-webrequest/i,
  /curl\b/i,
  /wget\b/i,
  /\bchoco\b/i,
  /\bscoop\b/i,
];

export class PermissionManager {
  /**
   * Assess the risk level of a command string.
   * Fails CLOSED: unknown patterns default to HIGH_RISK.
   */
  public assessRisk(command: string): RiskAssessment {
    const lower = command.trim().toLowerCase();
    const base = lower.split(/\s+/)[0];

    // 1. Critical check (always blocked)
    for (const pattern of CRITICAL_PATTERNS) {
      if (pattern.test(command)) {
        return {
          riskLevel: 'CRITICAL_RISK',
          reason: `Command matches critical danger pattern: ${pattern.toString()}`,
          requiresApproval: false,
          isBlocked: true,
        };
      }
    }

    // 2. Safe read-only check (always allowed)
    if (SAFE_READ_ONLY_COMMANDS.has(base) || SAFE_READ_ONLY_COMMANDS.has(lower)) {
      return {
        riskLevel: 'SAFE_READ_ONLY',
        reason: 'Command is on the safe read-only allowlist.',
        requiresApproval: false,
        isBlocked: false,
      };
    }

    // 3. High risk check (requires approval)
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(command)) {
        return {
          riskLevel: 'HIGH_RISK',
          reason: `Command matches high-risk pattern: ${pattern.toString()}`,
          requiresApproval: true,
          isBlocked: false,
        };
      }
    }

    // 4. Medium risk check (allowed, logged with warning)
    for (const pattern of MEDIUM_RISK_PATTERNS) {
      if (pattern.test(command)) {
        return {
          riskLevel: 'MEDIUM_RISK',
          reason: `Command matches medium-risk pattern: ${pattern.toString()}`,
          requiresApproval: false,
          isBlocked: false,
        };
      }
    }

    // 5. Known safe base commands → LOW_RISK
    const LOW_RISK_BASES = new Set([
      'git', 'tsc', 'eslint', 'jest', 'mocha',
      'ping', 'curl', 'nslookup', 'tracert',
    ]);
    if (LOW_RISK_BASES.has(base)) {
      return {
        riskLevel: 'LOW_RISK',
        reason: 'Command base is a known low-risk development tool.',
        requiresApproval: false,
        isBlocked: false,
      };
    }

    // 6. Unknown command → HIGH_RISK (fail closed)
    return {
      riskLevel: 'HIGH_RISK',
      reason: `Unknown command "${base}" — defaulting to HIGH_RISK (fail-closed policy).`,
      requiresApproval: true,
      isBlocked: false,
    };
  }

  /**
   * Legacy compatibility: simple blocked check.
   * Used by controllers that only check isBlocked.
   */
  public isBlocked(command: string): boolean {
    const assessment = this.assessRisk(command);
    if (assessment.isBlocked) {
      securityAuditLogger.denied(command, assessment.riskLevel, assessment.reason);
    }
    return assessment.isBlocked;
  }

  /**
   * Full async permission check.
   * Returns false for CRITICAL_RISK (no appeal).
   * Returns approval gate result for HIGH_RISK.
   * Returns true for MEDIUM/LOW/SAFE.
   */
  public async checkPermission(action: string, command: string): Promise<boolean> {
    const assessment = this.assessRisk(command);

    if (assessment.isBlocked) {
      console.error(`[PermissionManager] ❌ BLOCKED (${assessment.riskLevel}): ${command}`);
      console.error(`[PermissionManager] Reason: ${assessment.reason}`);
      securityAuditLogger.denied(command, assessment.riskLevel, assessment.reason);
      return false;
    }

    if (assessment.requiresApproval) {
      // Import lazily to avoid circular dependency
      const { approvalGate } = await import('./approvalGate.js');
      return approvalGate.requestApproval(action, command, assessment.riskLevel, assessment.reason);
    }

    securityAuditLogger.allowed(command, assessment.riskLevel);
    return true;
  }
}

export const permissionManager = new PermissionManager();
