/**
 * core/selfCheck.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only answers about JARVIS itself (self-healing architecture, Phase 3):
 *
 *   quick   "check yourself"         the health ledger and the open issues
 *   full    "run a full self-check"  the same, plus every service probe and
 *                                    what is not observed at all
 *   report  "show the repair report" the latest repair run and recent issues
 *   stuck   "why are you stuck?"     state, time in it, the step running, what
 *                                    it waits for, blocked goals and agents
 *
 * Nothing here changes anything: no restart, no repair, no file written.
 *
 * Every item is one of VERIFIED (observed working), FAILING, BLOCKED (cannot
 * work until something else does), NOT_VERIFIED (no recent evidence) or
 * SKIPPED. A report never says that everything works or that all errors are
 * fixed: it says how many checks were verified, of how many, and what was not
 * looked at (tests/selfCheckTest.ts holds every reply to that rule).
 */

import { healthLedger, ledgerLabel, LEDGER_PIPELINES, type LedgerStatus } from '../monitoring/healthLedger.js';
import { issueStore, type Issue } from './issueStore.js';
import { getRequestText, getTraceId } from './traceContext.js';

export type CheckState = 'VERIFIED' | 'FAILING' | 'BLOCKED' | 'NOT_VERIFIED' | 'SKIPPED';

export interface CheckItem {
  name: string;
  state: CheckState;
  detail: string;
}

export type SelfCheckMode = 'quick' | 'full' | 'report' | 'stuck';

export interface SelfCheckReport {
  mode: SelfCheckMode;
  at: string;
  items: CheckItem[];
  /** Active issues, most recent first (at most 10). */
  issues: { issueId: string; status: string; component: string; summary: string; occurrences: number; lastSeen: string; location: string }[];
  /** One or two sentences to say. */
  spoken: string;
  /** Lines for the console / the typed reply. */
  details: string[];
}

/** What was running when a request arrived, taken before the new request replaced it. */
export interface InFlightSnapshot {
  at: number;
  state: string;
  stateSince?: number;
  request?: string;
  traceId?: string;
  graph?: { goal: string; status: string; createdAt: number; running: { tool: string; startedAt?: number }[]; failed: string[] };
  approval?: string;
}

/** What the full self-check reads about Chrome (phase A5b). Reading it starts nothing. */
export interface ChromeFacts {
  /** JARVIS's Chrome (or the one on JARVIS_CDP_PORT), running and answering. */
  running?: { port: number };
  /** JARVIS_CDP_PORT, when the owner set it. */
  fixedPort?: number;
  /** Where Chrome is installed, if it was found. */
  installedPath?: string;
  /** JARVIS_CHROME_AUTOSTART is off: JARVIS does not start its Chrome (review B1). */
  autostartOff?: boolean;
}

/** `slow`: no answer within the wait, which is not proof that PowerShell cannot work (review B3). */
export type PowerShellAnswer = { ok: true; version: string } | { ok: false; reason: string; slow?: boolean };

/** The parts of JARVIS a check reads; real ones by default, stand-ins in tests. */
export interface SelfCheckDeps {
  connectedRoles?: () => string[];
  services?: () => Promise<{ name: string; status: string; detail?: string; fallback?: boolean }[]>;
  chrome?: () => Promise<ChromeFacts>;
  powershell?: () => Promise<PowerShellAnswer>;
  platform?: () => NodeJS.Platform;
  permission?: () => { level: number; remainingSeconds: number | null } | Promise<{ level: number; remainingSeconds: number | null }>;
  goals?: () => { id: string; title?: string; objective?: string; status: string; blockedReason?: string; waitingFor?: string }[];
  agents?: () => { running: number; waiting: number; agents: { name: string; status: string; task?: string; progress?: string }[] };
  latestRun?: () => { runId: string; status: string; issueId?: string; startedAt: string; finishedAt?: string; summary: string; items?: CheckItem[] } | undefined;
  now?: () => number;
}

const SNAPSHOT_FRESH_MS = 10_000;
let lastSnapshot: InFlightSnapshot | undefined;

/** Called by the orchestrator before a "why are you stuck?" request supersedes the one in flight. */
export function noteInFlight(snapshot: InFlightSnapshot): void {
  lastSnapshot = snapshot;
}

