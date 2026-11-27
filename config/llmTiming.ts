/**
 * config/llmTiming.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One place for how long a model request may take (PERF-03).
 *
 * The provider tried a request up to 3 times, 10 s each (30 s), while the
 * PLANNING watchdog reset the state machine to IDLE after 15 s: on a slow
 * link the second attempt was cut off from under it, and its answer arrived
 * in a state that no longer expected one. The watchdog's default is now
 * derived from the provider's own budget.
 */

/** Attempts one model request gets (bridge/groqProvider.ts). */
export const LLM_MAX_ATTEMPTS = 3;

/** One attempt's time limit (JARVIS_LLM_TIMEOUT_MS, default 10 s). */
export function llmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env['JARVIS_LLM_TIMEOUT_MS'] ?? 10_000);
  return Number.isFinite(v) && v > 0 ? v : 10_000;
}

/** Every attempt of one request, plus a short margin. */
export function llmRequestBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return llmTimeoutMs(env) * LLM_MAX_ATTEMPTS + 2_000;
}

/**
 * How long PLANNING may last: JARVIS_PLANNING_WATCHDOG_MS when set, else at
 * least the request budget (and never below the old 15 s). A set value below
 * the budget is raised to it, with a warning (VOICE-002: below it, an answer
 * still on its way was cut off and the request ended in silence; the owner's
 * .env had 30000 against a 62000 budget). A value that is not a positive
 * number of milliseconds is not used, and the warning says so.
 */
export function planningWatchdogMs(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = console.warn): number {
  const budget = llmRequestBudgetMs(env);
  const fallback = Math.max(15_000, budget);
  const raw = env['JARVIS_PLANNING_WATCHDOG_MS'];
  if (raw === undefined || raw.trim() === '') return fallback;
  const set = Number(raw);
  if (!Number.isFinite(set) || set <= 0) {
    warn(`[Config] JARVIS_PLANNING_WATCHDOG_MS="${raw.trim().slice(0, 40)}" is not a positive number of milliseconds: using ${fallback} instead. Leave it empty for that default, or set at least ${budget}.`);
    return fallback;
  }
  if (set < budget) {
    warn(`[Config] JARVIS_PLANNING_WATCHDOG_MS=${set} is below one model request's retries (${LLM_MAX_ATTEMPTS} × ${llmTimeoutMs(env)} ms) and would cut slow answers off: using ${budget}. Use at least ${budget}, or remove the line.`);
    return budget;
  }
  return set;
}
