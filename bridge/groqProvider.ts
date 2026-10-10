/**
 * bridge/groqProvider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The primary LLM client. Despite the file name it is not Groq-specific: it
 * speaks the OpenAI chat-completions protocol, which both Groq and Gemini serve,
 * and takes its address, key, models and thinking control from
 * config/llmconfig.ts (JARVIS_LLM_PROVIDER / GEMINI_* / GROQ_*).
 *
 *   - Forwards `tools` and `tool_choice`; returns `tool_calls`
 *   - Retries only what can succeed on retry: 5xx, network errors and our own
 *     timeout. 4xx (bad key, unknown model) and a reply cut off by max_tokens
 *     fail immediately — on a 5-requests-per-minute free tier every wasted
 *     retry costs a real request.
 *   - 429 drops to the fast model once (it has its own quota), then gives up
 */

import { llmConfig } from "../config/llmconfig.js";
import type { ILLMProvider, ILLMRequest, ILLMResponse, ILLMToolCall } from "./llmTypes.js";
import { AdaptiveLruCache } from "../core/adaptiveRamManager.js";
import { llmStatus } from "./llmStatus.js";
import { pipelineRegistry, LLM_PIPELINE } from "../self_healing/pipelineRegistry.js";
import crypto from "crypto";

// ─── Helper ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// PHASE1-LLM-1: Retry delay eliminated — blocking sleeps stall the voice pipeline.
// Server-error retries use a minimal 100ms to avoid tight-spin; all other paths are 0.
const RETRY_DELAY_MS = 100; // server-error only
const LLM_TIMEOUT_MS = Number(process.env.JARVIS_LLM_TIMEOUT_MS ?? 10_000);

/**
 * Model IDs are sent exactly as configured. Groq IDs may contain a slash
 * ("qwen/qwen3-32b") and must keep it; Gemini IDs are plain ("gemini-3.5-flash").
 */
function sanitizeModel(name: string): string {
  return name.trim();
}

function createRequestSignal(parentSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("LLM_TIMEOUT")), LLM_TIMEOUT_MS);
  const onAbort = () => controller.abort(parentSignal?.reason ?? new Error("LLM_ABORTED"));

  if (parentSignal) {
    if (parentSignal.aborted) {
      onAbort();
    } else {
      parentSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Every request's outcome goes to the shared LLM status (dashboard) and the
 * LLM pipeline (self-healing). A rate limit means the provider answered, and a
 * cancelled request is the caller's choice, so neither counts as a pipeline failure.
 */
function noteOk(): void {
  llmStatus.recordSuccess("request");
  pipelineRegistry.recordSuccess(LLM_PIPELINE);
}
function noteFail(err: unknown): void {
  const c = llmStatus.recordFailure(err, "request");
  if (c.kind !== "rate_limit" && c.kind !== "aborted") pipelineRegistry.recordFailure(LLM_PIPELINE, `${c.kind}: ${c.message}`);
}

/** Display name of the configured provider, for logs and errors. */
const PROVIDER_LABEL = () => (llmConfig.provider === "gemini" ? "Gemini" : "Groq");
const TAG = () => `[LLM:${llmConfig.provider}]`;

/** An HTTP failure from the provider, with its status kept for retry decisions. */
export class LLMHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LLMHttpError";
  }
}

/**
 * The error after the last retry. It keeps the last HTTP status, so a 503 is
 * still reported as a server error (it became a plain "request failed").
 */
function allAttemptsFailed(prefix: string, lastError: Error | null): Error {
  const message = `${prefix}. Last error: ${lastError?.message ?? "unknown"}`;
  return lastError instanceof LLMHttpError ? new LLMHttpError(lastError.status, message) : new Error(message);
}

