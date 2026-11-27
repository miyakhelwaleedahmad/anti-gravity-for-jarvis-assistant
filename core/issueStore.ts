/**
 * core/issueStore.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The machine-readable record of what has gone wrong (self-healing
 * architecture, Phase 2).
 *
 * Two kinds of record, in data/repairs/ under the data root:
 *
 *   occurrences.jsonl  every observed failure, appended, never edited: its own
 *                      time, correlation id, task/goal id, redacted message and
 *                      source location (core/sourceLocation.ts). Rotated at
 *                      2 MB; the last 10 rotated files are kept.
 *   issues.json        one issue per failure signature (core/failureSignature.ts):
 *                      repeated occurrences update it rather than opening new
 *                      issues. Written atomically (temporary file, then rename).
 *
 * The ACTIVE queue is every issue not RESOLVED, CANCELLED or DUPLICATE. A
 * resolved issue leaves the queue but stays here, searchable, so a failure that
 * returns is recognised: its issue is REOPENED and its recurrence counted,
 * instead of starting from nothing.
 *
 * An issue is RESOLVED only with verification evidence: the failed effect was
 * observed working again (a ledger success for its pipeline, for a runtime or
 * external failure) or an explicit check passed. A suspected code defect is
 * never resolved by "it worked once since"; it needs a check.
 *
 * Obsidian is a human-readable mirror (core/obsidianMirror.ts), off unless
 * JARVIS_OBSIDIAN_VAULT is set. This file is the authority.
 */

import * as fs from 'fs';
import * as path from 'path';
import { dataRoot, getWorkspaceRoot } from './workspaceRoot.js';
import { failureSignature, headline, withErrorName, type FailureCategory } from './failureSignature.js';
import { sourceLocationOf, currentCommit, type SourceLocation } from './sourceLocation.js';
import { getGoalContext, getTraceId } from './traceContext.js';
import { redact } from '../security/redactor.js';
import type { HealthLedger, LedgerOutcome, LedgerPipeline } from '../monitoring/healthLedger.js';
import { mirrorIssue, type MirrorResult } from './obsidianMirror.js';

export const ISSUE_SCHEMA_VERSION = 1;

export type IssueStatus =
  | 'OPEN' | 'DIAGNOSING' | 'REPAIR_PLANNED' | 'AWAITING_APPROVAL' | 'REPAIRING'
  | 'VERIFYING' | 'RESOLVED' | 'BLOCKED' | 'CANCELLED' | 'REOPENED' | 'DUPLICATE';

export type IssueSeverity = 'low' | 'medium' | 'high';

/** Allowed status changes. Anything else is a bug in the caller and throws. */
const TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  OPEN:              ['DIAGNOSING', 'REPAIR_PLANNED', 'VERIFYING', 'BLOCKED', 'CANCELLED', 'DUPLICATE'],
  REOPENED:          ['DIAGNOSING', 'REPAIR_PLANNED', 'VERIFYING', 'BLOCKED', 'CANCELLED', 'DUPLICATE'],
  DIAGNOSING:        ['OPEN', 'REPAIR_PLANNED', 'VERIFYING', 'BLOCKED', 'CANCELLED'],
  REPAIR_PLANNED:    ['AWAITING_APPROVAL', 'REPAIRING', 'BLOCKED', 'CANCELLED'],
  AWAITING_APPROVAL: ['REPAIRING', 'BLOCKED', 'CANCELLED'],
  REPAIRING:         ['VERIFYING', 'AWAITING_APPROVAL', 'BLOCKED', 'CANCELLED'],
  VERIFYING:         ['RESOLVED', 'OPEN', 'BLOCKED', 'CANCELLED'],
  BLOCKED:           ['OPEN', 'DIAGNOSING', 'REPAIR_PLANNED', 'VERIFYING', 'CANCELLED'],
  RESOLVED:          ['REOPENED'],
  CANCELLED:         ['REOPENED'],
  DUPLICATE:         [],
};

