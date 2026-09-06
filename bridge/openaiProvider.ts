/**
 * bridge/openaiProvider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A provider for any OpenAI-compatible chat-completions endpoint — OpenAI
 * itself, Together, OpenRouter, Ollama's compatibility layer, or a local
 * llama.cpp server.
 *
 * Exists so the reasoning path is not a single point of failure: the router had
 * exactly one provider registered, which made a Groq outage a total reasoning
 * outage (JARVIS-016). This provider stays dormant unless
 * JARVIS_FALLBACK_API_KEY (or JARVIS_FALLBACK_BASE_URL for a keyless local
 * server) is configured.
 *
 * Deliberately dependency-free: it uses the same axios client already present
 * for Groq rather than adding an SDK.
 */

import axios, { type AxiosInstance } from 'axios';
import type { ILLMProvider, ILLMRequest, ILLMResponse, ILLMToolCall } from './llmTypes.js';

const DEFAULT_TIMEOUT_MS = Number(process.env['JARVIS_LLM_TIMEOUT_MS'] ?? 10_000);

export class OpenAICompatibleProvider implements ILLMProvider {
  private client: AxiosInstance | null = null;

  constructor(
    private readonly baseURL = process.env['JARVIS_FALLBACK_BASE_URL'] ?? 'https://api.openai.com/v1',
    private readonly apiKey = process.env['JARVIS_FALLBACK_API_KEY'] ?? '',
    private readonly model = process.env['JARVIS_FALLBACK_MODEL'] ?? 'gpt-4o-mini',
  ) {}

  /**
   * True when this provider has enough configuration to be worth trying.
   * A local endpoint may legitimately need no key, so a non-default base URL
   * is sufficient on its own.
   */
  isConfigured(): boolean {
    if (this.apiKey.trim()) return true;
    return this.baseURL !== 'https://api.openai.com/v1';
  }

  private getClient(): AxiosInstance {
    if (!this.client) {
      this.client = axios.create({
        baseURL: this.baseURL,
        timeout: DEFAULT_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
      });
    }
    return this.client;
  }

  async chat(request: ILLMRequest): Promise<ILLMResponse> {
    if (!this.isConfigured()) {
      throw new Error('[OpenAIProvider] Not configured — set JARVIS_FALLBACK_API_KEY or JARVIS_FALLBACK_BASE_URL.');
    }

    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 1500,
    };
    if (request.tools?.length) {
      body['tools'] = request.tools;
      body['tool_choice'] = request.tool_choice ?? 'auto';
    }

    const res = await this.getClient().post('/chat/completions', body, {
      ...(request.signal ? { signal: request.signal } : {}),
    });

    const choice = res.data?.choices?.[0];
    const message = choice?.message ?? {};
    const toolCalls: ILLMToolCall[] | undefined = message.tool_calls?.length
      ? message.tool_calls
      : undefined;

    return {
      content: message.content ?? '',
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(res.data?.usage
        ? {
            usage: {
              promptTokens: res.data.usage.prompt_tokens ?? 0,
              completionTokens: res.data.usage.completion_tokens ?? 0,
              totalTokens: res.data.usage.total_tokens ?? 0,
            },
          }
        : {}),
    };
  }
}

export const openaiProvider = new OpenAICompatibleProvider();
