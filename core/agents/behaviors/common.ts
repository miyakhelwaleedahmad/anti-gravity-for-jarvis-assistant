/**
 * core/agents/behaviors/common.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Helpers shared by the agent behaviours:
 *  - askJson: one model call that must answer JSON, with a rule-based fallback
 *    when the model is unavailable, rate-limited, over budget or answers
 *    something unusable. Behaviours always have a way to finish without the
 *    model; the fallback is reported as a limitation, never hidden.
 *  - untrusted: wraps outside text (READMEs, web results, tool output) so the
 *    model treats it as data, as the rest of JARVIS does for web pages.
 *  - small parsing and scoring helpers.
 */

import { llmConfig } from '../../../config/llmconfig.js';
import type { AgentContext } from '../agentContextApi.js';
import { BudgetExceededError } from '../agentContextApi.js';
import { routeFor } from '../../../bridge/modelCategories.js';
import type { ToolResult } from '../../toolRegistryV2.js';

/** Model for agent calls: JARVIS_AGENT_MODEL, else the fast model (more requests per minute on the free tier). */
export function agentModel(): string {
  return process.env['JARVIS_AGENT_MODEL']?.trim() || llmConfig.fastModel;
}

// Shared with the orchestrator (SEC-03): one wrapper for outside text.
import { UNTRUSTED_RULE, untrusted } from '../../../security/untrustedText.js';
export { UNTRUSTED_RULE, untrusted };

/** The first JSON object or array in a model answer (code fences allowed). */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* look inside */ }
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = t.indexOf(open);
    const end = t.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try { return JSON.parse(t.slice(start, end + 1)); } catch { /* next */ }
    }
  }
  return undefined;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * The role whose strict route this agent's calls use: its own, or the nearest
 * specialist above it with a configured strict setting (a coding_agent or
 * qa_agent with its own model). The agent manager decides it from who spawned
 * whom (AgentContext.strictRouteRole), never from task input (owner, 2026-11-16).
 */
export function strictRouteRole(ctx: AgentContext): string | undefined {
  if (ctx.strictRouteRole) return ctx.strictRouteRole();
  return routeFor('planning', process.env, ctx.agent.role).strict ? ctx.agent.role : undefined;
}

/**
 * A worker's failure carried up to its parent with the worker's own code
 * (MODEL_UNAVAILABLE, MODEL_IDENTITY_UNCONFIRMED, or BUDGET_EXCEEDED with the
 * budget that ran out), so the parent is recorded as the same condition, not
 * as a different one (owner, 2026-11-16).
 */
export type FailureCause = { code: string; budget?: 'llmCalls' | 'toolCalls' | 'tokens' };

export class PropagatedFailure extends Error {
  constructor(message: string, readonly code: string, readonly budget?: 'llmCalls' | 'toolCalls' | 'tokens',
    /** Every distinct cause, when the parts failed for more than one (review LR-2). */
    readonly causes?: FailureCause[]) {
    super(message);
    this.name = 'PropagatedFailure';
  }
}

/**
 * The order recovery acts on causes (review LR-2): the provider did not confirm
 * the model (the owner fixes the setting), the model did not answer, then a
 * budget, model budgets before the tool budget.
 */
const CAUSE_RANK = ['MODEL_IDENTITY_UNCONFIRMED', 'MODEL_UNAVAILABLE', 'BUDGET_EXCEEDED:llmCalls', 'BUDGET_EXCEEDED:tokens', 'BUDGET_EXCEEDED:toolCalls', 'BUDGET_EXCEEDED:'];
const causeRank = (c: FailureCause): number => {
  const i = CAUSE_RANK.indexOf(c.code === 'BUDGET_EXCEEDED' ? `BUDGET_EXCEEDED:${c.budget ?? ''}` : c.code);
  return i < 0 ? CAUSE_RANK.length : i;
};

