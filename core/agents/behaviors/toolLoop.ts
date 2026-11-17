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
 *  - Without the model, keyword rules pick read-only tools from the scope,
 *    and the result says so (data.answeredBy = 'keyword_rules'). Not for a
 *    strict route that failed, a background call not sent in time, or the QA
 *    agent: those end the task FAILED with the original reason.
 */

import { toolRegistryV2 } from '../../toolRegistryV2.js';
import type { ILLMMessage } from '../../../bridge/llmTypes.js';
import type { AgentBehavior } from '../registry.js';
import type { AgentContext, ChildHandle } from '../agentContextApi.js';
import { BudgetExceededError, SpawnRejectedError } from '../agentContextApi.js';
import { parseEntry } from '../permissions.js';
import { agentModel, failureCauses, leadingCause, PropagatedFailure, strictRouteRole, UNTRUSTED_RULE, untrusted } from './common.js';
import { modelRouter } from '../../../bridge/modelRouter.js';
import { identityKey, isFloatingAlias, qaIndependenceRequired } from '../../../bridge/modelCategories.js';

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

/**
 * Whether this agent's work must come from its model, never from keyword
 * rules: the QA agent, and an agent on a strict route (a configured
 * coding_agent or qa_agent, and the helpers that inherit it).
 */
function needsModel(ctx: AgentContext): boolean {
  return ctx.agent.role === 'qa_agent' || strictRouteRole(ctx) !== undefined;
}

/**
 * A model failure that must end the task instead of being covered by keyword
 * rules (owner, 2026-11-15): a strict route that failed (StrictRouteError) or
 * was not sent (QueueWaitTimeoutError); any model failure of the QA agent,
 * whose result must come from its model; and a used-up model-call budget of
 * an agent whose work must come from its model (needsModel).
 */
function endsTask(err: unknown, ctx: AgentContext): boolean {
  const name = (err as Error | null)?.name;
  if (name === 'StrictRouteError' || name === 'QueueWaitTimeoutError' || name === 'IndependentQaUnavailableError' || ctx.agent.role === 'qa_agent') return true;
  return err instanceof BudgetExceededError && needsModel(ctx);
}

/** The error the task ends with: the original one when it already says why, else a clear one keeping it as `cause`. */
function taskFailure(err: unknown, role: string): Error {
  if (err instanceof BudgetExceededError) return err;   // the manager records its own code for it
  const name = (err as Error | null)?.name;
  if (name === 'StrictRouteError' || name === 'QueueWaitTimeoutError' || name === 'IndependentQaUnavailableError') return err as Error;
  const e = new Error(`The ${role === 'qa_agent' ? 'QA' : role} agent's model was not available, so nothing was checked: ${String((err as Error | null)?.message ?? err)}`, { cause: err });
  e.name = 'ModelUnavailableError';
  return e;
}

/** QA work: the QA agent and every agent below it (by who spawned whom, not by input). */
function isQaWork(ctx: AgentContext): boolean {
  return ctx.agent.role === 'qa_agent' || (ctx.lineageRoles?.() ?? []).includes('qa_agent');
}

/** identity: the model's identity was not confirmed (recorded as MODEL_IDENTITY_UNCONFIRMED, not MODEL_UNAVAILABLE). */
function independentQaUnavailable(reason: string, identity = false): Error {
  const e = Object.assign(new Error(`independent QA unavailable: ${reason}; human review required`), identity ? { identity: true } : {});
  e.name = 'IndependentQaUnavailableError';
  return e;
}

/** What QA work knows about its independence from coding (owner, 2026-11-16, D1). */
interface QaGate { required: boolean; independent: boolean; reason: string; codingModels: Set<string> }

/**
 * Before QA work asks a model: when independent QA is required and no model
 * distinct from every model coding can be answered by is available, it ends
 * here, before any model is asked (fail closed).
 */
async function qaGate(ctx: AgentContext): Promise<QaGate | undefined> {
  if (!isQaWork(ctx)) return undefined;
  // Identities are looked up (bounded) only when independence is required; otherwise the
  // label comes from names alone and is never "independent" (R4).
  const check = await modelRouter.qaIndependence(process.env, { resolve: qaIndependenceRequired() });
  if (check.required && !check.independent) throw independentQaUnavailable(check.reason.replace(/^not independent: /, ''));
  // Every identity key coding's models are known by (an alias, a dated or gateway id are one model; M-A, R2).
  return { required: check.required, independent: check.independent, reason: check.reason, codingModels: new Set((check.codingTargets ?? []).flatMap((t) => t.ids ?? [t.model]).map(identityKey)) };
}

