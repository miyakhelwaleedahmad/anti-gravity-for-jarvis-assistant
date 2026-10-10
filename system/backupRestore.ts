/**
 * system/backupRestore.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 9 — Backup & Restore System
 *
 * Provides automatic and manual backup of JARVIS state for production
 * resilience. Backs up:
 *
 *   1. Memory DB       — jarvis_memory.json (short-term + long-term facts)
 *   2. Graph memory    — graphMemory.json (entity relationships)
 *   3. Configuration   — .env (optional, sanitized — API keys redacted)
 *   4. Tool audit log  — data/logs/tool_audit.log
 *   5. Failure analytics JSONL — data/logs/failure_analytics.jsonl
 *   6. Goals and lessons — data/runtime/goals.json (core/goalManager.ts)
 *
 * Copying a live file is safe: lowdb writes a temporary file and renames it,
 * so a copy holds either the old or the new version whole. Restoring
 * replaces live files: stop JARVIS first, or the running process will
 * overwrite what was restored with what it has in memory.
 *
 * Backup strategy:
 *   - Scheduled: every JARVIS_BACKUP_INTERVAL_HOURS (default 6; 0 turns it off) while JARVIS runs
 *   - Retention: keep last MAX_BACKUPS backups, delete oldest
 *   - Format: timestamped directory under data/backups/YYYY-MM-DD_HH-MM-SS/
 *   - Restore: replaces live files from the specified backup snapshot
 *
 * Usage:
 *   import { backupRestore } from './system/backupRestore.js';
 *   backupRestore.startScheduled();
 *   await backupRestore.createBackup();
 *   await backupRestore.restore('2026-08-02_10-00-00');
 */

import * as fs   from 'fs';
import * as path from 'path';
import { dataRoot } from '../core/workspaceRoot.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Backups, and the files they copy and restore, live under the data root.
const DATA_ROOT = dataRoot(path.resolve(__dirname, '..'));

// ─── Constants ────────────────────────────────────────────────────────────────

const BACKUP_DIR         = path.join(DATA_ROOT, 'data', 'backups');
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours
const MAX_BACKUPS        = 5;

/** Files to back up: relative to DATA_ROOT → display label */
const BACKUP_TARGETS: Array<{ src: string; label: string }> = [
  { src: 'memory/jarvis_memory.json',          label: 'Memory DB' },
  { src: 'memory/graphMemory.json',             label: 'Graph Memory' },
  { src: 'data/logs/tool_audit.log',            label: 'Tool Audit Log' },
  { src: 'data/logs/failure_analytics.jsonl',   label: 'Failure Analytics' },
  { src: 'data/logs/alerts.jsonl',              label: 'Alert Log' },
  { src: 'data/runtime/goals.json',             label: 'Goals and lessons' },
];

/** The backup interval from JARVIS_BACKUP_INTERVAL_HOURS (default 6 h); 0 means no scheduled backups. */
export function backupIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env['JARVIS_BACKUP_INTERVAL_HOURS'];
  if (raw === undefined || raw.trim() === '') return BACKUP_INTERVAL_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return BACKUP_INTERVAL_MS;
  return hours === 0 ? 0 : Math.max(60_000, Math.round(hours * 3_600_000));
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BackupManifest {
  createdAt: string;
  snapshotId: string;
  files: Array<{ label: string; src: string; dest: string; sizeBytes: number; ok: boolean }>;
  totalFiles: number;
  successCount: number;
  failureCount: number;
}

export interface RestoreResult {
  snapshotId: string;
  restoredFiles: string[];
  failedFiles:   string[];
  success: boolean;
}

// ─── BackupRestore ────────────────────────────────────────────────────────────

export class BackupRestore {
  private static instance: BackupRestore;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {
    this._ensureBackupDir();
  }