const INACTIVE: IssueStatus[] = ['RESOLVED', 'CANCELLED', 'DUPLICATE'];

/** Statuses a success of the same effect may resolve (not while a repair run owns the issue). */
const EFFECT_RESOLVABLE: IssueStatus[] = ['OPEN', 'REOPENED', 'DIAGNOSING', 'BLOCKED', 'VERIFYING'];

/** Categories where "the effect worked again" is enough evidence. A code defect needs a check. */
const EFFECT_CATEGORIES: FailureCategory[] = ['runtime', 'external', 'environment', 'unknown'];

/** Pipelines whose success proves the same effect (one tool's success says nothing about another's). */
const EFFECT_PIPELINES: LedgerPipeline[] = ['brain_to_tts', 'stt_to_brain', 'wake_to_stt', 'brain_to_llm'];

const RECENT_PER_ISSUE = 20;
const MAX_CORRELATION_IDS = 50;
const MAX_CLOSED_ISSUES = 1000;
const ROTATE_BYTES = 2 * 1024 * 1024;
const KEEP_ROTATED = 10;
const MESSAGE_CAP = 500;

export interface OccurrenceInput {
  /** Which part of JARVIS: "tool:open_app", "service:tts", "brain_to_llm", "orchestrator", … */
  component: string;
  message: string;
  /** The thrown value or a traceback text, for the source location. */
  error?: unknown;
  tool?: string;
  code?: string;
  pipeline?: string;
  /** Defaults to the current trace id. */
  correlationId?: string;
  /** Defaults to the current goal task, if any. */
  taskId?: string;
  goalId?: string;
  severity?: IssueSeverity;
  at?: number;
}

export interface Occurrence {
  occurrenceId: string;
  issueId: string;
  signature: string;
  at: string;
  /** The request it happened in, or "UNKNOWN" when it happened outside one. */
  correlationId: string;
  taskId?: string;
  goalId?: string;
  component: string;
  tool?: string;
  pipeline?: string;
  category: FailureCategory;
  /** Redacted, at most 500 characters. */
  message: string;
  source: SourceLocation;
}

export interface Verification {
  passed: boolean;
  /** What was checked and what was seen. */
  evidence: string;
  at: string;
}

export interface Issue {
  issueId: string;
  signature: string;
  normalized: string;
  status: IssueStatus;
  severity: IssueSeverity;
  category: FailureCategory;
  component: string;
  tool?: string;
  pipeline?: string;
  /** Redacted message of the first occurrence. */
  summary: string;
  firstSeen: string;
  lastSeen: string;
  occurrenceCount: number;
  /** Times the issue came back after being resolved or cancelled. */
  recurrenceCount: number;
  correlationIds: string[];
  goalId?: string;
  taskId?: string;
  /** Source location of the latest occurrence. */
  sourceLocation: SourceLocation;
  /** The latest occurrences (all of them are in occurrences.jsonl). */
  recent: Occurrence[];
  diagnosis: {
    facts: string[];
    hypotheses: string[];
    confidence: 'none' | 'low' | 'medium' | 'high';
    reproduced: 'yes' | 'no' | 'not_tried';
  };
  environment: { platform: string; node: string; commit: string };
  /** RepairRun ids that worked on this issue (core/repairRun.ts). */
  runIds: string[];
  nextAction?: string;
  blockedReason?: string;
  verification?: Verification;
  resolvedAt?: string;
  duplicateOf?: string;
  history: { at: string; from: IssueStatus | null; to: IssueStatus; reason: string }[];
  obsidian?: MirrorResult;
}

interface IssueFile {
  schemaVersion: number;
  issues: Issue[];
}

export function isActive(issue: Issue): boolean {
  return !INACTIVE.includes(issue.status);
}

function baseSeverity(category: FailureCategory): IssueSeverity {
  if (category === 'code_defect') return 'high';
  if (category === 'permission') return 'low';
  return 'medium';
}

