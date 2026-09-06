/**
 * security/commandValidator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2 — Structured command validation.
 *
 * Evaluation pipeline:
 *   1. commandSafety  — multi-layer allowlist (user / developer / profile / OS / dynamic)
 *   2. permissionManager — risk tier classification (SAFE → CRITICAL)
 *   3. approvalGate  — human-in-the-loop for HIGH_RISK
 *
 * Returns a ValidationResult with:
 *   allowed          — whether execution should proceed
 *   riskLevel        — assessed risk tier
 *   reason           — human-readable explanation
 *   requiresApproval — whether the user was / needs to be prompted
 *   blockedReason    — set when action is hard-blocked
 *   safetySource     — which allowlist layer granted the command (if any)
 */

import { permissionManager, type RiskLevel } from './permissionManager.js';
import { securityAuditLogger } from './securityAuditLogger.js';
import { commandSafety, type AllowlistSource } from '../core/commandSafety.js';

export interface ValidationResult {
  allowed: boolean;
  riskLevel: RiskLevel;
  reason: string;
  requiresApproval: boolean;
  blockedReason?: string;
  safetySource?: AllowlistSource;
}

export class CommandValidator {
  /**
   * Validate a command before execution.
   * Fails CLOSED: empty / unknown / high-risk commands default to denied.
   *
   * @param command    - The raw command string to validate
   * @param toolName   - Caller tool name for audit logging (optional)
   * @param userIntent - Natural language user intent (for hallucination guard in commandSafety)
   */
  public async validate(
    command: string,
    toolName?: string,
    userIntent = '',
  ): Promise<ValidationResult> {
    // ── Guard: empty command ────────────────────────────────────────────────
    if (!command || command.trim().length === 0) {
      const result: ValidationResult = {
        allowed: false,
        riskLevel: 'HIGH_RISK',
        reason: 'Empty command rejected.',
        requiresApproval: false,
        blockedReason: 'Command string was empty or whitespace-only.',
      };
      securityAuditLogger.denied('', 'HIGH_RISK', result.reason, toolName);
      return result;
    }

    // ── Step 1: CommandSafety multi-layer allowlist ─────────────────────────
    // If commandSafety clears it, skip PermissionManager entirely.
    const safetyResult = commandSafety.validateCommand(command, userIntent);
    if (safetyResult.isSafe) {
      securityAuditLogger.allowed(command, 'SAFE_READ_ONLY', toolName);
      return {
        allowed: true,
        riskLevel: 'SAFE_READ_ONLY',
        reason: safetyResult.reason ?? 'Cleared by CommandSafety allowlist.',
        requiresApproval: false,
        safetySource: safetyResult.source,
      };
    }

    // ── Step 2: PermissionManager risk assessment ───────────────────────────
    const assessment = permissionManager.assessRisk(command);

    // Step 2a: Hard block for CRITICAL_RISK — no appeal possible
    if (assessment.isBlocked) {
      securityAuditLogger.denied(command, assessment.riskLevel, assessment.reason, toolName);
      return {
        allowed: false,
        riskLevel: assessment.riskLevel,
        reason: assessment.reason,
        requiresApproval: false,
        blockedReason: `CRITICAL_RISK command is permanently blocked: ${assessment.reason}`,
      };
    }

    // Step 2b: HIGH_RISK → must go through approval gate
    if (assessment.requiresApproval) {
      securityAuditLogger.approvalRequested(
        `Command validation (${toolName ?? 'unknown'})`,
        command,
        assessment.riskLevel,
      );

      const { approvalGate } = await import('./approvalGate.js');
      const approved = await approvalGate.requestApproval(
        `Execute: ${toolName ?? 'Command'}`,
        command,
        assessment.riskLevel,
        assessment.reason,
      );

      if (!approved) {
        securityAuditLogger.denied(command, assessment.riskLevel, 'Approval denied by user', toolName);
        return {
          allowed: false,
          riskLevel: assessment.riskLevel,
          reason: 'User denied approval for this command.',
          requiresApproval: true,
          blockedReason: 'User did not approve the HIGH_RISK command.',
        };
      }

      securityAuditLogger.allowed(command, assessment.riskLevel, toolName);
      return {
        allowed: true,
        riskLevel: assessment.riskLevel,
        reason: 'User explicitly approved this HIGH_RISK command.',
        requiresApproval: true,
      };
    }

    // Step 2c: MEDIUM / LOW / SAFE — allowed, log it
    securityAuditLogger.allowed(command, assessment.riskLevel, toolName);

    if (assessment.riskLevel === 'MEDIUM_RISK') {
      console.warn(
        `[CommandValidator] ⚠️  MEDIUM_RISK command allowed: "${command.slice(0, 80)}"`
      );
    }

    return {
      allowed: true,
      riskLevel: assessment.riskLevel,
      reason: assessment.reason,
      requiresApproval: false,
    };
  }
}

export const commandValidator = new CommandValidator();
