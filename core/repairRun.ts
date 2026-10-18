/**
 * core/repairRun.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "Heal yourself": bounded repair of runtime failures, checked by the same
 * effect that failed (self-healing architecture, Phase 4).
 *
 * Runtime only. The one repair action is restarting a voice service JARVIS
 * started (selfHealingManager.restartService), which stops the old process
 * first. Everything else ends BLOCKED with the reason and what the owner can
 * do: a suspected code defect (code repair in an isolated worktree is not
 * enabled), the language model provider, something missing on this machine,
 * a tool failure. A refusal or a denied approval is the safety system, not a
 * fault, and is skipped.
 *
 * Checked by the effect:
 *   speech output       after the restart, a short phrase is spoken and the
 *                       run waits for tts.py to report it played
 *   speech recognition, after the restart, the service must reconnect; it is
 *   wake word           proven only by a transcript or a detection, which
 *                       needs you to speak, so the run ends WAITING_FOR_EVIDENCE
 *                       and the issue closes itself on the next success
 *
 * Bounded: one active run; at most 2 attempts per service and 20 minutes per
 * run (JARVIS_REPAIR_MAX_ATTEMPTS, JARVIS_REPAIR_MAX_MINUTES); a token cap
 * (JARVIS_REPAIR_TOKEN_CAP; runtime repair makes no model request, so it uses
 * 0); the same failure twice in a row stops the run (no progress). Runs are
 * kept in data/repairs/runs/; a run that JARVIS's restart interrupted resumes
 * as AWAITING_APPROVAL and continues only when you say so.
 */

import * as fs from 'fs';
import * as path from 'path';
import { dataRoot, getWorkspaceRoot } from './workspaceRoot.js';
import { failureSignature } from './failureSignature.js';
import { issueStore as defaultStore, isActive, type Issue, type IssueStore } from './issueStore.js';
import { healthLedger as defaultLedger, ledgerLabel, type HealthLedger, type LedgerOutcome, type LedgerPipeline } from '../monitoring/healthLedger.js';
import { redact } from '../security/redactor.js';
import type { CheckItem } from './selfCheck.js';

export type RunStatus =
  | 'PLANNED' | 'REPAIRING' | 'VERIFYING' | 'AWAITING_APPROVAL'
  | 'SUCCEEDED' | 'WAITING_FOR_EVIDENCE' | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'NOTHING_TO_REPAIR';

const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  PLANNED:              ['REPAIRING', 'BLOCKED', 'CANCELLED', 'NOTHING_TO_REPAIR', 'FAILED'],
  REPAIRING:            ['VERIFYING', 'REPAIRING', 'BLOCKED', 'FAILED', 'CANCELLED', 'AWAITING_APPROVAL', 'SUCCEEDED', 'WAITING_FOR_EVIDENCE'],
  VERIFYING:            ['REPAIRING', 'SUCCEEDED', 'WAITING_FOR_EVIDENCE', 'FAILED', 'BLOCKED', 'CANCELLED', 'AWAITING_APPROVAL'],
  AWAITING_APPROVAL:    ['REPAIRING', 'CANCELLED'],
  SUCCEEDED:            [],
  WAITING_FOR_EVIDENCE: [],
  FAILED:               [],
  BLOCKED:              [],
  CANCELLED:            [],
  NOTHING_TO_REPAIR:    [],
};

const ACTIVE_RUN: RunStatus[] = ['PLANNED', 'REPAIRING', 'VERIFYING', 'AWAITING_APPROVAL'];

/** What a run does about one issue. */
export type RepairPlan =
  | { kind: 'restart'; label: 'TTS' | 'STT' | 'WakeWord'; role: 'tts' | 'stt' | 'wakeword'; pipeline: LedgerPipeline; verify: 'probe' | 'evidence' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'skip'; reason: string };

export interface RunAttempt {
  n: number;
  label: string;
  startedAt: string;
  action: string;
  result: 'passed' | 'failed' | 'waiting' | 'blocked' | 'cancelled';
  evidence: string;
}

