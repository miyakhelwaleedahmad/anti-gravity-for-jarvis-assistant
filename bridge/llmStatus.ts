/**
 * bridge/llmStatus.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * What JARVIS knows about the LLM provider it is using: the configured
 * provider and models, the last request or probe that worked, the last one
 * that failed (classified), and whether answers came from the fallback.
 *
 * One record for everyone. The LLM client writes to it on every request, the
 * health checker's probe and the router's failover write to it, and the
 * dashboard reads it. Before, the dashboard said "online" whenever a key was
 * set and the probe's result stayed in the self-healing registry, so the two
 * could disagree, and an old failure stayed visible until the next probe.
 *
 * Nothing here holds a key or a request body. Error messages are cut short and
 * pass through the redactor.
 */

import { llmConfig } from '../config/llmconfig.js';
import { redact } from '../security/redactor.js';

export type LLMErrorKind =
  | 'auth'          // 401/403, or a 400 that says the key is invalid
  | 'rate_limit'    // 429 or the client's own circuit breaker
  | 'timeout'       // no answer in time
  | 'network'       // DNS, refused connection, TLS
  | 'server'        // 5xx
  | 'model'         // the model name is not offered / 404
  | 'bad_request'   // other 4xx
  | 'bad_response'  // 200 with no usable content
  | 'aborted'       // the caller cancelled (not a provider failure)
  | 'unknown';

export interface ClassifiedLLMError {
  kind: LLMErrorKind;
  status?: number;
  message: string;
}

/** Puts an LLM error in one of the kinds above, from its HTTP status first and its text second. */
export function classifyLLMError(err: unknown): ClassifiedLLMError {
  const e = err as { status?: unknown; name?: unknown; message?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const message = String(e?.message ?? err ?? 'unknown error');
  const status = typeof e?.status === 'number' && e.status > 0 ? e.status : undefined;
  const code = String(e?.code ?? e?.cause?.code ?? '');
  const out = (kind: LLMErrorKind): ClassifiedLLMError => ({ kind, ...(status && status !== 200 ? { status } : {}), message: redact(message).slice(0, 200) });

  if (status === 401 || status === 403) return out('auth');
  if (status === 429) return out('rate_limit');
  if (status === 404) return out('model');
  if (status !== undefined && status >= 500) return out('server');
  // Gemini answers 400 INVALID_ARGUMENT "API key not valid" for a wrong key.
  if (status === 400 && /api[ _-]?key/i.test(message)) return out('auth');
  if (status !== undefined && status >= 400 && status < 500) return out('bad_request');
  if (/does not offer the model/i.test(message)) return out('model');
  if (/rate-limited|circuit broken|\b429\b/i.test(message)) return out('rate_limit');
  if (/LLM_TIMEOUT|timed? ?out|did not answer/i.test(message)) return out('timeout');
  if (e?.name === 'AbortError' || /LLM_ABORTED|aborted/i.test(message)) return out('aborted');
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed|getaddrinfo|socket hang up|certificate/i.test(`${code} ${message}`)) return out('network');
  if (/no choices|empty content|max_tokens budget|Unexpected token|JSON/i.test(message)) return out('bad_response');
  return out('unknown');
}

export interface LLMStatusSnapshot {
  provider: string;
  model: string;
  fastModel: string;
  /** Host only, never a path with a key. */
  host: string;
  hasKey: boolean;
  lastOkAt?: number;
  lastOkVia?: 'request' | 'probe';
  lastError?: ClassifiedLLMError & { at: number; provider: string; via: 'request' | 'probe' };
  /** Set when a fallback provider answered because the primary failed. */
  lastFallback?: { at: number; from: string; to: string; reason: string };
  lastCheckAt?: number;
}

export interface LLMHealth {
  status: 'online' | 'degraded' | 'offline' | 'unknown';
  detail: string;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

const NAMES: Record<string, string> = { gemini: 'Gemini', groq: 'Groq', openai: 'fallback provider' };
export const providerName = (p: string): string => NAMES[p] ?? p;

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

export class LLMStatusTracker {
  private state: Omit<LLMStatusSnapshot, 'provider' | 'model' | 'fastModel' | 'host' | 'hasKey'> = {};

