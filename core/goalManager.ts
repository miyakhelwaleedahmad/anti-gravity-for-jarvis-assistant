/**
 * core/goalManager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Goal records and their storage (data/runtime/goals.json, lowdb).
 *
 * Two uses:
 *   - Every typed or spoken command is recorded as a `request` goal while the
 *     orchestrator runs it (createGoal → updateGoalStatus → completeGoal /
 *     failGoal). Request goals are never run again by anything.
 *   - Temporary, permanent and recurring goals (createManagedGoal) are the
 *     Goal Runtime's work (core/goalRuntime.ts): objectives with success
 *     criteria, a plan of tasks, milestones and schedules.
 *
 * Every status change goes through the lifecycle policy (core/goalLifecycle.ts)
 * and is recorded with its reason. A change the policy does not allow is
 * refused and logged, not applied.
 *
 * Storage:
 *   - Writes are debounced (300 ms); persistImmediate() writes now, for
 *     claims and results that must survive a crash.
 *   - The newest 100 request goals are kept. Managed goals are never dropped
 *     by that window; finished ones are moved to data/runtime/goal-archive/
 *     after the retention period (archiveFinished), not deleted.
 *   - On disk, goals are written without credentials (redactDeep).
 */

import { EventEmitter } from 'node:events';
import { Low } from 'lowdb';
import { DataFile } from 'lowdb/node';
import { redactDeep } from '../security/redactor.js';
import * as fs from 'fs';
import path from 'path';
import { dataRoot, getWorkspaceRoot } from './workspaceRoot.js';
import {
  GOAL_KINDS, MAX_GOAL_HISTORY, goalTransitionProblem, isTerminalGoalStatus,
  type GoalBudget, type GoalCriterion, type GoalKind, type GoalLesson, type GoalPolicy, type GoalSchedule,
  type GoalStatus, type GoalTask, type ManagedGoalFields, type Milestone,
} from './goalLifecycle.js';
import { nextRunAfter, scheduleProblem } from './goalSchedule.js';

export type {
  GoalStatus, GoalKind, GoalTask, GoalCriterion, Milestone, GoalSchedule, GoalPolicy, GoalBudget, GoalLesson,
} from './goalLifecycle.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Goal extends ManagedGoalFields {
  id: string;
  description: string;           // the user's words (request) or the goal's title
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
  /** Execution priority 1 (lowest) – 10 (highest). Default: 5 */
  priority: number;
  /** IDs of goals this was merged from */
  mergedFrom?: string[];
  /** Reason for cancellation */
  cancelReason?: string;
}

/** A finished goal moved out of the live store. */
export interface ArchivedGoalRef {
  id: string;
  kind: GoalKind;
  description: string;
  status: GoalStatus;
  outcome?: string;
  finishedAt?: number;
  archivedAt: number;
  file: string;
  instanceKey?: string;
}

interface GoalDB {
  goals: Goal[];
  activeGoalId: string | null;
  archive?: ArchivedGoalRef[];
  lessons?: GoalLesson[];
}

/** What a caller gives to create a temporary, permanent or recurring goal. */
export interface NewGoalInput {
  kind: Exclude<GoalKind, 'request'>;
  objective: string;
  /** Short name; defaults to the objective's first line. */
  title?: string;
  source?: 'voice' | 'cli';
  priority?: number;
  /** Plain sentences become `judge` criteria. */
  successCriteria?: (string | Omit<GoalCriterion, 'id'>)[];
  constraints?: string[];
  milestones?: (string | { title: string; successCriteria?: (string | Omit<GoalCriterion, 'id'>)[] })[];
  schedule?: GoalSchedule;
  policy?: GoalPolicy;
  budget?: GoalBudget;
  triggers?: string[];
  /** A plan given up front (otherwise the runtime plans). `dependsOn` names other tasks by title. */
  tasks?: { title: string; description?: string; specialist: string; dependsOn?: string[]; sideEffects?: 'none' | 'possible' }[];
  maxRetries?: number;
  parentGoalId?: string;
  instanceKey?: string;
}

export const MAX_TASK_ATTEMPTS = 3;
const MAX_OBJECTIVE = 2_000;
const MAX_LESSONS = 500;
const REQUEST_HISTORY = 20;

export function goalKind(goal: Pick<Goal, 'kind'>): GoalKind {
  return goal.kind ?? 'request';
}