export interface RepairRunRecord {
  runId: string;
  status: RunStatus;
  scope: 'all' | 'last';
  issueIds: string[];
  startedAt: string;
  finishedAt?: string;
  source?: 'voice' | 'cli';
  budget: { maxAttempts: number; maxMinutes: number; tokenCap: number; tokensUsed: number };
  attempts: RunAttempt[];
  /** One per issue: what was done and how it ended. */
  items: CheckItem[];
  summary: string;
  blockedReason?: string;
  history: { at: string; from: RunStatus | null; to: RunStatus; reason: string }[];
}

export interface RepairDeps {
  store?: IssueStore;
  ledger?: HealthLedger;
  /** Restart a service (selfHealingManager.restartService by default). */
  restart?: (label: string) => Promise<{ ok: boolean; reason: string }>;
  /** Whether the bridge role is connected (nodeBridge.getReadyClients by default). */
  connected?: (role: string) => boolean;
  /** Speak the check phrase (nodeBridge.speakToClients by default). */
  speakProbe?: (text: string) => void;
  /** Say the outcome of a finished run (when the conversation is idle, by default). */
  notify?: (text: string) => void;
  now?: () => number;
  /** Polling step and waits (tests shorten them). */
  timing?: { pollMs?: number; reconnectMs?: number; probeMs?: number };
  dir?: string;
}

export const PROBE_PHRASE = 'Speech check.';

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

/** What a run may do about an issue: one allow-listed runtime action, or why not. */
export function planFor(issue: Issue): RepairPlan {
  const c = issue.component.toLowerCase();
  const p = issue.pipeline;
  if (issue.category === 'permission') {
    return { kind: 'skip', reason: 'a refusal or a denied approval is the safety system working, not a fault' };
  }
  if (issue.category === 'code_defect') {
    const where = issue.sourceLocation.status === 'KNOWN' ? ` at ${issue.sourceLocation.file}:${issue.sourceLocation.line}` : '';
    return { kind: 'blocked', reason: `it looks like a fault in JARVIS's code${where}; a code change is needed, and code repair (in an isolated worktree, with your typed approval) is not enabled` };
  }
  if (issue.category === 'environment') {
    return { kind: 'blocked', reason: `something is missing on this machine (${issue.summary.slice(0, 120)}); it needs installing or connecting by you` };
  }
  if (p === 'brain_to_tts' || c === 'service:tts') return { kind: 'restart', label: 'TTS', role: 'tts', pipeline: 'brain_to_tts', verify: 'probe' };
  if (p === 'stt_to_brain' || c === 'service:stt') return { kind: 'restart', label: 'STT', role: 'stt', pipeline: 'stt_to_brain', verify: 'evidence' };
  if (p === 'wake_to_stt' || c === 'service:wakeword') return { kind: 'restart', label: 'WakeWord', role: 'wakeword', pipeline: 'wake_to_stt', verify: 'evidence' };
  if (p === 'brain_to_llm' || issue.category === 'external') {
    return { kind: 'blocked', reason: `the language model or another outside service failed (${issue.summary.slice(0, 120)}); check the API key, quota and network — JARVIS cannot repair that itself` };
  }
  if (c.startsWith('tool:')) {
    return { kind: 'blocked', reason: `no safe runtime action exists for a failed tool (${issue.tool ?? c.slice(5)}); it is tried again on the next request` };
  }
  return { kind: 'blocked', reason: 'no known safe repair for this failure' };
}

export class RepairRunner {
  private runs = new Map<string, RepairRunRecord>();
  private loaded = false;
  private cancelRequested = new Set<string>();
  private running: Promise<RepairRunRecord> | null = null;
  private seq = 0;

  constructor(private readonly deps: RepairDeps = {}) {}

