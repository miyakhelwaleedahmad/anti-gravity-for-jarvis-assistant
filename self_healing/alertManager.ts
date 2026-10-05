/**
 * self_healing/alertManager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 8 — Alerting System
 *
 * Provides structured, rate-limited alerting for runtime failures and recovery
 * events. Avoids alert storms by:
 *
 *   - Rate-limiting: same alert key silenced for COOLDOWN_MS after first fire
 *   - Severity gating: console.log for INFO, console.warn for WARNING,
 *     console.error for CRITICAL; only CRITICAL+WARNING fire voice alerts
 *   - Alert history: last 200 alerts kept in memory for digest/reporting
 *   - Voice delivery: integrates with nodeBridge.speakToClients() for
 *     human-audible critical alerts (debounced to 1 per 30s)
 *
 * Alert keys follow the pattern: `${severity}::${pipeline}::${message_hash}`
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { dataRoot } from '../core/workspaceRoot.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALERT_LOG_PATH = path.join(dataRoot(path.resolve(__dirname, '..')), 'data', 'logs', 'alerts.jsonl');

// ─── Constants ────────────────────────────────────────────────────────────────

const COOLDOWN_MS        = 5 * 60 * 1000;  // 5 min cooldown per unique alert key
const VOICE_COOLDOWN_MS  = 30_000;          // 30s between any two voice alerts
const MAX_ALERT_HISTORY  = 200;

// ─── Types ────────────────────────────────────────────────────────────────────

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: string;
  timestamp: number;
  severity: AlertSeverity;
  pipeline: string;
  message: string;
  source: string;           // module that triggered the alert
  suppressed: boolean;      // true if rate-limited (logged but not voiced)
  voiceDelivered: boolean;
}

// ─── AlertManager ─────────────────────────────────────────────────────────────

export class AlertManager extends EventEmitter {
  private static instance: AlertManager;

  /** Rate-limit map: alertKey → expiry timestamp */
  private cooldowns = new Map<string, number>();
  /** Alert history ring buffer */
  private history: Alert[] = [];
  /** Last time voice alert was delivered */
  private lastVoiceAlertAt = 0;

  // Lazy import of nodeBridge to avoid circular dependencies
  private _bridge: { speakToClients(msg: string): void } | null = null;

  private constructor() { super(); }

  static getInstance(): AlertManager {
    if (!AlertManager.instance) {
      AlertManager.instance = new AlertManager();
    }
    return AlertManager.instance;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Raise an alert. If a matching alert was already raised within COOLDOWN_MS,
   * the alert is suppressed (logged to history but not voiced or emitted).
   */
  raise(
    severity: AlertSeverity,
    pipeline: string,
    message: string,
    source = 'unknown'
  ): Alert {
    const key      = this._key(severity, pipeline, message);
    const now      = Date.now();
    const cooldown = this.cooldowns.get(key) ?? 0;
    const suppressed = now < cooldown;

    const alert: Alert = {
      id: `alert_${now}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: now,
      severity,
      pipeline,
      message,
      source,
      suppressed,
      voiceDelivered: false,
    };

    // Always append to history
    this._appendHistory(alert);

    if (suppressed) {
      // Suppressed — count but don't re-fire
      return alert;
    }

    // Set cooldown for this key
    this.cooldowns.set(key, now + COOLDOWN_MS);

    // Console output by severity
    const prefix = `[AlertManager] [${severity.toUpperCase()}] [${pipeline}]`;
    if (severity === 'critical') {
      console.error(`${prefix} ${message}`);
    } else if (severity === 'warning') {
      console.warn(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }

    // Emit event for subscribers (e.g. watchdog, dashboard)
    this.emit('alert', alert);

    // Async disk log
    this._appendLog(alert);

    // Voice delivery for warning+ (rate-limited to 1 per 30s)
    if (severity !== 'info' && (now - this.lastVoiceAlertAt) > VOICE_COOLDOWN_MS) {
      this._deliverVoice(alert, message);
    }

    return alert;
  }

  /** Convenience: raise an INFO alert */
  info(pipeline: string, message: string, source?: string): Alert {
    return this.raise('info', pipeline, message, source);
  }

  /** Convenience: raise a WARNING alert */
  warn(pipeline: string, message: string, source?: string): Alert {
    return this.raise('warning', pipeline, message, source);
  }

  /** Convenience: raise a CRITICAL alert */
  critical(pipeline: string, message: string, source?: string): Alert {
    return this.raise('critical', pipeline, message, source);
  }

  // ── History & Reporting ───────────────────────────────────────────────────

  /** Get the N most recent alerts (newest first) */
  getRecent(n = 20): Alert[] {
    return this.history.slice(-n).reverse();
  }

  /** Get alerts for a specific pipeline */
  getForPipeline(pipeline: string, n = 10): Alert[] {
    return this.history
      .filter(a => a.pipeline === pipeline)
      .slice(-n)
      .reverse();
  }

  /** Count active (non-suppressed) alerts by severity in the last `windowMs` */
  countBySeverity(windowMs = 60 * 60 * 1000): Record<AlertSeverity, number> {
    const since = Date.now() - windowMs;
    const recent = this.history.filter(a => a.timestamp > since && !a.suppressed);
    return {
      info:     recent.filter(a => a.severity === 'info').length,
      warning:  recent.filter(a => a.severity === 'warning').length,
      critical: recent.filter(a => a.severity === 'critical').length,
    };
  }

  /** Clear all cooldowns (for testing) */
  resetCooldowns(): void { this.cooldowns.clear(); }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _key(severity: AlertSeverity, pipeline: string, message: string): string {
    // Stable key: severity + pipeline + first 60 chars of message
    return `${severity}::${pipeline}::${message.slice(0, 60).replace(/\s+/g, '_')}`;
  }

  private _appendHistory(alert: Alert): void {
    this.history.push(alert);
    if (this.history.length > MAX_ALERT_HISTORY) {
      this.history.splice(0, this.history.length - MAX_ALERT_HISTORY);
    }
  }

  private _appendLog(alert: Alert): void {
    const line = JSON.stringify(alert) + '\n';
    fs.appendFile(ALERT_LOG_PATH, line, { encoding: 'utf8' }, () => { /* non-fatal */ });
  }

  private async _deliverVoice(alert: Alert, message: string): Promise<void> {
    this.lastVoiceAlertAt = Date.now();
    alert.voiceDelivered = true;

    // Lazy-load nodeBridge to avoid circular import
    if (!this._bridge) {
      try {
        const mod = await import('../bridge/nodeBridge.js');
        this._bridge = mod.nodeBridge;
      } catch { return; }
    }

    const voiceMsg = alert.severity === 'critical'
      ? `Sir, a critical failure has been detected in my ${alert.pipeline} pipeline. ${message}`
      : `Sir, I've detected a warning in my ${alert.pipeline} system.`;

    try {
      this._bridge!.speakToClients(voiceMsg);
    } catch { /* non-fatal */ }
  }
}

export const alertManager = AlertManager.getInstance();
