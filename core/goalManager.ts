/**
 * core/goalManager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1 — Controlled Autonomy Layer: GOAL MANAGER
 *
 * Transforms JARVIS from raw-request execution into a goal-driven agent.
 * Every user input is first wrapped in a persistent Goal object that travels
 * through the full PLAN → EXECUTE → REFLECT lifecycle.
 *
 * Safety guarantees:
 *   - maxRetries prevents infinite re-execution loops
 *   - Goals in FAILED state cannot be resumed past the retry limit
 *   - All state transitions are logged for auditability
 *
 * Integration:
 *   - orchestrator.ts calls createGoal() before runAgentLoop()
 *   - orchestrator.ts calls updateGoalStatus() at each phase boundary
 *   - getActiveGoals() lets the consciousness clock detect stalled goals
 */

import { Low } from 'lowdb';
import { DataFile } from 'lowdb/node';
import { redactDeep } from '../security/redactor.js';
import * as fs from 'fs';
import path from 'path';
import { dataRoot, getWorkspaceRoot } from './workspaceRoot.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type GoalStatus =
  | 'pending'       // Created, not yet started
  | 'planning'      // Currently in planning phase
  | 'executing'     // Actively executing task graph or tool
  | 'waiting'       // Waiting for input or confirmation
  | 'in_progress'   // Actively executing (legacy compatibility)
  | 'completed'     // Successfully finished execution
  | 'failed'        // Permanently failed (exhausted retries or cap hit)
  | 'retry'         // Transient failure, queued for retry attempt
  | 'paused'        // Suspended, can be resumed later
  | 'cancelled';    // Phase 6: explicitly cancelled by user or orchestrator

export interface Goal {
  id: string;
  description: string;           // Original user input / intent
  status: GoalStatus;
  source: 'voice' | 'cli';
  retries: number;
  maxRetries: number;
  taskGraphId?: string;
  lastError?: string;
  planSummary?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
  /** Phase 6: Execution priority 1 (lowest) – 10 (highest). Default: 5 */
  priority: number;
  /** Phase 6: IDs of goals this was merged from */
  mergedFrom?: string[];
  /** Phase 6: Reason for cancellation */
  cancelReason?: string;
}

interface GoalDB {
  goals: Goal[];
  activeGoalId: string | null;
}

// ─── Goal Manager ─────────────────────────────────────────────────────────────

export class GoalManager {
  private db!: Low<GoalDB>;
  private initialized = false;
  /** The one initialisation; later callers wait for it (see init()). */
  private initPromise: Promise<void> | null = null;
  private readonly MAX_STORED_GOALS = 100; // Rolling window — avoid unbounded growth

  // OPT-2: Debounced disk writes — multiple rapid goal status changes collapse
  // into one write fired GOAL_WRITE_DEBOUNCE_MS after the last mutation.
  private _writeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly GOAL_WRITE_DEBOUNCE_MS = 300;

  // ── Initialization ─────────────────────────────────────────────────────────

  /**
   * One-time, copy-only migration of goals from the tracked legacy location.
   *
   * Runs only when the live file does not exist yet. COPYFILE_EXCL makes the
   * copy fail rather than overwrite, so an existing live file is never touched,
   * and the source is never modified or removed. Any failure is logged and
   * startup continues with an empty store — the legacy file is still intact.
   */
  static migrateLegacyGoals(legacyPath: string, livePath: string): 'migrated' | 'skipped' | 'failed' {
    if (fs.existsSync(livePath) || !fs.existsSync(legacyPath)) return 'skipped';
    try {
      fs.copyFileSync(legacyPath, livePath, fs.constants.COPYFILE_EXCL);
      console.log(`[GoalManager] 📦 Migrated goals from ${legacyPath} to ${livePath} (source left untouched).`);
      return 'migrated';
    } catch (err) {
      console.warn(`[GoalManager] ⚠️ Goal migration failed; starting with an empty store. ${legacyPath} is unchanged.`, err);
      return 'failed';
    }
  }