  private get store(): IssueStore { return this.deps.store ?? defaultStore; }
  private get ledger(): HealthLedger { return this.deps.ledger ?? defaultLedger; }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  dir(): string { return this.deps.dir ?? path.join(dataRoot(getWorkspaceRoot()), 'data', 'repairs', 'runs'); }

  /** Read the runs on disk; a run that was in progress when JARVIS stopped now waits for your answer. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let files: string[] = [];
    try { files = fs.readdirSync(this.dir()).filter((f) => /^run-[\w-]+\.json$/.test(f)); } catch { return; }
    for (const f of files) {
      try {
        const run = JSON.parse(fs.readFileSync(path.join(this.dir(), f), 'utf8')) as RepairRunRecord;
        if (!run?.runId || !run.status) continue;
        this.runs.set(run.runId, run);
        if (run.status === 'PLANNED' || run.status === 'REPAIRING' || run.status === 'VERIFYING') {
          this.move(run, 'AWAITING_APPROVAL', 'JARVIS restarted while this repair was in progress; it continues only when you say "continue the repair"');
          run.summary = 'Interrupted by a restart of JARVIS; waiting for you to continue or stop it.';
          this.save(run);
        }
      } catch (err) {
        console.warn(`[RepairRun] ⚠️ could not read ${f}: ${(err as Error).message}`);
      }
    }
  }

  /** The run in progress or waiting for your answer, if any. */
  active(): RepairRunRecord | undefined {
    this.load();
    return [...this.runs.values()].find((r) => ACTIVE_RUN.includes(r.status));
  }

  latest(): RepairRunRecord | undefined {
    this.load();
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  }

  get(runId: string): RepairRunRecord | undefined {
    this.load();
    return this.runs.get(runId);
  }

  /**
   * Start a run over the active issues (scope "all") or the latest one ("last").
   * Returns at once with the plan; the repair itself runs in the background
   * (`settled` resolves with the finished run).
   */
  start(scope: 'all' | 'last', source?: 'voice' | 'cli'): { run: RepairRunRecord; reply: string; settled: Promise<RepairRunRecord> } {
    this.load();
    const current = this.active();
    if (current) {
      const reply = current.status === 'AWAITING_APPROVAL'
        ? `A repair was interrupted and is waiting for you, sir: ${current.summary} Say "continue the repair" or "stop healing".`
        : `A repair is already running, sir (${current.runId}). Say "stop healing" to stop it.`;
      return { run: current, reply, settled: this.running ?? Promise.resolve(current) };
    }
    const all = this.store.active();
    const issues = scope === 'last' ? all.slice(0, 1) : all;
    const at = new Date(this.now()).toISOString();
    const run: RepairRunRecord = {
      runId: `run-${at.replace(/[-:.TZ]/g, '').slice(0, 14)}-${(this.seq++).toString(36)}`,
      status: 'PLANNED',
      scope,
      issueIds: issues.map((i) => i.issueId),
      startedAt: at,
      ...(source ? { source } : {}),
      budget: {
        maxAttempts: envInt('JARVIS_REPAIR_MAX_ATTEMPTS', 2, 1, 5),
        maxMinutes: envInt('JARVIS_REPAIR_MAX_MINUTES', 20, 1, 120),
        tokenCap: envInt('JARVIS_REPAIR_TOKEN_CAP', 20_000, 0, 1_000_000),
        tokensUsed: 0,
      },
      attempts: [],
      items: [],
      summary: '',
      history: [{ at, from: null, to: 'PLANNED', reason: `${scope === 'last' ? 'repair the latest issue' : 'heal'}: ${issues.length} active issue(s)` }],
    };
    this.runs.set(run.runId, run);

    if (issues.length === 0) {
      this.finish(run, 'NOTHING_TO_REPAIR', 'No open issue is recorded, so there was nothing to repair.');
      return { run, reply: '', settled: Promise.resolve(run) };
    }

    const plans = issues.map((i) => ({ issue: i, plan: planFor(i) }));
    const restarts = plans.filter((p) => p.plan.kind === 'restart');
    const blocked = plans.filter((p) => p.plan.kind === 'blocked');
    for (const { issue, plan } of plans) {
      if (plan.kind === 'restart') continue;
      run.items.push({ name: issue.component, state: plan.kind === 'skip' ? 'SKIPPED' : 'BLOCKED', detail: plan.reason });
      if (plan.kind === 'blocked') this.blockIssue(issue, plan.reason, run.runId);
    }
    const labels = [...new Set(restarts.map((r) => (r.plan as Extract<RepairPlan, { kind: 'restart' }>).label))];
    const parts: string[] = [];
    if (labels.length) parts.push(`Healing, sir: restarting ${labels.map(labelName).join(' and ')}, then checking that ${labels.length === 1 ? 'it works' : 'they work'}.`);
    else parts.push('Nothing here can be repaired at runtime, sir.');
    if (blocked.length) parts.push(`${blocked.length} issue${blocked.length === 1 ? ' needs' : 's need'} you: ${blocked.map((b) => b.issue.component).join(', ')}. Say "why can't you fix it" for the reasons.`);
    this.save(run);

    if (restarts.length === 0) {
      this.finish(run, blocked.length ? 'BLOCKED' : 'NOTHING_TO_REPAIR', blocked.length ? `Blocked: ${blocked.map((b) => `${b.issue.component} (${(b.plan as { reason: string }).reason})`).join('; ')}` : 'Only refusals were recorded; nothing to repair.');
      if (blocked.length) run.blockedReason = (blocked[0]!.plan as { reason: string }).reason;
      this.save(run);
      return { run, reply: parts.join(' '), settled: Promise.resolve(run) };
    }

    const settled = this.execute(run, restarts.map((r) => ({ issue: r.issue, plan: r.plan as Extract<RepairPlan, { kind: 'restart' }> })))
      .catch((err) => {
        this.finish(run, 'FAILED', `The repair stopped on an error: ${redact((err as Error).message)}`);
        return run;
      })
      .finally(() => { this.running = null; });
    this.running = settled;
    void settled.then((r) => this.announce(r));
    return { run, reply: parts.join(' '), settled };
  }

