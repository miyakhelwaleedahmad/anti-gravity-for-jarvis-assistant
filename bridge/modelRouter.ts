import { llmConfig, type LLMConfig } from "../config/llmconfig.js";
import { groqProvider } from "./groqProvider.js";
import { openaiProvider } from "./openaiProvider.js";
import { anthropicProvider } from "./anthropicProvider.js";
import type { ILLMMessage, ILLMProvider, ILLMRequest, ILLMResponse } from "./llmTypes.js";
import { llmStatus } from "./llmStatus.js";
import { redact } from "../security/redactor.js";
import { yieldToForeground } from "../core/foregroundGate.js";
import { recordUsage, routeFor, type ModelCategory } from "./modelCategories.js";
import { getTraceId } from "../core/traceContext.js";

/**
 * The request with credentials replaced in every message: tool output, memory,
 * context and the user's own words all reach the model through here
 * (docs/upgrade/SECURITY_MODEL.md).
 */
export function redactRequest(request: ILLMRequest): ILLMRequest {
  const messages = request.messages.map((m): ILLMMessage => {
    const content = typeof m.content === "string"
      ? redact(m.content)
      : Array.isArray(m.content)
        ? m.content.map((part) => (part && typeof part.text === "string" ? { ...part, text: redact(part.text) } : part))
        : m.content;
    const tool_calls = m.tool_calls?.map((call) => ({
      ...call,
      function: { ...call.function, arguments: redact(call.function.arguments) },
    }));
    return { ...m, content, ...(tool_calls ? { tool_calls } : {}) };
  });
  return { ...request, messages };
}

/**
 * The model to send to `provider`. Callers ask for llmConfig.model (the
 * brain) or llmConfig.fastModel; with Claude as the primary those become
 * Claude's brain and fast models, and on failover to Gemini or Groq a Claude
 * model goes back to that provider's own. Any other model is sent as asked.
 */
export function modelFor(provider: string, model: string | undefined, cfg: Pick<LLMConfig, "primary" | "anthropic" | "model" | "fastModel"> = llmConfig): string | undefined {
  const claude = cfg.primary === "anthropic" ? cfg.anthropic : undefined;
  if (!claude) return model;
  const isClaude = !!model && /^claude/i.test(model);
  if (provider === "anthropic") {
    if (isClaude) return model;
    return model === cfg.fastModel ? claude.fastModel : claude.model;
  }
  if (isClaude) return model === claude.fastModel ? cfg.fastModel : cfg.model;
  return model;
}

function withModel(request: ILLMRequest, model: string | undefined): ILLMRequest {
  if (model === request.model) return request;
  const { model: _drop, ...rest } = request;
  return model ? { ...rest, model } : rest;
}

/**
 * Routes LLM calls to a provider, with ordered failover.
 *
 * Only one provider was ever registered, so any Groq outage was a total
 * reasoning outage — the agent could not plan at all (JARVIS-016). A second,
 * OpenAI-compatible provider is now registered and tried when the primary
 * fails, but only when it has been configured; otherwise behaviour is exactly
 * as before.
 */
export class ModelRouter {
  private providers: Map<string, ILLMProvider> = new Map();
  /**
   * Providers reached only when a category names them (e.g. "anthropic").
   * They never join the failover order, so a key in .env cannot silently
   * move ordinary requests to another provider.
   */
  private namedOnly: Map<string, ILLMProvider> = new Map();

  /**
   * @param primary name the primary client is registered under — the active
   *   provider ("groq" or "gemini"). Tests pass it explicitly so a key in the
   *   developer's .env cannot turn a unit test into a live API call.
   */
  constructor(private readonly primary: string = llmConfig.primary) {
    if (primary === "anthropic") {
      // Claude first (JARVIS_LLM_PROVIDER=anthropic); Gemini or Groq is its
      // fallback, with that provider's own models (modelFor), when it has a key.
      this.providers.set("anthropic", anthropicProvider);
      if (llmConfig.apiKey) this.providers.set(llmConfig.provider, groqProvider);
    } else {
      // One OpenAI-compatible client serves Groq or Gemini; see config/llmconfig.ts.
      this.providers.set(primary, groqProvider);
    }
    this.providers.set("openai", openaiProvider);
    // Reached only through a category that names it (JARVIS_MODEL_<CATEGORY>=anthropic…).
    this.namedOnly.set("anthropic", anthropicProvider);
  }

