import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { securityAuditLogger } from '../security/securityAuditLogger.js';

/**
 * control/permissionSession.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2 — Security & Permission Architecture
 *
 * Permission levels:
 *   0 = READ ONLY     — observation only
 *   1 = SAFE CONTROL  — focus, open safe apps, read-only browser
 *   2 = FULL CONTROL  — keyboard, mouse, file ops, app close (session-bounded)
 *   3 = HIGH RISK     — always requires user confirmation even in full control
 *   4 = BLOCKED       — always denied (passwords, credentials, security bypass)
 *
 * New in Phase 2:
 *   - Persistent sessions: session state is saved to disk and restored on restart.
 *   - Permission caching: checkPermission() avoids re-computing level on hot paths.
 *   - Session renewal: extendSession() adds time without full re-approval.
 *   - Auto-revoke: expiry fires a 'session:expired' EventEmitter event.
 *   - Session logs: every activation/deactivation/renewal/expiry written to JSON log.
 *   - Better timeout handling: warns 5 min before expiry ('session:expiring_soon').
 *   - Voice approval integration: activateFullControl() accepts a voice-approved flag.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionState {
  level: number;
  fullControlExpiresAt: number | null;
  activatedAt: number | null;
  activatedBy: 'voice' | 'cli' | 'gui' | 'auto' | null;
  sessionId: string | null;
}

export interface SessionLogEntry {
  ts: string;
  sessionId: string;
  event: 'activate' | 'deactivate' | 'renew' | 'expire' | 'cache_hit' | 'permission_denied';
  level: number;
  expiresAt?: string;
  durationMinutes?: number;
  activatedBy?: string;
  reason?: string;
  action?: string;
}

export interface PermissionCacheEntry {
  level: number;
  result: boolean;
  cachedAt: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const SESSION_PERSIST_PATH = path.join(PROJECT_ROOT, 'data', 'security', 'permission_session.json');
const SESSION_LOG_PATH     = path.join(PROJECT_ROOT, 'data', 'logs', 'permission_session_log.json');

/** How often the auto-revoke interval ticks (ms) */
const REVOKE_CHECK_INTERVAL_MS = 10_000;

/** How early to warn before expiry (ms) */
const EXPIRY_WARN_AHEAD_MS = 5 * 60_000; // 5 minutes

/** Permission cache TTL — invalidate if level changes (ms) */
const CACHE_TTL_MS = 500;

/** Maximum log entries kept in memory before flush */
const MAX_LOG_ENTRIES = 500;

// ─── PermissionSession ────────────────────────────────────────────────────────

export class PermissionSession extends EventEmitter {
  // ── Core state ────────────────────────────────────────────────────────────
  private currentLevel: number = 0;
  private fullControlExpiresAt: number | null = null;
  private activatedAt: number | null = null;
  private activatedBy: SessionState['activatedBy'] = null;
  private sessionId: string | null = null;

  // ── Timers ────────────────────────────────────────────────────────────────
  private _revokeTimer: ReturnType<typeof setInterval> | null = null;
  private _warningSent = false;

  // ── Permission cache ──────────────────────────────────────────────────────
  // Hot-path cache for checkPermission(). Invalidated when level changes.
  // Key: `${requiredLevel}` → result bool.
  private _permCache: Map<number, PermissionCacheEntry> = new Map();
  private _cacheLevel: number = 0; // The level the cache was built for

  // ── Session log ───────────────────────────────────────────────────────────
  private _sessionLog: SessionLogEntry[] = [];