  /** Continue a run that waits for approval (after JARVIS restarted mid-repair). */
  resume(): { reply: string; settled?: Promise<RepairRunRecord> } {
    const run = this.active();
    if (!run || run.status !== 'AWAITING_APPROVAL') return { reply: 'No repair is waiting to be continued, sir.' };
    const issues = run.issueIds.map((id) => this.store.get(id)).filter((i): i is Issue => !!i && isActive(i));
    const restarts = issues.map((i) => ({ issue: i, plan: planFor(i) })).filter((p) => p.plan.kind === 'restart') as { issue: Issue; plan: Extract<RepairPlan, { kind: 'restart' }> }[];
    if (restarts.length === 0) {
      this.move(run, 'REPAIRING', 'continued by you');
      this.finish(run, 'SUCCEEDED', 'Continued: none of its issues is still open.');
      return { reply: 'Continued, sir: none of the issues of that repair is still open.' };
    }
    this.move(run, 'REPAIRING', 'continued by you');
    const settled = this.execute(run, restarts).finally(() => { this.running = null; });
    this.running = settled;
    void settled.then((r) => this.announce(r));
    return { reply: `Continuing the repair, sir: ${[...new Set(restarts.map((r) => labelName(r.plan.label)))].join(' and ')}.`, settled };
  }

  /** "Stop healing": no new action starts; the record is kept. */
  stop(): string {
    const run = this.active();
    if (!run) return 'No repair is running, sir.';
    if (run.status === 'AWAITING_APPROVAL' || run.status === 'PLANNED') {
      this.finish(run, 'CANCELLED', 'Stopped by you before it continued.');
      return 'Stopped, sir. The repair will not continue; its record is kept.';
    }
    this.cancelRequested.add(run.runId);
    return 'Stopping the repair, sir. A restart already under way finishes; nothing new starts.';
  }

