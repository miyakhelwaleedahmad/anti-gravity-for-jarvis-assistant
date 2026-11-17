/**
 * bridge/modelCategories.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Which model does which kind of work, in one place, and a record of every
 * model call (self-healing architecture, model-routing phase).
 *
 *   intent        short classification          fast model
 *   conversation  replies, synthesis            fast model
 *   planning      plans, tool calls, agents     brain model
 *   repair_plan   diagnosing a failure          brain model
 *   coding        writing a code repair         brain model
 *   review        checking a repair             a model other than coding's, when one is configured
 *
 * Each category can be moved by configuration alone:
 *   JARVIS_MODEL_<CATEGORY>=<model>              same provider, another model
 *   JARVIS_MODEL_<CATEGORY>=<provider>:<model>   e.g. anthropic:claude-opus-5-5
 *   JARVIS_MODEL_<CATEGORY>_TIMEOUT_MS / _MAX_TOKENS
 *   JARVIS_MODEL_AGENT_<ROLE>=…                  one specialist agent's own route
 *                                                (e.g. JARVIS_MODEL_AGENT_QA_AGENT)
 * Unset, a category goes exactly where it always did. Set, modelRouter.chat()
 * and streamChat() send it there (Phase 1A). A configured CODING or REVIEW
 * kind, and a configured JARVIS_MODEL_AGENT_CODING_AGENT / _QA_AGENT, is
 * strict: even as a bare model name it goes to that one provider and model,
 * and a failure is an error, never another provider's answer. The other kinds
 * fall back to the default model. JARVIS_MODEL_QUEUE_WAIT_MS limits how long a
 * background call waits for the owner's conversation.
 * A model ID is never assumed to exist: the Anthropic provider checks it
 * against the provider's model list before its first use.
 *
 * Usage: every call through modelRouter is recorded with its category,
 * provider, model, correlation id, latency, fallback, agent role and token
 * counts. Token counts a provider did not report are null, never 0. Cost is
 * estimated only from a configured price table (JARVIS_MODEL_PRICES) and only
 * when both token counts are known. The records are saved under the data root
 * (bridge/usageLedger.ts), so the history survives a restart.
 */

import { llmConfig } from '../config/llmconfig.js';
import { appendUsage, readRecentUsage } from './usageLedger.js';

export const MODEL_CATEGORIES = ['intent', 'conversation', 'planning', 'repair_plan', 'coding', 'review'] as const;
export type ModelCategory = typeof MODEL_CATEGORIES[number];

export interface ModelRoute {
  category: ModelCategory;
  /** "default": the configured provider with its failover; otherwise a named provider. */
  provider: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  source: 'default' | 'config';
  /** The setting that chose this route, e.g. JARVIS_MODEL_PLANNING or JARVIS_MODEL_AGENT_QA_AGENT. */
  key: string;
  /** The time limit / token cap were set explicitly (ModelRouter.chat() applies only these). */
  explicitTimeout: boolean;
  explicitMaxTokens: boolean;
  /** The agent whose own setting (JARVIS_MODEL_AGENT_<ROLE>) chose this route, if one did. */
  agentRole?: string;
  /**
   * A configured route whose model must never be replaced by another: its
   * failure is an error (StrictRouteError in bridge/modelRouter.ts), never
   * another provider's or model's answer. See STRICT_CATEGORIES and STRICT_AGENT_ROLES.
   */
  strict: boolean;
  /** For review: false when it is the same provider and model as coding. */
  independent?: boolean;
}

/**
 * Kinds of work whose configured model must never be replaced silently by
 * another: code repair's author and reviewer, and goalVerifier's judge (it
 * asks as 'review'). A configured route of any other kind falls back to the
 * default model when its provider fails.
 */
export const STRICT_CATEGORIES: ReadonlySet<ModelCategory> = new Set<ModelCategory>(['coding', 'review']);

/**
 * Agents whose own configured model (JARVIS_MODEL_AGENT_<ROLE>) is strict
 * (owner's decision, 2026-11-15): a failing QA route must not be answered by
 * the coding model, and coding must not silently move to another model.
 */
