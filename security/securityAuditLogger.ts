/**
 * security/securityAuditLogger.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Local-only security audit logger.
 * Writes security events to: data/logs/security_audit.log
 * Never logs secrets, API keys, or credentials.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Resolve project root (two levels up from security/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const AUDIT_LOG_PATH = path.join(PROJECT_ROOT, 'data', 'logs', 'security_audit.log');

export type SecurityEventType =
  | 'COMMAND_ALLOWED'
  | 'COMMAND_DENIED'
  | 'OPEN_APP_ATTEMPT'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_TIMEOUT'
  | 'RISK_ASSESSED'
  | 'FULL_CONTROL_SESSION';

export interface SecurityEvent {
  eventType: SecurityEventType;
  timestamp: string;
  action?: string;
  toolName?: string;
  command?: string;
  riskLevel?: string;
  reason?: string;
  approved?: boolean;
  requestedTarget?: string;
  resolvedTarget?: string;
  allowed?: boolean;
  source?: string;
  expiresAt?: string;
}

function sanitize(value: string | undefined): string {
  if (!value) return '';
  // Strip anything that looks like a secret/key (basic heuristic)
  return value
    .replace(/sk-[A-Za-z0-9\-_]{10,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]{10,}/g, 'Bearer [REDACTED]')
    .replace(/api[_\-]?key[=:]\s*["']?[A-Za-z0-9\-._~+/=]{8,}["']?/gi, 'api_key=[REDACTED]');
}

class SecurityAuditLogger {
  private ensureLogDir(): void {
    const logDir = path.dirname(AUDIT_LOG_PATH);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  public log(event: SecurityEvent): void {
    try {
      this.ensureLogDir();
      const line = JSON.stringify({
        ...event,
        command: sanitize(event.command),
        reason: sanitize(event.reason),
      });
      fs.appendFileSync(AUDIT_LOG_PATH, line + '\n', 'utf8');
    } catch {
      // Audit logging must never crash the application
    }
  }

  public allowed(command: string, riskLevel: string, toolName?: string): void {
    this.log({
      eventType: 'COMMAND_ALLOWED',
      timestamp: new Date().toISOString(),
      command,
      riskLevel,
      toolName,
    });
  }

  public denied(command: string, riskLevel: string, reason: string, toolName?: string): void {
    this.log({
      eventType: 'COMMAND_DENIED',
      timestamp: new Date().toISOString(),
      command,
      riskLevel,
      reason,
      toolName,
    });
  }

  public approvalRequested(action: string, command: string, riskLevel: string): void {
    this.log({
      eventType: 'APPROVAL_REQUESTED',
      timestamp: new Date().toISOString(),
      action,
      command,
      riskLevel,
    });
  }

  public approvalGranted(action: string, command: string): void {
    this.log({
      eventType: 'APPROVAL_GRANTED',
      timestamp: new Date().toISOString(),
      action,
      command,
      approved: true,
    });
  }

  public approvalDenied(action: string, command: string, reason: string): void {
    this.log({
      eventType: 'APPROVAL_DENIED',
      timestamp: new Date().toISOString(),
      action,
      command,
      reason,
      approved: false,
    });
  }

  public approvalTimeout(action: string, command: string): void {
    this.log({
      eventType: 'APPROVAL_TIMEOUT',
      timestamp: new Date().toISOString(),
      action,
      command,
      reason: 'User did not respond within timeout — denied by default',
      approved: false,
    });
  }

  public openAppAttempt(
    requestedTarget: string,
    resolvedTarget: string,
    allowed: boolean,
    source: string,
    reason?: string,
  ): void {
    this.log({
      eventType: 'OPEN_APP_ATTEMPT',
      timestamp: new Date().toISOString(),
      requestedTarget,
      resolvedTarget,
      allowed,
      source,
      reason,
    });
  }

  public fullControlSession(action: string, approved: boolean, reason: string, expiresAt?: number): void {
    this.log({
      eventType: 'FULL_CONTROL_SESSION',
      timestamp: new Date().toISOString(),
      action,
      approved,
      reason,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
    });
  }
}

export const securityAuditLogger = new SecurityAuditLogger();
