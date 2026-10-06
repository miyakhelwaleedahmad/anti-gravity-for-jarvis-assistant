/**
 * security/riskEngine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One decision for each concrete tool call — run it, ask for approval, or
 * refuse — from the tool's metadata, its arguments, the session level and the
 * user's policy (docs/upgrade/PERMISSION_MODEL.md).
 *
 * The registry calls it after its existing checks (dispatch floor, argument
 * validation); the controllers keep their own checks. It adds a decision on
 * top and never lets a call through that those checks would refuse.
 */

import * as os from 'os';
import * as path from 'path';
import type { RiskTier } from '../core/toolRegistryV2.js';
import { permissionManager, type RiskLevel as CommandClass } from './permissionManager.js';
import { validateDeveloperCommand } from '../tools/terminalTool.js';
import { resolveTargetUrl } from '../skills/automation/skill.js';
import { isSecurityService } from '../control/adminController.js';
import { approvedFolders } from '../control/fileController.js';
import { isForeignWindowsAbsolute, isPathInside, isProtectedSystemPath } from '../core/workspaceRoot.js';
import { isEnvFile } from './workspacePathPolicy.js';

export interface RiskAssessment {
  tool: string;
  action?: string;
  target?: string;
  level: RiskTier;
  /** Why the level is what it is, for logs and approval requests. */
  reasons: string[];
  /** Refused whatever the session or approval, with the reason. */
  refused?: string;
  /** Session level the call needs before approval is offered. */
  needsSession: number;
}

/**
 * `session` (default): a level-2+ action needs full control mode, as before.
 * `ask`: without full control mode, JARVIS asks to approve each such action.
 */
export type Level2Policy = 'session' | 'ask';

export type RiskDecision =
  | { outcome: 'allow' }
  | { outcome: 'approve'; grantsLevel: number }
  | { outcome: 'deny'; code: 'PERMISSION_DENIED' | 'RISK_REFUSED'; message: string };

export function level2Policy(env: Record<string, string | undefined> = process.env): Level2Policy {
  return env['JARVIS_LEVEL2_POLICY']?.trim().toLowerCase() === 'ask' ? 'ask' : 'session';
}

const COMMAND_CLASS_LEVEL: Record<CommandClass, RiskTier> = {
  SAFE_READ_ONLY: 0,
  LOW_RISK: 1,
  MEDIUM_RISK: 2,
  HIGH_RISK: 3,
  CRITICAL_RISK: 4,
};

/** Read-only git commands run_command allows. */
const READ_ONLY_GIT = /^git\s+(status|diff|log|show|branch)\b/i;

/** Deletes a folder and everything in it (cmd and PowerShell spellings). */
const TREE_DELETE = /\b(?:rd|rmdir|del|erase)\b[^\n]*\s\/s\b|\b(?:remove-item|ri|rm|rmdir|del)\b[^\n]*\s-r(?:ecurse)?\b|\brm\s+-[a-z]*r/i;

/**
 * Shell commands whose effect is hard or impossible to undo: level 4. The
 * command classes rate most of these HIGH_RISK, the same as `echo`.
 */
const CRITICAL_COMMANDS: ReadonlyArray<readonly [RegExp, string]> = [
  [TREE_DELETE, 'deletes a folder and everything in it'],
  [/\breg(?:\.exe)?\s+(?:import|restore|load|unload)\b/i, 'changes the Windows registry'],
  [/\breg(?:\.exe)?\s+(?:add|delete|copy)\b[^\n]*\b(?:hklm|hkcr|hku|hkey_local_machine|hkey_classes_root|hkey_users)\b/i, 'changes system-wide registry settings'],
  [/\b(?:set|new|remove|rename|clear)-item(?:property)?\b[^\n]*(?:\b(?:hklm|hkcr|hku):|registry::)/i, 'changes system-wide registry settings'],
  [/\bbcdedit\b/i, 'changes boot settings'],
  [/\b(?:vssadmin|wbadmin)\b[^\n]*\bdelete\b|\bshadowcopy\b[^\n]*\bdelete\b/i, 'deletes backups or restore points'],
  [/\b(?:clear-disk|initialize-disk|format-volume|remove-partition)\b/i, 'erases a disk'],
  [/\bcipher\b[^\n]*\s\/w\b/i, 'overwrites free disk space'],
  [/\btakeown\b|\b(?:icacls|cacls)\b[^\n]*\s\/(?:grant|deny|remove|setowner|reset|inheritance|restore)\b/i, 'changes file ownership or permissions'],
  [/\bset-executionpolicy\b/i, 'changes the script security policy'],
  [/\bschtasks\b[^\n]*\s\/create\b|\bregister-scheduledtask\b/i, 'creates a scheduled task'],
  [/\bnet\s+(?:user|localgroup)\b[^\n]*\s\/(?:add|delete)\b|\b(?:new|remove)-localuser\b|\badd-localgroupmember\b/i, 'changes user accounts'],
];

