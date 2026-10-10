/**
 * core/goalPlanner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns a goal (or one milestone of a permanent goal) into goal-tasks: what
 * to do, which specialist does it, what each step needs first.
 *
 *  - ModelGoalPlanner asks the model for a small plan as JSON, checks it
 *    (known specialists, allowed for this goal, unique titles, known
 *    dependencies, no cycles, at most MAX_TASKS) and falls back to one task
 *    for the specialist chooseSpecialist() picks when the model is down or
 *    its plan does not pass.
 *  - Lessons from earlier goals (core/goalLearning.ts) and advice from failed
 *    attempts go into the prompt.
 *  - Background goals get read-only specialists unless the goal allows the
 *    desktop (policy.allowDesktop): the Desktop and Browser agents act on the
 *    user's screen.
 *
 * Steps that can change something outside JARVIS are marked sideEffects
 * 'possible'; the runtime will not repeat them on its own after a failure.
 */

import type { GoalLesson, Milestone } from './goalLifecycle.js';
import type { Goal } from './goalManager.js';
import { SPECIALIST_ROLES } from './agents/specialists.js';
import { chooseSpecialist } from './agents/jarvisAgents.js';

export interface PlannedTask {
  title: string;
  description: string;
  specialist: string;
  /** Titles of tasks this one needs first. */
  dependsOn: string[];
  sideEffects: 'none' | 'possible';
}

export interface PlanInput {
  goal: Goal;
  milestone?: Milestone;
  lessons: GoalLesson[];
  /** What failed attempts said should change. */
  advice: string[];
  /** Results already in hand (completed tasks), to build on. */
  done: { title: string; summary: string }[];
}

export interface PlanOutput {
  tasks: PlannedTask[];
  via: 'model' | 'fallback' | 'given';
  note?: string;
}

export interface ProposedMilestone {
  title: string;
  successCriteria: string[];
}

export interface GoalPlanner {
  plan(input: PlanInput): Promise<PlanOutput>;
  /** For a permanent goal whose milestones are all done: the next one, or undefined. */
  proposeMilestone?(goal: Goal, lessons: GoalLesson[]): Promise<ProposedMilestone | undefined>;
}

export const MAX_TASKS = 6;
const DESKTOP_SPECIALISTS = new Set(['pc_agent', 'browser_agent']);
const ACTING_SPECIALISTS = new Set(['pc_agent', 'browser_agent', 'coding_agent']);

/** The specialists this goal may use. */
export function allowedSpecialists(goal: Goal): string[] {
  return SPECIALIST_ROLES.map((r) => r.role).filter((r) => goal.policy?.allowDesktop || !DESKTOP_SPECIALISTS.has(r));
}

export function sideEffectsOf(specialist: string): 'none' | 'possible' {
  return ACTING_SPECIALISTS.has(specialist) ? 'possible' : 'none';
}

/** The text a plan is made for: the goal, its milestone and constraints. */
export function planSubject(goal: Goal, milestone?: Milestone): string {
  return milestone ? `${milestone.title} (part of: ${goal.objective ?? goal.description})` : (goal.objective ?? goal.description);
}

/** One task for the specialist that fits the words best (allowed for this goal). */
export function fallbackPlan(input: PlanInput, note: string): PlanOutput {
  const subject = planSubject(input.goal, input.milestone);
  const allowed = allowedSpecialists(input.goal);
  let specialist = chooseSpecialist(subject);
  if (!allowed.includes(specialist)) specialist = 'research_agent';
  const extra = input.advice.length ? `\nAvoid what failed before: ${input.advice.slice(-3).join('; ')}` : '';
  return {
    via: 'fallback',
    note,
    tasks: [{
      title: subject.split('\n')[0]!.slice(0, 80),
      description: `${subject}${extra}`,
      specialist,
      dependsOn: [],
      sideEffects: sideEffectsOf(specialist),
    }],
  };
}

/** Why a plan cannot be used, or undefined. */
export function planProblem(tasks: PlannedTask[], allowed: string[]): string | undefined {
  if (!tasks.length) return 'the plan has no tasks';
  if (tasks.length > MAX_TASKS) return `the plan has more than ${MAX_TASKS} tasks`;
  const titles = new Set<string>();
  for (const t of tasks) {
    if (!t.title?.trim() || !t.description?.trim()) return 'a task has no title or description';
    if (titles.has(t.title)) return `two tasks are called "${t.title}"`;
    titles.add(t.title);
    if (!allowed.includes(t.specialist)) return `"${t.specialist}" is not a specialist this goal may use`;
  }
  for (const t of tasks) for (const d of t.dependsOn) if (!titles.has(d)) return `"${t.title}" depends on unknown "${d}"`;
  // Cycle check: repeatedly remove tasks whose dependencies are all removed.
  const left = new Map(tasks.map((t) => [t.title, new Set(t.dependsOn)]));
  let progress = true;
  while (left.size && progress) {
    progress = false;
    for (const [title, deps] of left) {
      if ([...deps].every((d) => !left.has(d))) { left.delete(title); progress = true; }
    }
  }
  return left.size ? `the dependencies form a cycle (${[...left.keys()].join(', ')})` : undefined;
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) return undefined;
  try { return JSON.parse(body.slice(start)); } catch {
    const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
    try { return JSON.parse(body.slice(start, end + 1)); } catch { return undefined; }
  }
}

