/**
 * core/agents/behaviors/toolLoop.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The behaviour of the Browser, PC/Windows, Coding, GitHub (non-research),
 * QA/Test and Memory specialists and their workers: a short loop in which the
 * model chooses tool calls from the agent's own scope, sees their results
 * (inside <untrusted_context>), and answers.
 *
 *  - Only tools in the agent's permission scope are offered; any call still
 *    goes through ctx.callTool (scope check) and toolRegistryV2 (risk engine,
 *    approval gate). A refused call is shown to the model as refused.
 *  - A request with independent parts ("check X; then look at Y") can go to
 *    workers of the specialist's worker role, when the spawn policy agrees.
 *  - Without the model, keyword rules pick read-only tools from the scope.
 */

import { toolRegistryV2 } from '../../toolRegistryV2.js';
import type { ILLMMessage } from '../../../bridge/llmTypes.js';
import type { AgentBehavior } from '../registry.js';
import type { AgentContext, ChildHandle } from '../agentContextApi.js';
import { BudgetExceededError, SpawnRejectedError } from '../agentContextApi.js';
import { parseEntry } from '../permissions.js';
import { agentModel, UNTRUSTED_RULE, untrusted } from './common.js';

export interface FallbackRule {
  pattern: RegExp;
  tool: string;
  args: (task: string) => Record<string, unknown>;
}

export interface ToolLoopOptions {
  /** What this agent is for, for the model. */
  purpose: string;
  maxSteps?: number;
  /** Worker role for independent parts of a request. */
  workerRole?: string;
  fallbackRules: FallbackRule[];
}

/** Splits "a; b", "a, then b", numbered lists, into parts. */
export function splitParts(task: string): string[] {
  const numbered = task.split(/\s*(?:^|\s)\d+[.)]\s+/).map((s) => s.trim()).filter(Boolean);
  if (numbered.length >= 2) return numbered;
  return task.split(/\s*(?:;|\bthen\b|\balso\b)\s*/i).map((s) => s.replace(/^[,\s]+|[,\s]+$/g, '')).filter((s) => s.length > 3);
}

function toolNames(ctx: AgentContext): string[] {
  const names = new Set(ctx.agent.permissions.tools.map((t) => parseEntry(t).tool));
  return [...names].filter((n) => toolRegistryV2.has(n));
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

async function runLoop(ctx: AgentContext, task: string, opts: ToolLoopOptions): Promise<{ answer: string; calls: number; failures: string[]; note?: string }> {
  const names = toolNames(ctx);
  const defs = toolRegistryV2.getLLMDefinitions(names);
  const allowedActions = ctx.agent.permissions.tools.filter((t) => t.includes(':'));
  const messages: ILLMMessage[] = [
    {
      role: 'system',
      content: `${opts.purpose}\nYou are an agent inside JARVIS. Use only the tools offered. `
        + (allowedActions.length ? `For tools with an "action" argument you may use only: ${allowedActions.join(', ')}. ` : '')
        + 'A tool may need the user\'s approval; if it is refused, say so and do not retry it. '
        + `Finish with a short factual answer for your parent agent.\n${UNTRUSTED_RULE}`,
    },
    { role: 'user', content: `${task}${Object.keys(ctx.input).length ? `\nContext: ${JSON.stringify(ctx.input).slice(0, 1_500)}` : ''}` },
  ];
  let calls = 0;
  const failures: string[] = [];
  for (let step = 0; step < (opts.maxSteps ?? 4); step++) {
    let res;
    try {
      res = await ctx.llm({ model: agentModel(), messages, ...(defs.length ? { tools: defs, tool_choice: 'auto' as const } : {}), temperature: 0.2, max_tokens: 700 });
    } catch (err) {
      if (isAbort(err)) throw err;
      const why = err instanceof BudgetExceededError ? 'the model-call budget was used up' : `the model was not available (${(err as Error).message.slice(0, 100)})`;
      if (step === 0) return { answer: '', calls, failures, note: why };
      return { answer: 'Stopped before a final answer: ' + why, calls, failures, note: why };
    }
    if (!res.tool_calls?.length) return { answer: (res.content ?? '').trim(), calls, failures };
    messages.push({ role: 'assistant', content: res.content ?? '', tool_calls: res.tool_calls });
    for (const call of res.tool_calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* empty args */ }
      ctx.progress(`using ${call.function.name}`);
      const out = await ctx.callTool(call.function.name, args);
      calls++;
      if (!out.success) failures.push(`${call.function.name}: ${(out.output || out.error || 'failed').slice(0, 160)}${out.error && out.error !== out.output ? ` (${out.error})` : ''}`);
      else ctx.addFinding({ text: `${call.function.name}: ${out.output.replace(/\s+/g, ' ').slice(0, 300)}`, confidence: 0.6, tags: ['tool-result'], data: { tool: call.function.name } });
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: untrusted(`tool:${call.function.name}`, out.success ? out.output : `FAILED: ${out.output}`) });
    }
  }
  return { answer: 'Stopped after the step limit.', calls, failures, note: 'the step limit was reached' };
}