export function isManaged(goal: Pick<Goal, 'kind'>): boolean {
  return goalKind(goal) !== 'request';
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function criteriaFrom(list: (string | Omit<GoalCriterion, 'id'>)[] | undefined): GoalCriterion[] {
  return (list ?? [])
    .map((c) => (typeof c === 'string' ? { description: c.trim(), kind: 'judge' as const } : c))
    .filter((c) => c.description?.trim())
    .map((c) => ({ ...c, id: newId('crit') }));
}

function retentionMs(): number {
  const days = Number(process.env['JARVIS_GOAL_RETENTION_DAYS']);
  return (Number.isFinite(days) && days >= 0 ? days : 7) * 86_400_000;
}

function zeroUsage(now: number): NonNullable<Goal['usage']> {
  return { llmCalls: 0, toolCalls: 0, tokens: 0, tasks: 0, periodStart: now };
}

// ─── Goal Manager ─────────────────────────────────────────────────────────────

export class GoalManager extends EventEmitter {
  /** The clock (tests run the runtime and the store on one fake clock). */
  readonly now: () => number;
  private db!: Low<GoalDB>;
  private initialized = false;
  /** The one initialisation; later callers wait for it (see init()). */
  private initPromise: Promise<void> | null = null;
  /** Request goals kept; managed goals are not counted. */
  private readonly MAX_STORED_GOALS = 100;
  private archiveDir = '';

  // OPT-2: Debounced disk writes — multiple rapid goal status changes collapse
  // into one write fired GOAL_WRITE_DEBOUNCE_MS after the last mutation.
  private _writeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly GOAL_WRITE_DEBOUNCE_MS = 300;

  constructor(opts: { now?: () => number } = {}) {
    super();
    this.now = opts.now ?? Date.now;
  }

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
    this.archiveDir = path.join(runtimeDir, 'goal-archive');

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
    this.db.data.goals ??= [];
    this.db.data.archive ??= [];
    this.db.data.lessons ??= [];

    // Request goals cut off by a restart are not run again (a command such as
    // "close …" must not replay by itself); they are left pending, as before,
    // for "continue what I was doing". Managed goals are reconciled by the Goal
    // Runtime when it starts (core/goalRuntime.ts), which knows what was running.
    const ACTIVE_STATES = new Set(['in_progress', 'planning', 'executing', 'waiting']);
    for (const goal of this.db.data.goals) {
      if (!isManaged(goal) && ACTIVE_STATES.has(goal.status)) {
        console.warn(`[GoalManager] 🔄 Healing stale ${goal.status} goal: "${goal.id}" — resetting to pending`);
        goal.status = 'pending';
        goal.updatedAt = this.now();
      }
    }

    await this.db.write();
    this.initialized = true;
    const managed = this.db.data.goals.filter(isManaged).length;
    console.log(`[GoalManager] ✅ Initialized. ${this.db.data.goals.length} historical goal(s) found${managed ? ` (${managed} managed)` : ''}.`);
  }

  // ── The lifecycle ──────────────────────────────────────────────────────────

  /**
   * The one way a goal's status changes. Records from, to, reason and time;
   * refuses (returns false, logs) a change the lifecycle policy does not allow.
   */
  transition(goalOrId: Goal | string, to: GoalStatus, reason: string, opts: { event?: string; taskId?: string; quiet?: boolean } = {}): boolean {
    this.ensureInit();
    const goal = typeof goalOrId === 'string' ? this.db.data.goals.find((g) => g.id === goalOrId) : goalOrId;
    if (!goal) {
      console.warn(`[GoalManager] ⚠️  transition: Goal "${String(goalOrId)}" not found.`);
      return false;
    }
    const from = goal.status;
    const problem = goalTransitionProblem(from, to);
    if (problem) {
      console.warn(`[GoalManager] ⛔ Goal "${goal.id}": refused ${from} → ${to} (${problem}). Reason given: ${reason}`);
      return false;
    }
    const now = this.now();
    goal.status = to;
    goal.updatedAt = now;
    if ((to === 'in_progress' || to === 'executing') && !goal.startedAt) goal.startedAt = now;
    if (isTerminalGoalStatus(to)) {
      goal.completedAt = now;
      if (this.db.data.activeGoalId === goal.id) this.db.data.activeGoalId = null;
    }
    if (to !== 'waiting') goal.waitingFor = undefined;
    if (to !== 'blocked') goal.blockedReason = undefined;
    if (from !== to) this.note(goal, { event: opts.event ?? 'status', reason, from, to, ...(opts.taskId ? { taskId: opts.taskId } : {}) });
    this.persist();
    if (from !== to && !opts.quiet) console.log(`[GoalManager] 📌 Goal "${goal.id}": ${from} → ${to}${isManaged(goal) ? ` (${reason})` : ''}`);
    if (from !== to) this.emit('goal_changed', goal, from, to);
    return true;
  }

  /** Adds a history entry (bounded) without changing the status. */
  note(goal: Goal, entry: { event: string; reason: string; from?: GoalStatus; to?: GoalStatus; taskId?: string }): void {
    const history = (goal.history ??= []);
    history.push({ at: this.now(), ...entry });
    const cap = isManaged(goal) ? MAX_GOAL_HISTORY : REQUEST_HISTORY;
    if (history.length > cap) history.splice(0, history.length - cap);
  }

  // ── Request goals (the orchestrator) ───────────────────────────────────────

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
      id: `goal_${this.now()}_${Math.random().toString(36).slice(2, 7)}`,
      description: input,
      status: 'pending',
      source,
      retries: 0,
      maxRetries,
      priority: Math.max(1, Math.min(10, priority)),
      createdAt: this.now(),
      updatedAt: this.now(),
      metadata: {},
      kind: 'request',
    };

    this.db.data.goals.push(goal);
    this.db.data.activeGoalId = goal.id;
    this.prune();

    await this.persist();
    console.log(`[GoalManager] 🎯 Goal created [priority ${goal.priority}]: "${goal.id}" — "${input.substring(0, 80)}"`);
    return goal;
  }

  // ── Managed goals (the Goal Runtime) ───────────────────────────────────────

  /** Why `input` cannot become a goal, or undefined. */
  validateGoalInput(input: NewGoalInput): string | undefined {
    if (!input || typeof input !== 'object') return 'no goal given';
    if (!GOAL_KINDS.includes(input.kind) || (input.kind as GoalKind) === 'request') return 'kind must be temporary, permanent or recurring';
    const objective = String(input.objective ?? '').trim();
    if (!objective) return 'the goal needs an objective';
    if (objective.length > MAX_OBJECTIVE) return `the objective is longer than ${MAX_OBJECTIVE} characters`;
    if (input.kind === 'recurring' && !input.schedule) return 'a recurring goal needs a schedule';
    if (input.kind === 'recurring' && input.schedule?.type === 'once') return 'a recurring goal needs a repeating schedule (interval or daily)';
    const sched = scheduleProblem(input.schedule);
    if (sched) return sched;
    if (input.tasks) {
      const titles = new Set(input.tasks.map((t) => t.title));
      if (titles.size !== input.tasks.length) return 'task titles must be different';
      for (const t of input.tasks) {
        if (!t.title?.trim() || !t.specialist?.trim()) return 'every task needs a title and a specialist';
        for (const d of t.dependsOn ?? []) if (!titles.has(d)) return `task "${t.title}" depends on unknown task "${d}"`;
      }
    }
    const b = input.budget;
    if (b) for (const k of ['llmCalls', 'toolCalls', 'tokens', 'maxTasks'] as const) {
      if (b[k] !== undefined && (!Number.isFinite(b[k]) || b[k]! < 0)) return `budget ${k} must be a positive number`;
    }
    return undefined;
  }

  /**
   * Creates a temporary, permanent or recurring goal. A goal whose
   * `instanceKey` already exists (live or archived) is not created again:
   * `created` is false and the live one, if any, is returned.
   */
  async createManagedGoal(input: NewGoalInput): Promise<{ goal: Goal; created: boolean }> {
    this.ensureInit();
    const problem = this.validateGoalInput(input);
    if (problem) throw new Error(`Goal not created: ${problem}.`);
    if (input.instanceKey) {
      const existing = this.db.data.goals.find((g) => g.instanceKey === input.instanceKey);
      if (existing) return { goal: existing, created: false };
      const archived = this.db.data.archive!.find((a) => a.instanceKey === input.instanceKey);
      if (archived) {
        const goal = this.readArchivedGoal(archived.id);
        if (goal) return { goal, created: false };
      }
    }
    const now = this.now();
    const objective = input.objective.trim();
    const goal: Goal = {
      id: newId(input.kind === 'recurring' ? 'rgoal' : input.kind === 'permanent' ? 'pgoal' : 'tgoal'),
      description: (input.title?.trim() || objective.split('\n')[0]!).slice(0, 200),
      status: 'pending',
      source: input.source ?? 'cli',
      retries: 0,
      maxRetries: input.maxRetries ?? 3,
      priority: Math.max(1, Math.min(10, Math.round(input.priority ?? 5))),
      createdAt: now,
      updatedAt: now,
      metadata: {},
      kind: input.kind,
      objective,
      successCriteria: criteriaFrom(input.successCriteria),
      constraints: (input.constraints ?? []).map((c) => c.trim()).filter(Boolean),
      policy: { ...(input.policy ?? {}) },
      ...(input.budget ? { budget: { ...input.budget } } : {}),
      usage: zeroUsage(now),
      history: [],
      cycles: 0,
      consecutiveFailures: 0,
      ...(input.schedule ? { schedule: input.schedule } : {}),
      ...(input.triggers?.length ? { triggers: [...new Set(input.triggers)] } : {}),
      ...(input.parentGoalId ? { parentGoalId: input.parentGoalId } : {}),
      ...(input.instanceKey ? { instanceKey: input.instanceKey } : {}),
    };
    if (input.milestones?.length) {
      goal.milestones = input.milestones.map((m): Milestone => {
        const def = typeof m === 'string' ? { title: m } : m;
        return { id: newId('ms'), title: def.title.trim(), successCriteria: criteriaFrom(def.successCriteria), status: 'pending' };
      });
    }
    if (input.tasks?.length) {
      const ids = new Map(input.tasks.map((t) => [t.title, newId('task')]));
      goal.tasks = input.tasks.map((t): GoalTask => ({
        id: ids.get(t.title)!, title: t.title.trim(), description: (t.description ?? t.title).trim(), specialist: t.specialist,
        dependsOn: (t.dependsOn ?? []).map((d) => ids.get(d)!), status: 'pending', sideEffects: t.sideEffects ?? 'none',
        attempts: 0, maxAttempts: MAX_TASK_ATTEMPTS, failures: [], createdAt: now,
      }));
    }

    // When it first runs.
    if (input.schedule) {
      goal.nextRunAt = input.schedule.type === 'once' ? input.schedule.at : nextRunAfter(input.schedule, now, now);
    } else if (input.policy?.startAfter && input.policy.startAfter > now) {
      goal.nextRunAt = input.policy.startAfter;
    }
    this.note(goal, { event: 'created', reason: `${input.kind} goal created` });
    if (input.kind === 'recurring' || (goal.nextRunAt && goal.nextRunAt > now)) {
      goal.status = 'waiting';
      goal.waitingFor = 'schedule';
    }

    this.db.data.goals.push(goal);
    await this.persistImmediate();
    console.log(`[GoalManager] 🎯 ${input.kind} goal created [priority ${goal.priority}]: "${goal.id}" — "${goal.description.slice(0, 80)}"`);
    this.emit('goal_created', goal);
    return { goal, created: true };
  }

  /** Goals, optionally of some kinds or statuses. */
  listGoals(filter: { kinds?: GoalKind[]; statuses?: GoalStatus[] } = {}): Goal[] {
    this.ensureInit();
    return this.db.data.goals.filter((g) =>
      (!filter.kinds || filter.kinds.includes(goalKind(g)))
      && (!filter.statuses || filter.statuses.includes(g.status)));
  }

  /** Marks a goal changed (fields other than status) and schedules a write. */
  touch(goal: Goal): void {
    goal.updatedAt = this.now();
    this.persist();
  }

  /**
   * Moves finished managed goals older than the retention period (default 7
   * days, JARVIS_GOAL_RETENTION_DAYS) to data/runtime/goal-archive/<id>.json.
   * The full record is written before it leaves the live store; a reference
   * stays in the store. Recurring templates stay live. Returns the ids archived.
   */
  async archiveFinished(now?: number, keepMs = retentionMs()): Promise<string[]> {
    now ??= this.now();
    this.ensureInit();
    const due = this.db.data.goals.filter((g) =>
      isManaged(g) && goalKind(g) !== 'recurring' && isTerminalGoalStatus(g.status)
      && (g.completedAt ?? g.updatedAt) <= now - keepMs);
    if (!due.length) return [];
    fs.mkdirSync(this.archiveDir, { recursive: true });
    const done: string[] = [];
    for (const g of due) {
      const file = path.join(this.archiveDir, `${g.id}.json`);
      try {
        fs.writeFileSync(file, JSON.stringify(redactDeep({ ...g, archivedAt: now }), null, 2));
      } catch (err) {
        console.warn(`[GoalManager] Could not archive ${g.id}; it stays in the live store: ${(err as Error).message}`);
        continue;
      }
      this.db.data.archive!.push({
        id: g.id, kind: goalKind(g), description: g.description, status: g.status,
        ...(g.outcome ? { outcome: g.outcome } : {}), ...(g.completedAt ? { finishedAt: g.completedAt } : {}),
        archivedAt: now, file, ...(g.instanceKey ? { instanceKey: g.instanceKey } : {}),
      });
      done.push(g.id);
    }
    this.db.data.goals = this.db.data.goals.filter((g) => !done.includes(g.id));
    await this.persistImmediate();
    if (done.length) console.log(`[GoalManager] 🗄️  Archived ${done.length} finished goal(s) to ${this.archiveDir}`);
    return done;
  }

  /** References to archived goals, newest first. */
  archivedGoals(limit = 50): ArchivedGoalRef[] {
    this.ensureInit();
    return [...this.db.data.archive!].sort((a, b) => b.archivedAt - a.archivedAt).slice(0, limit);
  }

  /** The full record of an archived goal. */
  readArchivedGoal(id: string): Goal | undefined {
    const ref = this.db.data.archive?.find((a) => a.id === id);
    if (!ref) return undefined;
    try { return JSON.parse(fs.readFileSync(ref.file, 'utf8')) as Goal; } catch { return undefined; }
  }

  // ── Lessons (core/goalLearning.ts) ─────────────────────────────────────────

  addLesson(lesson: GoalLesson): void {
    this.ensureInit();
    const lessons = this.db.data.lessons!;
    lessons.push(lesson);
    if (lessons.length > MAX_LESSONS) {
      // The least useful go first: never applied, then oldest.
      lessons.sort((a, b) => (a.applied - b.applied) || (a.createdAt - b.createdAt));
      lessons.splice(0, lessons.length - MAX_LESSONS);
    }
    this.persist();
  }

  getLessons(): GoalLesson[] {
    this.ensureInit();
    return this.db.data.lessons!;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /**
   * Goals that are still actionable (pending, planning, ready, executing,
   * waiting, in_progress, or retry). `kinds` limits it (jarvis.ts pauses only
   * request goals at shutdown).
   */
  getActiveGoals(kinds?: GoalKind[]): Goal[] {
    this.ensureInit();
    const active = new Set(['pending', 'planning', 'ready', 'executing', 'waiting', 'in_progress', 'retry']);
    return this.db.data.goals.filter(g => active.has(g.status) && (!kinds || kinds.includes(goalKind(g))));
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
   * The orchestrator calls this at each phase boundary. A change the
   * lifecycle policy refuses is logged and not applied.
   */
  async updateGoalStatus(
    id: string,
    status: GoalStatus,
    extras: Partial<Pick<Goal, 'lastError' | 'planSummary' | 'taskGraphId' | 'metadata'>> = {},
    reason = 'status update',
  ): Promise<void> {
    this.ensureInit();
    const goal = this.db.data.goals.find(g => g.id === id);
    if (!goal) {
      console.warn(`[GoalManager] ⚠️  updateGoalStatus: Goal "${id}" not found.`);
      return;
    }
    if (!this.transition(goal, status, reason)) return;

    if (extras.lastError !== undefined) goal.lastError = extras.lastError;
    if (extras.planSummary !== undefined) goal.planSummary = extras.planSummary;
    if (extras.taskGraphId !== undefined) goal.taskGraphId = extras.taskGraphId;
    if (extras.metadata !== undefined) goal.metadata = { ...goal.metadata, ...extras.metadata };
    await this.persist();
  }

  /**
   * Mark goal as completed successfully.
   */
  async completeGoal(id: string, reason = 'request finished'): Promise<void> {
    await this.updateGoalStatus(id, 'completed', {}, reason);
    if (this.getGoal(id)?.status === 'completed') console.log(`[GoalManager] ✅ Goal "${id}" completed.`);
  }

  /**
   * Mark goal as failed. Increments retry counter.
   * Returns TRUE if the goal can be retried, FALSE if maxRetries exceeded.
   */
  async failGoal(id: string, error?: string): Promise<boolean> {
    this.ensureInit();
    const goal = this.db.data.goals.find(g => g.id === id);
    if (!goal) return false;
    if (isTerminalGoalStatus(goal.status)) {
      console.warn(`[GoalManager] failGoal: Goal "${id}" has already ended (${goal.status}).`);
      return false;
    }

    goal.retries++;
    goal.lastError = error;

    const canRetry = goal.retries < goal.maxRetries;

    if (!canRetry) {
      // ── SAFETY: Hard stop — prevent infinite execution loops ──────────────
      this.transition(goal, 'failed', error ?? 'failed', { quiet: true });
      console.warn(`[GoalManager] ⛔ Goal "${id}" permanently failed after ${goal.retries} retries.`);
    } else {
      this.transition(goal, 'retry', error ?? 'failed', { quiet: true });
      console.log(`[GoalManager] 🔁 Goal "${id}" failed (attempt ${goal.retries}/${goal.maxRetries}). Set to retry status.`);
    }

    await this.persist();
    return canRetry;
  }

  /**
   * Resume a paused, waiting, blocked or retry goal, or a failed one with
   * attempts left. A managed goal's stopped tasks are made ready again, each
   * with one more attempt; what failed before stays in its history. A
   * recurring goal goes back to waiting for its next due time.
   */
  async resumeGoal(id: string, reason = 'resumed by the user'): Promise<boolean> {
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

    const recurring = goalKind(goal) === 'recurring';
    if (!this.transition(goal, recurring ? 'waiting' : 'pending', reason, { event: 'resumed' })) return false;
    if (isManaged(goal)) {
      for (const t of goal.tasks ?? []) {
        if (['blocked', 'needs_review', 'waiting', 'failed', 'retry'].includes(t.status)) {
          t.status = 'ready';
          t.waitingFor = undefined;
          t.nextAttemptAt = undefined;
          t.maxAttempts = Math.max(t.maxAttempts, t.attempts + 1);
        }
      }
      goal.consecutiveFailures = 0;
      // A budget that ran out is renewed by the person who resumes the goal.
      goal.usage = zeroUsage(this.now());
      if (recurring) goal.waitingFor = 'schedule';
      else goal.nextRunAt = this.now();
    } else {
      this.db.data.activeGoalId = id;
    }
    await this.persistImmediate();
    console.log(`[GoalManager] ▶️  Goal "${id}" resumed.`);
    this.emit('goal_resumed', goal);
    return true;
  }

  /** Pauses a goal: nothing new starts until it is resumed. */
  async pauseGoal(id: string, reason = 'paused by the user'): Promise<boolean> {
    const ok = this.transition(id, 'paused', reason, { event: 'paused' });
    if (ok) await this.persistImmediate();
    return ok;
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
      const age = Math.round((this.now() - g.createdAt) / 1000);
      const kind = isManaged(g) ? ` (${goalKind(g)} goal)` : '';
      return `  [${g.status.toUpperCase()}] [P${g.priority ?? 5}] "${g.description.substring(0, 80)}"${kind} (${age}s ago, ${g.retries} retries)`;
    });

    return `Recent Goals:\n${lines.join('\n')}`;
  }

  /**
   * The most recent request goals, the newest first ("continue what I was
   * doing", P13). Goals the runtime runs are not offered there.
   */
  getRecentGoals(limit = 5, kinds: GoalKind[] = ['request']): Goal[] {
    this.ensureInit();
    return this.db.data.goals.filter((g) => kinds.includes(goalKind(g))).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  // ── Priority, Cancellation, Merge ─────────────────────────────────────────

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
    if (!this.transition(goal, 'cancelled', reason, { event: 'cancelled', quiet: true })) return false;
    goal.cancelReason = reason;
    for (const t of goal.tasks ?? []) {
      if (!['completed', 'failed', 'cancelled'].includes(t.status)) t.status = 'cancelled';
    }
    await this.persistImmediate();
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
    goal.priority = Math.max(1, Math.min(10, Math.round(priority)));
    goal.updatedAt = this.now();
    this.note(goal, { event: 'priority', reason: `priority set to ${goal.priority}` });
    await this.persist();
    console.log(`[GoalManager] 🔄 Goal "${id}" priority updated to ${goal.priority}`);
    this.emit('goal_changed', goal, goal.status, goal.status);
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
    const kinds = new Set(sources.map(goalKind));
    if (kinds.size > 1 || kinds.has('recurring')) {
      throw new Error('[GoalManager] mergeGoals: only goals of the same kind (not recurring) can be merged');
    }

    const maxPriority = Math.max(...sources.map(g => g.priority ?? 5));
    const maxRetries  = Math.max(...sources.map(g => g.maxRetries));

    // Cancel all source goals
    for (const g of sources) {
      this.transition(g, 'cancelled', 'merged into new goal', { event: 'merged', quiet: true });
      g.cancelReason = 'merged into new goal';
    }

    const now = this.now();
    const managed = isManaged(sources[0]!);
    const merged: Goal = {
      id: `goal_${now}_merged_${Math.random().toString(36).slice(2, 5)}`,
      description: mergedDescription,
      status: 'pending',
      source,
      retries: 0,
      maxRetries,
      priority: maxPriority,
      mergedFrom: sources.map(g => g.id),
      createdAt: Math.min(...sources.map((g) => g.createdAt)),
      updatedAt: now,
      metadata: {},
      ...(managed ? {
        kind: goalKind(sources[0]!), objective: mergedDescription,
        successCriteria: sources.flatMap((g) => g.successCriteria ?? []),
        constraints: [...new Set(sources.flatMap((g) => g.constraints ?? []))],
        history: [], usage: zeroUsage(now), cycles: 0, consecutiveFailures: 0,
      } : { kind: 'request' as const }),
    };
    if (managed) this.note(merged, { event: 'created', reason: `merged from ${sources.map((g) => g.id).join(', ')}` });

    this.db.data.goals.push(merged);
    if (!managed) this.db.data.activeGoalId = merged.id;
    await this.persistImmediate();
    console.log(`[GoalManager] 🔀 Merged ${sources.length} goals into "${merged.id}"`);
    if (managed) this.emit('goal_created', merged);
    return merged;
  }

  /**
   * Returns pending/retry goals sorted by priority (highest first),
   * then by createdAt ascending (oldest first among equal priority).
   * `kinds` limits it (the Goal Runtime asks for managed goals only).
   */
  getPriorityQueue(kinds?: GoalKind[]): Goal[] {
    this.ensureInit();
    const actionable = new Set(['pending', 'retry']);
    return this.db.data.goals
      .filter(g => actionable.has(g.status) && (!kinds || kinds.includes(goalKind(g))))
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
    const managed = goals.filter(isManaged);
    const count = (list: Goal[], s: GoalStatus) => list.filter(g => g.status === s).length;
    return {
      total: goals.length,
      pending: count(goals, 'pending'),
      in_progress: count(goals, 'in_progress'),
      completed: count(goals, 'completed'),
      failed: count(goals, 'failed'),
      managed: {
        total: managed.length,
        temporary: managed.filter((g) => g.kind === 'temporary').length,
        permanent: managed.filter((g) => g.kind === 'permanent').length,
        recurring: managed.filter((g) => g.kind === 'recurring').length,
        executing: count(managed, 'executing'),
        waiting: count(managed, 'waiting'),
        retry: count(managed, 'retry'),
        blocked: count(managed, 'blocked'),
        paused: count(managed, 'paused'),
        archived: this.db.data.archive?.length ?? 0,
      },
    };
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('[GoalManager] Not initialized. Call goalManager.init() first.');
    }
  }

  /** Keeps the newest MAX_STORED_GOALS request goals. Managed goals are never dropped here. */
  private prune(): void {
    const goals = this.db.data.goals;
    const requests = goals.filter((g) => !isManaged(g));
    const excess = requests.length - this.MAX_STORED_GOALS;
    if (excess <= 0) return;
    const drop = new Set(requests.slice(0, excess).map((g) => g.id));
    this.db.data.goals = goals.filter((g) => !drop.has(g.id));
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

  /**
   * Writes now and waits for it: for a task claim or a result, which must be
   * on disk before work starts or is reported (lowdb writes to a temporary
   * file and renames it, so a crash leaves the old or the new file whole).
   */
  async persistImmediate(): Promise<void> {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    await this.db.write();
  }

  /** Force-flush any pending debounced write. Call on graceful shutdown. */
  async flush(): Promise<void> {
    await this.persistImmediate();
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const goalManager = new GoalManager();