/** The name a ledger pipeline is said by; the tools pipeline is the last tool call (phase A5b, TRA-08). */
function pipelineName(p: LedgerStatus['pipeline']): string {
  return p === LEDGER_PIPELINES.tools ? 'last tool call' : ledgerLabel(p);
}

function ledgerItem(s: LedgerStatus, now = Date.now()): CheckItem {
  const name = pipelineName(s.pipeline);
  let detail = s.detail;
  if (s.pipeline === LEDGER_PIPELINES.tools) {
    // What ran and when, not "working" (review B2); the note only where it could be misread.
    detail = s.state === 'healthy' && s.last
      ? `${s.last.cause} ${Math.round((now - s.last.at) / 1000)} s ago; not a check of what the tools can do`
      : s.detail.replace(/^tools: /, '');
  }
  if (s.state === 'healthy') return { name, state: 'VERIFIED', detail };
  if (s.state === 'degraded' || s.state === 'failing') return { name, state: s.blockedBy ? 'BLOCKED' : 'FAILING', detail };
  return { name, state: 'NOT_VERIFIED', detail };
}

function serviceItem(s: { name: string; status: string; detail?: string; fallback?: boolean }): CheckItem {
  // Redis on the in-memory cache works by design, but it is not Redis (phase A5b, owner Q1).
  if (s.fallback) return { name: `service ${s.name}`, state: 'NOT_VERIFIED', detail: 'Redis is not connected; JARVIS uses its in-memory cache instead' };
  const state: CheckState = s.status === 'online' ? 'VERIFIED' : s.status === 'offline' || s.status === 'degraded' ? 'FAILING' : 'NOT_VERIFIED';
  return { name: `service ${s.name}`, state, detail: s.detail ?? s.status };
}

const CHROME_ITEM = 'Chrome for web pages';
const POWERSHELL_ITEM = 'PowerShell for desktop control';
const POWERSHELL_WAIT_MS = 5_000;

async function defaultChrome(): Promise<ChromeFacts> {
  const { jarvisChrome, findChrome } = await import('../control/jarvisChrome.js');
  const fixed = Number(process.env['JARVIS_CDP_PORT']);
  const running = await jarvisChrome.running();
  const installedPath = findChrome();
  return {
    ...(running ? { running: { port: running.port } } : {}),
    ...(Number.isInteger(fixed) && fixed > 0 && fixed < 65536 ? { fixedPort: fixed } : {}),
    ...(installedPath ? { installedPath } : {}),
    // The same rule as jarvisChrome's start (control/jarvisChrome.ts).
    ...(/^(off|0|false|no)$/i.test(process.env['JARVIS_CHROME_AUTOSTART']?.trim() ?? '') ? { autostartOff: true } : {}),
  };
}