export const STRICT_AGENT_ROLES: ReadonlySet<string> = new Set(['coding_agent', 'qa_agent']);

/** The setting for one agent role: "coding_agent" → JARVIS_MODEL_AGENT_CODING_AGENT. */
export function agentRouteKey(role: string): string {
  return `JARVIS_MODEL_AGENT_${role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

const DEFAULTS: Record<ModelCategory, { fast: boolean; timeoutMs: number; maxTokens: number }> = {
  intent:       { fast: true,  timeoutMs: 3_000,   maxTokens: 256 },
  conversation: { fast: true,  timeoutMs: 30_000,  maxTokens: 1_024 },
  planning:     { fast: false, timeoutMs: 60_000,  maxTokens: 4_096 },
  repair_plan:  { fast: false, timeoutMs: 120_000, maxTokens: 8_000 },
  coding:       { fast: false, timeoutMs: 300_000, maxTokens: 16_000 },
  review:       { fast: false, timeoutMs: 120_000, maxTokens: 4_000 },
};

/** Default model per named provider, used only when a category names the provider without a model. */
const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-opus-5-5',
};

function num(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

/**
 * Where a category's calls go, from configuration (read each time, so tests
 * can change it). With `agentRole`, that agent's own setting
 * (JARVIS_MODEL_AGENT_<ROLE>, same syntax) wins over the category's.
 */
/**
 * The route a helper agent inherits from its parent (owner, 2026-11-15): the
 * parent's own route, when it is configured and strict (a coding_agent or
 * qa_agent with its own setting). Anything else inherits nothing, so a
 * helper of an unconfigured parent keeps its own route, as before.
 */
export function inheritedRoute(category: ModelCategory, parentRole: string | undefined, env: Record<string, string | undefined> = process.env): ModelRoute | undefined {
  if (!parentRole) return undefined;
  const route = routeFor(category, env, parentRole);
  return route.strict && route.agentRole === parentRole ? route : undefined;
}

export function routeFor(category: ModelCategory, env: Record<string, string | undefined> = process.env, agentRole?: string): ModelRoute {
  const d = DEFAULTS[category];
  const agentKey = agentRole ? agentRouteKey(agentRole) : undefined;
  const key = agentKey && env[agentKey]?.trim() ? agentKey : `JARVIS_MODEL_${category.toUpperCase()}`;
  const raw = env[key]?.trim();
  let provider = 'default';
  let model = d.fast ? llmConfig.fastModel : llmConfig.model;
  let source: ModelRoute['source'] = 'default';
  if (raw) {
    source = 'config';
    const m = /^([a-z][a-z0-9_-]*):(.+)$/.exec(raw);
    if (m && m[1] !== 'models') { provider = m[1]!; model = m[2]!.trim(); }
    else if (PROVIDER_DEFAULT_MODEL[raw]) { provider = raw; model = PROVIDER_DEFAULT_MODEL[raw]!; }
    else model = raw;
  }
  const timeoutMs = num(env[`${key}_TIMEOUT_MS`], -1, 1_000, 30 * 60_000);
  const maxTokens = num(env[`${key}_MAX_TOKENS`], -1, 16, 128_000);
  const route: ModelRoute = {
    category, provider, model, source, key,
    timeoutMs: timeoutMs > 0 ? timeoutMs : d.timeoutMs,
    maxTokens: maxTokens > 0 ? maxTokens : d.maxTokens,
    explicitTimeout: timeoutMs > 0,
    explicitMaxTokens: maxTokens > 0,
    ...(agentRole && key === agentKey ? { agentRole } : {}),
    // Strict only when configured: an unconfigured route keeps its failover, as before.
    strict: source === 'config' && (STRICT_CATEGORIES.has(category) || (!!agentRole && key === agentKey && STRICT_AGENT_ROLES.has(agentRole))),
  };
  if (category === 'review') {
    const coding = routeFor('coding', env);
    route.independent = !(coding.provider === route.provider && coding.model === route.model);
    // Without its own configuration, review uses the fast model when that differs from coding's.
    if (!raw && !route.independent && llmConfig.fastModel !== coding.model) {
      route.model = llmConfig.fastModel;
      route.independent = true;
    }
  }
  return route;
}

/**
 * How long a configured route's background call may wait for the owner's
 * conversation before it fails with a clear error (JARVIS_MODEL_QUEUE_WAIT_MS).
 * Undefined when unset: the wait is then bounded only by the background yield
 * limit (core/foregroundGate.ts, at most 120 s), after which the call goes ahead.
 */
export function queueWaitMs(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env['JARVIS_MODEL_QUEUE_WAIT_MS']?.trim();
  if (!raw) return undefined;
  const n = num(raw, -1, 1, 30 * 60_000);
  return n > 0 ? n : undefined;
}

/**
 * The provider and model a route really reaches: "default" is the primary
 * provider; with Claude as the primary a brain/fast model name becomes
 * Claude's (the same rule as modelFor() in bridge/modelRouter.ts, which
 * sends it); the OpenAI-compatible fallback ("openai") always sends its own
 * JARVIS_FALLBACK_MODEL, whatever model the route names
 * (bridge/openaiProvider.ts). Model names are compared without case.
 */
export function effectiveTarget(route: Pick<ModelRoute, 'provider' | 'model'>, env: Record<string, string | undefined> = process.env): { provider: string; model: string } {
  const provider = route.provider === 'default' ? llmConfig.primary : route.provider;
  let model = route.model;
  const claude = llmConfig.primary === 'anthropic' ? llmConfig.anthropic : undefined;
  if (claude && provider === 'anthropic' && !/^claude/i.test(model)) {
    model = model === llmConfig.fastModel ? claude.fastModel : claude.model;
  }
  if (provider === 'openai') model = env['JARVIS_FALLBACK_MODEL'] ?? 'gpt-4o-mini';
  return { provider, model: model.trim().toLowerCase() };
}

/**
 * Why two targets cannot be counted as different models, or undefined when
 * they can. Besides the same model, a provider's own client may answer with
 * another model of the same provider, and that would not show in the usage
 * records: the Gemini/Groq client moves to its fast model on a rate limit or
 * cooldown (bridge/groqProvider.ts), and Claude's server-side fallbacks may
 * answer with another Claude model (bridge/anthropicProvider.ts).
 */
function sameModelPossible(a: { provider: string; model: string; exact?: boolean; ids?: readonly string[]; resolved?: boolean }, b: { provider: string; model: string; exact?: boolean; ids?: readonly string[]; resolved?: boolean }): string | undefined {
  if (a.provider === b.provider && a.model === b.model) return `both use ${a.provider} ${a.model}`;
  // The same model id through two providers (e.g. two gateways) is the same model.
  if (a.model === b.model) return `both may use the model ${a.model} (${a.provider}, ${b.provider})`;
  // One model under two names (Claude's alias and its dated id, a gateway
  // id, a date stamp, a version suffix): compare identity keys, not names (review M-A, R2).
  const keysA = new Set((a.ids ?? [a.model]).map(identityKey));
  const shared = (b.ids ?? [b.model]).map(identityKey).find((k) => keysA.has(k));
  if (shared) return `${a.provider} ${a.model} and ${b.provider} ${b.model} are the same model (${shared})`;
  // A floating alias ("-latest") does not say which model answers: unknown, never independent (R2).
  const floating = [a, b].find((t) => isFloatingAlias(t.model));
  if (floating) return `${floating.provider} ${floating.model} is a floating alias; which model it names is not known`;
  // An identity the provider could not look up is unknown, never "different".
  if (a.resolved === false || b.resolved === false) return `the identity of ${a.resolved === false ? `${a.provider} ${a.model}` : `${b.provider} ${b.model}`} could not be looked up`;
  if (a.provider !== b.provider) return undefined;
  // Two strict routes are sent exactly and their reported model is confirmed
  // (bridge/modelRouter.ts, owner 2026-11-16): different models stay different.
  if (a.exact && b.exact) return undefined;
  if (a.provider === 'anthropic') return 'both use Claude, whose server-side fallbacks may answer with another Claude model';
  // The Gemini/Groq client can move either model to its fast model on a rate
  // limit or cooldown, so two models there may end up as the same one.
  if (a.provider === 'gemini' || a.provider === 'groq' || a.provider === llmConfig.provider) {
    return `both use ${a.provider}, whose client may move either model to its fast model ${llmConfig.fastModel} on a rate limit`;
  }
  return undefined;
}

/**
 * The key two model names are compared by: one model under several names has
 * one key (owner, 2026-11-16, R2; review L-1). Lower case; without a
 * "models/" prefix, a gateway "vendor/" prefix, a Bedrock "vendor." or
 * "region.vendor." prefix (letters only), a ":variant" suffix (":free",
 * ":0"), a date stamp ("-20261101", "-2026-11-01", "@20261101"), a "-NNN"
 * version ("-001") or a "-vN" version after a number ("…-5-5-v1"); a dot
 * between digits is a dash ("5.5" = "5-5").
 * Folding more names together only makes more pairs "the same" (fail closed).
 */
export function identityKey(model: string): string {
  let k = model.trim().toLowerCase().replace(/^models\//, '');
  k = k.slice(k.lastIndexOf('/') + 1);
  k = k.replace(/:[^:]*$/, '');
  k = k.replace(/^(?:[a-z][a-z-]*\.)+/, '');
  k = k.replace(/(\d)\.(?=\d)/g, '$1-');
  for (let before = ''; before !== k;) {
    before = k;
    k = k.replace(/(?:@|-)\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{3}$/, '').replace(/(?<=\d)-v\d+$/, '');
  }
  return k;
}

/** A name whose target model changes over time ("gemini-flash-latest", "latest", Ollama's "llama3:latest"): its identity is not known. */
export function isFloatingAlias(model: string): boolean {
  return /(?:^|[-_.:@/])latest$/i.test(model.trim()) || /(?:^|[-_.])latest$/i.test(identityKey(model));
}

/**
 * The helper roles each specialist can create, directly or through its
 * workers (core/agents/specialists.ts; a test keeps this in step with the
 * registry). A helper with its own model setting answers part of that
 * specialist's work, so it counts among the specialist's models (L1).
 */
export const HELPER_ROLES: Readonly<Record<string, readonly string[]>> = {
  coding_agent: ['code_analysis_worker', 'test_runner_worker', 'repo_discovery_worker', 'repo_code_analysis_worker', 'project_deep_analysis_worker'],
  qa_agent: ['test_runner_worker', 'evidence_check_worker'],
};

/**
 * A provider and model an agent's call can be answered by; exact: a strict
 * route (sent exactly, reported model confirmed). ids: every id the provider
 * treats as this model (e.g. Claude's alias and its dated id), lower case;
 * resolved: false when the provider could not look the model up.
 */
export interface ModelTarget { provider: string; model: string; exact: boolean; ids?: string[]; resolved?: boolean }

/**
 * Whether every model QA can be answered by differs from every model coding
 * can be answered by (N2: failover included; the router lists them,
 * ModelRouter.possibleTargets). Nothing known on either side: not independent.
 */
export function targetsIndependent(coding: readonly ModelTarget[], qa: readonly ModelTarget[]): { independent: boolean; reason: string } {
  if (!coding.length || !qa.length) return { independent: false, reason: `not independent: no known model for ${!coding.length ? 'coding' : 'QA'}` };
  for (const c of coding) {
    for (const q of qa) {
      const same = sameModelPossible(c, q);
      if (same) return { independent: false, reason: `not independent: ${same}` };
    }
  }
  const list = (ts: readonly ModelTarget[]) => ts.map((t) => `${t.provider} ${t.model}`).join(', ');
  return { independent: true, reason: `independent: coding may use ${list(coding)}; QA may use ${list(qa)}` };
}

/**
 * Whether QA must run on a model distinct from coding's (owner, 2026-11-16,
 * D1): JARVIS_QA_REQUIRE_INDEPENDENT true/1/yes/on = required, false/0/no/off =
 * not required (QA runs and is labelled not independent); unset = required
 * exactly when QA has its own model setting (JARVIS_MODEL_AGENT_QA_AGENT).
 */
export function qaIndependenceRequired(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env['JARVIS_QA_REQUIRE_INDEPENDENT']?.trim().toLowerCase();
  if (raw && ['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (raw && ['false', '0', 'no', 'off'].includes(raw)) return false;
  return routeFor('planning', env, 'qa_agent').agentRole === 'qa_agent';
}

/**
 * Whether qa_agent is configured to check coding_agent's work on a different
 * model, compared by the provider and model each route really reaches (not by
 * the setting's wording: "default" and the primary's own name, two names for
 * the fallback provider's one model, upper and lower case are the same target).
 * When the same model could answer both, they are not independent. Called
 * with `targets` (ModelRouter.qaIndependence: every model each side can be
 * answered by, with their looked-up identities), this is the check QA work
 * enforces before its first model call when JARVIS_QA_REQUIRE_INDEPENDENT
 * requires it (core/agents/behaviors/toolLoop.ts). Without targets it reads
 * configuration only. observedAgentIndependence() reads the usage records.
 */
export function agentIndependence(env: Record<string, string | undefined> = process.env, targets?: { coding: readonly ModelTarget[]; qa: readonly ModelTarget[] }): { coding: ModelRoute; qa: ModelRoute; codingTarget: { provider: string; model: string }; qaTarget: { provider: string; model: string }; codingTargets?: readonly ModelTarget[]; qaTargets?: readonly ModelTarget[]; independent: boolean; reason: string } {
  const coding = routeFor('planning', env, 'coding_agent');
  const qa = routeFor('planning', env, 'qa_agent');
  // With no setting, the router does not route an agent's call: it goes out
  // with the model the agent sends, agentModel() in core/agents/behaviors/common.ts
  // (JARVIS_AGENT_MODEL, else the fast model), not the planning default.
  const sent = (route: ModelRoute) => (route.source === 'default' ? { ...route, model: env['JARVIS_AGENT_MODEL']?.trim() || llmConfig.fastModel } : route);
  const codingTarget = effectiveTarget(sent(coding), env);
  const qaTarget = effectiveTarget(sent(qa), env);
  if (targets) {
    // Every model each side can be answered by, failover included (N2).
    const t = targetsIndependent(targets.coding, targets.qa);
    return { coding, qa, codingTarget, qaTarget, codingTargets: targets.coding, qaTargets: targets.qa, ...t };
  }
  const same = sameModelPossible(codingTarget, qaTarget);
  return {
    coding, qa, codingTarget, qaTarget,
    independent: !same,
    reason: same ? `not independent: ${same}` : `independent: coding uses ${codingTarget.provider} ${codingTarget.model}, QA uses ${qaTarget.provider} ${qaTarget.model}`,
  };
}

/**
 * Whether coding_agent and qa_agent really ran on different models: their
 * latest successful calls in the usage records (provider, and the model the
 * provider really uses, as effectiveTarget() reads it). With
 * `opts.correlationId`, only that request's calls are paired. null when either
 * has no successful call: QA that did not run is never reported as
 * independent. As with agentIndependence(), a model swap inside a provider's
 * client is not visible in the records, so a pair that could have been
 * answered by the same model is not counted as independent.
 */
export function observedAgentIndependence(recs: readonly UsageRecord[] = usageLog(), opts: { correlationId?: string } = {}): { coding?: { provider: string; model: string }; qa?: { provider: string; model: string }; independent: boolean | null; reason: string } {
  const latest = (role: string) => {
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i]!;
      if (r.agentRole !== role || !r.ok) continue;
      if (opts.correlationId !== undefined && r.correlationId !== opts.correlationId) continue;
      return effectiveTarget({ provider: r.provider, model: r.model });
    }
    return undefined;
  };
  const coding = latest('coding_agent');
  const qa = latest('qa_agent');
  if (!coding || !qa) {
    return { ...(coding ? { coding } : {}), ...(qa ? { qa } : {}), independent: null, reason: `unknown: ${!coding ? 'no successful coding_agent call' : 'no successful qa_agent call'}${opts.correlationId !== undefined ? ` for ${opts.correlationId}` : ''}` };
  }
  // A call made without a model name is recorded as "(provider default)": which model answered is not known.
  const unknownModel = [coding, qa].find((t) => t.model === UNKNOWN_MODEL);
  if (unknownModel) return { coding, qa, independent: null, reason: `unknown: a ${unknownModel === coding ? 'coding_agent' : 'qa_agent'} call was recorded without its model` };
  const same = sameModelPossible(coding, qa);
  return { coding, qa, independent: !same, reason: same ? `not independent: ${same}` : 'independent: different models answered' };
}

/** The model name the router records for a call made without one (bridge/modelRouter.ts noteUsage), lowercased as effectiveTarget does. */
const UNKNOWN_MODEL = '(provider default)';

// ─── Usage records ───────────────────────────────────────────────────────────

export interface UsageRecord {
  at: string;
  category: ModelCategory | 'unspecified';
  provider: string;
  model: string;
  correlationId?: string;
  latencyMs: number;
  ok: boolean;
  /** A provider other than the first one answered. */
  fallbackUsed: boolean;
  streamed: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Only with a configured price and both token counts; always an estimate. */
  estimatedCostUsd?: number;
  error?: string;
  /** The specialist agent that made the call, when one did. */
  agentRole?: string;
  /** The model the provider reported it used; absent when it reported none (never copied from `model`). */
  servedModel?: string;
}

const KEEP = 500;
const records: UsageRecord[] = [];
/**
 * The ledger's latest records are loaded on the first use, not at import, so
 * a restart keeps the history (bridge/usageLedger.ts) and no import pays for it.
 */
let loaded = false;
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  records.unshift(...readRecentUsage(KEEP));
  if (records.length > KEEP) records.splice(0, records.length - KEEP);
}

/** Price per million tokens, from JARVIS_MODEL_PRICES='{"model":{"input":4,"output":20}}'. */
export function priceOf(model: string, env: Record<string, string | undefined> = process.env): { input: number; output: number } | undefined {
  try {
    const table = JSON.parse(env['JARVIS_MODEL_PRICES'] ?? '{}') as Record<string, { input?: unknown; output?: unknown }>;
    const p = table[model];
    return p && typeof p.input === 'number' && typeof p.output === 'number' ? { input: p.input, output: p.output } : undefined;
  } catch {
    return undefined;
  }
}

export function recordUsage(r: Omit<UsageRecord, 'at' | 'estimatedCostUsd'> & { at?: string }): UsageRecord {
  ensureLoaded();
  const price = priceOf(r.model);
  const rec: UsageRecord = {
    ...r,
    at: r.at ?? new Date().toISOString(),
    ...(price && typeof r.promptTokens === 'number' && typeof r.completionTokens === 'number'
      ? { estimatedCostUsd: Math.round(((r.promptTokens * price.input + r.completionTokens * price.output) / 1_000_000) * 1e6) / 1e6 }
      : {}),
  };
  records.push(rec);
  if (records.length > KEEP) records.splice(0, records.length - KEEP);
  appendUsage(rec);   // never throws: a lost record never fails the call
  return rec;
}

/** The latest records, oldest first. */
export function usageLog(limit = KEEP): UsageRecord[] {
  ensureLoaded();
  return records.slice(-limit);
}

/** Totals per category; tokens summed only where known, with how many calls had no count. */
export function usageSummary(): Record<string, { calls: number; failed: number; promptTokens: number; completionTokens: number; unknownTokenCalls: number; estimatedCostUsd?: number }> {
  ensureLoaded();
  const out: ReturnType<typeof usageSummary> = {};
  for (const r of records) {
    const s = out[r.category] ??= { calls: 0, failed: 0, promptTokens: 0, completionTokens: 0, unknownTokenCalls: 0 };
    s.calls++;
    if (!r.ok) s.failed++;
    if (typeof r.promptTokens === 'number' && typeof r.completionTokens === 'number') {
      s.promptTokens += r.promptTokens;
      s.completionTokens += r.completionTokens;
    } else s.unknownTokenCalls++;
    if (r.estimatedCostUsd !== undefined) s.estimatedCostUsd = Math.round(((s.estimatedCostUsd ?? 0) + r.estimatedCostUsd) * 1e6) / 1e6;
  }
  return out;
}

/** For tests: empties the in-memory list (the ledger file is kept and not reloaded). */
export function clearUsage(): void {
  records.length = 0;
  loaded = true;
}