/** The provider's own error message, shortened; never the request (it holds the key header). */
async function readErrorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    const body = Array.isArray(parsed) ? parsed[0] : parsed;
    const msg = body?.error?.message;
    if (typeof msg === "string" && msg) {
      const flat = msg.replace(/\s+/g, " ");
      // Gemini's 429 text opens with boilerplate; the useful part (which quota,
      // its limit, when to retry) comes after it and was cut off at 300 chars.
      const quota = flat.match(/Quota exceeded for metric:[^*]*?(?=\* |$)/)?.[0];
      const retry = flat.match(/Please retry in [\dhm.]+s/)?.[0];
      if (quota) return (retry && !quota.includes(retry) ? `${quota.trim()} ${retry}` : quota.trim()).slice(0, 300);
      return flat.slice(0, 300);
    }
  } catch {
    // not JSON — fall through
  }
  return text.replace(/\s+/g, " ").slice(0, 300);
}

/** "Please retry in 16h37m57.5s" → milliseconds; undefined when absent. */
export function parseRetryDelayMs(text: string): number | undefined {
  const m = text.match(/retry in (?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

function describeFetchError(err: Error): string {
  const cause = (err as Error & { cause?: unknown }).cause;
  if (err.message.includes("LLM_TIMEOUT") || String(cause).includes("LLM_TIMEOUT")) return `timed out after ${LLM_TIMEOUT_MS}ms`;
  return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
}

// ─── GroqProvider ─────────────────────────────────────────────────────────────

export class GroqProvider implements ILLMProvider {
  private static isCircuitBroken = false;
  private static circuitBreakerResetTime = 0;
  private static consecutive429s = 0;
  /**
   * Models rate-limited for longer than a minute — typically a used-up daily
   * quota (Gemini free tier: 20 requests/day on gemini-3.5-flash). Until the
   * time the provider gave, requests go straight to the fast model instead of
   * paying a rejected round trip and a warning on every command.
   */
  private static modelCooldownUntil = new Map<string, number>();

  private static coolingDown(model: string): boolean {
    const until = GroqProvider.modelCooldownUntil.get(model);
    if (until === undefined) return false;
    if (Date.now() >= until) { GroqProvider.modelCooldownUntil.delete(model); return false; }
    return true;
  }

  private static noteLongRateLimit(model: string, detail: string): void {
    const delay = parseRetryDelayMs(detail);
    if (delay !== undefined && delay > 60_000) {
      GroqProvider.modelCooldownUntil.set(model, Date.now() + delay);
      console.warn(`${TAG()} ${model} is rate-limited for ${Math.round(delay / 60_000)} min; using ${llmConfig.fastModel} until then.`);
    }
  }

  /** The model to start with: the requested one, unless it is cooling down. */
  private static startModel(requested: string, fastModel: string): string {
    return GroqProvider.coolingDown(requested) && !GroqProvider.coolingDown(fastModel) ? fastModel : requested;
  }

  // Phase 7: Response cache — identical planning calls reuse the last result for 60s
  private static responseCache = new AdaptiveLruCache<string, ILLMResponse>(64, 60_000, 'groq-resp');
  // Phase 7: In-flight dedup — same hash never fires two concurrent Groq requests
  private static inFlight = new Map<string, Promise<ILLMResponse>>();

  // Phase 7: Stable hash key for request dedup/cache
  private static hashRequest(req: ILLMRequest): string {
    const key = JSON.stringify({
      model: req.model ?? llmConfig.model,
      // Previously `.slice(0, 200)`: two different requests sharing a 200-char
      // prefix collided in the cache and the second received the first's
      // response (JARVIS-010). Hashing the full content costs microseconds
      // against a network round-trip.
      messages: req.messages.map(m => ({ role: m.role, c: m.content ?? '' })),
      tools: (req.tools ?? []).map((t: any) => t?.function?.name ?? t?.name ?? ''),
    });
    return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  }

  private checkCircuit(): void {
    if (GroqProvider.isCircuitBroken) {
      if (Date.now() > GroqProvider.circuitBreakerResetTime) {
        GroqProvider.isCircuitBroken = false;
        GroqProvider.consecutive429s = 0;
        console.log(`${TAG()} 🔌 Circuit breaker reset. Retrying cloud model...`);
      } else {
        const remainingSec = Math.ceil((GroqProvider.circuitBreakerResetTime - Date.now()) / 1000);
        throw new Error(`${PROVIDER_LABEL()} API rate-limited (circuit broken, retrying in ${remainingSec}s)`);
      }
    }
  }

  private handle429Success(): void {
    GroqProvider.consecutive429s = 0;
    GroqProvider.isCircuitBroken = false;
  }

  private handle429Failure(): void {
    GroqProvider.consecutive429s++;
    if (GroqProvider.consecutive429s >= 2) {
      GroqProvider.isCircuitBroken = true;
      GroqProvider.circuitBreakerResetTime = Date.now() + 60000; // Break for 60 seconds
      console.warn(`${TAG()} 🔌 Circuit broken due to repeated 429s. Cloud requests suspended for 60s.`);
    }
  }

  async chat(request: ILLMRequest): Promise<ILLMResponse> {
    try { this.checkCircuit(); } catch (err) { noteFail(err); throw err; }

    // Phase 7: Check response cache for non-streaming identical requests
    const cacheKey = GroqProvider.hashRequest(request);
    const cached = GroqProvider.responseCache.get(cacheKey);
    if (cached && !request.signal?.aborted) {
      console.log(`${TAG()} ⚡ Cache hit (${cacheKey}) — skipping API call`);
      return cached;
    }

    // Phase 7: In-flight dedup — if an identical request is already pending, await it
    const existing = GroqProvider.inFlight.get(cacheKey);
    if (existing) {
      console.log(`${TAG()} 🔄 Deduped in-flight request (${cacheKey})`);
      return existing;
    }

    const promise = this._chatInternal(request, cacheKey);
    promise.then(() => noteOk(), (err) => noteFail(err));
    GroqProvider.inFlight.set(cacheKey, promise);
    // `.finally()` would return a second promise that rejects with nobody
    // listening — an unhandled rejection on every failed call.
    const clear = () => { GroqProvider.inFlight.delete(cacheKey); };
    promise.then(clear, clear);
    return promise;
  }

  /** Request body shared by chat and streaming. */
  private buildBody(request: ILLMRequest, model: string, maxTokens: number): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
      temperature: request.temperature ?? llmConfig.temperature,
      max_tokens: maxTokens,
    };
    if (llmConfig.reasoningEffort) body.reasoning_effort = llmConfig.reasoningEffort;
    return body;
  }

  private post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const requestSignal = createRequestSignal(signal);
    return fetch(`${llmConfig.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: requestSignal.signal,
    }).finally(requestSignal.cleanup);
  }

  private async _chatInternal(request: ILLMRequest, cacheKey: string): Promise<ILLMResponse> {
    const MAX_ATTEMPTS = 3;
    let lastError: Error | null = null;
    const fastModel = sanitizeModel(llmConfig.fastModel);
    let currentModel = GroqProvider.startModel(sanitizeModel(request.model || llmConfig.model), fastModel);
    let usedFastModelFor429 = false;
    // Phase 7: Cap planning tokens at 1024 to reduce queue time
    const maxTokens = request.max_tokens ?? Math.min(llmConfig.maxTokens ?? 4096, 1024);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const body = this.buildBody(request, currentModel, maxTokens);
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools;
        body.tool_choice = request.tool_choice ?? "auto";
      }

      let response: Response;
      try {
        response = await this.post(body, request.signal);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // The caller cancelled: retrying would spend a request nobody wants.
        if (request.signal?.aborted) throw lastError;
        console.warn(`${TAG()} Attempt ${attempt + 1} failed (${describeFetchError(lastError)}).${attempt < MAX_ATTEMPTS - 1 ? " Retrying…" : ""}`);
        continue;
      }

      if (response.status === 429) {
        this.handle429Failure();
        const detail = await readErrorText(response);
        lastError = new LLMHttpError(429, `${PROVIDER_LABEL()} rate-limited (429): ${detail}`);
        GroqProvider.noteLongRateLimit(currentModel, detail);
        if (usedFastModelFor429 || currentModel === fastModel) throw lastError;
        console.warn(`${TAG()} Rate limited (429) on ${currentModel}; trying the fast model ${fastModel} once. ${detail}`);
        currentModel = fastModel;
        usedFastModelFor429 = true;
        continue;
      }

      if (response.status >= 500) {
        lastError = new LLMHttpError(response.status, `${PROVIDER_LABEL()} server error ${response.status}: ${await readErrorText(response)}`);
        console.warn(`${TAG()} ${lastError.message}.${attempt < MAX_ATTEMPTS - 1 ? " Retrying…" : ""}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      if (!response.ok) {
        // 400/401/403/404: a bad key, an unknown model or a rejected request.
        // The same request will fail the same way, so do not retry it.
        throw new LLMHttpError(response.status, `${PROVIDER_LABEL()} API error ${response.status}: ${await readErrorText(response)}`);
      }

      const data = await response.json() as any;
      const choice = data?.choices?.[0];
      if (!choice) {
        lastError = new Error(`${PROVIDER_LABEL()} returned no choices: ${JSON.stringify(data).slice(0, 300)}`);
        continue;
      }

      const finishReason: string = choice.finish_reason ?? "";
      const message = choice.message ?? {};
      this.handle429Success();

      const usage = {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      };

      if (finishReason === "tool_calls" || (message.tool_calls && message.tool_calls.length > 0)) {
        const toolCalls: ILLMToolCall[] = (message.tool_calls ?? []).map((tc: any, i: number) => ({
          id: tc.id || `call_${Date.now()}_${i}`,
          type: "function" as const,
          function: {
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "{}",
          },
        }));
        console.log(`${TAG()} 🔧 Model called ${toolCalls.length} tool(s): ${toolCalls.map(t => t.function.name).join(", ")}`);
        // Don't cache tool_call responses — they contain live call IDs
        return { content: "", tool_calls: toolCalls, usage };
      }

      const content = message.content ?? "";
      if (!content && finishReason === "length") {
        // Thinking models spend max_tokens on reasoning first; at a small limit
        // nothing is left for the answer. Retrying cannot change that.
        throw new LLMHttpError(200, `${PROVIDER_LABEL()} used the whole max_tokens budget (${maxTokens}) before answering. ` +
          `Raise the limit, or lower thinking with JARVIS_LLM_REASONING_EFFORT=minimal.`);
      }
      if (!content && finishReason !== "stop") {
        lastError = new Error(`${PROVIDER_LABEL()} returned empty content (finish_reason=${finishReason || "none"}).`);
        continue;
      }

      const result: ILLMResponse = { content, usage };
      // Phase 7: Cache successful text responses for 60s
      if (content) GroqProvider.responseCache.set(cacheKey, result);
      return result;
    }

    throw allAttemptsFailed(`${TAG()} All ${MAX_ATTEMPTS} attempts failed`, lastError);
  }

  async *streamChat(request: ILLMRequest): AsyncGenerator<string, void, unknown> {
    try {
      yield* this._streamInternal(request);
      noteOk();
    } catch (err) {
      noteFail(err);
      throw err;
    }
  }

  private async *_streamInternal(request: ILLMRequest): AsyncGenerator<string, void, unknown> {
    this.checkCircuit();

    const fastModel = sanitizeModel(llmConfig.fastModel);
    let currentModel = GroqProvider.startModel(sanitizeModel(request.model || llmConfig.model), fastModel);
    let usedFastModelFor429 = false;

    const MAX_ATTEMPTS = 3;
    let response: Response | null = null;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const body = this.buildBody(request, currentModel, request.max_tokens ?? llmConfig.maxTokens);
      body.stream = true;

      let res: Response;
      try {
        res = await this.post(body, request.signal);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (request.signal?.aborted) throw lastError;
        console.warn(`${TAG()} Stream attempt ${attempt + 1} failed (${describeFetchError(lastError)}).`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      if (res.status === 429) {
        this.handle429Failure();
        const detail = await readErrorText(res);
        lastError = new LLMHttpError(429, `${PROVIDER_LABEL()} rate-limited (429): ${detail}`);
        GroqProvider.noteLongRateLimit(currentModel, detail);
        if (usedFastModelFor429 || currentModel === fastModel) throw lastError;
        console.warn(`${TAG()} Streaming rate limited (429) on ${currentModel}; trying the fast model ${fastModel} once.`);
        currentModel = fastModel;
        usedFastModelFor429 = true;
        continue;
      }

      if (res.status >= 500) {
        lastError = new LLMHttpError(res.status, `${PROVIDER_LABEL()} server error ${res.status}: ${await readErrorText(res)}`);
        console.warn(`${TAG()} ${lastError.message}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      if (!res.ok) {
        // Not retried, and not re-sent through chat(): it would fail the same way.
        throw new LLMHttpError(res.status, `${PROVIDER_LABEL()} streaming error ${res.status}: ${await readErrorText(res)}`);
      }

      this.handle429Success();
      response = res;
      break;
    }

    if (!response) {
      throw allAttemptsFailed(`${TAG()} All ${MAX_ATTEMPTS} stream attempts failed`, lastError);
    }
    if (!response.body) throw new Error("No response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      if (request.signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new Error("LLM stream aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') return;
          try {
            const data = JSON.parse(dataStr);
            const piece = data?.choices?.[0]?.delta?.content;
            if (piece) yield piece;
          } catch {
            // Ignore partial or non-JSON lines
          }
        }
      }
    }
  }

  /**
   * Cheap reachability check: lists the provider's models. Confirms the address,
   * the key and the configured model name without generating anything, so it
   * costs no generation quota and cannot come back empty because the model
   * spent its token budget thinking.
   */
  async ping(signal?: AbortSignal): Promise<{ modelFound: boolean; models: number }> {
    // Only the LLM status here: the caller (health checker, self-heal) records
    // the pipeline result itself, and doing both counted every failed probe twice.
    try {
      const result = await this._ping(signal);
      llmStatus.recordSuccess("probe");
      return result;
    } catch (err) {
      llmStatus.recordFailure(err, "probe");
      throw err;
    }
  }

  private async _ping(signal?: AbortSignal): Promise<{ modelFound: boolean; models: number }> {
    const requestSignal = createRequestSignal(signal);
    let res: Response;
    try {
      res = await fetch(`${llmConfig.baseURL}/models`, {
        headers: { Authorization: `Bearer ${llmConfig.apiKey}` },
        signal: requestSignal.signal,
      });
    } finally {
      requestSignal.cleanup();
    }
    if (!res.ok) {
      throw new LLMHttpError(res.status, `${PROVIDER_LABEL()} /models returned ${res.status}: ${await readErrorText(res)}`);
    }
    const data = await res.json() as { data?: Array<{ id?: string }> };
    if (!Array.isArray(data?.data)) {
      throw new Error(`${PROVIDER_LABEL()} /models answered without a model list (unexpected JSON).`);
    }
    const ids = data.data.map((m) => m.id ?? "");
    // Gemini lists "models/gemini-3.5-flash"; Groq lists the bare id.
    const offered = (model: string) => ids.some((id) => id === model || id.endsWith(`/${model}`));
    // Both models: a wrong fast model used to show up only when a 429 switched to it.
    for (const [model, field] of [[llmConfig.model, "JARVIS_BRAIN_MODEL"], [llmConfig.fastModel, "JARVIS_FAST_MODEL"]] as const) {
      if (!offered(model)) {
        throw new Error(`${PROVIDER_LABEL()} does not offer the model "${model}" (${field}). Check the name.`);
      }
    }
    return { modelFound: true, models: ids.length };
  }
}

export const groqProvider = new GroqProvider();