function raise(s: IssueSeverity): IssueSeverity {
  return s === 'low' ? 'medium' : 'high';
}

export class IssueStore {
  private issues = new Map<string, Issue>();
  private loaded = false;
  private dirty = new Set<string>();
  private resolvedListeners = new Set<(issue: Issue) => void>();
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  /** Set when the file on disk could not be read as ours; the store then refuses to overwrite it. */
  loadProblem: string | null = null;
  private readOnly = false;
  private ledgerDetach: (() => void) | null = null;

  constructor(private readonly dirOverride?: string) {}

  /** data/repairs under the data root (read on every call, so tests can move it). */
  dir(): string {
    return this.dirOverride ?? path.join(dataRoot(getWorkspaceRoot()), 'data', 'repairs');
  }
  private issuesPath(): string { return path.join(this.dir(), 'issues.json'); }
  occurrencesPath(): string { return path.join(this.dir(), 'occurrences.jsonl'); }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = this.issuesPath();
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }   // no file yet
    let parsed: IssueFile;
    try {
      parsed = JSON.parse(text) as IssueFile;
      if (!parsed || !Array.isArray(parsed.issues)) throw new Error('no issues list');
    } catch (err) {
      const aside = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, aside); } catch { /* left in place; it is overwritten on the next write */ }
      this.loadProblem = `issues.json could not be read (${(err as Error).message}); it was moved to ${path.basename(aside)} and the store started empty`;
      console.warn(`[IssueStore] ⚠️ ${this.loadProblem}`);
      return;
    }
    if (parsed.schemaVersion !== ISSUE_SCHEMA_VERSION) {
      this.readOnly = true;
      this.loadProblem = `issues.json has schema version ${String(parsed.schemaVersion)}, this JARVIS reads ${ISSUE_SCHEMA_VERSION}: the file is left untouched and new issues are kept in memory only`;
      console.warn(`[IssueStore] ⚠️ ${this.loadProblem}`);
      return;
    }
    for (const issue of parsed.issues) this.issues.set(issue.issueId, issue);
  }

  /** Record one observed failure. Returns the issue it belongs to and the occurrence. */
  recordOccurrence(input: OccurrenceInput): { issue: Issue; occurrence: Occurrence; isNew: boolean; reopened: boolean } {
    this.load();
    const at = new Date(input.at ?? Date.now()).toISOString();
    const message = redact(withErrorName(String(input.message ?? ''), input.error)).slice(0, MESSAGE_CAP);
    const sig = failureSignature({ component: input.component, message, ...(input.tool ? { tool: input.tool } : {}), ...(input.code ? { code: input.code } : {}) });
    const issueId = `iss-${sig.id.slice(4)}`;
    const goal = getGoalContext();
    const correlationId = input.correlationId ?? getTraceId() ?? 'UNKNOWN';
    const taskId = input.taskId ?? goal?.goalTaskId;
    const goalId = input.goalId ?? goal?.goalId;
    // Without a thrown value, the message itself may still be a traceback (Python services report them as text).
    const source = sourceLocationOf(input.error !== undefined ? input.error : message);
    const occurrence: Occurrence = {
      occurrenceId: `occ-${Date.now().toString(36)}-${(this.seq++).toString(36)}`,
      issueId,
      signature: sig.id,
      at,
      correlationId,
      ...(taskId ? { taskId } : {}),
      ...(goalId ? { goalId } : {}),
      component: input.component,
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.pipeline ? { pipeline: input.pipeline } : {}),
      category: sig.category,
      message,
      source,
    };
    this.appendOccurrence(occurrence);

    let issue = this.issues.get(issueId);
    let isNew = false;
    let reopened = false;
    if (!issue) {
      isNew = true;
      issue = {
        issueId,
        signature: sig.id,
        normalized: sig.normalized,
        status: 'OPEN',
        severity: input.severity ?? baseSeverity(sig.category),
        category: sig.category,
        component: input.component,
        ...(input.tool ? { tool: input.tool } : {}),
        ...(input.pipeline ? { pipeline: input.pipeline } : {}),
        summary: headline(message).slice(0, 240),
        firstSeen: at,
        lastSeen: at,
        occurrenceCount: 0,
        recurrenceCount: 0,
        correlationIds: [],
        sourceLocation: source,
        recent: [],
        diagnosis: { facts: [], hypotheses: [], confidence: 'none', reproduced: 'not_tried' },
        environment: { platform: process.platform, node: process.version, commit: currentCommit() },
        runIds: [],
        history: [{ at, from: null, to: 'OPEN', reason: 'first occurrence' }],
      };
      this.issues.set(issueId, issue);
    } else if (issue.status === 'RESOLVED' || issue.status === 'CANCELLED') {
      reopened = true;
      issue.recurrenceCount += 1;
      this.move(issue, 'REOPENED', `the failure returned after being ${issue.status.toLowerCase()} (${issue.resolvedAt ?? issue.lastSeen})`, at);
      delete issue.verification;
      delete issue.resolvedAt;
      delete issue.blockedReason;
    }
    issue.lastSeen = at;
    issue.occurrenceCount += 1;
    issue.sourceLocation = source;
    if (taskId) issue.taskId = taskId;
    if (goalId) issue.goalId = goalId;
    if (correlationId !== 'UNKNOWN' && !issue.correlationIds.includes(correlationId)) {
      issue.correlationIds.push(correlationId);
      if (issue.correlationIds.length > MAX_CORRELATION_IDS) issue.correlationIds.splice(0, issue.correlationIds.length - MAX_CORRELATION_IDS);
    }
    issue.recent.push(occurrence);
    if (issue.recent.length > RECENT_PER_ISSUE) issue.recent.splice(0, issue.recent.length - RECENT_PER_ISSUE);
    if (issue.occurrenceCount === 3 && !input.severity) issue.severity = raise(issue.severity);
    this.markDirty(issue.issueId);
    return { issue, occurrence, isNew, reopened };
  }

  /** Change an issue's status. Throws on a change the lifecycle does not allow. */
  transition(issueId: string, to: IssueStatus, reason: string, extra: { blockedReason?: string; nextAction?: string; runId?: string; duplicateOf?: string } = {}): Issue {
    const issue = this.require(issueId);
    if (to === 'RESOLVED') throw new Error('use resolve(): an issue is resolved only with verification evidence');
    this.move(issue, to, reason);
    if (to === 'BLOCKED') issue.blockedReason = extra.blockedReason ?? reason;
    else delete issue.blockedReason;
    if (extra.nextAction !== undefined) issue.nextAction = extra.nextAction;
    if (extra.runId && !issue.runIds.includes(extra.runId)) issue.runIds.push(extra.runId);
    if (to === 'DUPLICATE') {
      if (!extra.duplicateOf) throw new Error('DUPLICATE needs duplicateOf');
      this.require(extra.duplicateOf);
      issue.duplicateOf = extra.duplicateOf;
    }
    this.markDirty(issueId);
    return issue;
  }

  /**
   * Resolve with evidence. A failed or empty verification does not resolve:
   * it is recorded and the issue goes back to OPEN.
   */
  resolve(issueId: string, check: { passed: boolean; evidence: string }, at = Date.now()): Issue {
    const issue = this.require(issueId);
    const evidence = redact(String(check.evidence ?? '')).trim().slice(0, MESSAGE_CAP);
    const iso = new Date(at).toISOString();
    if (!evidence) throw new Error('resolve() needs evidence: what was checked and what was seen');
    if (issue.status !== 'VERIFYING') this.move(issue, 'VERIFYING', 'verification started', iso);
    issue.verification = { passed: check.passed, evidence, at: iso };
    if (check.passed) {
      this.move(issue, 'RESOLVED', `verified: ${evidence}`, iso);
      issue.resolvedAt = iso;
      delete issue.blockedReason;
      delete issue.nextAction;
      for (const fn of this.resolvedListeners) {
        try { fn(issue); } catch (err) { console.warn('[IssueStore] ⚠️ a resolution listener failed:', (err as Error).message); }
      }
    } else {
      this.move(issue, 'OPEN', `verification failed: ${evidence}`, iso);
    }
    this.markDirty(issueId);
    return issue;
  }

  /** Called after each verified resolution (the second brain turns it into a lesson). Returns an unsubscribe. */
  onResolved(fn: (issue: Issue) => void): () => void {
    this.resolvedListeners.add(fn);
    return () => { this.resolvedListeners.delete(fn); };
  }

  /** Add a diagnosis fact or hypothesis (kept separate: a hypothesis is not a fact). */
  note(issueId: string, kind: 'fact' | 'hypothesis', text: string): Issue {
    const issue = this.require(issueId);
    const list = kind === 'fact' ? issue.diagnosis.facts : issue.diagnosis.hypotheses;
    list.push(redact(text).slice(0, MESSAGE_CAP));
    this.markDirty(issueId);
    return issue;
  }

  /**
   * The effect of a pipeline was observed working: resolve its open runtime /
   * external / environment / unknown issues last seen before this success.
   */
  noteEffectOk(pipeline: string, cause: string, at = Date.now()): Issue[] {
    this.load();
    if (!EFFECT_PIPELINES.includes(pipeline as LedgerPipeline)) return [];
    const resolved: Issue[] = [];
    for (const issue of this.issues.values()) {
      if (issue.pipeline !== pipeline || !EFFECT_RESOLVABLE.includes(issue.status)) continue;
      if (!EFFECT_CATEGORIES.includes(issue.category)) continue;
      if (Date.parse(issue.lastSeen) > at) continue;
      resolved.push(this.resolve(issue.issueId, { passed: true, evidence: `${pipeline} worked again: ${cause}` }, at));
    }
    return resolved;
  }

  /** Follow a health ledger: failures become occurrences, successes resolve what they prove. */
  attachLedger(ledger: HealthLedger): () => void {
    this.ledgerDetach?.();
    const onOutcome = (o: LedgerOutcome) => {
      try {
        if (o.ok) this.noteEffectOk(o.pipeline, o.cause, o.at);
        // Tool failures are recorded where they happen, with their stack.
        else if (o.pipeline !== 'tool_execution') {
          this.recordOccurrence({ component: o.pipeline, pipeline: o.pipeline, message: o.cause, at: o.at, ...(o.correlationId ? { correlationId: o.correlationId } : {}) });
        }
      } catch (err) {
        console.warn('[IssueStore] ⚠️ could not record a health outcome:', (err as Error).message);
      }
    };
    ledger.on('outcome', onOutcome);
    this.ledgerDetach = () => { ledger.off('outcome', onOutcome); this.ledgerDetach = null; };
    return this.ledgerDetach;
  }

  get(issueId: string): Issue | undefined {
    this.load();
    return this.issues.get(issueId);
  }

  /** Issues being worked on or waiting, most recent first. */
  active(): Issue[] {
    this.load();
    return [...this.issues.values()].filter(isActive).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  /** Every issue, active and closed, most recent first. */
  all(): Issue[] {
    this.load();
    return [...this.issues.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  /** Closed issues whose summary, component, signature or location mention the text. */
  searchHistory(text: string): Issue[] {
    const q = text.toLowerCase();
    return this.all().filter((i) => !isActive(i) && [i.summary, i.component, i.signature, i.normalized, i.tool ?? '', i.sourceLocation.file ?? '']
      .some((s) => s.toLowerCase().includes(q)));
  }

  /** The issue of the latest occurrence for a correlation id (or overall). */
  latest(correlationId?: string): Issue | undefined {
    const list = this.all().filter((i) => !correlationId || i.correlationIds.includes(correlationId));
    return list[0];
  }

  /** Occurrences on disk for an issue, oldest first (the current file only). */
  occurrencesOf(issueId: string): Occurrence[] {
    let text = '';
    try { text = fs.readFileSync(this.occurrencesPath(), 'utf8'); } catch { return []; }
    const out: Occurrence[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as Occurrence;
        if (o.issueId === issueId) out.push(o);
      } catch { /* a torn last line from a crash: skipped, the rest is intact */ }
    }
    return out;
  }

  /** Write pending changes now (and mirror them). */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.dirty.size === 0) return;
    const changed = [...this.dirty];
    this.dirty.clear();
    if (!this.readOnly) this.writeIssues();
    for (const id of changed) {
      const issue = this.issues.get(id);
      if (!issue) continue;
      try { issue.obsidian = mirrorIssue(issue); }
      catch (err) { issue.obsidian = { syncStatus: 'failed', error: (err as Error).message }; }
    }
    // The sync status itself is part of the record.
    if (!this.readOnly && changed.length > 0) this.writeIssues();
  }

  /** For tests: forget the in-memory state (the files are left alone). */
  reset(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.issues.clear();
    this.dirty.clear();
    this.loaded = false;
    this.readOnly = false;
    this.loadProblem = null;
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private require(issueId: string): Issue {
    this.load();
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`no issue ${issueId}`);
    return issue;
  }

  private move(issue: Issue, to: IssueStatus, reason: string, at = new Date().toISOString()): void {
    const from = issue.status;
    if (!TRANSITIONS[from].includes(to)) throw new Error(`issue ${issue.issueId}: ${from} → ${to} is not allowed`);
    issue.status = to;
    issue.history.push({ at, from, to, reason: redact(reason).slice(0, MESSAGE_CAP) });
    if (issue.history.length > 100) issue.history.splice(0, issue.history.length - 100);
  }

  private markDirty(issueId: string): void {
    this.dirty.add(issueId);
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 250);
    this.timer.unref?.();
  }

  private writeIssues(): void {
    // Keep closed history bounded: the oldest closed issues go first (their occurrences stay in the log).
    const closed = [...this.issues.values()].filter((i) => !isActive(i)).sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
    for (const old of closed.slice(0, Math.max(0, closed.length - MAX_CLOSED_ISSUES))) this.issues.delete(old.issueId);
    const file = this.issuesPath();
    const body: IssueFile = { schemaVersion: ISSUE_SCHEMA_VERSION, issues: [...this.issues.values()] };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn('[IssueStore] ⚠️ could not write issues.json:', (err as Error).message);
    }
  }

  private appendOccurrence(o: Occurrence): void {
    const file = this.occurrencesPath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > ROTATE_BYTES) this.rotate(file);
      } catch { /* no file yet */ }
      fs.appendFileSync(file, JSON.stringify(o) + '\n');
    } catch (err) {
      console.warn('[IssueStore] ⚠️ could not append an occurrence:', (err as Error).message);
    }
  }

  private rotate(file: string): void {
    const dir = path.dirname(file);
    fs.renameSync(file, path.join(dir, `occurrences-${Date.now()}.jsonl`));
    const rotated = fs.readdirSync(dir).filter((f) => /^occurrences-\d+\.jsonl$/.test(f)).sort();
    for (const old of rotated.slice(0, Math.max(0, rotated.length - KEEP_ROTATED))) {
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* already gone */ }
    }
  }
}

export const issueStore = new IssueStore();

let exitHooked = false;
/** Start recording: follow the health ledger and write pending changes on exit. Idempotent. */
export function startIssueRecording(ledger: HealthLedger): void {
  issueStore.attachLedger(ledger);
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => { try { issueStore.flush(); } catch { /* exiting */ } });
}

/** Record a failure without letting the recording itself break the caller. */
export function recordFailure(input: OccurrenceInput): Issue | undefined {
  try {
    return issueStore.recordOccurrence(input).issue;
  } catch (err) {
    console.warn('[IssueStore] ⚠️ could not record a failure:', (err as Error).message);
    return undefined;
  }
}
