/**
 * core/worldState.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One picture of the current world, each part with the time it was observed
 * (docs/upgrade/SYSTEM_AWARENESS.md, "World state"):
 *
 *   system       OS, CPU load, memory, disks           stale after 5 min
 *   apps         active window, open apps               stale after 30 s
 *   browser      Chrome tabs                            stale after 30 s
 *   development  local servers, git repositories        stale after 60 s
 *   task         goal, plan, current step, done, failed, pending approval
 *
 * A part is read again only when a request needs it and it is stale; callers
 * asking at the same time share one read. Nothing here polls, and nothing is
 * written to long-term memory. The planner gets a short summary of the parts
 * its request is about, redacted and marked as data.
 */

import { redact, redactDeep } from '../security/redactor.js';

export type ObservedSection = 'system' | 'apps' | 'browser' | 'development';
export type SectionName = ObservedSection | 'task';

export interface Section<T = unknown> {
  data: T;
  observedAt: number;
  source: string;
}

export interface TaskState {
  goal?: string;
  plan: string[];
  currentStep?: string;
  done: string[];
  failed: string[];
}

export const MAX_AGE_MS: Readonly<Record<ObservedSection, number>> = {
  system: 5 * 60_000,
  apps: 30_000,
  browser: 30_000,
  development: 60_000,
};

export type SectionReader = () => Promise<{ data: unknown; source: string }>;

/** How each part is read: the P6 probes and the existing perception. */
const READERS: Record<ObservedSection, SectionReader> = {
  system: async () => {
    const { systemSnapshot } = await import('../perception/systemProbe.js');
    return { data: await systemSnapshot(), source: 'systemProbe' };
  },
  apps: async () => {
    const { getWindowsState } = await import('../perception/windowsState.js');
    return { data: await getWindowsState({ allowStale: true }), source: 'windowsState' };
  },
  browser: async () => {
    const { getChromeState } = await import('../perception/chromeState.js');
    return { data: await getChromeState(), source: 'chromeState' };
  },
  development: async () => {
    const [{ scanDevPorts }, { gitOverview }] = await Promise.all([
      import('../perception/devProbe.js'),
      import('../perception/gitProbe.js'),
    ]);
    const [ports, repositories] = await Promise.all([scanDevPorts(), gitOverview()]);
    return { data: { ports, repositories }, source: 'devProbe+gitProbe' };
  },
};

/** The summary the planner gets is at most this long. */
export const SUMMARY_LIMIT = 600;

/** Which parts a request is about, from its words. */
const SECTION_WORDS: ReadonlyArray<readonly [ObservedSection, RegExp]> = [
  ['browser', /\b(browser|tab|tabs|page|website|site|chrome|url)\b/],
  ['development', /\b(running|server|servers|port|ports|backend|frontend|localhost|git|branch|commit|repo|repository|project)\b/],
  ['apps', /\b(app|apps|application|window|windows|open|focused|active)\b/],
  ['system', /\b(cpu|memory|ram|disk|storage|slow|performance|battery|uptime|system)\b/],
];