  /** "Why can't you fix it?": the reasons of the latest run, or of the open issues. */
  explainBlock(): string {
    const run = this.latest();
    const blocked = run?.items.filter((i) => i.state === 'BLOCKED' || i.state === 'FAILING') ?? [];
    if (run && blocked.length) {
      return `From the last repair, sir: ${blocked.map((b) => `${b.name}: ${b.detail}`).join('. ')}.`;
    }
    const open = this.store.active().map((i) => ({ i, p: planFor(i) })).filter((x) => x.p.kind !== 'restart');
    if (open.length) return `Sir, ${open.map(({ i, p }) => `${i.component}: ${(p as { reason: string }).reason}`).join('. ')}.`;
    if (run) return `The last repair (${run.runId}) is ${run.status.toLowerCase()}: ${run.summary}`;
    return 'Nothing is blocked, sir: no repair has run and no open issue needs you.';
  }

  // ─── the run ─────────────────────────────────────────────────────────────────

  private async execute(run: RepairRunRecord, work: { issue: Issue; plan: Extract<RepairPlan, { kind: 'restart' }> }[]): Promise<RepairRunRecord> {
    if (!this.deps.connected || !this.deps.speakProbe) await ensureBridge();
    const deadline = Date.parse(run.startedAt) + run.budget.maxMinutes * 60_000;
    const byLabel = new Map<string, { plan: Extract<RepairPlan, { kind: 'restart' }>; issues: Issue[] }>();
    for (const w of work) {
      const g = byLabel.get(w.plan.label) ?? { plan: w.plan, issues: [] };
      g.issues.push(w.issue);
      byLabel.set(w.plan.label, g);
    }
    if (run.status === 'PLANNED') this.move(run, 'REPAIRING', 'starting');
    const outcomes: RunStatus[] = [];

    for (const { plan, issues } of byLabel.values()) {
      for (const issue of issues) this.toRepairing(issue, run.runId);
      let lastCause: string | undefined;
      let ended: RunStatus | undefined;
      const done = run.attempts.filter((a) => a.label === plan.label).length;
      for (let n = done + 1; n <= run.budget.maxAttempts; n++) {
        if (this.cancelRequested.has(run.runId)) { ended = 'CANCELLED'; break; }
        if (this.now() > deadline) { ended = 'FAILED'; this.itemFor(run, plan, issues, 'FAILING', `the ${run.budget.maxMinutes}-minute budget was used up`); break; }
        if (run.status !== 'REPAIRING') this.move(run, 'REPAIRING', `attempt ${n} for ${plan.label}`);
        const attempt: RunAttempt = { n, label: plan.label, startedAt: new Date(this.now()).toISOString(), action: `restart ${plan.label}`, result: 'failed', evidence: '' };
        run.attempts.push(attempt);
        this.save(run);

        const restarted = await (this.deps.restart ?? defaultRestart)(plan.label);
        if (!restarted.ok) {
          attempt.result = 'blocked';
          attempt.evidence = restarted.reason;
          ended = 'BLOCKED';
          this.itemFor(run, plan, issues, 'BLOCKED', restarted.reason);
          for (const i of issues) this.blockIssue(this.store.get(i.issueId) ?? i, restarted.reason, run.runId);
          break;
        }
        this.move(run, 'VERIFYING', `${plan.label} restarted; checking the effect`);
        this.save(run);
        const check = await this.verify(run, plan);
        attempt.evidence = check.evidence;
        if (check.result === 'cancelled') { attempt.result = 'cancelled'; ended = 'CANCELLED'; break; }
        if (check.result === 'passed') {
          attempt.result = 'passed';
          for (const i of issues) {
            const cur = this.store.get(i.issueId);
            if (cur && isActive(cur)) this.store.resolve(cur.issueId, { passed: true, evidence: check.evidence });
          }
          this.itemFor(run, plan, issues, 'VERIFIED', check.evidence);
          ended = 'SUCCEEDED';
          break;
        }
        if (check.result === 'waiting') {
          attempt.result = 'waiting';
          for (const i of issues) {
            const cur = this.store.get(i.issueId);
            if (cur && cur.status === 'REPAIRING') this.store.transition(cur.issueId, 'VERIFYING', 'restarted and reconnected; waiting for a real outcome', { nextAction: `speak to JARVIS: the issue closes when ${ledgerLabel(plan.pipeline)} works again` });
          }
          this.itemFor(run, plan, issues, 'NOT_VERIFIED', check.evidence);
          ended = 'WAITING_FOR_EVIDENCE';
          break;
        }
        // Failed: the same failure twice is no progress.
        const cause = failureSignature({ component: plan.label, message: check.evidence }).id;
        if (lastCause && cause === lastCause) {
          ended = 'FAILED';
          this.itemFor(run, plan, issues, 'FAILING', `no progress: the same failure twice (${check.evidence})`);
          break;
        }
        lastCause = cause;
        if (n === run.budget.maxAttempts) {
          ended = 'FAILED';
          this.itemFor(run, plan, issues, 'FAILING', `${run.budget.maxAttempts} attempts, still failing: ${check.evidence}`);
        }
      }
      if (ended === 'FAILED') {
        for (const i of issues) {
          const cur = this.store.get(i.issueId);
          if (cur && isActive(cur)) {
            if (cur.status === 'REPAIRING') this.store.transition(cur.issueId, 'VERIFYING', 'the repair attempts ended');
            if (this.store.get(cur.issueId)!.status === 'VERIFYING') this.store.resolve(cur.issueId, { passed: false, evidence: run.items[run.items.length - 1]?.detail ?? 'the check failed' });
          }
        }
      }
      if (ended === 'CANCELLED') {
        this.itemFor(run, plan, issues, 'SKIPPED', 'stopped by you');
        outcomes.push('CANCELLED');
        break;
      }
      outcomes.push(ended ?? 'FAILED');
    }

    const final: RunStatus = outcomes.includes('CANCELLED') ? 'CANCELLED'
      : outcomes.includes('FAILED') ? 'FAILED'
      : outcomes.includes('BLOCKED') ? 'BLOCKED'
      : outcomes.includes('WAITING_FOR_EVIDENCE') ? 'WAITING_FOR_EVIDENCE'
      : run.items.some((i) => i.state === 'BLOCKED') ? 'BLOCKED'
      : 'SUCCEEDED';
    this.cancelRequested.delete(run.runId);
    this.finish(run, final, summarise(run));
    return run;
  }

