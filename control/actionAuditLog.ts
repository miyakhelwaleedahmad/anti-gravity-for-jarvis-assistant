/**
 * control/actionAuditLog.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Logs control executions and safety events to logs/jarvis-actions.jsonl
 */

import * as fs from 'fs';
import { redactDeep } from '../security/redactor.js';
import * as path from 'path';
import { dataRoot } from '../core/workspaceRoot.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AuditLogEntry {
  timestamp: string;
  /** The request's trace id, as in the request trace (data/logs/jarvis.*.jsonl), when there is one (phase A6). */
  traceId?: string;
  /** The owner's request, cut short; the action name outside a request (phase A6). */
  userCommand: string;
  /** Inside a background agent: which agent (its words are `userCommand`; no foreground trace id) (phase A6). */
  agentPath?: string;
  normalizedIntent: string;
  action: string;
  target: string;
  permissionLevel: number;
  riskLevel: 'safe' | 'medium' | 'high' | 'blocked';
  allowed: boolean;
  /** "success" means the controller returned; whether it had the effect is checked afterwards. */
  result: 'success' | 'failure' | 'blocked';
  /** On a success: the effect check is still to come, in a later `verification` line (phase A6). */
  verified?: 'pending';
  durationMs: number;
  error?: string | null;
}

/** The registry's check of a call's effect, joined to the request by its trace id (phase A6, TRA-13). */
export interface VerificationLogEntry {
  traceId?: string;
  /** Set when an agent ran the action; then traceId is left out (review F10). */
  agentPath?: string;
  tool: string;
  status: 'verified' | 'failed';
  evidence: string;
}

export class ActionAuditLog {
  private logPath: string;

  constructor() {
    this.logPath = path.join(dataRoot(path.resolve(__dirname, '..')), 'logs', 'jarvis-actions.jsonl');
    
    // Ensure logs directory exists
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  public async log(entry: Omit<AuditLogEntry, 'timestamp'>): Promise<void> {
    const fullEntry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      ...entry
    };

    await this.append(fullEntry);
  }

  /** A `verification` line: the check of an action's effect (phase A6). */
  public async logVerification(entry: VerificationLogEntry): Promise<void> {
    await this.append({ timestamp: new Date().toISOString(), type: 'verification', ...entry });
  }

  private async append(entry: object): Promise<void> {
    try {
      await fs.promises.appendFile(this.logPath, JSON.stringify(redactDeep(entry)) + '\n', 'utf-8');
    } catch (err) {
      console.error('[ActionAuditLog] Failed to write to audit log:', err);
    }
  }
}

export const actionAuditLog = new ActionAuditLog();
