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
 * A model ID is never assumed to exist: the Anthropic provider checks it
 * against the provider's model list before its first use.
 *
 * Usage: every call through modelRouter is recorded with its category,
 * provider, model, correlation id, latency, fallback and token counts. Token
 * counts a provider did not report are null, never 0. Cost is estimated only
 * from a configured price table (JARVIS_MODEL_PRICES) and only when both
 * token counts are known.
 */

import { llmConfig } from '../config/llmconfig.js';

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
  /** For review: false when it is the same provider and model as coding. */
  independent?: boolean;
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

/** Where a category's calls go, from configuration (read each time, so tests can change it). */
export function routeFor(category: ModelCategory, env: Record<string, string | undefined> = process.env): ModelRoute {
  const d = DEFAULTS[category];
  const key = `JARVIS_MODEL_${category.toUpperCase()}`;
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
  const route: ModelRoute = {
    category, provider, model, source,
    timeoutMs: num(env[`${key}_TIMEOUT_MS`], d.timeoutMs, 1_000, 30 * 60_000),
    maxTokens: num(env[`${key}_MAX_TOKENS`], d.maxTokens, 16, 128_000),
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
}

const KEEP = 500;
const records: UsageRecord[] = [];

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
  return rec;
}

/** The latest records, oldest first. */
export function usageLog(limit = KEEP): UsageRecord[] {
  return records.slice(-limit);
}

/** Totals per category; tokens summed only where known, with how many calls had no count. */
export function usageSummary(): Record<string, { calls: number; failed: number; promptTokens: number; completionTokens: number; unknownTokenCalls: number; estimatedCostUsd?: number }> {
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

/** For tests. */
export function clearUsage(): void {
  records.length = 0;
}
