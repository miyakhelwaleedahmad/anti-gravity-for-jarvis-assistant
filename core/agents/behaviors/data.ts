/**
 * core/agents/behaviors/data.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The Data & Problem-Solving Agent and its Data Analysis Worker.
 *
 *  - A plain calculation or "average of 3, 5, 8" is done with data_tools at
 *    once, without the model (exact, and works offline).
 *  - A request with independent parts ("the average of …; then 15% of 240")
 *    goes to one Data Analysis Worker per part, run in parallel, and the
 *    results are combined by aggregateResults (Microsoft Agent Framework's
 *    concurrent fan-out with an aggregator over all participant results).
 *  - Anything else goes to the tool loop with the model.
 */

import type { AgentBehavior } from '../registry.js';
import type { AgentContext, ChildHandle } from '../agentContextApi.js';
import { SpawnRejectedError } from '../agentContextApi.js';
import type { AgentOutcome, ChildResult } from '../types.js';
import { runLoop, splitParts, toolLoopBehavior, type FallbackRule } from './toolLoop.js';

export const DATA_WORKER_ROLE = 'data_analysis_worker';

const PURPOSE = 'You are the Data & Problem-Solving Agent: exact calculations, statistics, comparisons and log analysis. '
  + 'Use data_tools for every number you report; state assumptions.';

/** Without the model only direct calculations are possible; no keyword rule reads files on a guess. */
export const DATA_RULES: FallbackRule[] = [];