  /** A request or probe to the configured provider worked. */
  recordSuccess(via: 'request' | 'probe' = 'request', provider: string = llmConfig.provider): void {
    if (provider !== llmConfig.provider) return;
    this.state.lastOkAt = Date.now();
    this.state.lastOkVia = via;
    this.state.lastCheckAt = this.state.lastOkAt;
  }

  /** A request or probe to the configured provider failed. Aborts by the caller are not failures. */
  recordFailure(err: unknown, via: 'request' | 'probe' = 'request', provider: string = llmConfig.provider): ClassifiedLLMError {
    const c = classifyLLMError(err);
    if (c.kind === 'aborted' || provider !== llmConfig.provider) return c;
    this.state.lastError = { ...c, at: Date.now(), provider, via };
    this.state.lastCheckAt = this.state.lastError.at;
    return c;
  }

  /** The router answered from a fallback provider because the primary failed. */
  recordFallback(from: string, to: string, reason: string): void {
    this.state.lastFallback = { at: Date.now(), from, to, reason: redact(reason).slice(0, 160) };
  }

  snapshot(): LLMStatusSnapshot {
    return {
      provider: llmConfig.provider,
      model: llmConfig.model,
      fastModel: llmConfig.fastModel,
      host: hostOf(llmConfig.baseURL),
      hasKey: !!llmConfig.apiKey,
      ...this.state,
    };
  }

  /** Whether nothing has been checked in `maxAgeMs`. */
  isStale(maxAgeMs: number): boolean {
    return !this.state.lastCheckAt || Date.now() - this.state.lastCheckAt > maxAgeMs;
  }

  /**
   * Status for the dashboard. A failure counts only while it is newer than the
   * last success, and only for the provider in use now, so a fixed problem or
   * another provider's error is never shown.
   */
  health(now = Date.now()): LLMHealth {
    const s = this.snapshot();
    const name = providerName(s.provider);
    const keyVar = s.provider === 'gemini' ? 'GEMINI_API_KEY' : 'GROQ_API_KEY';
    if (!s.hasKey) return { status: 'offline', detail: `${name}: missing ${keyVar}` };
    const err = s.lastError && s.lastError.provider === s.provider && (!s.lastOkAt || s.lastError.at > s.lastOkAt) ? s.lastError : undefined;
    // The fallback answered after the primary failed: say both.
    if (s.lastFallback && (!s.lastOkAt || s.lastFallback.at >= s.lastOkAt) && (!err || s.lastFallback.at >= err.at)) {
      return {
        status: 'degraded',
        detail: `${name} failed${err ? ` (${err.kind}${err.status ? ` ${err.status}` : ''})` : ''}; answered by ${providerName(s.lastFallback.to)} (${ago(now - s.lastFallback.at)})`,
      };
    }
    if (err) {
      const what: Record<LLMErrorKind, string> = {
        auth: `rejected the key${err.status ? ` (${err.status})` : ''} — check ${keyVar}`,
        rate_limit: 'rate-limited (quota); requests will retry later',
        timeout: 'did not answer in time',
        network: 'not reachable (network)',
        server: `server error${err.status ? ` ${err.status}` : ''}`,
        model: `does not offer the configured model — check JARVIS_BRAIN_MODEL / JARVIS_FAST_MODEL`,
        bad_request: `refused the request${err.status ? ` (${err.status})` : ''}`,
        bad_response: 'answered without usable content',
        aborted: 'request cancelled',
        unknown: 'request failed',
      };
      const status = err.kind === 'auth' || err.kind === 'model' ? 'offline' : 'degraded';
      return { status, detail: `${name} · ${s.model}: ${what[err.kind]} (${ago(now - err.at)})` };
    }
    if (s.lastOkAt) return { status: 'online', detail: `${name} · model: ${s.model} · OK ${ago(now - s.lastOkAt)}` };
    return { status: 'unknown', detail: `${name} · model: ${s.model} · not checked yet` };
  }

  /** For tests. */
  reset(): void {
    this.state = {};
  }
}

export const llmStatus = new LLMStatusTracker();
