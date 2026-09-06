/**
 * core/commandSafety.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2 — Security & Permission Architecture
 *
 * Multi-layer command safety gate that sits BEFORE PermissionManager.
 * Evaluation order (short-circuit on first match):
 *   1. User allowlist  — trusted commands that always pass (user-defined)
 *   2. Developer allowlist — hardcoded dev-tooling safe commands
 *   3. Trusted command profiles — named sets (e.g. "developer", "admin")
 *   4. OS-specific policy overrides (Windows vs POSIX differ on rm, del, etc.)
 *   5. Dynamic policies — runtime overrides set by orchestrator/skills
 *   6. Read-only exact / prefix matching (original legacy logic, preserved)
 *   7. Explicit user intent guard (hallucination check)
 *
 * All decisions are loggable via the optional SecurityAuditLogger.
 */

import * as os from 'os';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  isSafe: boolean;
  reason?: string;
  source?: AllowlistSource;
}

export type AllowlistSource =
  | 'user_allowlist'
  | 'developer_allowlist'
  | 'trusted_profile'
  | 'os_policy'
  | 'dynamic_policy'
  | 'read_only'
  | 'explicit_intent'
  | 'denied';

export type TrustedProfile = 'developer' | 'admin' | 'readonly' | 'automation';

export interface DynamicPolicy {
  id: string;
  pattern: RegExp;
  isSafe: boolean;
  reason: string;
  expiresAt?: number; // epoch ms; undefined = permanent
  source: 'orchestrator' | 'skill' | 'user';
}

// ─── OS Detection ─────────────────────────────────────────────────────────────

const IS_WINDOWS = os.platform() === 'win32';

// ─── Developer Allowlist ──────────────────────────────────────────────────────
// Hardcoded set of commands that are always safe in a dev context.
// This is the "developer allowlist" requirement from the roadmap.

const DEVELOPER_ALLOWLIST = new Set([
  // node/npm/pnpm tooling
  'tsc', 'eslint', 'jest', 'mocha', 'ts-node', 'tsx', 'node', 'nodemon',
  'npm', 'pnpm', 'npx', 'yarn',
  // git (read-only subset)
  'git status', 'git diff', 'git log', 'git show', 'git stash list',
  'git branch', 'git remote -v', 'git fetch',
  // system info (read-only)
  'dir', 'ls', 'ls -la', 'ls -l', 'ls -a',
  'type', 'cat', 'echo',
  'ping', 'nslookup', 'tracert', 'ipconfig', 'ifconfig',
  'whoami', 'hostname',
  'tasklist', 'ps', 'ps aux',
  'netstat',
  // python tools
  'python --version', 'python3 --version',
  'pip list', 'pip show',
]);

// Prefix patterns that are always developer-safe (read/list operations)
const DEVELOPER_ALLOWLIST_PREFIXES: readonly RegExp[] = [
  /^git\s+(status|diff|log|show|branch|remote|fetch|stash list)\b/i,
  /^npm\s+(list|ls|outdated|audit|help|version)\b/i,
  /^pnpm\s+(list|ls|outdated|audit|help)\b/i,
  /^tsc\b/i,
  /^eslint\b/i,
  /^jest\b/i,
  /^mocha\b/i,
  /^ping\s+\S+/i,
  /^nslookup\s+\S+/i,
  /^type\s+\S+/i,        // Windows: type file.txt
  /^cat\s+\S+/i,          // POSIX: cat file
];

// ─── Trusted Profiles ─────────────────────────────────────────────────────────
// Named command sets that are enabled as a batch. A user with "developer"
// profile active gets the union of read-only + developer tooling.

const TRUSTED_PROFILE_COMMANDS: Record<TrustedProfile, readonly RegExp[]> = {
  readonly: [
    /^dir\b/i, /^ls\b/i, /^type\b/i, /^cat\b/i,
    /^git\s+(status|diff|log)\b/i,
    /^echo\b/i, /^ping\b/i, /^whoami\b/i,
  ],
  developer: [
    /^(tsc|eslint|jest|mocha|tsx|ts-node|node)\b/i,
    /^(npm|pnpm|npx|yarn)\s+(install|run|build|test|lint)\b/i,
    /^git\s+(commit|push|pull|checkout|merge|rebase|reset --soft|stash)\b/i,
    /^python[3]?\s+/i,
    /^pip\s+(install|uninstall)\b/i,
    /^taskkill\s+\/im\s+node/i,    // kill hung node process — dev-common
    /^taskkill\s+\/im\s+tsc/i,
  ],
  automation: [
    /^(taskkill|kill)\b/i,
    /^(start|stop)\s+\S+/i,
    /^(sc\s+start|sc\s+stop)\b/i,
  ],
  admin: [
    // Admin profile allows everything not in CRITICAL. Handled by PermissionManager.
    /.*/,
  ],
};