/** A drive, a user profile or a Windows system folder, as written in a command. */
function namesCriticalFolder(command: string): boolean {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((t) => t.replace(/^["']|["']$/g, '').replace(/[\\/]\*(\.\*)?$/, ''))
    .some((t) => /^[a-z]:[\\/]?$/i.test(t) || t === '/' || /^~[\\/]?$/.test(t)
      || /^(?:\$home|\$env:(?:userprofile|systemroot|windir)|%(?:userprofile|systemroot|windir)%)[\\/]?$/i.test(t)
      || /^[a-z]:[\\/]users(?:[\\/][^\\/]+)?[\\/]?$/i.test(t)
      || isProtectedSystemPath(t));
}

/** Files FileController.writeFile asks to approve before writing. */
const SENSITIVE_FILE = /\.(env|ts|js|json|py)$|package\.json$|tsconfig/i;

export function callLabel(tool: string, action?: string): string {
  return action ? `${tool} ${action}` : tool;
}

function text(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? (args[key] as string).trim() : '';
}

function isInside(root: string, candidate: string): boolean {
  if (!candidate || isProtectedSystemPath(candidate) || isForeignWindowsAbsolute(candidate)) return false;
  return isPathInside(root, path.resolve(root, candidate));
}

function samePath(a: string, b: string): boolean {
  return !!b && path.resolve(a) === path.resolve(b);
}

export function assessRisk(call: { tool: string; args: Record<string, unknown>; baseRisk: RiskTier }): RiskAssessment {
  const { tool, args } = call;
  const action = text(args, 'action').toLowerCase() || undefined;
  const target = text(args, 'target') || text(args, 'path') || text(args, 'command')
    || text(args, 'url') || text(args, 'file_path') || undefined;
  let level: RiskTier = call.baseRisk;
  const reasons = [`${callLabel(tool, action)} is risk ${call.baseRisk} in its metadata`];
  let refused: string | undefined;
  let needsSession: number | undefined;
  // The level of run_command, temp writes and YouTube tabs comes from the
  // arguments, as the controllers already treat them; everywhere else an
  // argument can only raise it.
  const set = (to: RiskTier, why: string) => { level = to; reasons.push(why); };
  const raise = (to: RiskTier, why: string) => { if (to > level) set(to, why); };

  switch (tool) {
    case 'run_command': {
      const command = text(args, 'command');
      const dev = validateDeveloperCommand(command);
      if (!dev.allowed) refused = dev.reason;
      else set(READ_ONLY_GIT.test(command) ? 0 : 1, 'allow-listed developer command');
      break;
    }
    case 'control_system': {
      if (action === 'shell' || action === 'powershell') {
        const command = text(args, 'target');
        const assessment = permissionManager.assessRisk(command);
        if (assessment.isBlocked) {
          refused = assessment.reason;
          set(4, 'critical command');
        } else {
          raise(COMMAND_CLASS_LEVEL[assessment.riskLevel], `command class ${assessment.riskLevel}`);
          const critical = CRITICAL_COMMANDS.find(([pattern]) => pattern.test(command));
          if (critical) raise(4, critical[1]);
          if (TREE_DELETE.test(command) && namesCriticalFolder(command)) {
            refused = 'JARVIS does not delete a drive, a user profile or a Windows system folder.';
          }
        }
      }
      if (action?.endsWith('_service') && isSecurityService(text(args, 'target'))) {
        refused = `JARVIS does not ${action.replace('_service', '')} the security service "${text(args, 'target')}".`;
        set(4, 'security service');
      }
      break;
    }
    case 'control_file': {
      const target = text(args, 'path');
      // The same tests FileController.writeFile makes: a .txt file in the temp
      // folder needs no full control mode; source and config files need approval.
      if (action === 'write' && path.extname(target).toLowerCase() === '.txt'
        && isInside(path.resolve(os.tmpdir()), path.resolve(target))) {
        set(1, 'text file in the temp folder');
      } else if (action === 'write' && SENSITIVE_FILE.test(target)) {
        raise(3, 'source code or configuration file');
      }
      if ((action === 'delete' || action === 'delete_folder') && approvedFolders().some((f) => samePath(f, target))) {
        raise(4, 'deletes a whole approved folder');
      }
      break;
    }
    case 'write_file':
      if (isEnvFile(text(args, 'filePath'))) raise(3, '.env files hold keys');
      break;
    case 'open_app': {
      // The skill returns before launching anything when dryRun is set.
      if (args['dryRun']) {
        set(0, 'dry run: resolves the target and opens nothing');
        break;
      }
      const resolved = resolveTargetUrl(text(args, 'target'));
      if (resolved.requiresApproval) {
        raise(3, resolved.reason ?? 'target needs approval');
        needsSession = 0; // approval alone, as open_app always required
      }
      break;
    }
    case 'control_browser': {
      if (action === 'close' && /^(about:blank)?$|youtube/i.test(text(args, 'target'))) {
        set(1, 'closing a YouTube or blank tab');
      }
      break;
    }
    case 'enable_full_control_session':
      needsSession = 0; // this call is how full control mode is turned on
      break;
  }

  return {
    tool,
    ...(action ? { action } : {}),
    ...(target ? { target: target.slice(0, 160) } : {}),
    level,
    reasons,
    ...(refused ? { refused } : {}),
    needsSession: needsSession ?? (level >= 2 ? 2 : 0),
  };
}

/**
 * `floor` is the tool's dispatch floor (`requiredLevel`). Under policy `ask`
 * the registry lets a call below its floor reach this point, so that an
 * approval can stand in for full control mode.
 */
export function decide(
  a: RiskAssessment,
  ctx: { sessionLevel: number; policy: Level2Policy; floor?: number },
): RiskDecision {
  if (a.refused) {
    return { outcome: 'deny', code: 'RISK_REFUSED', message: `Refused by safety policy: ${a.refused}` };
  }
  const needs = Math.max(a.needsSession, ctx.floor ?? 0);
  if (ctx.sessionLevel < needs) {
    return ctx.policy === 'ask'
      ? { outcome: 'approve', grantsLevel: Math.min(needs, 2) }
      : {
          outcome: 'deny',
          code: 'PERMISSION_DENIED',
          message: `${callLabel(a.tool, a.action)} needs full control mode (risk level ${a.level}).`,
        };
  }
  return a.level >= 3 ? { outcome: 'approve', grantsLevel: 0 } : { outcome: 'allow' };
}