  /**
   * Opens the goal store once. jarvis.ts and the Orchestrator constructor both
   * call this at startup; without the guard each call opened a new database on
   * the same file and re-read it, so a goal created in between was lost.
   */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this._init().catch((err) => {
        this.initPromise = null; // a failed start may be retried
        throw err;
      });
    }
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    // Live goals are written to data/runtime/goals.json, which is gitignored.
    //
    // They used to live at data/goals.json, a file that is tracked in git and
    // was rewritten on every startup (the unconditional write below). That made
    // live state part of the repository: untracking it records a deletion that
    // removes it from every working copy that merges it. data/goals.json now
    // stays tracked and unchanged, and is read once as the seed for the live file.
    const root = dataRoot(getWorkspaceRoot());
    const runtimeDir = path.join(root, 'data', 'runtime');
    const dbPath = path.join(runtimeDir, 'goals.json');
    const legacyPath = path.join(root, 'data', 'goals.json');

    fs.mkdirSync(runtimeDir, { recursive: true });
    GoalManager.migrateLegacyGoals(legacyPath, dbPath);

    // A goal holds the user's words; on disk they are kept without credentials
    // (the copy in memory is unchanged for this session's retries).
    const adapter = new DataFile<GoalDB>(dbPath, {
      parse: JSON.parse,
      stringify: (data) => JSON.stringify(redactDeep(data), null, 2),
    });

    this.db = new Low<GoalDB>(adapter, {
      goals: [],
      activeGoalId: null,
    });

    await this.db.read();

    // Heal stale active goals from previous session (crash recovery)
    const ACTIVE_STATES = new Set(['in_progress', 'planning', 'executing', 'waiting']);
    for (const goal of this.db.data.goals) {
      if (ACTIVE_STATES.has(goal.status)) {
        console.warn(`[GoalManager] 🔄 Healing stale ${goal.status} goal: "${goal.id}" — resetting to pending`);
        goal.status = 'pending';
        goal.updatedAt = Date.now();
      }
    }

    await this.db.write();
    this.initialized = true;
    console.log(`[GoalManager] ✅ Initialized. ${this.db.data.goals.length} historical goal(s) found.`);
  }

  // ── Core API ───────────────────────────────────────────────────────────────

  /**
   * Create a new Goal from raw user input.
   * Called at the very top of orchestrator.process() BEFORE runAgentLoop().
   *
   * @param input     The raw user text / voice transcription
   * @param source    Origin of the request
   * @param maxRetries Override the default retry cap (default: 3)
   */
  async createGoal(
    input: string,
    source: 'voice' | 'cli' = 'cli',
    maxRetries = 3,
    priority = 5
  ): Promise<Goal> {
    this.ensureInit();

    const goal: Goal = {
      id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      description: input,
      status: 'pending',
      source,
      retries: 0,
      maxRetries,
      priority: Math.max(1, Math.min(10, priority)),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    };

    this.db.data.goals.push(goal);
    this.db.data.activeGoalId = goal.id;

    if (this.db.data.goals.length > this.MAX_STORED_GOALS) {
      this.db.data.goals = this.db.data.goals.slice(-this.MAX_STORED_GOALS);
    }

    await this.persist();
    console.log(`[GoalManager] 🎯 Goal created [priority ${goal.priority}]: "${goal.id}" — "${input.substring(0, 80)}"`);
    return goal;
  }

  /**
   * Get all goals that are still actionable (pending, planning, executing, waiting, in_progress, or retry).
   * Used by consciousness clock to detect stalled execution.
   */
  getActiveGoals(): Goal[] {
    this.ensureInit();
    const active = new Set(['pending', 'planning', 'executing', 'waiting', 'in_progress', 'retry']);
    return this.db.data.goals.filter(g => active.has(g.status));
  }

  /**
   * Retrieve a goal by ID.
   */
  getGoal(id: string): Goal | undefined {
    this.ensureInit();
    return this.db.data.goals.find(g => g.id === id);
  }

  /**
   * Get the most recently active goal (current session).
   */
  getCurrentGoal(): Goal | undefined {
    this.ensureInit();
    const id = this.db.data.activeGoalId;
    return id ? this.db.data.goals.find(g => g.id === id) : undefined;
  }

  /**
   * Update goal status and optional metadata fields.
   * The orchestrator calls this at each phase boundary.
   */
  async updateGoalStatus(
    id: string,
    status: GoalStatus,
    extras: Partial<Pick<Goal, 'lastError' | 'planSummary' | 'taskGraphId' | 'metadata'>> = {}
  ): Promise<void> {
    this.ensureInit();
    const goal = this.db.data.goals.find(g => g.id === id);
    if (!goal) {
      console.warn(`[GoalManager] ⚠️  updateGoalStatus: Goal "${id}" not found.`);
      return;
    }

    const prev = goal.status;
    goal.status = status;
    goal.updatedAt = Date.now();

    if (extras.lastError !== undefined) goal.lastError = extras.lastError;
    if (extras.planSummary !== undefined) goal.planSummary = extras.planSummary;
    if (extras.taskGraphId !== undefined) goal.taskGraphId = extras.taskGraphId;
    if (extras.metadata !== undefined) goal.metadata = { ...goal.metadata, ...extras.metadata };

    // Timestamp tracking
    if (status === 'in_progress' && !goal.startedAt) {
      goal.startedAt = Date.now();
    }
    if (status === 'completed' || status === 'failed') {
      goal.completedAt = Date.now();
      this.db.data.activeGoalId = null;
    }

    await this.persist();
    console.log(`[GoalManager] 📌 Goal "${id}": ${prev} → ${status}`);
  }

  /**
   * Mark goal as completed successfully.
   */
  async completeGoal(id: string): Promise<void> {
    await this.updateGoalStatus(id, 'completed');
    console.log(`[GoalManager] ✅ Goal "${id}" completed.`);
  }

  /**
   * Mark goal as failed. Increments retry counter.
   * Returns TRUE if the goal can be retried, FALSE if maxRetries exceeded.
   */
  async failGoal(id: string, error?: string): Promise<boolean> {
    this.ensureInit();
    const goal = this.db.data.goals.find(g => g.id === id);
    if (!goal) return false;

    goal.retries++;
    goal.lastError = error;
    goal.updatedAt = Date.now();

    const canRetry = goal.retries < goal.maxRetries;

    if (!canRetry) {
      // ── SAFETY: Hard stop — prevent infinite execution loops ──────────────
      goal.status = 'failed';
      goal.completedAt = Date.now();
      this.db.data.activeGoalId = null;
      console.warn(`[GoalManager] ⛔ Goal "${id}" permanently failed after ${goal.retries} retries.`);
    } else {
      goal.status = 'retry'; // Set retry state for retry attempt
      console.log(`[GoalManager] 🔁 Goal "${id}" failed (attempt ${goal.retries}/${goal.maxRetries}). Set to retry status.`);
    }

    await this.persist();
    return canRetry;
  }

  /**
   * Resume a paused goal (re-queue it for execution).
   * Safety: blocked if goal has hit maxRetries.
   */
  async resumeGoal(id: string): Promise<boolean> {
    this.ensureInit();
    const goal = this.db.data.goals.find(g => g.id === id);
    if (!goal) {
      console.warn(`[GoalManager] resumeGoal: Goal "${id}" not found.`);
      return false;
    }

    if (goal.status === 'failed' && goal.retries >= goal.maxRetries) {
      console.warn(`[GoalManager] ⚠️  Cannot resume goal "${id}": max retries exhausted.`);
      return false;
    }

    if (goal.status === 'completed') {
      console.warn(`[GoalManager] ⚠️  Cannot resume goal "${id}": already completed.`);
      return false;
    }

    goal.status = 'pending';
    goal.updatedAt = Date.now();
    this.db.data.activeGoalId = id;
    await this.persist();
    console.log(`[GoalManager] ▶️  Goal "${id}" resumed.`);
    return true;
  }

  /**
   * Returns recent goals for context injection into LLM prompts.
   * Provides the planner with awareness of what was recently attempted.
   */
  getRecentGoalContext(limit = 5): string {
    this.ensureInit();
    if (!this.db.data.goals || this.db.data.goals.length === 0) return '';

    const recent = [...this.db.data.goals]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);

    if (recent.length === 0) return '';

    const lines = recent.map(g => {
      const age = Math.round((Date.now() - g.createdAt) / 1000);
      return `  [${g.status.toUpperCase()}] [P${g.priority ?? 5}] "${g.description.substring(0, 80)}" (${age}s ago, ${g.retries} retries)`;
    });

    return `Recent Goals:\n${lines.join('\n')}`;
  }

  /** The most recent goals, the newest request first ("continue what I was doing", P13). */
  getRecentGoals(limit = 5): Goal[] {
    this.ensureInit();
    return [...this.db.data.goals].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  // ── Phase 6: Priority, Cancellation, Merge ────────────────────────────────

  /**
   * Cancel a goal explicitly. Sets status to 'cancelled' and records reason.
   * No-op if goal is already completed or cancelled.
   */
  async cancelGoal(id: string, reason = 'cancelled by user'): Promise<boolean> {
    this.ensureInit();
    const goal = this.db.data.goals.find(g => g.id === id);
    if (!goal) {
      console.warn(`[GoalManager] cancelGoal: Goal "${id}" not found.`);
      return false;
    }
    if (goal.status === 'completed' || goal.status === 'cancelled') {
      console.warn(`[GoalManager] cancelGoal: Goal "${id}" is already ${goal.status}.`);
      return false;
    }
    goal.status = 'cancelled';
    goal.cancelReason = reason;
    goal.completedAt = Date.now();
    goal.updatedAt = Date.now();
    if (this.db.data.activeGoalId === id) this.db.data.activeGoalId = null;
    await this.persist();
    console.log(`[GoalManager] ❌ Goal "${id}" cancelled: ${reason}`);
    return true;
  }

  /**
   * Update a goal's priority (1–10). Higher = executed sooner.
   */
  async updatePriority(id: string, priority: number): Promise<void> {
    this.ensureInit();
    const goal = this.db.data.goals.find(g => g.id === id);
    if (!goal) return;
    goal.priority = Math.max(1, Math.min(10, priority));
    goal.updatedAt = Date.now();
    await this.persist();
    console.log(`[GoalManager] 🔄 Goal "${id}" priority updated to ${goal.priority}`);
  }

  /**
   * Merge multiple pending goals into one.
   * The merged goal inherits the highest priority and the oldest createdAt.
   * All source goals are cancelled.
   * Returns the new merged goal.
   */
  async mergeGoals(ids: string[], mergedDescription: string, source: 'voice' | 'cli' = 'cli'): Promise<Goal> {
    this.ensureInit();
    const sources = ids
      .map(id => this.db.data.goals.find(g => g.id === id))
      .filter((g): g is Goal => !!g && g.status === 'pending');

    if (sources.length < 2) {
      throw new Error(`[GoalManager] mergeGoals: need at least 2 pending goals, got ${sources.length}`);
    }

    const maxPriority = Math.max(...sources.map(g => g.priority ?? 5));
    const maxRetries  = Math.max(...sources.map(g => g.maxRetries));

    // Cancel all source goals
    for (const g of sources) {
      g.status = 'cancelled';
      g.cancelReason = 'merged into new goal';
      g.completedAt = Date.now();
      g.updatedAt   = Date.now();
    }

    const merged: Goal = {
      id: `goal_${Date.now()}_merged_${Math.random().toString(36).slice(2, 5)}`,
      description: mergedDescription,
      status: 'pending',
      source,
      retries: 0,
      maxRetries,
      priority: maxPriority,
      mergedFrom: sources.map(g => g.id),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    };

    this.db.data.goals.push(merged);
    this.db.data.activeGoalId = merged.id;
    await this.persist();
    console.log(`[GoalManager] 🔀 Merged ${sources.length} goals into "${merged.id}"`);
    return merged;
  }

  /**
   * Returns pending/retry goals sorted by priority (highest first),
   * then by createdAt ascending (oldest first among equal priority).
   * Used by orchestrator for intelligent goal scheduling.
   */
  getPriorityQueue(): Goal[] {
    this.ensureInit();
    const actionable = new Set(['pending', 'retry']);
    return this.db.data.goals
      .filter(g => actionable.has(g.status))
      .sort((a, b) => {
        const pa = a.priority ?? 5;
        const pb = b.priority ?? 5;
        if (pb !== pa) return pb - pa;         // Higher priority first
        return a.createdAt - b.createdAt;      // Older goal first among ties
      });
  }

  /**
   * Get summary stats for telemetry / monitoring.
   */
  getStats() {
    this.ensureInit();
    const goals = this.db.data.goals;
    return {
      total: goals.length,
      pending: goals.filter(g => g.status === 'pending').length,
      in_progress: goals.filter(g => g.status === 'in_progress').length,
      completed: goals.filter(g => g.status === 'completed').length,
      failed: goals.filter(g => g.status === 'failed').length,
    };
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('[GoalManager] Not initialized. Call goalManager.init() first.');
    }
  }

  private persist(): void {
    // OPT-2: Debounce — collapse rapid successive writes into one disk I/O.
    // On graceful shutdown, flush() ensures nothing is lost.
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this.db.write().catch(err =>
        console.error('[GoalManager] ⚠️  Failed to persist goals:', err)
      );
    }, this.GOAL_WRITE_DEBOUNCE_MS);
  }

  /** Fire-and-forget: trigger a debounced write without awaiting. */
  persistNow(): Promise<void> {
    this.persist();
    return Promise.resolve();
  }

  /** Force-flush any pending debounced write. Call on graceful shutdown. */
  async flush(): Promise<void> {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    await this.db.write();
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const goalManager = new GoalManager();
