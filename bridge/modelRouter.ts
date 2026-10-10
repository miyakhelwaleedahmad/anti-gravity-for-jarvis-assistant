import { llmConfig } from "../config/llmconfig.js";
import { groqProvider } from "./groqProvider.js";
import { openaiProvider } from "./openaiProvider.js";
import type { ILLMMessage, ILLMProvider, ILLMRequest, ILLMResponse } from "./llmTypes.js";
import { llmStatus } from "./llmStatus.js";
import { redact } from "../security/redactor.js";

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
   * @param primary name the primary client is registered under — the active
   *   provider ("groq" or "gemini"). Tests pass it explicitly so a key in the
   *   developer's .env cannot turn a unit test into a live API call.
   */
  constructor(private readonly primary: string = llmConfig.provider) {
    // One OpenAI-compatible client serves Groq or Gemini; see config/llmconfig.ts.
    this.providers.set(primary, groqProvider);
    this.providers.set("openai", openaiProvider);
  }

  registerProvider(name: string, provider: ILLMProvider) {
    this.providers.set(name, provider);
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

  async chat(request: ILLMRequest, providerName?: string): Promise<ILLMResponse> {
    request = redactRequest(request);
    const order = this.failoverOrder(providerName);
    let lastError: unknown;

    for (const name of order) {
      const provider = this.providers.get(name);
      if (!provider) {
        lastError = new Error(`LLM Provider '${name}' is not registered or supported.`);
        continue;
      }
      try {
        const response = await provider.chat(request);
        if (name !== order[0]) {
          // Visible on the dashboard too (bridge/llmStatus.ts), not only in the log.
          const reason = (lastError as Error)?.message ?? "failed";
          console.warn(`[ModelRouter] ${order[0]} failed (${reason.slice(0, 120)}); answered by the fallback "${name}".`);
          llmStatus.recordFallback(order[0]!, name, reason);
        }
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
    try {
      for await (const chunk of stream.call(provider, request)) {
        yielded = true;
        yield chunk;
      }
    } catch (err) {
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