/**
 * After each reply to QA work, when independence is required: the model the
 * provider reports must be known and not one coding can be answered by. The
 * requested model is never taken as evidence (owner, 2026-11-16).
 */
function checkServed(gate: QaGate | undefined, served: string | undefined): void {
  if (!gate?.required) return;
  if (!served) throw independentQaUnavailable('the provider did not report which model answered QA, so its independence cannot be confirmed', true);
  if (isFloatingAlias(served)) throw independentQaUnavailable(`QA was answered by ${served}, a floating alias whose model is not known`, true);
  if (gate.codingModels.has(identityKey(served))) throw independentQaUnavailable(`QA was answered by ${served}, a model coding may also use`);
}

/**
 * The independence label of a QA result: "independent" only when it was
 * required, the configuration is independent and every reply reported a model
 * distinct from coding's. Not required: never "independent".
 */
function independenceOf(gate: QaGate, served: readonly string[]): { status: 'independent' | 'not_independent' | 'unknown'; required: boolean; qaModels: string[]; reason: string } {
  const qaModels = [...new Set(served)];
  if (gate.required) {
    return qaModels.length
      ? { status: 'independent', required: true, qaModels, reason: `${gate.reason}; every reply reported a model coding does not use` }
      : { status: 'unknown', required: true, qaModels, reason: 'no model reply to confirm' };
  }
  return { status: gate.independent ? 'unknown' : 'not_independent', required: false, qaModels, reason: `independence not required (JARVIS_QA_REQUIRE_INDEPENDENT), so not enforced: ${gate.reason}` };
}

/** QA split into parts: "independent" only when every part was; any part not independent makes the whole not independent. */
function combinedIndependence(gate: QaGate, parts: readonly (ReturnType<typeof independenceOf> | undefined)[]): ReturnType<typeof independenceOf> {
  const qaModels = [...new Set(parts.flatMap((p) => p?.qaModels ?? []))];
  const statuses = parts.map((p) => p?.status ?? 'unknown');
  const status = statuses.length && statuses.every((x) => x === 'independent') ? 'independent'
    : statuses.includes('not_independent') ? 'not_independent' : 'unknown';
  return { status: gate.required || status !== 'independent' ? status : 'unknown', required: gate.required, qaModels, reason: `${statuses.length} part(s): ${statuses.join(', ') || 'none'}` };
}

/**
 * Who produced a tool-loop answer: the model ('model'), the model but it did
 * not finish ('model_incomplete': the step limit, or its model failed after
 * some tool calls), or keyword rules without the model ('keyword_rules').
 * None of these is an independent check of other work.
 */
export type AnsweredBy = 'model' | 'model_incomplete' | 'keyword_rules';