type Chat = (req: { messages: { role: 'system' | 'user'; content: string }[]; temperature?: number; max_tokens?: number }) => Promise<{ content: string }>;

async function defaultChat(): Promise<Chat> {
  const { modelRouter } = await import('../bridge/modelRouter.js');
  return (req) => modelRouter.chat(req as never);
}

export class ModelGoalPlanner implements GoalPlanner {
  constructor(private readonly chat?: Chat) {}

  private async model(): Promise<Chat> {
    return this.chat ?? defaultChat();
  }

  async plan(input: PlanInput): Promise<PlanOutput> {
    if (input.goal.policy?.planner === 'single') return fallbackPlan(input, 'the goal asks for a single task');
    const allowed = allowedSpecialists(input.goal);
    const roles = SPECIALIST_ROLES.filter((r) => allowed.includes(r.role)).map((r) => `- ${r.role}: ${r.description}`).join('\n');
    const lessons = input.lessons.slice(0, 5).map((l) => `- ${l.text}`).join('\n');
    const prompt = [
      `Objective: ${planSubject(input.goal, input.milestone)}`,
      input.goal.constraints?.length ? `Constraints: ${input.goal.constraints.join('; ')}` : '',
      (input.milestone?.successCriteria ?? input.goal.successCriteria ?? []).length
        ? `Done when: ${(input.milestone?.successCriteria ?? input.goal.successCriteria ?? []).map((c) => c.description).join('; ')}` : '',
      input.done.length ? `Already done:\n${input.done.map((d) => `- ${d.title}: ${d.summary.slice(0, 200)}`).join('\n')}` : '',
      input.advice.length ? `What failed before and should change:\n${input.advice.slice(-5).map((a) => `- ${a}`).join('\n')}` : '',
      lessons ? `Lessons from earlier goals:\n${lessons}` : '',
      `Specialists:\n${roles}`,
      `Write the smallest plan that reaches the objective: 1 to ${MAX_TASKS} tasks. Use one task when one specialist can do it. `
        + 'Tasks that do not depend on each other run at the same time. Reply with JSON only: '
        + '[{"title": "...", "description": "...", "specialist": "<one of the specialists>", "dependsOn": ["<title>"]}]',
    ].filter(Boolean).join('\n\n');
    let raw: unknown;
    try {
      const chat = await this.model();
      const res = await chat({
        messages: [
          { role: 'system', content: 'You plan work for JARVIS\'s specialist agents. Reply with JSON only.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 900,
      });
      raw = extractJson(res.content);
    } catch (err) {
      return fallbackPlan(input, `the model could not plan (${(err as Error).message.slice(0, 120)})`);
    }
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as { tasks?: unknown })?.tasks) ? (raw as { tasks: unknown[] }).tasks : undefined;
    if (!list) return fallbackPlan(input, 'the model\'s plan was not a list of tasks');
    const tasks: PlannedTask[] = list.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const specialist = String(o['specialist'] ?? '').trim();
      return {
        title: String(o['title'] ?? '').trim().slice(0, 80),
        description: String(o['description'] ?? o['title'] ?? '').trim().slice(0, 1200),
        specialist,
        dependsOn: Array.isArray(o['dependsOn']) ? (o['dependsOn'] as unknown[]).map(String) : [],
        sideEffects: sideEffectsOf(specialist),
      };
    });
    const problem = planProblem(tasks, allowed);
    if (problem) return fallbackPlan(input, `the model's plan was not usable: ${problem}`);
    return { tasks, via: 'model' };
  }

  async proposeMilestone(goal: Goal, lessons: GoalLesson[]): Promise<ProposedMilestone | undefined> {
    const done = (goal.milestones ?? []).map((m) => `- ${m.title}: ${m.status}${m.evidence ? ` (${m.evidence.slice(0, 120)})` : ''}`).join('\n');
    try {
      const chat = await this.model();
      const res = await chat({
        messages: [
          { role: 'system', content: 'You propose the next milestone of a long-term goal. Reply with JSON only.' },
          {
            role: 'user', content: [
              `Long-term goal: ${goal.objective ?? goal.description}`,
              goal.constraints?.length ? `Constraints: ${goal.constraints.join('; ')}` : '',
              done ? `Milestones so far:\n${done}` : 'No milestones yet.',
              lessons.length ? `Lessons:\n${lessons.slice(0, 5).map((l) => `- ${l.text}`).join('\n')}` : '',
              'Propose ONE next milestone that is small, useful and checkable, and that needs no purchases, deployments or changes to security settings. '
                + 'Reply {"title": "...", "successCriteria": ["..."]}, or {"title": ""} if no useful next step exists.',
            ].filter(Boolean).join('\n\n'),
          },
        ],
        temperature: 0.3,
        max_tokens: 400,
      });
      const o = extractJson(res.content) as { title?: unknown; successCriteria?: unknown } | undefined;
      const title = String(o?.title ?? '').trim();
      if (!title) return undefined;
      const criteria = Array.isArray(o?.successCriteria) ? (o!.successCriteria as unknown[]).map(String).filter(Boolean).slice(0, 4) : [];
      return { title: title.slice(0, 160), successCriteria: criteria };
    } catch {
      return undefined;
    }
  }
}