// ─── OS-Specific Policy Overrides ─────────────────────────────────────────────
// Windows and POSIX behave differently for process kill, deletion, etc.
// These overrides ensure the right patterns are matched per platform.

const OS_SAFE_PATTERNS: readonly RegExp[] = IS_WINDOWS
  ? [
      /^tasklist\b/i,             // read-only on Windows
      /^wmic\s+process\s+list/i,  // read-only on Windows
      /^ipconfig\b/i,
      /^netstat\b/i,
      /^systeminfo\b/i,
    ]
  : [
      /^ps\s*(aux)?\b/i,
      /^top\b/i,
      /^df\b/i,
      /^du\b/i,
      /^netstat\b/i,
      /^ifconfig\b/i,
    ];

// ─── CommandSafetyLayer ───────────────────────────────────────────────────────

export class CommandSafetyLayer {
  // ── Active state ──────────────────────────────────────────────────────────
  private _activeProfiles: Set<TrustedProfile> = new Set(['readonly']);
  private _userAllowlist: Set<string> = new Set();
  private _dynamicPolicies: Map<string, DynamicPolicy> = new Map();

  // ── Legacy read-only lists (preserved for backward compatibility) ──────────
  private readonly SAFE_READ_ONLY_EXACT = new Set(['dir', 'ls', 'git status', 'git diff']);
  private readonly SAFE_READ_ONLY_PREFIXES = [/^type\s+\S+/i, /^cat\s+\S+/i];

  // ── Profile management ────────────────────────────────────────────────────

  /**
   * Enable a trusted command profile.
   * Profiles stack — enabling 'developer' does NOT disable 'readonly'.
   */
  enableProfile(profile: TrustedProfile): void {
    this._activeProfiles.add(profile);
    console.log(`[CommandSafety] ✅ Profile enabled: ${profile}`);
  }

  disableProfile(profile: TrustedProfile): void {
    if (profile === 'readonly') return; // readonly is always on
    this._activeProfiles.delete(profile);
    console.log(`[CommandSafety] 🛡️ Profile disabled: ${profile}`);
  }

  getActiveProfiles(): TrustedProfile[] {
    return [...this._activeProfiles];
  }

  // ── User allowlist management ─────────────────────────────────────────────

  /**
   * Add a command to the user-defined allowlist.
   * This is a permanent (in-memory) override that survives the session.
   * Use this to whitelist specific commands like "taskkill /im myapp.exe".
   */
  addToUserAllowlist(command: string): void {
    this._userAllowlist.add(command.trim().toLowerCase());
    console.log(`[CommandSafety] 📋 User allowlist: added "${command.trim()}"`);
  }

  removeFromUserAllowlist(command: string): void {
    this._userAllowlist.delete(command.trim().toLowerCase());
  }

  getUserAllowlist(): string[] {
    return [...this._userAllowlist];
  }

  // ── Dynamic policy management ─────────────────────────────────────────────

  /**
   * Register a dynamic security policy at runtime.
   * Policies with an expiresAt are auto-pruned on next evaluation.
   *
   * Example — allow taskkill during a dev session (30 min):
   *   commandSafety.addDynamicPolicy({
   *     id: 'dev_taskkill',
   *     pattern: /^taskkill\s+\/im\s+(node|tsc)\.exe/i,
   *     isSafe: true,
   *     reason: 'Developer session: killing node/tsc processes is safe.',
   *     expiresAt: Date.now() + 30 * 60_000,
   *     source: 'user',
   *   });
   */
  addDynamicPolicy(policy: DynamicPolicy): void {
    this._dynamicPolicies.set(policy.id, policy);
    const expStr = policy.expiresAt
      ? ` (expires ${new Date(policy.expiresAt).toLocaleTimeString()})`
      : ' (permanent)';
    console.log(`[CommandSafety] 🔧 Dynamic policy added: "${policy.id}"${expStr}`);
  }

  removeDynamicPolicy(id: string): void {
    this._dynamicPolicies.delete(id);
    console.log(`[CommandSafety] 🗑️ Dynamic policy removed: "${id}"`);
  }

  getDynamicPolicies(): DynamicPolicy[] {
    this._pruneExpiredPolicies();
    return [...this._dynamicPolicies.values()];
  }

  // ── Main validation ───────────────────────────────────────────────────────

  public isExplicitCommand(userIntent: string): boolean {
    const explicitIntentRegex = /\b(run|execute|check|list|show me|test|find|search)\b/i;
    return explicitIntentRegex.test(userIntent);
  }

