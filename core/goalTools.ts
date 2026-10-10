/**
 * core/goalTools.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * How the user (and the planner, on the user's words) works with goals:
 *
 *   goal_create   a temporary, permanent or recurring goal for the Goal Runtime
 *   goal_status   what the goals are doing: running work, waiting approvals,
 *                 blocked goals, retries, the schedule, milestone progress
 *   goal_control  pause, resume, cancel, confirm (a result waiting for review),
 *                 priority, feedback (a correction JARVIS learns from)
 *
 * Creating a goal only records it; every action its agents take later still
 * passes the risk engine and the approval gate. Goals run with read-only
 * specialists unless allow_desktop is given.
 */

import type { AgentTool } from './toolRegistryV2.js';
import type { GoalSchedule } from './goalLifecycle.js';
import { goalKind, goalManager, isManaged, type Goal } from './goalManager.js';
import { describeSchedule, localTimeZone, scheduleProblem } from './goalSchedule.js';
import { goalLearning } from './goalLearning.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function hhmm(h: number, m: number, ampm?: string): string | undefined {
  let hour = h;
  if (ampm) {
    const pm = ampm.toLowerCase() === 'pm';
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  return hour <= 23 && m <= 59 ? `${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')}` : undefined;
}

/**
 * Plain-words schedules:
 *   "every 30 minutes", "every 2 hours", "hourly", "every day at 9", "daily 09:30",
 *   "weekdays at 8am", "every monday and thursday at 18:00", "once at 2026-10-11T09:00"
 */
export function parseSchedule(text: string, timezone?: string): GoalSchedule | string {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const tz = timezone?.trim() || localTimeZone();
  let m = /^every (\d+) ?(minutes?|mins?|hours?|hrs?|days?)$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!.startsWith('m') ? 60_000 : m[2]!.startsWith('h') ? 3_600_000 : 86_400_000;
    return { type: 'interval', everyMs: n * unit };
  }
  if (/^(hourly|every hour)$/.test(t)) return { type: 'interval', everyMs: 3_600_000 };
  const time = '(?: at)? (\\d{1,2})(?::(\\d{2}))? ?(am|pm)?';
  m = new RegExp(`^(?:daily|every day)${time}$`).exec(t);
  if (m) {
    const at = hhmm(Number(m[1]), Number(m[2] ?? 0), m[3]);
    return at ? { type: 'daily', time: at, timezone: tz } : `"${text}" has no valid time of day`;
  }
  m = new RegExp(`^(?:weekdays|every weekday|on weekdays)${time}$`).exec(t);
  if (m) {
    const at = hhmm(Number(m[1]), Number(m[2] ?? 0), m[3]);
    return at ? { type: 'daily', time: at, timezone: tz, weekdays: [1, 2, 3, 4, 5] } : `"${text}" has no valid time of day`;
  }
  m = new RegExp(`^(?:every |on )?((?:${WEEKDAYS.join('|')})s?(?:(?:,| and|, and) (?:${WEEKDAYS.join('|')})s?)*)${time}$`).exec(t);
  if (m) {
    const days = [...new Set(m[1]!.split(/,| and /).map((d) => WEEKDAYS.indexOf(d.trim().replace(/s$/, ''))).filter((d) => d >= 0))];
    const at = hhmm(Number(m[2]), Number(m[3] ?? 0), m[4]);
    return at && days.length ? { type: 'daily', time: at, timezone: tz, weekdays: days } : `"${text}" is not a schedule I can read`;
  }
  m = /^(?:once )?(?:at |on )?(\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2})?(?:z|[+-]\d{2}:?\d{2})?)$/.exec(t);
  if (m) {
    const at = Date.parse(m[1]!.toUpperCase().replace(' ', 'T'));
    return Number.isFinite(at) ? { type: 'once', at } : `"${text}" is not a date I can read`;
  }
  m = /^in (\d+) ?(minutes?|mins?|hours?|hrs?|days?)$/.exec(t);
  if (m) {
    const unit = m[2]!.startsWith('m') ? 60_000 : m[2]!.startsWith('h') ? 3_600_000 : 86_400_000;
    return { type: 'once', at: Date.now() + Number(m[1]) * unit };
  }
  return `"${text}" is not a schedule I can read (try "every 2 hours", "daily at 9", "weekdays at 8am", "every monday at 18:00", "in 30 minutes")`;
}

/** "in 3 hours", "2026-10-12T18:00", "tomorrow" → a time. */
export function parseWhen(text: string, now = Date.now()): number | undefined {
  const t = text.trim().toLowerCase();
  const m = /^in (\d+) ?(minutes?|mins?|hours?|hrs?|days?)$/.exec(t);
  if (m) return now + Number(m[1]) * (m[2]!.startsWith('m') ? 60_000 : m[2]!.startsWith('h') ? 3_600_000 : 86_400_000);
  if (t === 'tomorrow') return now + 86_400_000;
  const at = Date.parse(text.trim());
  return Number.isFinite(at) ? at : undefined;
}