async function runRules(ctx: AgentContext, task: string, rules: FallbackRule[]): Promise<{ answer: string; calls: number; failures: string[] }> {
  const allowed = new Set(toolNames(ctx));
  const chosen = rules.filter((r) => r.pattern.test(task) && allowed.has(r.tool)).slice(0, 2);
  const outputs: string[] = [];
  const failures: string[] = [];
  for (const rule of chosen) {
    ctx.progress(`using ${rule.tool}`);
    const out = await ctx.callTool(rule.tool, rule.args(task));
    if (out.success) {
      outputs.push(`${rule.tool}: ${out.output.replace(/\s+/g, ' ').slice(0, 600)}`);
      ctx.addFinding({ text: `${rule.tool}: ${out.output.replace(/\s+/g, ' ').slice(0, 300)}`, confidence: 0.5, tags: ['tool-result'], data: { tool: rule.tool } });
    } else {
      failures.push(`${rule.tool}: ${(out.output || out.error || 'failed').slice(0, 160)}${out.error && out.error !== out.output ? ` (${out.error})` : ''}`);
    }
  }
  return {
    answer: outputs.length ? outputs.join('\n') : 'No rule matched a tool for this request without the model.',
    calls: chosen.length,
    failures,
  };
}

export function toolLoopBehavior(opts: ToolLoopOptions): AgentBehavior {
  return {
    async run(ctx) {
      const task = ctx.task.description;
      const limitations: string[] = [];

      // Independent parts may go to workers.
      const parts = opts.workerRole ? splitParts(task) : [];
      if (opts.workerRole && parts.length >= 2) {
        const decision = ctx.decideSpawn({ subtasks: parts.map((p) => ({ description: p, role: opts.workerRole!, estimatedUnits: 2 })) });
        if (decision.decision === 'SPAWN') {
          const handles: ChildHandle[] = [];
          const own: string[] = [];
          for (const p of decision.plan) {
            if (p.action !== 'SPAWN') { own.push(parts[p.index]); continue; }
            try {
              handles.push(await ctx.spawn({ childRole: opts.workerRole, childTask: { description: parts[p.index] }, reason: 'independent part of the request' }));
            } catch (err) {
              own.push(parts[p.index]);
              limitations.push(err instanceof SpawnRejectedError ? err.reasons.join('; ') : (err as Error).message);
            }
          }
          const ownAnswers: string[] = [];
          for (const p of own) ownAnswers.push((await runLoop(ctx, p, opts)).answer);
          const results = await ctx.wait(handles);
          for (const r of results) if (r.status !== 'COMPLETED') limitations.push(`${r.agentId}: ${r.status.toLowerCase()} — ${r.error?.message ?? ''}`);
          const answer = [...results.map((r) => r.summary), ...ownAnswers].filter(Boolean).join('\n');
          return {
            summary: answer || 'The parts produced no answer.',
            confidence: results.every((r) => r.status === 'COMPLETED') ? 0.7 : 0.4,
            limitations: [...limitations, ...results.flatMap((r) => r.limitations)],
          };
        }
      }

      let loop = await runLoop(ctx, task, opts);
      if (loop.note) limitations.push(`Model: ${loop.note}${loop.calls ? '' : '; keyword rules were used'}.`);
      if (!loop.answer && !loop.calls) loop = { ...(await runRules(ctx, task, opts.fallbackRules)), note: loop.note };
      limitations.push(...loop.failures.map((f) => `Tool refused or failed: ${f}`));
      return {
        summary: loop.answer || 'No answer.',
        confidence: loop.calls && !loop.failures.length ? 0.7 : loop.calls ? 0.5 : 0.3,
        limitations,
        data: { toolCalls: loop.calls },
      };
    },
  };
}