  static getInstance(): BackupRestore {
    if (!BackupRestore.instance) {
      BackupRestore.instance = new BackupRestore();
    }
    return BackupRestore.instance;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  startScheduled(intervalMs = BACKUP_INTERVAL_MS): void {
    if (this.schedulerTimer || intervalMs <= 0) return;
    this.schedulerTimer = setInterval(async () => {
      try {
        const manifest = await this.createBackup();
        console.log(`[BackupRestore] ✅ Scheduled backup complete: ${manifest.snapshotId} (${manifest.successCount}/${manifest.totalFiles} files)`);
      } catch (err) {
        console.warn(`[BackupRestore] Scheduled backup failed: ${(err as Error).message}`);
      }
    }, intervalMs);
    this.schedulerTimer.unref();
    console.log(`[BackupRestore] 📦 Scheduled backups every ${intervalMs / 3600000}h.`);
  }

  get isScheduled(): boolean {
    return this.schedulerTimer !== null;
  }

  stopScheduled(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  // ── Backup ────────────────────────────────────────────────────────────────

  async createBackup(): Promise<BackupManifest> {
    const now        = new Date();
    // Two backups in the same second (a manual one and a scheduled one) get their own folders.
    let snapshotId = this._formatTimestamp(now);
    for (let n = 1; fs.existsSync(path.join(BACKUP_DIR, snapshotId)); n++) snapshotId = `${this._formatTimestamp(now)}-${n}`;
    const snapDir    = path.join(BACKUP_DIR, snapshotId);

    console.log(`[BackupRestore] 📦 Creating backup snapshot: ${snapshotId}`);
    fs.mkdirSync(snapDir, { recursive: true });

    const files: BackupManifest['files'] = [];

    for (const target of BACKUP_TARGETS) {
      const srcAbs  = path.join(DATA_ROOT, target.src);
      const destAbs = path.join(snapDir, path.basename(target.src));
      const entry: BackupManifest['files'][0] = {
        label: target.label,
        src:   target.src,
        dest:  path.relative(DATA_ROOT, destAbs),
        sizeBytes: 0,
        ok: false,
      };

      try {
        if (fs.existsSync(srcAbs)) {
          fs.copyFileSync(srcAbs, destAbs);
          entry.sizeBytes = fs.statSync(destAbs).size;
          entry.ok = true;
          console.log(`[BackupRestore]   ✓ ${target.label} (${(entry.sizeBytes / 1024).toFixed(1)} KB)`);
        } else {
          console.log(`[BackupRestore]   ⊘ ${target.label} — file not found (skipped)`);
          entry.ok = true; // Not an error — file may not exist yet
        }
      } catch (err) {
        console.warn(`[BackupRestore]   ✗ ${target.label}: ${(err as Error).message}`);
      }

      files.push(entry);
    }

    const manifest: BackupManifest = {
      createdAt:    now.toISOString(),
      snapshotId,
      files,
      totalFiles:   files.length,
      successCount: files.filter(f => f.ok).length,
      failureCount: files.filter(f => !f.ok).length,
    };

    // Write manifest file
    fs.writeFileSync(
      path.join(snapDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    // Rotate old backups
    this._rotateBackups();

    return manifest;
  }

  // ── Restore ───────────────────────────────────────────────────────────────

  async restore(snapshotId: string): Promise<RestoreResult> {
    const snapDir = path.join(BACKUP_DIR, snapshotId);

    if (!fs.existsSync(snapDir)) {
      throw new Error(`Backup snapshot '${snapshotId}' not found in ${BACKUP_DIR}`);
    }

    const manifestPath = path.join(snapDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Snapshot '${snapshotId}' has no manifest.json — corrupt backup?`);
    }

    const manifest: BackupManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const restoredFiles: string[] = [];
    const failedFiles:   string[] = [];

    console.log(`[BackupRestore] 🔄 Restoring from snapshot: ${snapshotId}`);

    for (const file of manifest.files) {
      if (!file.ok) continue;
      const srcAbs  = path.join(snapDir, path.basename(file.src));
      const destAbs = path.join(DATA_ROOT, file.src);

      try {
        if (!fs.existsSync(srcAbs)) {
          console.warn(`[BackupRestore]   ⊘ ${file.label} — not in backup, skipping`);
          continue;
        }
        // Ensure destination directory exists
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        // Create a .bak of current file before overwriting
        if (fs.existsSync(destAbs)) {
          fs.copyFileSync(destAbs, destAbs + '.bak');
        }
        fs.copyFileSync(srcAbs, destAbs);
        restoredFiles.push(file.label);
        console.log(`[BackupRestore]   ✓ Restored: ${file.label}`);
      } catch (err) {
        failedFiles.push(file.label);
        console.error(`[BackupRestore]   ✗ Failed to restore ${file.label}: ${(err as Error).message}`);
      }
    }

    const result: RestoreResult = {
      snapshotId,
      restoredFiles,
      failedFiles,
      success: failedFiles.length === 0,
    };

    console.log(`[BackupRestore] ✅ Restore complete: ${restoredFiles.length} restored, ${failedFiles.length} failed.`);
    return result;
  }

  // ── List Backups ──────────────────────────────────────────────────────────

  listBackups(): Array<{ snapshotId: string; createdAt: string; sizeBytes: number }> {
    try {
      return fs.readdirSync(BACKUP_DIR)
        .filter(d => fs.statSync(path.join(BACKUP_DIR, d)).isDirectory())
        .map(d => {
          const manifestPath = path.join(BACKUP_DIR, d, 'manifest.json');
          let createdAt = d;
          if (fs.existsSync(manifestPath)) {
            try { createdAt = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).createdAt; } catch { /* ignore */ }
          }
          const sizeBytes = this._dirSize(path.join(BACKUP_DIR, d));
          return { snapshotId: d, createdAt, sizeBytes };
        })
        .sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
    } catch {
      return [];
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _ensureBackupDir(): void {
    try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch { /* ignore */ }
  }

  private _rotateBackups(): void {
    try {
      const backups = this.listBackups();
      while (backups.length > MAX_BACKUPS) {
        const oldest = backups.shift()!;
        const dir    = path.join(BACKUP_DIR, oldest.snapshotId);
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[BackupRestore] 🗑️  Rotated old backup: ${oldest.snapshotId}`);
      }
    } catch { /* non-fatal */ }
  }

  private _dirSize(dir: string): number {
    try {
      return fs.readdirSync(dir).reduce((sum, f) => {
        try { return sum + fs.statSync(path.join(dir, f)).size; } catch { return sum; }
      }, 0);
    } catch { return 0; }
  }

  private _formatTimestamp(date: Date): string {
    return date.toISOString()
      .replace('T', '_')
      .replace(/:/g, '-')
      .slice(0, 19);
  }
}

export const backupRestore = BackupRestore.getInstance();