  /** Wait for the service to reconnect, then for the effect itself. */
  private async verify(run: RepairRunRecord, plan: Extract<RepairPlan, { kind: 'restart' }>): Promise<{ result: 'passed' | 'failed' | 'waiting' | 'cancelled'; evidence: string }> {
    const t = this.deps.timing ?? {};
    const poll = t.pollMs ?? 250;
    const connected = this.deps.connected ?? defaultConnected;
    const reconnectBy = this.now() + (t.reconnectMs ?? 60_000);
    while (!connected(plan.role)) {
      if (this.cancelRequested.has(run.runId)) return { result: 'cancelled', evidence: 'stopped by you while waiting for the service' };
      if (this.now() > reconnectBy) return { result: 'failed', evidence: `${plan.label} did not reconnect within ${Math.round((t.reconnectMs ?? 60_000) / 1000)} s` };
      await sleep(poll);
    }
    if (plan.verify === 'evidence') {
      return { result: 'waiting', evidence: `${plan.label} reconnected; ${ledgerLabel(plan.pipeline)} is proven only by a real ${plan.pipeline === 'wake_to_stt' ? 'wake-word detection' : 'transcript'}, which needs you to speak` };
    }
    // Speech output: say a short phrase and wait for tts.py's own report.
    const since = this.now();
    const outcome = new Promise<LedgerOutcome | undefined>((resolve) => {
      // Not unref'd: the wait is bounded, and the run must not be dropped by an idle event loop.
      const timer = setTimeout(() => { this.ledger.off('outcome', on); resolve(undefined); }, t.probeMs ?? 30_000);
      const on = (o: LedgerOutcome) => {
        if (o.pipeline !== plan.pipeline || o.at < since) return;
        clearTimeout(timer);
        this.ledger.off('outcome', on);
        resolve(o);
      };
      this.ledger.on('outcome', on);
    });
    (this.deps.speakProbe ?? defaultSpeak)(PROBE_PHRASE);
    const o = await outcome;
    if (!o) return { result: 'failed', evidence: `no report from speech output within ${Math.round((t.probeMs ?? 30_000) / 1000)} s of the check phrase` };
    return o.ok
      ? { result: 'passed', evidence: `the check phrase played (${o.cause})` }
      : { result: 'failed', evidence: `the check phrase did not play (${o.cause})` };
  }