/**
 * The distinct causes of a split request's failed parts, in recovery order. A
 * part with no carried code (answered by keyword rules, unfinished, the
 * parent's own part, or another failure) is the model not answering.
 */
export function failureCauses(parts: ReadonlyArray<FailureCause | undefined>): FailureCause[] {
  const out = new Map<string, FailureCause>();
  for (const p of parts) {
    const c: FailureCause = p?.code === 'MODEL_IDENTITY_UNCONFIRMED' ? { code: p.code }
      : p?.code === 'BUDGET_EXCEEDED' ? { code: p.code, ...(p.budget ? { budget: p.budget } : {}) }
      : { code: 'MODEL_UNAVAILABLE' };
    out.set(`${c.code}:${c.budget ?? ''}`, c);
  }
  return [...out.values()].sort((a, b) => causeRank(a) - causeRank(b));
}

/** The cause recovery acts on first: identity, then the model not answering, then a budget. */
export function leadingCause(causes: FailureCause[]): FailureCause {
  return [...causes].sort((a, b) => causeRank(a) - causeRank(b))[0] ?? { code: 'MODEL_UNAVAILABLE' };
}

/** Carried codes, most specific first: the provider did not confirm the model, a budget ran out, the model did not answer. */
const FAILURE_ORDER = ['MODEL_IDENTITY_UNCONFIRMED', 'BUDGET_EXCEEDED', 'MODEL_UNAVAILABLE'] as const;

/**
 * Of several workers' failures, the most specific condition to record on their
 * parent (review L-4, M1), with the budget that ran out; undefined when none
 * carries one of these codes.
 */
export function mostSpecificFailure(errors: ReadonlyArray<{ code?: string; budget?: 'llmCalls' | 'toolCalls' | 'tokens' } | undefined>): { code: string; budget?: 'llmCalls' | 'toolCalls' | 'tokens' } | undefined {
  for (const code of FAILURE_ORDER) {
    const e = errors.find((x) => x?.code === code);
    if (e) return { code, ...(e.budget ? { budget: e.budget } : {}) };
  }
  return undefined;
}

/** The required model did not give a usable answer: the task ends FAILED with this, never answered by rules. */
export function modelUnavailable(message: string, cause?: unknown): Error {
  const e = new Error(message, cause === undefined ? undefined : { cause });
  e.name = 'ModelUnavailableError';
  return e;
}

export interface AskResult<T> {
  value: T;
  viaModel: boolean;
  /** Why the rules were used, when they were. */
  note?: string;
}

/**
 * Asks the model for JSON that `accept` validates. Falls back to `fallback()`
 * when the call fails or the answer is not acceptable. Cancellation is never
 * swallowed. On a strict route (strictRouteRole) there is no fallback: a
 * failed call, a used-up budget or an unusable answer ends the task with the
 * full reason (owner, 2026-11-16).
 */
export async function askJson<T>(
  ctx: AgentContext,
  input: { system: string; user: string; maxTokens?: number },
  accept: (value: unknown) => T | undefined,
  fallback: () => T,
): Promise<AskResult<T>> {
  let note: string;
  const strict = strictRouteRole(ctx);
  try {
    const res = await ctx.llm({
      model: agentModel(),
      messages: [
        { role: 'system', content: `${input.system}\n${UNTRUSTED_RULE}\nAnswer with JSON only, no prose.` },
        { role: 'user', content: input.user },
      ],
      temperature: 0.2,
      max_tokens: input.maxTokens ?? 900,
    });
    const value = accept(extractJson(res.content ?? ''));
    if (value !== undefined) return { value, viaModel: true };
    if (strict) throw modelUnavailable(`The ${ctx.agent.role} agent's configured model (${strict} setting) gave an answer that was not usable; rules are not used in its place.`);
    note = 'the model\'s answer was not usable';
  } catch (err) {
    if (isAbort(err)) throw err;
    if (strict) {
      // Strict route: the original error ends the task, never answered by rules.
      if (err instanceof BudgetExceededError || (err instanceof Error && err.name === 'ModelUnavailableError')) throw err;
      throw err instanceof Error && ['StrictRouteError', 'QueueWaitTimeoutError'].includes(err.name)
        ? err
        : modelUnavailable(`The ${ctx.agent.role} agent's configured model (${strict} setting) was not available: ${err instanceof Error ? err.message : String(err)}`, err);
    }
    note = err instanceof BudgetExceededError ? 'the model-call budget was used up'
      : `the model was not available (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`;
  }
  ctx.checkpoint();
  return { value: fallback(), viaModel: false, note: `${note}; rules were used instead` };
}