function list(text: unknown): string[] {
  if (Array.isArray(text)) return text.map(String).map((s) => s.trim()).filter(Boolean);
  return String(text ?? '').split(/\s*(?:;|\n)\s*/).map((s) => s.trim()).filter(Boolean);
}

/** The goal a word refers to: an id, "latest", or words of its title. Managed goals only. */
export function findGoal(ref: unknown): Goal | undefined {
  const goals = goalManager.listGoals({ kinds: ['temporary', 'permanent', 'recurring'] });
  const r = String(ref ?? '').trim();
  if (!r || r === 'latest' || r === 'last') return [...goals].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const byId = goals.find((g) => g.id === r);
  if (byId) return byId;
  const words = r.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const scored = goals.map((g) => {
    const text = `${g.description} ${g.objective ?? ''}`.toLowerCase();
    return { g, score: words.filter((w) => text.includes(w)).length };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.g.updatedAt - a.g.updatedAt);
  return scored[0]?.g;
}

function when(t: number | undefined): string {
  if (!t) return '';
  const mins = Math.round((t - Date.now()) / 60_000);
  if (Math.abs(mins) < 1) return 'now';
  if (mins > 0 && mins < 120) return `in ${mins} min`;
  return new Date(t).toLocaleString();
}

/** One line per goal, for the console. */
export function goalLine(g: Goal): string {
  const ts = (g.tasks ?? []).filter((t) => t.status !== 'cancelled');
  const done = ts.filter((t) => t.status === 'completed').length;
  const parts = [
    `[${g.status}${g.waitingFor ? `: ${g.waitingFor}` : ''}]`,
    `${goalKind(g)} P${g.priority}`,
    `"${g.description.slice(0, 70)}"`,
    ts.length ? `${done}/${ts.length} tasks` : '',
    g.milestones?.length ? `milestones ${g.milestones.filter((m) => m.status === 'completed').length}/${g.milestones.length}` : '',
    g.schedule ? describeSchedule(g.schedule) : '',
    g.nextRunAt && !['completed', 'failed', 'cancelled', 'expired'].includes(g.status) ? `next ${when(g.nextRunAt)}` : '',
    g.blockedReason ? `— ${g.blockedReason.slice(0, 120)}` : '',
    g.outcome && ['completed', 'failed', 'expired'].includes(g.status) ? `— ${g.outcome.slice(0, 120)}` : '',
  ];
  return `${g.id}  ${parts.filter(Boolean).join('  ')}`;
}

/** One goal in detail. */
export function goalDetail(g: Goal): string {
  const lines = [goalLine(g), `Objective: ${g.objective ?? g.description}`];
  if (g.successCriteria?.length) lines.push('Success criteria:', ...g.successCriteria.map((c) => `  ${c.met === true ? '✓' : c.met === false ? '✗' : '·'} ${c.description}${c.evidence ? ` — ${c.evidence}` : ''}`));
  if (g.milestones?.length) lines.push('Milestones:', ...g.milestones.map((m) => `  [${m.status}] ${m.title}${m.proposed ? ' (proposed)' : ''}`));
  if (g.progress) lines.push(`Progress: ${g.progress.percent}% — ${g.progress.note}`);
  const tasks = (g.tasks ?? []).filter((t) => t.status !== 'cancelled').slice(-10);
  if (tasks.length) {
    lines.push('Tasks:');
    for (const t of tasks) {
      lines.push(`  [${t.status}] ${t.title} → ${t.specialist}${t.result?.agents?.length && t.result.agents.length > 1 ? ` (with ${t.result.agents.slice(1).join(', ')})` : ''} attempt ${t.attempts}/${t.maxAttempts}${t.nextAttemptAt && t.status === 'retry' ? `, retry ${when(t.nextAttemptAt)}` : ''}`);
      if (t.result?.summary) lines.push(`      ${t.result.summary.slice(0, 160)}`);
      const f = t.failures.at(-1);
      if (f && t.status !== 'completed') lines.push(`      last problem (${f.class}): ${f.message.slice(0, 140)} → ${f.action.slice(0, 100)}`);
    }
  }
  lines.push('Recent history:', ...(g.history ?? []).slice(-6).map((h) => `  ${new Date(h.at).toLocaleTimeString()} ${h.event}: ${h.reason.slice(0, 140)}`));
  return lines.join('\n');
}

/** The status answer: a sentence to say, then the console detail. */
export function goalStatusText(which?: string): string {
  const goals = goalManager.listGoals({ kinds: ['temporary', 'permanent', 'recurring'] });
  if (which && which !== 'all') {
    const g = findGoal(which);
    return g ? `${g.description.slice(0, 80)} is ${g.status}${g.waitingFor ? `, waiting for ${g.waitingFor}` : ''}, sir.\n${goalDetail(g)}` : `I have no goal matching "${which}", sir.`;
  }
  if (!goals.length) return 'You have no goals yet, sir. Say, for example, "make it a goal to research …" or "every morning at 9, check …".';
  const live = goals.filter((g) => !['completed', 'failed', 'cancelled', 'expired'].includes(g.status));
  const count = (s: string) => live.filter((g) => g.status === s).length;
  const approvals = live.filter((g) => g.status === 'waiting' && (g.waitingFor === 'approval' || g.waitingFor === 'review'));
  const say = [
    `${live.length} active goal${live.length === 1 ? '' : 's'}, sir`,
    count('executing') ? `${count('executing')} working` : '',
    approvals.length ? `${approvals.length} waiting for you` : '',
    count('blocked') ? `${count('blocked')} blocked` : '',
    count('retry') ? `${count('retry')} waiting to retry` : '',
  ].filter(Boolean).join(', ');
  const recent = goals.filter((g) => ['completed', 'failed', 'expired'].includes(g.status)).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)).slice(0, 5);
  // Repeated failures, as suggestions for the user (core/goalLearning.ts); nothing is changed by them.
  const proposals = goalLearning.proposals();
  return `${say}.\n${[
    ...live.map(goalLine),
    ...(recent.length ? ['Recently finished:', ...recent.map(goalLine)] : []),
    ...(proposals.length ? ['Suggestions from repeated problems:', ...proposals.map((p) => `  - ${p}`)] : []),
  ].join('\n')}`;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export const goalCreateTool: AgentTool = {
  name: 'goal_create',
  description:
    'Records a goal that JARVIS works on in the background, also when the user is away. Use only when the user asks for a goal, '
    + 'something to keep doing, something recurring ("every morning …") or long work to finish later. '
    + 'Parameters: objective (what to achieve), kind (temporary: finish once; permanent: keep working through milestones; recurring: on a schedule), '
    + 'success_criteria (sentences separated by ";"), milestones (for permanent goals, ";"-separated), schedule (for recurring or later goals: '
    + '"every 2 hours", "daily at 9", "weekdays at 8am", "in 30 minutes"), timezone (IANA, optional), priority (1–10), '
    + 'deadline ("in 3 hours" or a date), allow_desktop (true only if the user wants it to use the screen, browser or apps), max_tasks (budget).',
  riskLevel: 'medium',
  inputSchema: {
    objective: { type: 'string', description: 'What to achieve, in the user\'s words', required: true },
    kind: { type: 'string', description: 'temporary, permanent or recurring', required: false, enum: ['temporary', 'permanent', 'recurring'] },
    title: { type: 'string', description: 'A short name', required: false },
    success_criteria: { type: 'string', description: 'When it is done, ";"-separated', required: false },
    milestones: { type: 'string', description: 'Permanent goals: milestones, ";"-separated', required: false },
    schedule: { type: 'string', description: 'When it runs', required: false },
    timezone: { type: 'string', description: 'IANA time zone', required: false },
    priority: { type: 'number', description: '1–10', required: false },
    deadline: { type: 'string', description: 'When it must be done by', required: false },
    allow_desktop: { type: 'boolean', description: 'May use the desktop and browser agents', required: false },
    max_tasks: { type: 'number', description: 'Most task runs it may start', required: false },
  },
  fallbacks: [],
  async execute(args) {
    await goalManager.init();
    const kind = (['temporary', 'permanent', 'recurring'].includes(String(args['kind'])) ? args['kind'] : (args['schedule'] && /every|daily|weekday|hourly|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(String(args['schedule'])) ? 'recurring' : 'temporary')) as 'temporary' | 'permanent' | 'recurring';
    let schedule: GoalSchedule | undefined;
    if (args['schedule']) {
      const s = parseSchedule(String(args['schedule']), args['timezone'] ? String(args['timezone']) : undefined);
      if (typeof s === 'string') return JSON.stringify({ success: false, error: s });
      const problem = scheduleProblem(s);
      if (problem) return JSON.stringify({ success: false, error: problem });
      schedule = s;
    }
    let deadline: number | undefined;
    if (args['deadline']) {
      deadline = parseWhen(String(args['deadline']));
      if (!deadline) return JSON.stringify({ success: false, error: `"${String(args['deadline'])}" is not a time I can read` });
    }
    try {
      const { goal } = await goalManager.createManagedGoal({
        kind,
        objective: String(args['objective'] ?? ''),
        ...(args['title'] ? { title: String(args['title']) } : {}),
        successCriteria: list(args['success_criteria']),
        milestones: list(args['milestones']),
        ...(schedule ? { schedule } : {}),
        ...(typeof args['priority'] === 'number' ? { priority: args['priority'] } : {}),
        policy: { ...(args['allow_desktop'] === true || args['allow_desktop'] === 'true' ? { allowDesktop: true } : {}), ...(deadline ? { deadline } : {}) },
        ...(typeof args['max_tasks'] === 'number' ? { budget: { maxTasks: args['max_tasks'] } } : {}),
      });
      const next = goal.nextRunAt && goal.nextRunAt > Date.now() ? ` It first runs ${when(goal.nextRunAt)}.` : ' I am starting on it now in the background.';
      return JSON.stringify({ success: true, message: `Goal recorded, sir: "${goal.description.slice(0, 80)}" (${kind}).${next} Ask "goal status" to follow it.`, goalId: goal.id, kind, ...(goal.schedule ? { schedule: describeSchedule(goal.schedule) } : {}) });
    } catch (err) {
      return JSON.stringify({ success: false, error: (err as Error).message });
    }
  },
};

