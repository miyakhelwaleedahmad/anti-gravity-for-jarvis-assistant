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
  /**
   * "success" means the controller returned; whether it had the effect is checked afterwards.
   * "unknown": it was stopped part way, so part of it may have run (B4).
   */
  result: 'success' | 'failure' | 'blocked' | 'unknown';
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

/** Who a call belongs to, captured when it started (core/outcomeUnknown.ts). */
interface CallIdentity {
  callId: string;
  traceId?: string;
  agentPath?: string;
  userCommand: string;
}

/** JARVIS stopped waiting for a tool that may still finish (B4): the outcome is unknown. */
export interface OutcomeUnknownLogEntry extends CallIdentity {
  tool: string;
  /** Wall-clock time from the call's start until JARVIS stopped waiting. */
  waitedMs: number;
  /** Why it was stopped: its time budget ran out, or its caller cancelled it. */
  reason: 'budget' | 'cancelled';
}

/** A tool JARVIS had stopped waiting for has ended (B4): the same call, a later line. */
export interface LateResultLogEntry extends CallIdentity {
  tool: string;
  /** When the tool really ended (ISO time). */
  completedAt: string;
  /** From the call's start until the tool ended. */
  durationMs: number;
  result: 'success' | 'failure';
  /** The tool's result, cut short. */
  detail: string;
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

  /**
   * An `outcome_unknown` line: JARVIS stopped waiting for the call (B4). Never
   * rewritten. True once it is written; false when the write failed (reported).
   */
  public async logOutcomeUnknown(entry: OutcomeUnknownLogEntry): Promise<boolean> {
    return this.append({ timestamp: new Date().toISOString(), type: 'outcome_unknown', ...entry });
  }

  /** A `late_result` line: the same call, ended after JARVIS stopped waiting (B4). */
  public async logLateResult(entry: LateResultLogEntry): Promise<void> {
    await this.append({ timestamp: new Date().toISOString(), type: 'late_result', ...entry, detail: entry.detail.slice(0, 200) });
  }

  /** True once the line is written; false when the write failed (reported here). */
  private async append(entry: object): Promise<boolean> {
    try {
      await fs.promises.appendFile(this.logPath, JSON.stringify(redactDeep(entry)) + '\n', 'utf-8');
      return true;
    } catch (err) {
      console.error('[ActionAuditLog] Failed to write to audit log:', err);
      return false;
    }
  }
}

export const actionAuditLog = new ActionAuditLog();
