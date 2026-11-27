/**
 * core/agents/config.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Limits of the multi-agent system. Every value can be set in .env; nothing
 * is hard-coded elsewhere. Defaults suit a slow PC on the Gemini free tier
 * (RECURSIVE_AGENT_RESEARCH.md §6).
 *
 * Depth counts from JARVIS (0): specialists are 1, their workers 2, and so on.
 */

import type { ResourceBudget } from './types.js';

export interface AgentLimits {
  /** Deepest agent level. JARVIS is 0; an agent at this depth cannot spawn. */
  maxDepth: number;
  /** Active (non-finished) children one agent may have at once. */
  maxChildrenPerAgent: number;
  /** Temporary agents alive at once, across all root tasks. */
  maxActiveAgents: number;
  /** Agents doing work at once (an agent waiting for its children does not count). */
  maxConcurrentAgents: number;
  /** Model calls from agents at once (the free tier allows few per minute). */
  maxConcurrentLlmCalls: number;
  /** Deepest task in a task tree (root task = 0). */
  maxTaskDepth: number;
  /** Whole root task, from start to final result. */
  maxRootLifetimeMs: number;
  /** Default time a child task gets when the request gives no deadline. */
  defaultTaskTimeoutMs: number;
  /** A running task with no activity for this long is stopped as stalled. */
  idleTimeoutMs: number;
  /** Retries or replacements a parent may make for one failed child. */
  maxRetries: number;
  /** Budget for a whole root task; children get parts of it. */
  rootBudget: ResourceBudget;
  /** Root tasks running at once. */
  maxRootTasks: number;
}

interface IntSpec {
  env: string;
  fallback: number;
  min: number;
  max: number;
}

const SPECS: Record<Exclude<keyof AgentLimits, 'rootBudget'>, IntSpec> = {
  maxDepth:              { env: 'JARVIS_AGENT_MAX_DEPTH', fallback: 4, min: 1, max: 8 },
  maxChildrenPerAgent:   { env: 'JARVIS_AGENT_MAX_CHILDREN', fallback: 5, min: 1, max: 20 },
  maxActiveAgents:       { env: 'JARVIS_AGENT_MAX_ACTIVE', fallback: 20, min: 1, max: 200 },
  maxConcurrentAgents:   { env: 'JARVIS_AGENT_MAX_CONCURRENT', fallback: 4, min: 1, max: 32 },
  maxConcurrentLlmCalls: { env: 'JARVIS_AGENT_LLM_CONCURRENCY', fallback: 2, min: 1, max: 16 },
  maxTaskDepth:          { env: 'JARVIS_AGENT_MAX_TASK_DEPTH', fallback: 6, min: 1, max: 12 },
  maxRootLifetimeMs:     { env: 'JARVIS_AGENT_MAX_LIFETIME_MS', fallback: 600_000, min: 1_000, max: 3_600_000 },
  defaultTaskTimeoutMs:  { env: 'JARVIS_AGENT_TASK_TIMEOUT_MS', fallback: 300_000, min: 500, max: 3_600_000 },
  idleTimeoutMs:         { env: 'JARVIS_AGENT_IDLE_TIMEOUT_MS', fallback: 120_000, min: 200, max: 3_600_000 },
  maxRetries:            { env: 'JARVIS_AGENT_MAX_RETRIES', fallback: 1, min: 0, max: 5 },
  maxRootTasks:          { env: 'JARVIS_AGENT_MAX_ROOT_TASKS', fallback: 3, min: 1, max: 20 },
};

const BUDGET_SPECS: Record<keyof ResourceBudget, IntSpec> = {
  llmCalls:  { env: 'JARVIS_AGENT_BUDGET_LLM_CALLS', fallback: 40, min: 0, max: 10_000 },
  toolCalls: { env: 'JARVIS_AGENT_BUDGET_TOOL_CALLS', fallback: 120, min: 0, max: 100_000 },
  tokens:    { env: 'JARVIS_AGENT_BUDGET_TOKENS', fallback: 400_000, min: 0, max: 100_000_000 },
};

/** Problems found while reading the settings (shown once at startup). */
export const configWarnings: string[] = [];

function readInt(spec: IntSpec, env: NodeJS.ProcessEnv): number {
  const raw = env[spec.env]?.trim();
  if (!raw) return spec.fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    configWarnings.push(`${spec.env}="${raw}" is not a whole number; using ${spec.fallback}.`);
    return spec.fallback;
  }
  if (n < spec.min || n > spec.max) {
    const clamped = Math.min(spec.max, Math.max(spec.min, n));
    configWarnings.push(`${spec.env}=${n} is outside ${spec.min}–${spec.max}; using ${clamped}.`);
    return clamped;
  }
  return n;
}

/** Reads the limits from `env`. Called again by tests that change the environment. */
export function loadAgentLimits(env: NodeJS.ProcessEnv = process.env): AgentLimits {
  configWarnings.length = 0;
  const out = {} as AgentLimits;
  for (const [key, spec] of Object.entries(SPECS) as [Exclude<keyof AgentLimits, 'rootBudget'>, IntSpec][]) {
    out[key] = readInt(spec, env);
  }
  out.rootBudget = {
    llmCalls: readInt(BUDGET_SPECS.llmCalls, env),
    toolCalls: readInt(BUDGET_SPECS.toolCalls, env),
    tokens: readInt(BUDGET_SPECS.tokens, env),
  };
  return out;
}

/** The environment variable behind each limit, for docs and the status report. */
export function limitEnvNames(): Record<string, string> {
  const names: Record<string, string> = {};
  for (const [key, spec] of Object.entries(SPECS)) names[key] = spec.env;
  for (const [key, spec] of Object.entries(BUDGET_SPECS)) names[`rootBudget.${key}`] = spec.env;
  return names;
}