export const goalStatusTool: AgentTool = {
  name: 'goal_status',
  description: 'Reports JARVIS\'s background goals: what is running, waiting for approval or review, blocked, retrying, scheduled, and milestone progress. Parameter: goal (optional: an id or words of its title). Read-only.',
  riskLevel: 'low',
  inputSchema: { goal: { type: 'string', description: 'Which goal (optional)', required: false } },
  fallbacks: [],
  async execute(args) {
    await goalManager.init();
    return goalStatusText(typeof args['goal'] === 'string' ? args['goal'] : undefined);
  },
};

/** Set by core/goalService.ts: confirming a reviewed goal and taking feedback need the runtime and the learning store. */
export const goalControlHooks: {
  confirm?: (id: string) => Promise<boolean>;
  feedback?: (goal: Goal, text: string) => Promise<string>;
} = {};

export const goalControlTool: AgentTool = {
  name: 'goal_control',
  description:
    'Changes a background goal: action pause, resume, cancel, confirm (accept a result that waits for review), priority (value 1–10), '
    + 'or feedback (value: the user\'s correction, which JARVIS learns from). Parameter goal: an id, "latest", or words of its title.',
  riskLevel: 'medium',
  inputSchema: {
    action: { type: 'string', description: 'pause, resume, cancel, confirm, priority or feedback', required: true, enum: ['pause', 'resume', 'cancel', 'confirm', 'priority', 'feedback'] },
    goal: { type: 'string', description: 'Which goal', required: false },
    value: { type: 'string', description: 'Priority number or feedback text', required: false },
  },
  fallbacks: [],
  async execute(args) {
    await goalManager.init();
    const g = findGoal(args['goal']);
    if (!g || !isManaged(g)) return JSON.stringify({ success: false, error: `No goal matches "${String(args['goal'] ?? 'latest')}".` });
    const name = `"${g.description.slice(0, 60)}"`;
    switch (String(args['action'])) {
      case 'pause':
        return JSON.stringify(await goalManager.pauseGoal(g.id) ? { success: true, goalId: g.id, message: `Paused ${name}, sir.` } : { success: false, error: `${name} is ${g.status} and cannot be paused.` });
      case 'resume':
        return JSON.stringify(await goalManager.resumeGoal(g.id) ? { success: true, goalId: g.id, message: `Resumed ${name}, sir.` } : { success: false, error: `${name} is ${g.status} and cannot be resumed.` });
      case 'cancel':
        return JSON.stringify(await goalManager.cancelGoal(g.id, 'cancelled by the user') ? { success: true, goalId: g.id, message: `Cancelled ${name}, sir.` } : { success: false, error: `${name} is already ${g.status}.` });
      case 'confirm': {
        const ok = await goalControlHooks.confirm?.(g.id);
        return JSON.stringify(ok ? { success: true, goalId: g.id, message: `Marked ${name} as done, sir.` } : { success: false, error: `${name} is not waiting for your review (it is ${g.status}).` });
      }
      case 'priority': {
        const p = Number(args['value']);
        if (!Number.isFinite(p)) return JSON.stringify({ success: false, error: 'Give a priority from 1 to 10.' });
        await goalManager.updatePriority(g.id, p);
        return JSON.stringify({ success: true, goalId: g.id, message: `${name} now has priority ${g.priority}, sir.` });
      }
      case 'feedback': {
        const text = String(args['value'] ?? '').trim();
        if (!text) return JSON.stringify({ success: false, error: 'What should I learn from it?' });
        const msg = goalControlHooks.feedback ? await goalControlHooks.feedback(g, text) : 'Noted.';
        return JSON.stringify({ success: true, goalId: g.id, message: msg });
      }
      default:
        return JSON.stringify({ success: false, error: 'action must be pause, resume, cancel, confirm, priority or feedback' });
    }
  },
};

export const goalTools: AgentTool[] = [goalCreateTool, goalStatusTool, goalControlTool];
