/**
 * bridge/providerGuard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One provider's own circuit breaker and optional request limit (Phase 1A,
 * MM-1A-03). The router keeps one guard per provider name, so one provider's
 * rate limits never stop another provider's calls.
 *
 *   JARVIS_PROVIDER_<NAME>_BREAKER_429S  consecutive rate limits that open it
 *                                         (default 2, the rule the Gemini/Groq
 *                                         client already uses)
 *   JARVIS_PROVIDER_<NAME>_BREAKER_MS    how long it stays open (default 60000)
 *   JARVIS_PROVIDER_<NAME>_RPM           at most this many calls a minute
 *                                         (default: no limit)
 *
 * Only a rate limit counts: a 5xx or a network error is not a quota problem,
 * and a cancelled call is the caller's choice. A non-rate-limit error does
 * not reset the count (the Gemini/Groq client's own rule): only a success does.
 * When the open period ends, exactly one trial call goes through; calls made
 * while it runs are refused. check() hands every call a ticket, and only the
 * trial's own ticket decides: a success closes the breaker, another rate limit
 * opens it again at once, any other failure or a cancellation frees the lease
 * so that the next call becomes the next single trial. A non-rate-limit
 * failure or a cancellation of another call (one sent before the breaker
 * opened) leaves the running trial's lease alone. Two late results of such
 * a call do act on the breaker: a late rate limit opens it again at once (the
 * count is still at the threshold), and a late success closes it (the
 * provider did answer).
 * A trial that never reports back frees the lease after one open period, so
 * the provider is never blocked for ever.
 * Settings are read on each check, so a change in the environment applies to
 * the next call.
 */

import { classifyLLMError } from './llmStatus.js';

/** A call this guard did not send. Reads as a rate limit, never as an outage. */
export class ProviderUnavailableError extends Error {
  constructor(readonly provider: string, why: string) {
    super(`${provider} rate-limited locally (${why}); not sent`);
    this.name = 'ProviderUnavailableError';
  }
}

const MINUTE = 60_000;

/** What check() let through; pass it back with the call's outcome. */
export interface GuardTicket {
  /** This call is the half-open trial. */
  readonly trial: boolean;
  readonly id: number;
}

function envName(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function intSetting(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

export class ProviderGuard {
  private consecutiveRateLimits = 0;
  private openUntil = 0;
  /** Set when the open period has ended and one trial call was let through. */
  private trial = false;
  /** Until when the running trial holds the provider (a trial that never reports back lets go then). */
  private trialUntil = 0;
  /** The running trial's ticket id (0: none running). */
  private trialId = 0;
  private nextTicket = 1;
  private calls: number[] = [];

  constructor(
    readonly name: string,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly now: () => number = Date.now,
  ) {}

  private settings() {
    const p = `JARVIS_PROVIDER_${envName(this.name)}`;
    return {
      threshold: intSetting(this.env, `${p}_BREAKER_429S`, 2, 1, 1_000_000),
      openMs: intSetting(this.env, `${p}_BREAKER_MS`, 60_000, 1, 24 * 60 * MINUTE),
      rpm: this.env[`${p}_RPM`]?.trim() ? intSetting(this.env, `${p}_RPM`, 0, 1, 100_000) || null : null,
    };
  }

  /**
   * Throws ProviderUnavailableError when this provider must not be called
   * now; otherwise counts the call. `useBreaker` is false for a provider that
   * has its own breaker (its request limit still applies).
   */
  check(useBreaker: boolean): GuardTicket {
    const { rpm, openMs } = this.settings();
    const t = this.now();
    // Decide first, change state only once the call is really let through.
    let startsTrial = false;
    if (useBreaker) {
      if (this.openUntil > 0 && t < this.openUntil) {
        throw new ProviderUnavailableError(this.name, `circuit open, retrying in ${Math.ceil((this.openUntil - t) / 1000)} s`);
      }
      if (this.openUntil > 0) startsTrial = true;                       // the open period has just ended
      else if (this.trial && t < this.trialUntil) {
        throw new ProviderUnavailableError(this.name, 'a trial call after the open period is still running');
      } else if (this.trial) startsTrial = true;                        // the last trial never reported back
    }
    if (rpm !== null) {
      this.calls = this.calls.filter((at) => t - at < MINUTE);
      if (this.calls.length >= rpm) {
        throw new ProviderUnavailableError(this.name, `${rpm} requests a minute reached`);
      }
      this.calls.push(t);
    }
    const id = this.nextTicket++;
    if (startsTrial) {
      this.openUntil = 0;
      this.trial = true;
      this.trialUntil = t + openMs;
      this.trialId = id;
    }
    return { trial: startsTrial, id };
  }

  /** Whether `ticket` is the trial that is running now (a stale ticket, from an expired lease, is not). */
  private isRunningTrial(ticket: GuardTicket | undefined): boolean {
    return !!ticket?.trial && this.trial && ticket.id === this.trialId;
  }

  /** The trial's lease is free; the breaker stays half-open, so the next call is the next single trial. */
  private freeLease(): void {
    this.trialUntil = 0;
    this.trialId = 0;
  }

  noteSuccess(_ticket?: GuardTicket): void {
    this.consecutiveRateLimits = 0;
    this.openUntil = 0;
    this.trial = false;
    this.trialId = 0;
  }

  /** The call with `ticket` was cancelled by its caller: not a provider failure; a trial frees its lease. */
  noteCancelled(ticket?: GuardTicket): void {
    if (this.isRunningTrial(ticket)) this.freeLease();
  }

  noteFailure(err: unknown, ticket?: GuardTicket): void {
    const kind = classifyLLMError(err).kind;
    if (kind !== 'rate_limit') {
      // Not about quota (the count stays). Only the trial's own failure frees its lease.
      if (kind === 'aborted') this.noteCancelled(ticket);
      else if (this.isRunningTrial(ticket)) this.freeLease();
      return;
    }
    this.consecutiveRateLimits++;
    const { threshold, openMs } = this.settings();
    const trialFailed = ticket ? this.isRunningTrial(ticket) : false;
    if (trialFailed || this.consecutiveRateLimits >= threshold) {
      this.openUntil = this.now() + openMs;
      this.trial = false;
      this.trialId = 0;
      console.warn(`[ProviderGuard] ${this.name}: ${this.consecutiveRateLimits} rate limit(s) in a row; not called for ${Math.round(openMs / 1000)} s.`);
    }
  }

  snapshot(): { open: boolean; openForMs: number; consecutiveRateLimits: number; callsLastMinute: number; rpm: number | null } {
    const t = this.now();
    const { rpm } = this.settings();
    return {
      open: this.openUntil > t,
      openForMs: Math.max(0, this.openUntil - t),
      consecutiveRateLimits: this.consecutiveRateLimits,
      callsLastMinute: this.calls.filter((at) => t - at < MINUTE).length,
      rpm,
    };
  }
}