  registerProvider(name: string, provider: ILLMProvider) {
    this.providers.set(name, provider);
  }

  /** A provider used only by the categories that name it (bridge/modelCategories.ts). */
  registerNamedProvider(name: string, provider: ILLMProvider) {
    this.namedOnly.set(name, provider);
  }

  /**
   * A call for one kind of work: the category's model, provider, time limit
   * and token cap from configuration (bridge/modelCategories.ts).
   */
  async categoryChat(category: ModelCategory, request: ILLMRequest): Promise<ILLMResponse> {
    const route = routeFor(category);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(Object.assign(new Error(`${category} call timed out after ${route.timeoutMs} ms`), { name: "TimeoutError" })), route.timeoutMs);
    const onAbort = () => timeout.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const routed: ILLMRequest = { ...request, model: route.model, max_tokens: request.max_tokens ?? route.maxTokens, category, signal: timeout.signal };
    try {
      const named = this.namedOnly.get(route.provider);
      if (named) return await this.callNamed(route.provider, named, routed);
      if (route.provider !== "default" && !this.providers.has(route.provider)) {
        throw new Error(`The ${category} category names provider "${route.provider}", which is not configured.`);
      }
      return await this.chat(routed, route.provider === "default" ? undefined : route.provider);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async callNamed(name: string, provider: ILLMProvider, request: ILLMRequest): Promise<ILLMResponse> {
    request = redactRequest(request);
    const started = Date.now();
    try {
      const response = await provider.chat(request);
      this.noteUsage(request, name, started, true, false, false, response);
      return response;
    } catch (err) {
      this.noteUsage(request, name, started, false, false, false, undefined, err);
      throw err;
    }
  }

  /** One usage record per call (bridge/modelCategories.ts); never lets recording break the call. */
  private noteUsage(request: ILLMRequest, provider: string, started: number, ok: boolean, fallbackUsed: boolean, streamed: boolean, response?: ILLMResponse, err?: unknown): void {
    try {
      const correlationId = getTraceId();
      recordUsage({
        category: request.category ?? "unspecified",
        provider,
        model: request.model ?? "(provider default)",
        ...(correlationId ? { correlationId } : {}),
        latencyMs: Date.now() - started,
        ok,
        fallbackUsed,
        streamed,
        promptTokens: response?.usage?.promptTokens ?? null,
        completionTokens: response?.usage?.completionTokens ?? null,
        ...(err ? { error: redact(String((err as Error)?.message ?? err)).slice(0, 200) } : {}),
      });
      // One line per call with its token counts ("?" when the provider gives none).
      const tok = (n: number | null | undefined) => (typeof n === "number" ? String(n) : "?");
      console.log(`[LLM usage] ${provider} ${request.model ?? "(default model)"} ${request.category ?? "unspecified"}: ` +
        `${tok(response?.usage?.promptTokens)} in / ${tok(response?.usage?.completionTokens)} out tokens, ${Date.now() - started} ms${ok ? "" : ", failed"}${streamed ? ", streamed" : ""}`);
    } catch { /* the record is optional; the call is not */ }
  }

  /**
   * Provider names to try, in order: the requested (or configured) provider
   * first, then any other registered provider that reports itself configured.
   */
  private failoverOrder(providerName?: string): string[] {
    const primary = providerName || this.primary;
    const order = [primary];

    // An explicitly requested provider is honoured exactly — a caller asking
    // for a specific model must not be silently answered by a different one.
    if (providerName) return order;

    for (const [name, provider] of this.providers) {
      if (name === primary) continue;
      const configured = (provider as { isConfigured?(): boolean }).isConfigured;
      if (typeof configured === "function" && !configured.call(provider)) continue;
      order.push(name);
    }
    return order;
  }

  /**
   * A background agent's or goal's call waits while the owner is in a
   * conversation (PERF-02, core/foregroundGate.ts). A call cancelled while it
   * waits is not sent.
   */
  private async backgroundWaits(request: ILLMRequest): Promise<void> {
    const waited = await yieldToForeground(request.signal);
    if (waited > 0) console.log(`[ModelRouter] Background call waited ${waited} ms for the owner's request.`);
    if (request.signal?.aborted) {
      throw Object.assign(new Error("Request aborted before it was sent"), { name: "AbortError" });
    }
  }

  async chat(request: ILLMRequest, providerName?: string): Promise<ILLMResponse> {
    request = redactRequest(request);
    await this.backgroundWaits(request);
    const order = this.failoverOrder(providerName);
    let lastError: unknown;
    const started = Date.now();

    for (const name of order) {
      const provider = this.providers.get(name);
      if (!provider) {
        lastError = new Error(`LLM Provider '${name}' is not registered or supported.`);
        continue;
      }
      const sent = withModel(request, modelFor(name, request.model));
      try {
        const response = await provider.chat(sent);
        if (name !== order[0]) {
          // Visible on the dashboard too (bridge/llmStatus.ts), not only in the log.
          const reason = (lastError as Error)?.message ?? "failed";
          console.warn(`[ModelRouter] ${order[0]} failed (${reason.slice(0, 120)}); answered by the fallback "${name}".`);
          llmStatus.recordFallback(order[0]!, name, reason);
        }
        this.noteUsage(sent, name, started, true, name !== order[0], false, response);
        return response;
      } catch (err) {
        lastError = err;
        // An aborted request is the caller's decision, not a provider failure —
        // failing over would run the same work again against a second provider.
        if (request.signal?.aborted) throw err;
        if (name !== order[order.length - 1]) {
          console.warn(`[ModelRouter] Provider "${name}" failed (${(err as Error)?.message}); trying next.`);
        }
      }
    }

    this.noteUsage(request, order[order.length - 1] ?? "none", started, false, order.length > 1, false, undefined, lastError);
    throw lastError instanceof Error
      ? lastError
      : new Error(`All LLM providers failed: ${order.join(", ")}`);
  }

  /**
   * Streams from the primary provider. If the stream fails before producing
   * anything, the request is answered once more through chat(), which applies
   * the normal failover order — previously a failed stream had no fallback, so
   * voice replies went silent whenever the primary was down.
   */
  async *streamChat(request: ILLMRequest, providerName?: string): AsyncGenerator<string, void, unknown> {
    request = redactRequest(request);
    await this.backgroundWaits(request);
    const selectedProviderName = providerName || this.primary;
    const provider = this.providers.get(selectedProviderName);

    if (!provider) {
      throw new Error(`LLM Provider '${selectedProviderName}' is not registered or supported.`);
    }

    const stream = (provider as { streamChat?: (r: ILLMRequest) => AsyncGenerator<string, void, unknown> }).streamChat;
    if (!stream) {
      throw new Error(`Provider '${selectedProviderName}' does not support streaming.`);
    }

    let yielded = false;
    const started = Date.now();
    const sent = withModel(request, modelFor(selectedProviderName, request.model));
    try {
      for await (const chunk of stream.call(provider, sent)) {
        yielded = true;
        yield chunk;
      }
      // Token counts when the provider reports them for a stream (Claude does); else null, not 0.
      const usage = (provider as { lastStreamUsage?: ILLMResponse["usage"] | null }).lastStreamUsage;
      this.noteUsage(sent, selectedProviderName, started, true, false, true, usage ? { content: "", usage } : undefined);
    } catch (err) {
      if (yielded || request.signal?.aborted) this.noteUsage(sent, selectedProviderName, started, false, false, true, undefined, err);
      // Mid-reply failures and cancellations are not retried: the caller has
      // already spoken part of the answer, or asked for it to stop.
      if (yielded || request.signal?.aborted) throw err;
      console.warn(`[ModelRouter] Stream from "${selectedProviderName}" failed (${(err as Error)?.message}); answering without streaming.`);
      const response = await this.chat(request, providerName);
      if (response.content) yield response.content;
    }
  }
}

export const modelRouter = new ModelRouter();