/** A tool call whose JSON result is parsed; failures come back as { ok: false, error }. */
export async function callJson(ctx: AgentContext, tool: string, args: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown>; raw: ToolResult } | { ok: false; error: string; raw: ToolResult }> {
  const raw = await ctx.callTool(tool, args);
  if (!raw.success) return { ok: false, error: raw.error && raw.error !== raw.output ? `${raw.error}: ${raw.output}` : raw.output, raw };
  const parsed = extractJson(raw.output);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const data = parsed as Record<string, unknown>;
    if (data['success'] === false) return { ok: false, error: String(data['error'] ?? 'failed'), raw };
    return { ok: true, data, raw };
  }
  return { ok: true, data: { text: raw.output }, raw };
}

/** Lower-case words of a request that carry meaning, for search queries and relevance. */
const FILLER = new Set([
  'find', 'the', 'best', 'for', 'giving', 'give', 'a', 'an', 'of', 'to', 'and', 'or', 'me', 'my', 'please', 'jarvis',
  'projects', 'project', 'github', 'repositories', 'repository', 'repos', 'repo', 'what', 'which', 'are', 'is', 'on',
  'with', 'that', 'can', 'could', 'should', 'good', 'top', 'some', 'about', 'in', 'how', 'do', 'i', 'search', 'look', 'up',
]);
export function keywords(text: string, max = 5): string[] {
  const words = text.toLowerCase().replace(/[^a-z0-9+#.\- ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !FILLER.has(w));
  return [...new Set(words)].slice(0, max);
}

export function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

/** Permissive licences score 1; copyleft lower; none or unknown lowest. */
export function licenseScore(license: string | null | undefined): number {
  const l = String(license ?? '').toUpperCase();
  if (!l || l === 'NULL' || l === 'NOASSERTION' || l === 'OTHER') return 0.2;
  if (/MIT|APACHE|BSD|ISC|MPL|UNLICENSE|0BSD|ZLIB/.test(l)) return 1;
  if (/LGPL/.test(l)) return 0.6;
  if (/GPL|AGPL/.test(l)) return 0.4;
  return 0.5;
}

/** How JARVIS (Node/TypeScript) can use a project written in `language`. */
export function languageFit(language: string | null | undefined): { score: number; note: string } {
  const l = String(language ?? '').toLowerCase();
  if (l === 'typescript' || l === 'javascript') return { score: 1, note: 'same runtime as JARVIS (Node/TypeScript)' };
  if (l === 'python') return { score: 0.6, note: 'Python: usable through a separate process or port' };
  if (l === 'go' || l === 'rust') return { score: 0.5, note: `${language}: ideas portable, code needs a separate binary` };
  if (!l) return { score: 0.4, note: 'language unknown' };
  return { score: 0.4, note: `${language}: would need porting` };
}

/** Months since an ISO date (Infinity when unknown). */
export function monthsSince(iso: string | null | undefined, now = Date.now()): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? (now - t) / (30 * 24 * 3600 * 1000) : Infinity;
}

/** Share of `terms` that appear in `text`, 0–1. */
export function relevance(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  const t = text.toLowerCase();
  return terms.filter((w) => t.includes(w)).length / terms.length;
}
