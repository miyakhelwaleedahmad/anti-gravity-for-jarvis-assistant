/**
 * control/actionAuditLog.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Logs control executions and safety events to logs/jarvis-actions.jsonl
 */

import * as fs from 'fs';
import * as path from 'path';
import { dataRoot } from '../core/workspaceRoot.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AuditLogEntry {
  timestamp: string;
  userCommand: string;
  normalizedIntent: string;
  action: string;
  target: string;
  permissionLevel: number;
  riskLevel: 'safe' | 'medium' | 'high' | 'blocked';
  allowed: boolean;
  confirmationRequired: boolean;
  result: 'success' | 'failure' | 'blocked';
  durationMs: number;
  rollbackAvailable: boolean;
  error?: string | null;
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

    try {
      await fs.promises.appendFile(this.logPath, JSON.stringify(fullEntry) + '\n', 'utf-8');
    } catch (err) {
      console.error('[ActionAuditLog] Failed to write to audit log:', err);
    }
  }
}

export const actionAuditLog = new ActionAuditLog();