  // ─── records ─────────────────────────────────────────────────────────────────

  private itemFor(run: RepairRunRecord, plan: Extract<RepairPlan, { kind: 'restart' }>, issues: Issue[], state: CheckItem['state'], detail: string): void {
    const name = `${labelName(plan.label)} (${issues.map((i) => i.issueId).join(', ')})`;
    run.items = run.items.filter((i) => i.name !== name);
    run.items.push({ name, state, detail: redact(detail).slice(0, 300) });
  }

  private toRepairing(issue: Issue, runId: string): void {
    const cur = this.store.get(issue.issueId);
    if (!cur || !isActive(cur)) return;
    if (cur.status === 'VERIFYING') this.store.transition(cur.issueId, 'OPEN', 'a new repair run starts');
    const s = this.store.get(cur.issueId)!.status;
    if (s === 'OPEN' || s === 'REOPENED' || s === 'DIAGNOSING' || s === 'BLOCKED') this.store.transition(cur.issueId, 'REPAIR_PLANNED', 'restart planned', { runId });
    if (this.store.get(cur.issueId)!.status === 'REPAIR_PLANNED') this.store.transition(cur.issueId, 'REPAIRING', 'restarting the service', { runId });
  }

  private blockIssue(issue: Issue, reason: string, runId: string): void {
    const cur = this.store.get(issue.issueId);
    if (!cur || !isActive(cur) || cur.status === 'BLOCKED') return;
    try {
      if (cur.status === 'REPAIR_PLANNED' || cur.status === 'AWAITING_APPROVAL' || cur.status === 'REPAIRING' || cur.status === 'VERIFYING'
        || cur.status === 'OPEN' || cur.status === 'REOPENED' || cur.status === 'DIAGNOSING') {
        this.store.transition(cur.issueId, 'BLOCKED', reason, { blockedReason: reason, runId });
      }
    } catch (err) {
      console.warn(`[RepairRun] could not mark ${cur.issueId} blocked: ${(err as Error).message}`);
    }
  }

  private move(run: RepairRunRecord, to: RunStatus, reason: string): void {
    const from = run.status;
    if (from !== to && !RUN_TRANSITIONS[from].includes(to)) throw new Error(`repair run ${run.runId}: ${from} → ${to} is not allowed`);
    if (from === to) return;
    run.status = to;
    run.history.push({ at: new Date(this.now()).toISOString(), from, to, reason: redact(reason).slice(0, 300) });
  }

  private finish(run: RepairRunRecord, to: RunStatus, summary: string): void {
    this.move(run, to, summary);
    run.summary = redact(summary).slice(0, 600);
    run.finishedAt = new Date(this.now()).toISOString();
    this.save(run);
  }