/** JARVIS's Chrome, read only: running, installed but not running (owner Q2), or missing. */
async function chromeItem(deps: SelfCheckDeps): Promise<CheckItem> {
  try {
    const c = await (deps.chrome ?? defaultChrome)();
    if (c.running) return { name: CHROME_ITEM, state: 'VERIFIED', detail: `Chrome is running and answers on port ${c.running.port}` };
    if (c.fixedPort) return { name: CHROME_ITEM, state: 'FAILING', detail: `nothing answers on JARVIS_CDP_PORT ${c.fixedPort}, so JARVIS can't open or read web pages` };
    if (c.installedPath && c.autostartOff) return { name: CHROME_ITEM, state: 'BLOCKED', detail: `not running, and JARVIS_CHROME_AUTOSTART is off, so JARVIS will not start it (Chrome found: ${c.installedPath})` };
    if (c.installedPath) return { name: CHROME_ITEM, state: 'NOT_VERIFIED', detail: `not running; it starts when JARVIS opens a page (Chrome found: ${c.installedPath})` };
    return { name: CHROME_ITEM, state: 'FAILING', detail: "Chrome is not installed where JARVIS looks (or JARVIS_CHROME_PATH is wrong), so web pages can't open" };
  } catch (err) {
    return { name: CHROME_ITEM, state: 'FAILING', detail: `the check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function defaultPowerShell(): Promise<PowerShellAnswer> {
  const { execFile } = await import('child_process');
  const { childEnv } = await import('../system/childEnv.js');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
      { timeout: POWERSHELL_WAIT_MS, windowsHide: true, env: childEnv() },
      (err, stdout) => {
        const version = String(stdout ?? '').trim();
        if (err) resolve(err.killed ? { ok: false, reason: `no answer within ${POWERSHELL_WAIT_MS / 1000} s`, slow: true } : { ok: false, reason: err.message });
        else if (!version) resolve({ ok: false, reason: 'it printed no version' });
        else resolve({ ok: true, version });
      });
  });
}

/** PowerShell, which desktop control runs through: asked only on Windows. */
async function powershellItem(deps: SelfCheckDeps): Promise<CheckItem> {
  const platform = deps.platform ? deps.platform() : process.platform;
  if (platform !== 'win32') return { name: POWERSHELL_ITEM, state: 'BLOCKED', detail: 'desktop control needs Windows, and this computer is not running Windows' };
  try {
    const r = await (deps.powershell ?? defaultPowerShell)();
    if (r.ok) return { name: POWERSHELL_ITEM, state: 'VERIFIED', detail: `PowerShell ${r.version} answers` };
    if (r.slow) return { name: POWERSHELL_ITEM, state: 'NOT_VERIFIED', detail: `PowerShell did not answer within ${POWERSHELL_WAIT_MS / 1000} s; it may only be slow to start, so desktop control was not checked` };
    return { name: POWERSHELL_ITEM, state: 'FAILING', detail: `PowerShell did not answer (${r.reason}), so desktop control cannot work` };
  } catch (err) {
    return { name: POWERSHELL_ITEM, state: 'FAILING', detail: `the check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function defaultPermission(): Promise<{ level: number; remainingSeconds: number | null }> {
  const { permissionSession } = await import('../control/permissionSession.js');
  return { level: permissionSession.getCurrentLevel(), remainingSeconds: permissionSession.getRemainingSeconds() };
}

/** The permission level, said as a line, not counted as a check (phase A5b). */
async function permissionLine(deps: SelfCheckDeps): Promise<{ said: string; problem?: string }> {
  try {
    const p = await (deps.permission ?? defaultPermission)();
    if (p.level === 2) {
      if (p.remainingSeconds === null) return { said: 'full control' };
      return { said: p.remainingSeconds < 60 ? 'full control, less than 1 min left' : `full control, ${Math.round(p.remainingSeconds / 60)} min left` };
    }
    if (p.level === 1) return { said: 'level 1, safe control' };
    if (p.level === 0) return { said: 'level 0, read only' };
    return { said: `level ${p.level}` };
  } catch (err) {
    return { said: 'not read', problem: err instanceof Error ? err.message : String(err) };
  }
}

function issueLine(i: Issue): SelfCheckReport['issues'][number] {
  const l = i.sourceLocation;
  return {
    issueId: i.issueId, status: i.status, component: i.component, summary: i.summary,
    occurrences: i.occurrenceCount, lastSeen: i.lastSeen,
    location: l.status === 'KNOWN' ? `${l.file}:${l.line}` : l.status,
  };
}

function count(items: CheckItem[], state: CheckState): number {
  return items.filter((i) => i.state === state).length;
}

/** "3 of 5 checks verified, 1 failing (speech output), 1 not verified yet." */
export function tally(items: CheckItem[]): string {
  const v = count(items, 'VERIFIED');
  const parts = [`${v} of ${items.length} checks verified`];
  const failing = items.filter((i) => i.state === 'FAILING');
  const blocked = items.filter((i) => i.state === 'BLOCKED');
  const unverified = count(items, 'NOT_VERIFIED');
  const skipped = count(items, 'SKIPPED');
  if (failing.length) parts.push(`${failing.length} failing (${failing.map((i) => i.name).join(', ')})`);
  if (blocked.length) parts.push(`${blocked.length} blocked (${blocked.map((i) => i.name).join(', ')})`);
  if (unverified) parts.push(`${unverified} not verified yet`);
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.join(', ');
}

function issuesSentence(issues: Issue[]): string {
  if (issues.length === 0) return 'No open issues are recorded.';
  const top = issues[0]!;
  return `${issues.length} open issue${issues.length === 1 ? '' : 's'}; the latest: ${top.component}, ${top.summary.slice(0, 90)} (seen ${top.occurrenceCount} time${top.occurrenceCount === 1 ? '' : 's'}).`;
}

function itemLines(items: CheckItem[]): string[] {
  return items.map((i) => `  [${i.state}] ${i.name}: ${i.detail}`);
}

async function defaultConnectedRoles(): Promise<string[] | undefined> {
  try {
    const { nodeBridge } = await import('../bridge/nodeBridge.js');
    return nodeBridge.getReadyClients();
  } catch { return undefined; }
}

async function defaultServices(): Promise<{ name: string; status: string; detail?: string }[]> {
  const { healthManager } = await import('../monitoring/healthManager.js');
  const snap = await healthManager.probe();
  return Object.values(snap.services).map((s) => ({ name: s.name, status: s.status, ...(s.detail ? { detail: s.detail } : {}), ...(s.fallback ? { fallback: true } : {}) }));
}

/** Health ledger + open issues ("check yourself"); with `full`, every service probe too. */
export async function healthCheck(full: boolean, deps: SelfCheckDeps = {}): Promise<SelfCheckReport> {
  const now = deps.now?.() ?? Date.now();
  const roles = deps.connectedRoles ? deps.connectedRoles() : await defaultConnectedRoles();
  const items = healthLedger.all(roles, now).map((s) => ledgerItem(s, now));
  if (full) {
    try {
      const services = await (deps.services ?? defaultServices)();
      items.push(...services.map(serviceItem));
    } catch (err) {
      items.push({ name: 'service probes', state: 'SKIPPED', detail: `the probe failed: ${(err as Error).message}` });
    }
    // Chrome and PowerShell in the full self-check only (phase A5b, owner Q3).
    items.push(...await Promise.all([chromeItem(deps), powershellItem(deps)]));
  }
  const permission = await permissionLine(deps);
  const issues = issueStore.active();
  const head = full ? 'Full self-check' : 'Self-check';
  const spoken = `${head}: ${tally(items)}. ${issuesSentence(issues)} Permission: ${permission.said}.`;
  const details = [
    `${head} (read-only; nothing was changed):`,
    `Permission: ${permission.said}${permission.problem ? ` (${permission.problem})` : ''}`,
    ...itemLines(items),
    `Open issues: ${issues.length}`,
    ...issues.slice(0, 10).map((i) => `  ${i.issueId} [${i.status}] ${i.component}: ${i.summary} ×${i.occurrenceCount} (${issueLine(i).location})`),
  ];
  if (full) {
    details.push(
      'Not observed by these checks: failures outside tool calls, speech, the wake word, the language model,',
      'the Python services and goal tasks; and a pipeline marked "not verified" has had no outcome this run.',
      'Chrome and PowerShell are checked only for whether they answer, not for every action that uses them.',
    );
  }
  if (issueStore.loadProblem) details.push(`Issue record: ${issueStore.loadProblem}`);
  return { mode: full ? 'full' : 'quick', at: new Date(now).toISOString(), items, issues: issues.slice(0, 10).map(issueLine), spoken, details };
}

/** The latest repair run, if any, and what the issue record says ("show the repair report"). */
export async function repairReport(deps: SelfCheckDeps = {}): Promise<SelfCheckReport> {
  const now = deps.now?.() ?? Date.now();
  const run = deps.latestRun ? deps.latestRun() : await defaultLatestRun();
  const active = issueStore.active();
  const weekAgo = now - 7 * 24 * 3600_000;
  const resolved = issueStore.all().filter((i) => i.status === 'RESOLVED' && i.resolvedAt && Date.parse(i.resolvedAt) >= weekAgo);
  const items = run?.items ?? [];
  const runSentence = run
    ? `The latest repair run, ${run.runId}, is ${run.status.toLowerCase()}: ${run.summary}`
    : 'No repair run has been recorded.';
  const spoken = `${runSentence} ${issuesSentence(active)} ${resolved.length} issue${resolved.length === 1 ? ' was' : 's were'} resolved with evidence in the last 7 days.`;
  const details = [
    'Repair report (read-only):',
    runSentence,
    ...(run ? [`  started ${run.startedAt}${run.finishedAt ? `, finished ${run.finishedAt}` : ''}${run.issueId ? `, issue ${run.issueId}` : ''}`, ...itemLines(items)] : []),
    `Open issues: ${active.length}`,
    ...active.slice(0, 10).map((i) => `  ${i.issueId} [${i.status}] ${i.component}: ${i.summary}${i.blockedReason ? ` — blocked: ${i.blockedReason}` : ''}`),
    `Resolved in the last 7 days: ${resolved.length}`,
    ...resolved.slice(0, 10).map((i) => `  ${i.issueId} ${i.component}: ${i.verification?.evidence ?? ''}`),
    `Full record: ${issueStore.dir()} (issues.json, occurrences.jsonl)`,
  ];
  return { mode: 'report', at: new Date(now).toISOString(), items, issues: active.slice(0, 10).map(issueLine), spoken, details };
}

async function defaultLatestRun(): Promise<ReturnType<NonNullable<SelfCheckDeps['latestRun']>>> {
  const { repairRunner } = await import('./repairRun.js');
  return repairRunner.latest();
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

async function defaultGoals(): Promise<NonNullable<ReturnType<NonNullable<SelfCheckDeps['goals']>>>> {
  const { goalManager } = await import('./goalManager.js');
  return goalManager.listGoals({ statuses: ['waiting', 'blocked', 'retry'] }) as never;
}

async function defaultAgents(): Promise<ReturnType<NonNullable<SelfCheckDeps['agents']>>> {
  const { agentManager } = await import('./agents/agentManager.js');
  return agentManager.status();
}

/**
 * "Why are you stuck?": what was running when the question came (taken before
 * the question replaced it), background goals that wait or are blocked, agents
 * that run or wait, and the latest failures. Read-only.
 */
export async function investigateStuck(deps: SelfCheckDeps & { snapshot?: InFlightSnapshot } = {}): Promise<SelfCheckReport> {
  const now = deps.now?.() ?? Date.now();
  const snap = deps.snapshot ?? (lastSnapshot && now - lastSnapshot.at <= SNAPSHOT_FRESH_MS ? lastSnapshot : undefined);
  const items: CheckItem[] = [];
  const findings: string[] = [];

  if (snap) {
    // A running graph or a waiting approval is work in flight even if the state
    // machine was reset to IDLE meanwhile (its watchdogs do that).
    const busy = (snap.state !== 'IDLE' && snap.state !== 'LISTENING') || !!snap.graph || !!snap.approval;
    const since = snap.stateSince ? ` for ${ago(snap.at - snap.stateSince)}` : '';
    if (busy) {
      const running = snap.graph?.running ?? [];
      const step = running.length
        ? running.map((r) => `${r.tool}${r.startedAt ? ` (running ${ago(snap.at - r.startedAt)})` : ''}`).join(', ')
        : 'no step was running';
      const what = snap.request ? ` on "${snap.request.slice(0, 80)}"` : '';
      const idleState = snap.state === 'IDLE' || snap.state === 'LISTENING';
      const doing = idleState ? `A request was still in flight${what}` : `I was ${snap.state.toLowerCase()}${since}${what}`;
      findings.push(`${doing}; ${step}.${snap.approval ? ` It was waiting for your answer: ${snap.approval}.` : ''} Asking stopped that request; background goals and agents keep running.`);
      items.push({ name: 'foreground request', state: snap.approval ? 'BLOCKED' : 'NOT_VERIFIED', detail: `${snap.state}${since}; ${step}${snap.approval ? `; waiting for approval: ${snap.approval}` : ''}` });
    } else {
      items.push({ name: 'foreground request', state: 'VERIFIED', detail: `idle (${snap.state}): no request was running` });
    }
    if (snap.graph?.failed.length) findings.push(`Failed steps: ${snap.graph.failed.join(', ')}.`);
  } else {
    items.push({ name: 'foreground request', state: 'SKIPPED', detail: 'no snapshot of the request in flight was taken' });
  }

  try {
    const goals = deps.goals ? deps.goals() : await defaultGoals();
    for (const g of goals.slice(0, 5)) {
      const why = g.blockedReason ?? g.waitingFor ?? g.status;
      items.push({ name: `goal ${g.title ?? g.objective ?? g.id}`.slice(0, 80), state: g.status === 'blocked' ? 'BLOCKED' : 'NOT_VERIFIED', detail: `${g.status}: ${why}` });
    }
    if (goals.length) findings.push(`${goals.length} background goal${goals.length === 1 ? ' is' : 's are'} waiting or blocked; the first: ${(goals[0]!.title ?? goals[0]!.objective ?? goals[0]!.id).slice(0, 60)} (${goals[0]!.blockedReason ?? goals[0]!.waitingFor ?? goals[0]!.status}).`);
  } catch (err) {
    items.push({ name: 'goals', state: 'SKIPPED', detail: `could not read the goals: ${(err as Error).message}` });
  }

  try {
    const a = deps.agents ? deps.agents() : await defaultAgents();
    if (a.running || a.waiting) {
      findings.push(`${a.running} agent${a.running === 1 ? '' : 's'} running, ${a.waiting} waiting.`);
      for (const ag of a.agents.slice(0, 5)) items.push({ name: `agent ${ag.name}`, state: ag.status === 'WAITING' ? 'BLOCKED' : 'NOT_VERIFIED', detail: `${ag.status}${ag.task ? `: ${ag.task.slice(0, 60)}` : ''}${ag.progress ? ` (${ag.progress})` : ''}` });
    }
  } catch (err) {
    items.push({ name: 'agents', state: 'SKIPPED', detail: `could not read the agents: ${(err as Error).message}` });
  }

  const failing = healthLedger.all(undefined, now).filter((s) => s.state === 'degraded' || s.state === 'failing');
  for (const f of failing) items.push(ledgerItem(f, now));
  if (failing.length) findings.push(`Failing: ${failing.map((f) => pipelineName(f.pipeline)).join(', ')}.`);
  const issues = issueStore.active();

  const spoken = findings.length
    ? findings.join(' ')
    : snap
      ? 'I am not stuck: no request was running, and no goal, agent or pipeline is waiting or failing.'
      : 'I found nothing waiting or failing; I did not see what was running when you asked.';
  const details = [
    'Why stuck (read-only; nothing was changed):',
    ...(snap?.traceId ? [`  request trace: ${snap.traceId}`] : []),
    ...itemLines(items),
    `Open issues: ${issues.length}`,
  ];
  return { mode: 'stuck', at: new Date(now).toISOString(), items, issues: issues.slice(0, 10).map(issueLine), spoken, details };
}

/**
 * The in-flight snapshot, from what the orchestrator holds (synchronous: it is
 * taken just before the new request supersedes the old one).
 */
export function captureInFlight(src: {
  state: string;
  stateHistory: { state: string; timestamp: number }[];
  graph: { goal: string; status: string; createdAt: number; nodes: Map<string, { tool: string; status: string; startedAt?: number }> } | null;
  approval?: string;
  now?: number;
}): InFlightSnapshot {
  const last = src.stateHistory[src.stateHistory.length - 1];
  const nodes = src.graph ? [...src.graph.nodes.values()] : [];
  const request = getRequestText();
  const traceId = getTraceId();
  return {
    at: src.now ?? Date.now(),
    state: src.state,
    ...(last ? { stateSince: last.timestamp } : {}),
    ...(request ? { request } : {}),
    ...(traceId ? { traceId } : {}),
    ...(src.graph && src.graph.status === 'running' ? {
      graph: {
        goal: src.graph.goal, status: src.graph.status, createdAt: src.graph.createdAt,
        running: nodes.filter((n) => n.status === 'running').map((n) => ({ tool: n.tool, ...(n.startedAt ? { startedAt: n.startedAt } : {}) })),
        failed: nodes.filter((n) => n.status === 'failed').map((n) => n.tool),
      },
    } : {}),
    ...(src.approval ? { approval: src.approval } : {}),
  };
}

export async function runSelfCheck(mode: SelfCheckMode, deps: SelfCheckDeps = {}): Promise<SelfCheckReport> {
  if (mode === 'report') return repairReport(deps);
  if (mode === 'stuck') return investigateStuck(deps);
  return healthCheck(mode === 'full', deps);
}

/** Phrases a self-healing reply must never contain: they claim more than any check shows. */
export const OVERCLAIMS: readonly RegExp[] = [
  /\ball (?:errors?|issues?|problems?|bugs?) (?:are |have been |were )?(?:fixed|resolved|gone|repaired)/i,
  /\b(?:everything|all systems?) (?:is |are )?(?:fine|working|operational|healthy|ok)\b/i,
  /\bno (?:errors?|problems?) (?:at all|anywhere)\b/i,
  /\bfully (?:healthy|repaired|fixed)\b/i,
];

export function overclaims(text: string): boolean {
  return OVERCLAIMS.some((re) => re.test(text));
}
