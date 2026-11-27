/**
 * bridge/usageLedger.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Model usage records on disk, so they survive a restart (Phase 1A, MM-1A-05).
 *
 *   <data root>/data/usage/model_usage.jsonl
 *
 * One JSON line per model call, holding the UsageRecord fields only
 * (bridge/modelCategories.ts): never a message, a prompt, a reply or a key.
 * Error texts are already redacted and cut to 200 characters by the router.
 * Rotated at 2 MB; the last 10 rotated files are kept, as
 * core/issueStore.ts keeps its occurrences. A restart reads the newest
 * records back from the current file and, after a rotation, from the rotated
 * ones. JARVIS_USAGE_LEDGER=off neither writes nor reads.
 *
 * Appending never throws: a full or unwritable disk loses the record, never
 * the model call. The first such failure is logged once.
 */

import * as fs from 'fs';
import * as path from 'path';
import { dataRoot, getWorkspaceRoot } from '../core/workspaceRoot.js';
import type { UsageRecord } from './modelCategories.js';

const ROTATE_BYTES = 2 * 1024 * 1024;
const KEEP_ROTATED = 10;
const BASE = 'model_usage';

export function ledgerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env['JARVIS_USAGE_LEDGER'] ?? '').trim().toLowerCase() !== 'off';
}

/** Where the records live now (follows JARVIS_DATA_ROOT, read on each call). */
export function usageLedgerFile(): string {
  return path.join(dataRoot(getWorkspaceRoot()), 'data', 'usage', `${BASE}.jsonl`);
}

export class UsageLedger {
  private warned = false;
  private seq = 0;

  /**
   * @param file  the ledger file, or a function giving it (the default ledger
   *   follows the data root).
   * @param opts  rotation limits; tests lower them.
   */
  constructor(
    private readonly file: string | (() => string),
    private readonly opts: { rotateBytes?: number; keepRotated?: number } = {},
  ) {}

  private path(): string {
    return typeof this.file === 'function' ? this.file() : this.file;
  }

  append(rec: UsageRecord): void {
    try {
      const file = this.path();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > (this.opts.rotateBytes ?? ROTATE_BYTES)) this.rotate(file);
      } catch { /* no file yet, or another process rotated it first: the record is still appended below */ }
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn(`[UsageLedger] usage records are not being saved: ${(err as Error).message}`);
      }
    }
  }

  private rotate(file: string): void {
    const dir = path.dirname(file);
    // A counter keeps names unique when two rotations happen in one millisecond.
    fs.renameSync(file, path.join(dir, `${BASE}-${Date.now()}-${String(this.seq++).padStart(4, '0')}.jsonl`));
    const keep = this.opts.keepRotated ?? KEEP_ROTATED;
    const rotated = fs.readdirSync(dir).filter((f) => /^model_usage-\d+(-\d+)?\.jsonl$/.test(f)).sort();
    for (const old of rotated.slice(0, Math.max(0, rotated.length - keep))) {
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* removed on the next rotation */ }
    }
  }

  /**
   * The newest `limit` records, oldest first: from the current file, then,
   * if it holds fewer (just after a rotation), from the rotated files, newest
   * first. Lines that are not records are skipped.
   */
  readRecent(limit: number): UsageRecord[] {
    const file = this.path();
    const dir = path.dirname(file);
    let rotated: string[] = [];
    try {
      rotated = fs.readdirSync(dir).filter((f) => /^model_usage-\d+(-\d+)?\.jsonl$/.test(f)).sort().reverse().map((f) => path.join(dir, f));
    } catch { /* no folder yet */ }
    const out: UsageRecord[] = [];   // newest first while collecting
    for (const f of [file, ...rotated]) {
      if (out.length >= limit) break;
      let text: string;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i]!.trim();
        if (!line) continue;
        try {
          const r = JSON.parse(line) as UsageRecord;
          if (r && typeof r === 'object' && typeof r.provider === 'string' && typeof r.model === 'string' && typeof r.at === 'string') out.push(r);
        } catch { /* a torn or foreign line */ }
      }
    }
    return out.reverse();
  }
}

const defaultLedger = new UsageLedger(usageLedgerFile);

/** Appends one record to the data root's ledger (nothing when JARVIS_USAGE_LEDGER=off). Never throws. */
export function appendUsage(rec: UsageRecord): void {
  if (ledgerEnabled()) defaultLedger.append(rec);
}

/** The newest records from the data root's ledger, oldest first (none when off). */
export function readRecentUsage(limit: number): UsageRecord[] {
  return ledgerEnabled() ? defaultLedger.readRecent(limit) : [];
}
