/**
 * core/goalVerifier.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Decides whether a goal (or a milestone) met its success criteria, from the
 * evidence its tasks produced — never from "the tool said success" alone.
 *
 * Always required: every task in scope completed with a non-empty result.
 * Then each criterion (core/goalLifecycle.ts GoalCriterion):
 *   tasks_completed  covered by the rule above
 *   min_confidence   average result confidence ≥ value
 *   verified         at least one result was checked by the Verification
 *                    agent, and none was found to have issues
 *   sources          at least `value` distinct sources cited
 *   judge            the model reads the criterion and the results and says
 *                    met or not met, with a reason; without a model the goal
 *                    waits for the user to review it (needs_review), it is
 *                    not marked completed
 */

import type { GoalCriterion, GoalTask } from './goalLifecycle.js';

export interface JudgeInput {
  objective: string;
  criterion: string;
  evidence: string;
}

/** Undefined: no verdict could be reached (model down). */
export type Judge = (input: JudgeInput) => Promise<{ met: boolean; reason: string } | undefined>;

export interface CriterionCheck {
  id: string;
  description: string;
  met?: boolean;
  evidence: string;
}

export interface Verdict {
  status: 'met' | 'unmet' | 'needs_review';
  checks: CriterionCheck[];
  /** One paragraph: what was achieved, from the results. */
  summary: string;
}

/** The results as evidence text for the judge and the outcome. */
export function evidenceOf(tasks: GoalTask[], max = 4000): string {
  const parts = tasks.filter((t) => t.result).map((t) => {
    const r = t.result!;
    const src = r.sources.slice(0, 5).map((s) => s.url ?? s.title).join('; ');
    return `## ${t.title} (by ${r.agent}, confidence ${r.confidence.toFixed(2)}${r.verification ? `, verification: ${r.verification.verdict}` : ''})\n`
      + `${r.summary}\n${r.findings.slice(0, 5).map((f) => `- ${f}`).join('\n')}${src ? `\nSources: ${src}` : ''}`;
  });
  return parts.join('\n\n').slice(0, max);
}

function summaryOf(tasks: GoalTask[]): string {
  return tasks.filter((t) => t.result?.summary).map((t) => t.result!.summary.trim()).join(' ').slice(0, 600);
}

export async function verifyCriteria(input: {
  objective: string;
  tasks: GoalTask[];
  criteria: GoalCriterion[];
  judge?: Judge;
}): Promise<Verdict> {
  const { tasks } = input;
  const checks: CriterionCheck[] = [];
  const unfinished = tasks.filter((t) => t.status !== 'completed');
  const empty = tasks.filter((t) => t.status === 'completed' && !t.result?.summary?.trim());
  checks.push({
    id: 'all_tasks', description: 'every task completed with a result',
    met: tasks.length > 0 && !unfinished.length && !empty.length,
    evidence: !tasks.length ? 'no tasks ran'
      : unfinished.length ? `${unfinished.length} task(s) not completed: ${unfinished.map((t) => `${t.title} (${t.status})`).join(', ')}`
        : empty.length ? `${empty.length} task(s) completed without a result` : `${tasks.length} task(s) completed`,
  });
  const results = tasks.map((t) => t.result).filter((r): r is NonNullable<GoalTask['result']> => !!r);
  const evidence = evidenceOf(tasks);

  for (const c of input.criteria) {
    let check: CriterionCheck;
    switch (c.kind) {
      case 'tasks_completed':
        check = { id: c.id, description: c.description, met: checks[0]!.met, evidence: checks[0]!.evidence };
        break;
      case 'min_confidence': {
        const avg = results.length ? results.reduce((s, r) => s + r.confidence, 0) / results.length : 0;
        const want = c.value ?? 0.6;
        check = { id: c.id, description: c.description, met: avg >= want, evidence: `average confidence ${avg.toFixed(2)} (needs ${want})` };
        break;
      }
      case 'verified': {
        const checked = results.filter((r) => r.verification);
        const issues = checked.filter((r) => r.verification!.verdict === 'issues');
        check = {
          id: c.id, description: c.description, met: checked.length > 0 && !issues.length,
          evidence: !checked.length ? 'no result was checked by the Verification agent'
            : issues.length ? `the Verification agent found issues in ${issues.length} result(s)` : `${checked.length} result(s) verified`,
        };
        break;
      }
      case 'sources': {
        const urls = new Set(results.flatMap((r) => r.sources.map((s) => s.url ?? s.title)));
        const want = c.value ?? 2;
        check = { id: c.id, description: c.description, met: urls.size >= want, evidence: `${urls.size} distinct source(s) (needs ${want})` };
        break;
      }
      case 'judge':
      default: {
        if (!input.judge) {
          check = { id: c.id, description: c.description, evidence: 'no model to check this; waiting for your review' };
          break;
        }
        const verdict = await input.judge({ objective: input.objective, criterion: c.description, evidence }).catch(() => undefined);
        check = verdict
          ? { id: c.id, description: c.description, met: verdict.met, evidence: verdict.reason.slice(0, 300) }
          : { id: c.id, description: c.description, evidence: 'the check could not run (model unavailable); waiting for your review' };
      }
    }
    checks.push(check);
  }

  const unmet = checks.some((c) => c.met === false);
  const unknown = checks.some((c) => c.met === undefined);
  return {
    status: unmet ? 'unmet' : unknown ? 'needs_review' : 'met',
    checks,
    summary: summaryOf(tasks),
  };
}

/** A judge that asks the model; undefined when the model fails or answers out of form. */
export function modelJudge(chat?: (req: { messages: { role: 'system' | 'user'; content: string }[]; temperature?: number; max_tokens?: number }) => Promise<{ content: string }>): Judge {
  return async ({ objective, criterion, evidence }) => {
    try {
      const send: NonNullable<typeof chat> = chat ?? (async (req) => {
        const { modelRouter } = await import('../bridge/modelRouter.js');
        return modelRouter.chat(req as never);
      });
      const res = await send({
        messages: [
          { role: 'system', content: 'You check whether work met a success criterion, using only the evidence given. Reply with JSON only.' },
          { role: 'user', content: `Objective: ${objective}\nCriterion: ${criterion}\n\nEvidence:\n${evidence || '(none)'}\n\nReply {"met": true|false, "reason": "one sentence citing the evidence"}. If the evidence does not show it, met is false.` },
        ],
        temperature: 0,
        max_tokens: 200,
      });
      const m = /\{[\s\S]*\}/.exec(res.content);
      const o = m ? JSON.parse(m[0]) as { met?: unknown; reason?: unknown } : undefined;
      if (!o || typeof o.met !== 'boolean') return undefined;
      return { met: o.met, reason: String(o.reason ?? '') };
    } catch {
      return undefined;
    }
  };
}
