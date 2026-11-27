/**
 * core/foregroundGate.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PERF-02: the owner's request goes first. Background agents and goals share
 * the model provider's quota with the request the owner is waiting for. A
 * conversation already paused self-healing and deferred background speech,
 * but background model calls kept going, so a research run could use up the
 * per-minute quota while the owner waited for an answer.
 *
 * A model call made inside an agent (background research, a goal) waits while
 * a conversation is active, up to a limit, then goes ahead. Calls from the
 * foreground request never wait. No foreground request waits for an agent
 * (delegate_task returns at once), so this cannot hold up the owner.
 *
 *   JARVIS_BACKGROUND_YIELD_MS   longest wait per call (default 20000; 0 = off)
 */

import { conversationBus } from './conversationBus.js';
import { getAgentIds } from './traceContext.js';

const DEFAULT_YIELD_MS = 20_000;

export function backgroundYieldMs(): number {
  const raw = process.env['JARVIS_BACKGROUND_YIELD_MS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_YIELD_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 120_000) : DEFAULT_YIELD_MS;
}

/** True when the current call is made by a background agent or goal. */
export function isBackgroundCall(): boolean {
  return getAgentIds() !== undefined;
}

/**
 * Waits, for a background call, until no conversation is active (or the
 * limit passes, or the call is cancelled). Returns the ms waited.
 */
export async function yieldToForeground(signal?: AbortSignal): Promise<number> {
  if (!isBackgroundCall() || !conversationBus.isActive) return 0;
  const limit = backgroundYieldMs();
  if (limit <= 0 || signal?.aborted) return 0;
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      conversationBus.off('conversation:end', done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, limit);
    conversationBus.on('conversation:end', done);
    signal?.addEventListener('abort', done, { once: true });
  });
  return Date.now() - t0;
}