  private save(run: RepairRunRecord): void {
    try {
      fs.mkdirSync(this.dir(), { recursive: true });
      const file = path.join(this.dir(), `${run.runId}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(run, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn(`[RepairRun] ⚠️ could not save ${run.runId}: ${(err as Error).message}`);
    }
    try { this.store.flush(); } catch { /* the store logs its own write problems */ }
  }

  private announce(run: RepairRunRecord): void {
    const text = spokenResult(run);
    try { (this.deps.notify ?? defaultNotify)(text); } catch { /* best effort */ }
  }

  /** For tests: forget the in-memory runs. */
  reset(): void {
    this.runs.clear();
    this.loaded = false;
    this.cancelRequested.clear();
    this.running = null;
  }
}

function labelName(label: string): string {
  return label === 'TTS' ? 'speech output' : label === 'STT' ? 'speech recognition' : label === 'WakeWord' ? 'the wake word' : label;
}

function summarise(run: RepairRunRecord): string {
  const v = run.items.filter((i) => i.state === 'VERIFIED').length;
  const parts = [`${v} of ${run.items.length} verified working after the repair`];
  for (const state of ['FAILING', 'BLOCKED', 'NOT_VERIFIED', 'SKIPPED'] as const) {
    const n = run.items.filter((i) => i.state === state).length;
    if (n) parts.push(`${n} ${state === 'FAILING' ? 'still failing' : state === 'NOT_VERIFIED' ? 'waiting for a real outcome' : state.toLowerCase()}`);
  }
  return `${parts.join(', ')}. Model tokens used: ${run.budget.tokensUsed}.`;
}

/** What JARVIS says when a run ends: what was checked, never "all fixed". */
export function spokenResult(run: RepairRunRecord): string {
  const lines = run.items.map((i) => `${i.name}: ${i.state === 'VERIFIED' ? 'checked, it works' : i.state === 'NOT_VERIFIED' ? 'restarted; it is confirmed when you next use it' : i.state === 'SKIPPED' ? 'skipped' : i.state === 'BLOCKED' ? 'needs you' : 'still failing'}`);
  const head = run.status === 'SUCCEEDED' ? 'Repair finished, sir.'
    : run.status === 'WAITING_FOR_EVIDENCE' ? 'Repair done as far as I can check, sir.'
    : run.status === 'CANCELLED' ? 'Repair stopped, sir.'
    : run.status === 'NOTHING_TO_REPAIR' ? 'Nothing to repair, sir.'
    : run.status === 'BLOCKED' ? 'I could not repair everything, sir.'
    : 'The repair did not work, sir.';
  return `${head} ${lines.join('. ')}${lines.length ? '.' : ''}`.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function defaultRestart(label: string): Promise<{ ok: boolean; reason: string }> {
  const { selfHealingManager } = await import('../self_healing/selfHealingManager.js');
  return selfHealingManager.restartService(label);
}

let bridgeRef: { getReadyClients(): string[]; speakToClients(t: string, o?: { allowRepeat?: boolean }): void } | undefined;
/** Loaded when a run needs it, not on import (tests of the run logic have no bridge). */
async function ensureBridge(): Promise<void> {
  if (bridgeRef) return;
  try { bridgeRef = (await import('../bridge/nodeBridge.js')).nodeBridge; } catch { /* no bridge in this process */ }
}

function defaultConnected(role: string): boolean {
  return bridgeRef?.getReadyClients().includes(role) ?? false;
}

function defaultSpeak(text: string): void {
  // The same phrase twice (a second attempt) must not be dropped as a repeat.
  bridgeRef?.speakToClients(text, { allowRepeat: true });
}

function defaultNotify(text: string): void {
  void Promise.all([import('./conversationBus.js'), ensureBridge()]).then(([{ conversationBus }]) => {
    const say = () => bridgeRef?.speakToClients(text);
    if (conversationBus.isIdle) say();
    else conversationBus.onceIdle(say);
  }).catch(() => console.log(`[RepairRun] ${text}`));
  console.log(`[RepairRun] ${text}`);
}

export const repairRunner = new RepairRunner();
