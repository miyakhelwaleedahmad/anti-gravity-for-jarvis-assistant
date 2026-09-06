import { llmConfig } from "../config/llmconfig.js";
import { groqProvider } from "./groqProvider.js";
import { openaiProvider } from "./openaiProvider.js";
import type { ILLMProvider, ILLMRequest, ILLMResponse } from "./llmTypes.js";

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

  constructor() {
    // Register default providers mapped to their names
    this.providers.set("groq", groqProvider);
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
    const primary = providerName || llmConfig.provider;
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
          console.warn(`[ModelRouter] Primary provider failed; answered by fallback "${name}".`);
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

  // ✅ FIXED: Added streaming support to router
  async *streamChat(request: ILLMRequest, providerName?: string): AsyncGenerator<string, void, unknown> {
    const selectedProviderName = providerName || llmConfig.provider;
    const provider = this.providers.get(selectedProviderName);

    if (!provider) {
      throw new Error(`LLM Provider '${selectedProviderName}' is not registered or supported.`);
    }

    if (!(provider as any).streamChat) {
      throw new Error(`Provider '${selectedProviderName}' does not support streaming.`);
    }

    yield* (provider as any).streamChat(request);
  }
}

export const modelRouter = new ModelRouter();