/** No angle brackets: the text cannot close the wrapper it is put in. */
function clean(text: unknown, max: number): string {
  return redact(String(text ?? '')).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

export class WorldState {
  private sections: Partial<Record<ObservedSection, Section>> = {};
  private inflight = new Map<ObservedSection, Promise<void>>();
  private task: TaskState = { plan: [], done: [], failed: [] };
  private pendingApproval: () => string | undefined = () => undefined;

  constructor(private readonly readers: Record<ObservedSection, SectionReader> = READERS) {}

  get<T = unknown>(name: ObservedSection): Section<T> | undefined {
    return this.sections[name] as Section<T> | undefined;
  }

  /** Store a reading (the background observer hands in what it already read). */
  set(name: ObservedSection, data: unknown, source: string, observedAt = Date.now()): void {
    const current = this.sections[name];
    if (current && current.observedAt > observedAt) return; // never replace newer with older
    this.sections[name] = { data: redactDeep(data), observedAt, source };
  }

  isStale(name: ObservedSection, maxAgeMs = MAX_AGE_MS[name], now = Date.now()): boolean {
    const section = this.sections[name];
    return !section || now - section.observedAt > maxAgeMs;
  }

  /** Read again each requested part that is stale; one read per part at a time. */
  async refresh(names: ObservedSection[], maxAgeMs?: number): Promise<void> {
    await Promise.all(names.map((name) => {
      if (!this.isStale(name, maxAgeMs ?? MAX_AGE_MS[name])) return Promise.resolve();
      const running = this.inflight.get(name);
      if (running) return running;
      const read = this.readers[name]()
        .then(({ data, source }) => this.set(name, data, source))
        .catch((err: unknown) => {
          console.warn(`[WorldState] Reading ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => this.inflight.delete(name));
      this.inflight.set(name, read);
      return read;
    }));
  }

  // ── Task ──────────────────────────────────────────────────────────────────

  startTask(goal: string, plan: string[]): void {
    this.task = { goal: clean(goal, 160), plan: plan.map((p) => clean(p, 60)), done: [], failed: [] };
  }

  stepStarted(step: string): void {
    this.task.currentStep = clean(step, 60);
  }

  stepFinished(step: string, ok: boolean): void {
    (ok ? this.task.done : this.task.failed).push(clean(step, 60));
    if (this.task.currentStep === clean(step, 60)) this.task.currentStep = undefined;
  }

  endTask(): void {
    this.task = { plan: [], done: [], failed: [] };
  }

  /** Where the pending approval request comes from (the approval gate). */
  watchApprovals(pending: () => string | undefined): void {
    this.pendingApproval = pending;
  }

  taskState(): TaskState & { pendingApproval?: string } {
    const pending = this.pendingApproval();
    return { ...this.task, plan: [...this.task.plan], done: [...this.task.done], failed: [...this.task.failed], ...(pending ? { pendingApproval: pending } : {}) };
  }

  // ── Planning summary ──────────────────────────────────────────────────────

  /** The parts `input` is about. */
  sectionsFor(input: string): ObservedSection[] {
    const text = input.toLowerCase();
    return SECTION_WORDS.filter(([, words]) => words.test(text)).map(([name]) => name);
  }

  /**
   * A summary of the parts `input` is about, at most SUMMARY_LIMIT characters,
   * redacted. Empty when the request is about none of them.
   */
  summarize(input: string, now = Date.now()): string {
    const lines: string[] = [];
    for (const name of this.sectionsFor(input)) {
      const section = this.sections[name];
      if (!section) continue;
      const line = this.describe(name, section, now);
      if (line) lines.push(line);
    }
    const task = this.taskState();
    if (task.goal && (task.currentStep || task.pendingApproval)) {
      lines.push(`task: "${task.goal}"${task.currentStep ? `, step ${task.currentStep}` : ''}${task.pendingApproval ? `, waiting for approval: ${task.pendingApproval}` : ''}`);
    }
    const text = lines.join('\n');
    return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1)}…` : text;
  }

  /** The summary as planner context: user role, marked as data (like the OCR context). */
  planningContext(input: string): string | undefined {
    const summary = this.summarize(input);
    if (!summary) return undefined;
    return `<untrusted_context source="world-state">\n${summary}\n</untrusted_context>`;
  }

  private describe(name: ObservedSection, section: Section, now: number): string {
    const when = age(now - section.observedAt);
    const d = section.data as any;
    switch (name) {
      case 'system': {
        const disk = d?.disks?.[0];
        return `system (${when}): CPU ${Math.round(d?.cpu?.usagePercent ?? 0)}%, memory ${d?.memory?.freeGB}/${d?.memory?.totalGB} GB free` +
          (disk ? `, ${clean(disk.mount, 8)} ${Math.round(disk.freeGB)} GB free` : '');
      }
      case 'apps': {
        const active = clean(d?.activeWindow?.title, 60);
        const apps = (d?.openApps ?? []).slice(0, 6).map((a: any) => clean(a?.name, 20)).filter(Boolean);
        return `apps (${when}): active "${active || 'none'}"; open: ${apps.join(', ') || 'none'}`;
      }
      case 'browser': {
        if (!d?.running && !(d?.tabs ?? []).length) return `browser (${when}): no debuggable Chrome`;
        const tabs = (d?.tabs ?? []).slice(0, 5).map((t: any) => `${t?.active ? '*' : ''}${clean(t?.title, 40)}`);
        return `browser (${when}): ${(d?.tabs ?? []).length} tab(s): ${tabs.join(' | ')}`;
      }
      case 'development': {
        const open = (d?.ports ?? []).filter((p: any) => p?.open).map((p: any) => `${p.port}${p.http ? `=${p.http.status}` : ''}`);
        const repos = (d?.repositories ?? []).slice(0, 3).map((r: any) =>
          `${clean(String(r?.path ?? '').split(/[\\/]/).pop(), 30)}@${clean(r?.branch, 30)} ${r?.changed ?? 0} changed`);
        return `development (${when}): servers ${open.join(', ') || 'none'}; repos ${repos.join('; ') || 'none'}`;
      }
    }
  }
}

export const worldState = new WorldState();