/** One model-driven tool loop over `task` (exported for behaviours that split a request themselves). */
export async function runLoop(ctx: AgentContext, task: string, opts: ToolLoopOptions): Promise<{ answer: string; calls: number; failures: string[]; note?: string; modelAnswered?: boolean; servedModels?: string[]; qa?: QaGate }> {
  // QA work: fail closed before any model call when independent QA is required but unavailable (P4).
  const qa = await qaGate(ctx);
  const servedModels: string[] = [];
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
      if (endsTask(err, ctx)) throw taskFailure(err, ctx.agent.role);
      const why = err instanceof BudgetExceededError ? 'the model-call budget was used up' : `the model was not available (${(err as Error).message.slice(0, 300)})`;
      if (step === 0) return { answer: '', calls, failures, note: why, servedModels, ...(qa ? { qa } : {}) };
      return { answer: 'Stopped before a final answer: ' + why, calls, failures, note: why, servedModels, ...(qa ? { qa } : {}) };
    }
    if (qa) {
      checkServed(qa, res.model);
      if (res.model) servedModels.push(res.model);
    }
    if (!res.tool_calls?.length) {
      const answer = (res.content ?? '').trim();
      const role = ctx.agent.role;
      if (!answer && needsModel(ctx)) {
        // An empty answer is not an answer: QA, and an agent on a strict route
        // (a configured coding_agent, or a helper inheriting one), end FAILED, never answered by keyword rules.
        const e = new Error(role === 'qa_agent'
          ? `The QA agent's model returned an empty answer${calls ? ` after ${calls} tool call(s)` : ''}, so nothing was checked.`
          : `The ${role} agent's configured model returned an empty answer${calls ? ` after ${calls} tool call(s)` : ''}; keyword rules are not used in its place.`);
        e.name = 'ModelUnavailableError';
        throw e;
      }
      return { answer, calls, failures, modelAnswered: true, servedModels, ...(qa ? { qa } : {}) };
    }
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
  return { answer: 'Stopped after the step limit.', calls, failures, note: 'the step limit was reached', servedModels, ...(qa ? { qa } : {}) };
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
          // QA work that only delegates still fails closed before any helper starts (P4).
          const parentGate = await qaGate(ctx);
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
          let ownByModel = true;
          const ownIndependence: ReturnType<typeof independenceOf>[] = [];
          for (const p of own) {
            const r = await runLoop(ctx, p, opts);
            ownAnswers.push(r.answer);
            if (r.modelAnswered !== true) ownByModel = false;
            if (r.qa) ownIndependence.push(independenceOf(r.qa, r.servedModels ?? []));
          }
          const results = await ctx.wait(handles);
          const byModel = (r: (typeof results)[number]) => r.status === 'COMPLETED' && (r.data as Record<string, unknown> | undefined)?.['answeredBy'] === 'model';
          if (needsModel(ctx)) {
            // QA, or a parent on a strict route, counts a part as done only when it
            // completed and its model answered it (never keyword rules, never unfinished).
            const unchecked = results.filter((r) => !byModel(r));
            if (unchecked.length || !ownByModel) {
              const why = (r: (typeof results)[number]) => {
                if (r.status !== 'COMPLETED') return `${r.status.toLowerCase()} — ${r.error?.message ?? ''}`;
                const by = (r.data as Record<string, unknown> | undefined)?.['answeredBy'];
                return by === 'keyword_rules' ? 'answered by keyword rules, not its model' : by === 'model_incomplete' ? 'its model did not finish' : 'not answered by its model';
              };
              const list = [...unchecked.map((r) => `${r.agentId} (${r.role}): ${why(r)}`), ...(ownByModel ? [] : ['a part it did itself: its model did not finish'])].join('; ');
              const message = ctx.agent.role === 'qa_agent'
                ? `QA could not check every part: ${list}`
                : `The ${ctx.agent.role} agent could not complete every part with its configured model: ${list}`;
              // A helper's own condition is kept on the parent (review M1), and every distinct
              // cause with it; a budget leads only when every failed part failed for a budget (review LR-2).
              const causes = failureCauses([...unchecked.map((r) => r.error), ...(ownByModel ? [] : [undefined])]);
              const lead = leadingCause(causes);
              if (causes.length > 1 || lead.code !== 'MODEL_UNAVAILABLE' || unchecked.some((r) => r.error?.code === 'MODEL_UNAVAILABLE')) {
                throw new PropagatedFailure(message, lead.code, lead.budget, causes.length > 1 ? causes : undefined);
              }
              const e = new Error(message);
              e.name = 'ModelUnavailableError';
              throw e;
            }
          }
          for (const r of results) if (r.status !== 'COMPLETED') limitations.push(`${r.agentId}: ${r.status.toLowerCase()} — ${r.error?.message ?? ''}`);
          const answer = [...results.map((r) => r.summary), ...ownAnswers].filter(Boolean).join('\n');
          return {
            summary: answer || 'The parts produced no answer.',
            confidence: results.every((r) => r.status === 'COMPLETED') ? 0.7 : 0.4,
            limitations: [...limitations, ...results.flatMap((r) => r.limitations)],
            data: {
              modelUsed: ownByModel && results.every(byModel), answeredBy: (ownByModel && results.every(byModel) ? 'model' : 'model_incomplete') as AnsweredBy,
              ...(parentGate ? { independence: combinedIndependence(parentGate, [...results.map((r) => (r.data as Record<string, unknown> | undefined)?.['independence'] as ReturnType<typeof independenceOf> | undefined), ...ownIndependence]) } : {}),
            },
          };
        }
      }

      let loop = await runLoop(ctx, task, opts);
      const qa = loop.qa;
      const servedModels = loop.servedModels ?? [];
      let answeredBy: AnsweredBy = loop.modelAnswered === true ? 'model' : 'model_incomplete';
      if (loop.note) limitations.push(`Model: ${loop.note}${loop.calls ? '' : '; keyword rules were used'}.`);
      if (!loop.answer && !loop.calls) {
        loop = { ...(await runRules(ctx, task, opts.fallbackRules)), note: loop.note };
        answeredBy = 'keyword_rules';
      }
      limitations.push(...loop.failures.map((f) => `Tool refused or failed: ${f}`));
      return {
        summary: loop.answer || 'No answer.',
        confidence: loop.calls && !loop.failures.length ? 0.7 : loop.calls ? 0.5 : 0.3,
        limitations,
        // modelUsed is false when keyword rules produced this answer (QA does not count such a part as checked).
        data: { toolCalls: loop.calls, modelUsed: answeredBy !== 'keyword_rules', answeredBy, ...(qa ? { independence: independenceOf(qa, answeredBy === 'keyword_rules' ? [] : servedModels) } : {}) },
      };
    },
  };
}
