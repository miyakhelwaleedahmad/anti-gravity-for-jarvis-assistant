import { llmConfig } from "../config/llmconfig.js";
import { groqProvider } from "./groqProvider.js";
import type { ILLMProvider, ILLMRequest, ILLMResponse } from "./llmTypes.js";

export class ModelRouter {
  private providers: Map<string, ILLMProvider> = new Map();

  constructor() {
    // Register default providers mapped to their names
    this.providers.set("groq", groqProvider);
  }

  registerProvider(name: string, provider: ILLMProvider) {
    this.providers.set(name, provider);
  }

  async chat(request: ILLMRequest, providerName?: string): Promise<ILLMResponse> {
    const selectedProviderName = providerName || llmConfig.provider;
    const provider = this.providers.get(selectedProviderName);

    if (!provider) {
      throw new Error(`LLM Provider '${selectedProviderName}' is not registered or supported.`);
    }

    return provider.chat(request);
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