  constructor() {
    super();
    this.setMaxListeners(20);

    // Restore persisted session (may already be expired)
    this._restoreSession();

    // Start the auto-revoke interval
    this._startRevokeTimer();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public read API
  // ─────────────────────────────────────────────────────────────────────────

  getCurrentLevel(): number {
    this._checkExpiry();
    return this.currentLevel;
  }

  isFullControlActive(): boolean {
    this._checkExpiry();
    return this.currentLevel === 2;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Remaining session time in seconds, or null if no active session */
  getRemainingSeconds(): number | null {
    if (this.fullControlExpiresAt === null) return null;
    const remaining = Math.max(0, this.fullControlExpiresAt - Date.now());
    return Math.round(remaining / 1000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Activate / Deactivate / Renew
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Enable Level 2 Full Control session.
   *
   * @param durationMinutes  How long the session lasts (1–120 min, default 30)
   * @param source           Who approved it: 'voice' | 'cli' | 'gui' | 'auto'
   * @param voiceApproved    Set to true when approval came through the voice pipeline
   */
  activateFullControl(
    durationMinutes = 30,
    source: SessionState['activatedBy'] = 'cli',
    voiceApproved = false,
  ): void {
    const clampedMinutes = Math.min(Math.max(durationMinutes, 1), 120);
    const now = Date.now();

    this.currentLevel = 2;
    this.fullControlExpiresAt = now + clampedMinutes * 60_000;
    this.activatedAt = now;
    this.activatedBy = voiceApproved ? 'voice' : (source ?? 'cli');
    this.sessionId = this._generateSessionId();
    this._warningSent = false;
    this._invalidateCache();

    securityAuditLogger.fullControlSession(
      'activate',
      true,
      `Full Control Mode enabled for ${clampedMinutes} min via ${this.activatedBy}.`,
      this.fullControlExpiresAt,
    );

    const expiryStr = new Date(this.fullControlExpiresAt).toLocaleTimeString();
    console.log(
      `[PermissionSession] 🚀 Full Control active. Session: ${this.sessionId} | ` +
      `Duration: ${clampedMinutes} min | Expires: ${expiryStr} | Source: ${this.activatedBy}`
    );

    this._writeLog({
      ts: new Date(now).toISOString(),
      sessionId: this.sessionId,
      event: 'activate',
      level: 2,
      expiresAt: new Date(this.fullControlExpiresAt).toISOString(),
      durationMinutes: clampedMinutes,
      activatedBy: this.activatedBy ?? 'unknown',
    });

    this._persistSession();

    // Emit event so orchestrator / dashboard can react
    this.emit('session:started', {
      sessionId: this.sessionId,
      expiresAt: this.fullControlExpiresAt,
      source: this.activatedBy,
    });
  }

  /**
   * Extend an active session without requiring re-approval.
   * Only valid while a session is currently active.
   * Maximum extension is capped so total remaining time ≤ 120 minutes.
   */
  extendSession(additionalMinutes: number): boolean {
    this._checkExpiry();
    if (this.currentLevel !== 2 || this.fullControlExpiresAt === null) {
      console.warn('[PermissionSession] extendSession() called but no active session.');
      return false;
    }

    const maxExtend = Math.min(additionalMinutes, 120);
    this.fullControlExpiresAt += maxExtend * 60_000;
    this._warningSent = false; // reset warn flag so it fires again near new expiry
    this._invalidateCache();

    securityAuditLogger.fullControlSession(
      'renew',
      true,
      `Session ${this.sessionId} extended by ${maxExtend} min. New expiry: ${new Date(this.fullControlExpiresAt).toLocaleTimeString()}`,
      this.fullControlExpiresAt,
    );

    console.log(
      `[PermissionSession] 🔄 Session extended by ${maxExtend} min. ` +
      `New expiry: ${new Date(this.fullControlExpiresAt).toLocaleTimeString()}`
    );

    this._writeLog({
      ts: new Date().toISOString(),
      sessionId: this.sessionId ?? 'unknown',
      event: 'renew',
      level: 2,
      expiresAt: new Date(this.fullControlExpiresAt).toISOString(),
      durationMinutes: maxExtend,
    });

    this._persistSession();
    this.emit('session:renewed', { sessionId: this.sessionId, expiresAt: this.fullControlExpiresAt });
    return true;
  }

  /**
   * Disable Level 2 Full Control — returns to Level 0 (Read Only).
   * Always safe to call; no-op if already at level 0.
   */
  deactivateFullControl(reason = 'manual'): void {
    if (this.currentLevel === 0 && this.fullControlExpiresAt === null) return;

    const prevSessionId = this.sessionId ?? 'unknown';
    this.currentLevel = 0;
    this.fullControlExpiresAt = null;
    this.activatedAt = null;
    this.activatedBy = null;
    this.sessionId = null;
    this._warningSent = false;
    this._invalidateCache();

    securityAuditLogger.fullControlSession('deactivate', true, `Full Control Mode disabled. Reason: ${reason}`);
    console.log(`[PermissionSession] 🛡️ Full Control disabled. Reason: ${reason}. Session: ${prevSessionId}`);

    this._writeLog({
      ts: new Date().toISOString(),
      sessionId: prevSessionId,
      event: 'deactivate',
      level: 0,
      reason,
    });

    this._persistSession();
    this.emit('session:ended', { sessionId: prevSessionId, reason });
  }

  /** @deprecated Use activateFullControl() instead */
  enableFullControl(): void { this.activateFullControl(30); }

  /** @deprecated Use deactivateFullControl() instead */
  disableFullControl(): void { this.deactivateFullControl(); }

  // ─────────────────────────────────────────────────────────────────────────
  // Permission Check (with caching)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns true if the current level is sufficient for the required level.
   * Results are cached per level for CACHE_TTL_MS to avoid re-computation
   * on hot paths (e.g. keyboard events that call this 60x/sec).
   *
   * Level 3 = HIGH RISK: always requires explicit approval (never cached as true)
   * Level 4 = BLOCKED: always denied, no exceptions
   */
  checkPermission(requiredLevel: number, actionName: string): boolean {
    // Level 4 = always blocked, never cache
    if (requiredLevel >= 4) {
      console.warn(`[PermissionSession] ❌ Action "${actionName}" BLOCKED (Level 4: Forbidden).`);
      this._writeLog({
        ts: new Date().toISOString(),
        sessionId: this.sessionId ?? 'none',
        event: 'permission_denied',
        level: this.currentLevel,
        action: actionName,
        reason: 'Level 4 BLOCKED',
      });
      return false;
    }

    // Level 3 = HIGH RISK: always requires confirmation — cannot pass by level alone
    if (requiredLevel >= 3) {
      console.warn(`[PermissionSession] ⚠️  Action "${actionName}" requires Level 3 explicit confirmation.`);
      return false;
    }

    // Check expiry first (updates level if expired)
    this._checkExpiry();

    // ── Cache lookup ──────────────────────────────────────────────────────
    const cacheEntry = this._permCache.get(requiredLevel);
    if (
      cacheEntry &&
      this._cacheLevel === this.currentLevel &&
      Date.now() - cacheEntry.cachedAt < CACHE_TTL_MS
    ) {
      return cacheEntry.result;
    }

    // ── Compute ───────────────────────────────────────────────────────────
    const result = this.currentLevel >= requiredLevel;

    if (!result) {
      console.warn(
        `[PermissionSession] ❌ "${actionName}" rejected. ` +
        `Required: L${requiredLevel}, Current: L${this.currentLevel}`
      );
    }

    // ── Cache store ───────────────────────────────────────────────────────
    this._permCache.set(requiredLevel, { level: this.currentLevel, result, cachedAt: Date.now() });
    this._cacheLevel = this.currentLevel;

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status & Diagnostics
  // ─────────────────────────────────────────────────────────────────────────

  getStatus(): string {
    this._checkExpiry();
    const levelsMap: Record<number, string> = {
      0: 'Level 0: Read Only',
      1: 'Level 1: Safe Control',
      2: 'Level 2: Full Control Session',
    };
    const remaining = this.getRemainingSeconds();
    const expiry = remaining !== null
      ? ` (${Math.floor(remaining / 60)}m ${remaining % 60}s remaining, session: ${this.sessionId ?? '?'})`
      : '';
    return `Current Permission Level: ${levelsMap[this.currentLevel] ?? 'Unknown'}${expiry}`;
  }

  /** @deprecated Use getStatus() */
  getStatusMessage(): string { return this.getStatus(); }

  getSessionLog(last = 50): SessionLogEntry[] {
    return this._sessionLog.slice(-last);
  }

  getSessionSnapshot(): SessionState {
    this._checkExpiry();
    return {
      level: this.currentLevel,
      fullControlExpiresAt: this.fullControlExpiresAt,
      activatedAt: this.activatedAt,
      activatedBy: this.activatedBy,
      sessionId: this.sessionId,
    };
  }

  getCacheStats(): { size: number; ttlMs: number } {
    return { size: this._permCache.size, ttlMs: CACHE_TTL_MS };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Shutdown
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Call at process exit. Stops the revoke timer and flushes the session log.
   * Does NOT deactivate the session — a persistent session should survive restart.
   */
  shutdown(): void {
    if (this._revokeTimer) {
      clearInterval(this._revokeTimer);
      this._revokeTimer = null;
    }
    this._flushLog();
    console.log('[PermissionSession] 🛑 Shutdown — timer stopped, log flushed.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private _checkExpiry(): void {
    if (
      this.currentLevel === 2 &&
      this.fullControlExpiresAt !== null &&
      Date.now() > this.fullControlExpiresAt
    ) {
      console.log('[PermissionSession] ⏱️ Full Control session expired. Auto-revoking.');
      const expiredSessionId = this.sessionId ?? 'unknown';

      this.currentLevel = 0;
      this.fullControlExpiresAt = null;
      this.activatedAt = null;
      this.activatedBy = null;
      this.sessionId = null;
      this._warningSent = false;
      this._invalidateCache();

      securityAuditLogger.fullControlSession('expire', false, 'Session auto-revoked due to timeout.');

      this._writeLog({
        ts: new Date().toISOString(),
        sessionId: expiredSessionId,
        event: 'expire',
        level: 0,
        reason: 'auto_revoke_timeout',
      });

      this._persistSession();
      // Emit async so this never blocks checkPermission()
      setImmediate(() => this.emit('session:expired', { sessionId: expiredSessionId }));
    }
  }

  private _startRevokeTimer(): void {
    this._revokeTimer = setInterval(() => {
      this._checkExpiry();

      // Near-expiry warning
      if (
        !this._warningSent &&
        this.currentLevel === 2 &&
        this.fullControlExpiresAt !== null
      ) {
        const timeLeft = this.fullControlExpiresAt - Date.now();
        if (timeLeft > 0 && timeLeft <= EXPIRY_WARN_AHEAD_MS) {
          this._warningSent = true;
          const minsLeft = Math.ceil(timeLeft / 60_000);
          console.warn(
            `[PermissionSession] ⚠️  Full Control session expires in ~${minsLeft} minute(s). ` +
            `Session: ${this.sessionId}`
          );
          this.emit('session:expiring_soon', {
            sessionId: this.sessionId,
            remainingMs: timeLeft,
          });
        }
      }
    }, REVOKE_CHECK_INTERVAL_MS);

    // Unref so this timer never prevents Node.js from exiting
    if (this._revokeTimer && typeof (this._revokeTimer as any).unref === 'function') {
      (this._revokeTimer as any).unref();
    }
  }

  private _invalidateCache(): void {
    this._permCache.clear();
  }

  private _generateSessionId(): string {
    return `ps_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private _persistSession(): void {
    try {
      const dir = path.dirname(SESSION_PERSIST_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const state: SessionState = {
        level: this.currentLevel,
        fullControlExpiresAt: this.fullControlExpiresAt,
        activatedAt: this.activatedAt,
        activatedBy: this.activatedBy,
        sessionId: this.sessionId,
      };
      fs.writeFileSync(SESSION_PERSIST_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // Persistence failure must never crash the security layer
    }
  }

  private _restoreSession(): void {
    try {
      if (!fs.existsSync(SESSION_PERSIST_PATH)) return;

      const raw = fs.readFileSync(SESSION_PERSIST_PATH, 'utf8');
      const state: SessionState = JSON.parse(raw);

      // Only restore if the persisted session is still valid
      if (
        state.level === 2 &&
        state.fullControlExpiresAt !== null &&
        Date.now() < state.fullControlExpiresAt
      ) {
        this.currentLevel = state.level;
        this.fullControlExpiresAt = state.fullControlExpiresAt;
        this.activatedAt = state.activatedAt;
        this.activatedBy = state.activatedBy;
        this.sessionId = state.sessionId;

        const expiryStr = new Date(state.fullControlExpiresAt).toLocaleTimeString();
        console.log(
          `[PermissionSession] 🔄 Restored active session: ${state.sessionId} | ` +
          `Expires: ${expiryStr}`
        );
      } else if (state.level === 2) {
        // Persisted session is stale — clear the file
        console.log('[PermissionSession] ℹ️  Persisted session was expired — starting at Level 0.');
        this._persistSession(); // writes level=0 state
      }
    } catch {
      // Corrupt file — ignore, start at level 0
    }
  }

  // ── Session log ───────────────────────────────────────────────────────────

  private _writeLog(entry: SessionLogEntry): void {
    this._sessionLog.push(entry);
    if (this._sessionLog.length > MAX_LOG_ENTRIES) {
      this._sessionLog.shift();
    }
    // Async flush to disk — fire and forget, non-blocking
    setImmediate(() => this._flushLog());
  }

  private _flushLog(): void {
    try {
      const dir = path.dirname(SESSION_LOG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Read existing log and merge (append-only)
      let existing: SessionLogEntry[] = [];
      if (fs.existsSync(SESSION_LOG_PATH)) {
        try {
          existing = JSON.parse(fs.readFileSync(SESSION_LOG_PATH, 'utf8'));
          if (!Array.isArray(existing)) existing = [];
        } catch { existing = []; }
      }

      const merged = [...existing, ...this._sessionLog].slice(-MAX_LOG_ENTRIES);
      fs.writeFileSync(SESSION_LOG_PATH, JSON.stringify(merged, null, 2), 'utf8');
      this._sessionLog = []; // clear in-memory buffer after successful flush
    } catch {
      // Log flush failure must never crash the permission layer
    }
  }
}

export const permissionSession = new PermissionSession();