  /**
   * Validate a command string against the full safety stack.
   * Short-circuits on first safe/unsafe match.
   *
   * @param cmd         - Raw command string to validate
   * @param userIntent  - Natural language intent (for hallucination guard)
   * @param context     - Optional extra context (used by dynamic policies)
   */
  public validateCommand(
    cmd: string,
    userIntent: string,
    context?: Record<string, unknown>,
  ): ValidationResult {
    const trimmedCmd = cmd.trim();
    if (!trimmedCmd) {
      return { isSafe: false, reason: 'Empty command rejected.', source: 'denied' };
    }

    const normalized = trimmedCmd.replace(/\s+/g, ' ').toLowerCase();

    // ── Step 1: Prune expired dynamic policies ─────────────────────────────
    this._pruneExpiredPolicies();

    // ── Step 2: User allowlist (highest priority — user explicitly trusts this) ──
    if (this._userAllowlist.has(normalized)) {
      return {
        isSafe: true,
        reason: `Command is on the user allowlist.`,
        source: 'user_allowlist',
      };
    }

    // ── Step 3: Dynamic policy overrides ──────────────────────────────────
    for (const policy of this._dynamicPolicies.values()) {
      if (policy.pattern.test(trimmedCmd)) {
        return {
          isSafe: policy.isSafe,
          reason: policy.reason,
          source: 'dynamic_policy',
        };
      }
    }

    // ── Step 4: Developer allowlist (exact and prefix) ─────────────────────
    if (DEVELOPER_ALLOWLIST.has(normalized) || DEVELOPER_ALLOWLIST.has(trimmedCmd.toLowerCase())) {
      return {
        isSafe: true,
        reason: 'Command is on the hardcoded developer allowlist.',
        source: 'developer_allowlist',
      };
    }
    for (const prefix of DEVELOPER_ALLOWLIST_PREFIXES) {
      if (prefix.test(trimmedCmd)) {
        return {
          isSafe: true,
          reason: `Command matches developer allowlist prefix: ${prefix}`,
          source: 'developer_allowlist',
        };
      }
    }

    // ── Step 5: Trusted profile check ─────────────────────────────────────
    for (const profile of this._activeProfiles) {
      const profilePatterns = TRUSTED_PROFILE_COMMANDS[profile];
      for (const pattern of profilePatterns) {
        if (pattern.test(trimmedCmd)) {
          return {
            isSafe: true,
            reason: `Command matches trusted profile "${profile}": ${pattern}`,
            source: 'trusted_profile',
          };
        }
      }
    }

    // ── Step 6: OS-specific safe patterns ─────────────────────────────────
    for (const pattern of OS_SAFE_PATTERNS) {
      if (pattern.test(trimmedCmd)) {
        return {
          isSafe: true,
          reason: `Command matches OS-specific safe pattern (${IS_WINDOWS ? 'Windows' : 'POSIX'}): ${pattern}`,
          source: 'os_policy',
        };
      }
    }

    // ── Step 7: Legacy read-only check (backward compat) ──────────────────
    const isReadOnly =
      this.SAFE_READ_ONLY_EXACT.has(normalized) ||
      this.SAFE_READ_ONLY_PREFIXES.some((p) => p.test(trimmedCmd));
    if (isReadOnly) {
      return {
        isSafe: true,
        reason: 'Command is on the legacy read-only allowlist.',
        source: 'read_only',
      };
    }

    // ── Step 8: Explicit user intent guard (hallucination check) ──────────
    if (!this.isExplicitCommand(userIntent)) {
      return {
        isSafe: false,
        reason: 'User intent did not explicitly request system execution (hallucination guard).',
        source: 'denied',
      };
    }

    // ── Step 9: Fallback — not whitelisted, but user was explicit → escalate
    // Let PermissionManager handle the risk assessment. Return isSafe=false
    // with a clear reason so the caller can invoke PermissionManager.
    return {
      isSafe: false,
      reason: 'Command not on any allowlist. Requires PermissionManager assessment.',
      source: 'denied',
    };
  }

  // ── Summary / diagnostics ─────────────────────────────────────────────────

  getSummary(): {
    activeProfiles: TrustedProfile[];
    userAllowlistSize: number;
    dynamicPoliciesActive: number;
    platform: string;
  } {
    return {
      activeProfiles: this.getActiveProfiles(),
      userAllowlistSize: this._userAllowlist.size,
      dynamicPoliciesActive: this._dynamicPolicies.size,
      platform: IS_WINDOWS ? 'windows' : 'posix',
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _pruneExpiredPolicies(): void {
    const now = Date.now();
    for (const [id, policy] of this._dynamicPolicies) {
      if (policy.expiresAt !== undefined && now > policy.expiresAt) {
        this._dynamicPolicies.delete(id);
        console.log(`[CommandSafety] ⏱️ Dynamic policy expired and removed: "${id}"`);
      }
    }
  }
}

export const commandSafety = new CommandSafetyLayer();