/** "what is 15% of 240" → "15/100*240"; "(2+3)*4?" → "(2+3)*4". Undefined when no arithmetic is found. */
export function extractExpression(task: string): string | undefined {
  let t = task.toLowerCase()
    .replace(/^(please\s+)?(calculate|compute|work out|evaluate|what(?:'s| is)|how much is)\s*/i, '')
    .replace(/[?!.]+\s*$/, '')
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*/g, '$1/100*')
    .replace(/\btimes\b|\bmultiplied by\b/g, '*')
    .replace(/\bdivided by\b/g, '/')
    .replace(/\bplus\b/g, '+')
    .replace(/\bminus\b/g, '-')
    .replace(/\bsquare root of\s*(\d+(?:\.\d+)?)/g, 'sqrt($1)')
    .replace(/\bto the power of\b/g, '^')
    .trim();
  if (!/\d/.test(t) || !/[-+*/%^()]|sqrt|pow|log|ln|exp/.test(t)) return undefined;
  // Only arithmetic characters and known function names may remain.
  t = t.replace(/\s+/g, ' ');
  return /^[\d\s.+\-*/%^(),a-z×÷]+$/.test(t) && !/[a-z]{2,}/.test(t.replace(/\b(sqrt|abs|round|floor|ceil|min|max|pow|exp|ln|log2?|sin|cos|tan|pi|e)\b/g, ''))
    ? t : undefined;
}

/** "average of 3, 5 and 8" → [3,5,8]. Undefined unless it asks for a statistic over a list. */
export function extractNumbers(task: string): number[] | undefined {
  if (!/\b(average|mean|median|sum|total|statistics|stats|standard deviation|std ?dev|min(?:imum)?|max(?:imum)?)\b/i.test(task)) return undefined;
  const nums = (task.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  return nums.length >= 2 ? nums : undefined;
}

/** Combines the results of independent workers: one line each, the weakest confidence, every limitation. */
export function aggregateResults(results: ChildResult[], parts: string[]): AgentOutcome {
  const lines = results.map((r, i) => `${i + 1}. ${parts[i] ?? r.agentId}: ${r.status === 'COMPLETED' ? r.summary : `not done (${r.status.toLowerCase()}${r.error ? `: ${r.error.message}` : ''})`}`);
  const done = results.filter((r) => r.status === 'COMPLETED');
  return {
    summary: lines.join('\n') || 'No part produced a result.',
    confidence: done.length ? Math.min(...done.map((r) => r.confidence)) * (done.length / results.length) : 0,
    limitations: [
      ...results.filter((r) => r.status !== 'COMPLETED').map((r) => `${r.agentId} ${r.status.toLowerCase()}`),
      ...results.flatMap((r) => r.limitations),
    ],
    data: { parts: results.map((r, i) => ({ part: parts[i], status: r.status, summary: r.summary, data: r.data })) },
  };
}

/** Direct, exact answers for calculations and statistics; undefined when the request needs more. */
async function direct(ctx: AgentContext, task: string): Promise<AgentOutcome | undefined> {
  const numbers = extractNumbers(task);
  const expression = numbers ? undefined : extractExpression(task);
  if (!numbers && !expression) return undefined;
  const args = numbers ? { action: 'stats', numbers: numbers.join(',') } : { action: 'calculate', expression };
  ctx.progress(`using data_tools ${args.action}`);
  const out = await ctx.callTool('data_tools', args);
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(out.output) as Record<string, unknown>; } catch { /* not JSON */ }
  if (!out.success || body['success'] === false) {
    return { summary: `I could not calculate that: ${String(body['error'] ?? out.error ?? out.output).slice(0, 160)}`, confidence: 0.2, limitations: [`data_tools ${args.action} failed`] };
  }
  const summary = expression
    ? `${expression} = ${String(body['result'])}`
    : `count ${String(body['count'])}, sum ${String(body['sum'])}, mean ${String(body['mean'])}, median ${String(body['median'])}, min ${String(body['min'])}, max ${String(body['max'])}, standard deviation ${String(body['stdDev'])}`;
  ctx.addFinding({ text: summary, confidence: 0.95, tags: ['calculation'], data: body });
  return { summary, confidence: 0.95, data: body };
}

const LOOP_OPTIONS = { purpose: PURPOSE, fallbackRules: DATA_RULES };
const loop = toolLoopBehavior(LOOP_OPTIONS);

/** The Data Analysis Worker: one part, done directly when it is arithmetic. */
export const dataWorker: AgentBehavior = {
  async run(ctx) {
    return (await direct(ctx, ctx.task.description)) ?? loop.run(ctx);
  },
};

/** A part the specialist does itself: exact when it is arithmetic, else one model loop. */
async function ownPart(ctx: AgentContext, part: string): Promise<AgentOutcome> {
  const exact = await direct(ctx, part);
  if (exact) return exact;
  const res = await runLoop(ctx, part, LOOP_OPTIONS);
  return {
    summary: res.answer || `not done${res.note ? `: ${res.note}` : ''}`,
    confidence: res.answer ? 0.6 : 0.2,
    limitations: [...(res.note ? [`Model: ${res.note}.`] : []), ...res.failures.map((f) => `Tool refused or failed: ${f}`)],
  };
}

/**
 * The Data & Problem-Solving specialist. Independent parts that are real work
 * (not a single calculation) go to parallel workers; the spawn policy decides,
 * and small parts are done here. All parts are then combined in order.
 */
export const dataSpecialist: AgentBehavior = {
  async run(ctx) {
    const task = ctx.task.description;
    const parts = splitParts(task);
    if (parts.length < 2) return (await direct(ctx, task)) ?? loop.run(ctx);

    const isExact = parts.map((p) => !!(extractNumbers(p) || extractExpression(p)));
    const decision = ctx.decideSpawn({ subtasks: parts.map((p, i) => ({ description: p, role: DATA_WORKER_ROLE, estimatedUnits: isExact[i] ? 1 : 3 })) });
    const spawned: { index: number; handle: ChildHandle }[] = [];
    const limitations: string[] = [];
    if (decision.decision === 'SPAWN') {
      for (const p of decision.plan) {
        if (p.action !== 'SPAWN' || isExact[p.index]) continue;
        try {
          spawned.push({ index: p.index, handle: await ctx.spawn({ childRole: DATA_WORKER_ROLE, childTask: { description: parts[p.index]! }, reason: 'independent analysis, run in parallel' }) });
        } catch (err) {
          limitations.push(err instanceof SpawnRejectedError ? err.reasons.join('; ') : (err as Error).message);
        }
      }
    }
    // While the workers run, the specialist does the remaining parts itself.
    const ownIdx = parts.map((_, i) => i).filter((i) => !spawned.some((s) => s.index === i));
    const own = new Map<number, AgentOutcome>();
    for (const i of ownIdx) own.set(i, await ownPart(ctx, parts[i]!));
    const results = await ctx.wait(spawned.map((s) => s.handle));
    const byIndex = new Map<number, ChildResult>(spawned.map((s, k) => [s.index, results[k]!]));

    // One ordered list: worker results through aggregateResults, own parts as completed results.
    const all: ChildResult[] = parts.map((p, i) => byIndex.get(i) ?? {
      taskId: ctx.task.taskId, agentId: ctx.agent.agentId, role: ctx.agent.role, status: 'COMPLETED',
      summary: own.get(i)!.summary, findings: [], sources: [], artifacts: [], confidence: own.get(i)!.confidence,
      limitations: own.get(i)!.limitations ?? [], usage: { llmCalls: 0, toolCalls: 0, tokens: 0 }, durationMs: 0,
    });
    const merged = aggregateResults(all, parts);
    return {
      ...merged,
      limitations: [...limitations, ...(merged.limitations ?? [])],
      data: { ...merged.data, workers: spawned.length, doneHere: ownIdx.length },
    };
  },
};
