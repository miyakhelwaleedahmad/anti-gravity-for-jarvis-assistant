/**
 * bridge/groqProvider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Groq API provider — now with full tool/function-calling support.
 *
 * Changes from previous version:
 *   - Forwards `tools` and `tool_choice` from the request to the Groq API
 *   - Reads `tool_calls` from the response and returns them in ILLMResponse
 *   - Handles finish_reason "tool_calls" (no content when model calls a tool)
 */

import { llmConfig } from "../config/llmconfig.js";
import type { ILLMProvider, ILLMRequest, ILLMResponse, ILLMToolCall } from "./llmTypes.js";
import { AdaptiveLruCache } from "../core/adaptiveRamManager.js";
import crypto from "crypto";

// ─── Helper ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// PHASE1-LLM-1: Retry delay eliminated — blocking sleeps stall the voice pipeline.
// Server-error retries use a minimal 100ms to avoid tight-spin; all other paths are 0.
const RETRY_DELAY_MS = 100; // server-error only
const LLM_TIMEOUT_MS = Number(process.env.JARVIS_LLM_TIMEOUT_MS ?? 10_000);

/**
 * PHASE1-LLM-2: Sanitize model names.
 * Groq API rejects names with forward-slashes (e.g. "qwen/qwen3-32b").
 * Strip everything up to and including the last slash so the bare model
 * ID is sent ("qwen/qwen3-32b" → "qwen3-32b", "llama-3.1-8b-instant" unchanged).
 */
function sanitizeModel(name: string): string {
  // Groq API uses model IDs containing forward slashes (e.g., "qwen/qwen3.6-27b").
  // Do not strip the slash; return the name as is.
  return name;
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

// ─── GroqProvider ─────────────────────────────────────────────────────────────

export class GroqProvider implements ILLMProvider {
  private static isCircuitBroken = false;
  private static circuitBreakerResetTime = 0;
  private static consecutive429s = 0;

  // Phase 7: Response cache — identical planning calls reuse the last result for 60s
  private static responseCache = new AdaptiveLruCache<string, ILLMResponse>(64, 60_000, 'groq-resp');
  // Phase 7: In-flight dedup — same hash never fires two concurrent Groq requests
  private static inFlight = new Map<string, Promise<ILLMResponse>>();

  // Phase 7: Stable hash key for request dedup/cache
  private static hashRequest(req: ILLMRequest): string {
    const key = JSON.stringify({
      model: req.model ?? llmConfig.model,
      messages: req.messages.map(m => ({ role: m.role, c: (m.content ?? '').slice(0, 200) })),
      tools: (req.tools ?? []).map((t: any) => t?.function?.name ?? t?.name ?? ''),
    });
    return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  }

  private checkCircuit(): void {
    if (GroqProvider.isCircuitBroken) {
      if (Date.now() > GroqProvider.circuitBreakerResetTime) {
        GroqProvider.isCircuitBroken = false;
        GroqProvider.consecutive429s = 0;
        console.log("[GroqProvider] 🔌 Circuit breaker reset. Retrying cloud model...");
      } else {
        const remainingSec = Math.ceil((GroqProvider.circuitBreakerResetTime - Date.now()) / 1000);
        throw new Error(`Groq API rate-limited (circuit broken, retrying in ${remainingSec}s)`);
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
      console.warn(`[GroqProvider] 🔌 Circuit broken due to repeated 429s. Cloud requests suspended for 60s.`);
    }
  }

  async chat(request: ILLMRequest): Promise<ILLMResponse> {
    this.checkCircuit();

    // Phase 7: Check response cache for non-streaming identical requests
    const cacheKey = GroqProvider.hashRequest(request);
    const cached = GroqProvider.responseCache.get(cacheKey);
    if (cached && !request.signal?.aborted) {
      console.log(`[GroqProvider] ⚡ Cache hit (${cacheKey}) — skipping Groq call`);
      return cached;
    }

    // Phase 7: In-flight dedup — if an identical request is already pending, await it
    const existing = GroqProvider.inFlight.get(cacheKey);
    if (existing) {
      console.log(`[GroqProvider] 🔄 Deduped in-flight request (${cacheKey})`);
      return existing;
    }

    const promise = this._chatInternal(request, cacheKey);
    GroqProvider.inFlight.set(cacheKey, promise);
    promise.finally(() => GroqProvider.inFlight.delete(cacheKey));
    return promise;
  }

  private async _chatInternal(request: ILLMRequest, cacheKey: string): Promise<ILLMResponse> {
    const url = `${llmConfig.baseURL}/chat/completions`;

    const MAX_ATTEMPTS = 3;
    let lastError: Error | null = null;
    let currentModel = sanitizeModel(request.model || llmConfig.model);
    const fastModel = sanitizeModel(process.env.JARVIS_FAST_MODEL || "llama-3.1-8b-instant");
    // Phase 7: Cap planning tokens at 1024 to reduce Groq queue time
    const maxTokens = request.max_tokens ?? Math.min(llmConfig.maxTokens ?? 4096, 1024);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const body: Record<string, unknown> = {
        model: currentModel,
        messages: request.messages,
        temperature: request.temperature ?? llmConfig.temperature,
        max_tokens: maxTokens,
      };

      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools;
        body.tool_choice = request.tool_choice ?? "auto";
      }

      try {
        const requestSignal = createRequestSignal(request.signal);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${llmConfig.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: requestSignal.signal,
        }).finally(requestSignal.cleanup);

        if (response.status === 429) {
          this.handle429Failure();
          if (attempt >= 1) {
            console.warn(`[GroqProvider] Rate limited on fallback/attempts. Raising error.`);
            throw new Error("Groq API Rate Limited (429)");
          }
          // PHASE1-LLM-1: Zero sleep — immediate fallback, no pipeline stall
          console.warn(`[GroqProvider] Rate limited (429). Falling back to fast model: ${fastModel} immediately.`);
          currentModel = fastModel;
          continue; // No sleep — immediate retry on fast model
        }

        if (response.status >= 500) {
          console.warn(`[GroqProvider] Server error (${response.status}). Retrying in 1s…`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Groq API Error: ${response.status} - ${errorText}`);
        }

        const data = await response.json() as any;
        const choice = data?.choices?.[0];

        if (!choice) {
          throw new Error(`Groq returned no choices. Response: ${JSON.stringify(data)}`);
        }

        const finishReason: string = choice.finish_reason ?? "";
        const message = choice.message ?? {};

        this.handle429Success();

        if (finishReason === "tool_calls" || (message.tool_calls && message.tool_calls.length > 0)) {
          const toolCalls: ILLMToolCall[] = (message.tool_calls ?? []).map((tc: any) => ({
            id: tc.id ?? `call_${Date.now()}`,
            type: "function" as const,
            function: {
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "{}",
            },
          }));

          console.log(`[GroqProvider] 🔧 Model called ${toolCalls.length} tool(s): ${toolCalls.map(t => t.function.name).join(", ")}`);

          const toolResult: ILLMResponse = {
            content: "",
            tool_calls: toolCalls,
            usage: {
              promptTokens: data.usage?.prompt_tokens ?? 0,
              completionTokens: data.usage?.completion_tokens ?? 0,
              totalTokens: data.usage?.total_tokens ?? 0,
            },
          };
          // Don't cache tool_call responses — they contain live call IDs
          return toolResult;
        }

        const content = message.content ?? "";
        if (!content && finishReason !== "stop") {
          throw new Error(`Groq returned empty content. Response: ${JSON.stringify(data)}`);
        }

        const result: ILLMResponse = {
          content,
          usage: {
            promptTokens: data.usage?.prompt_tokens ?? 0,
            completionTokens: data.usage?.completion_tokens ?? 0,
            totalTokens: data.usage?.total_tokens ?? 0,
          },
        };
        // Phase 7: Cache successful text responses for 60s
        if (content) GroqProvider.responseCache.set(cacheKey, result);
        return result;

      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (request.signal?.aborted || lastError.message.includes("LLM_TIMEOUT")) {
          console.warn(`[GroqProvider] LLM request timed out or was aborted after ${LLM_TIMEOUT_MS}ms.`);
        }
        if (lastError.message.includes("Groq API Error: 4") && !lastError.message.includes("429")) {
          throw lastError;
        }
        if (attempt < MAX_ATTEMPTS - 1) {
          // PHASE1-LLM-1: Only sleep on server errors (5xx), never on client errors
          const needsDelay = lastError.message.includes("Server error") || lastError.message.includes("5");
          console.warn(`[GroqProvider] Attempt ${attempt + 1} failed: ${lastError.message}. Retrying${needsDelay ? ` in ${RETRY_DELAY_MS}ms` : " immediately"}…`);
          if (needsDelay) await sleep(RETRY_DELAY_MS);
        }
      }
    }

    throw new Error(`[GroqProvider] All ${MAX_ATTEMPTS} attempts failed. Last error: ${lastError?.message}`);
  }

  async *streamChat(request: ILLMRequest): AsyncGenerator<string, void, unknown> {
    this.checkCircuit();
    const url = `${llmConfig.baseURL}/chat/completions`;

    // PHASE1-LLM-2: Strip slashes from model names before sending to Groq
    let currentModel = sanitizeModel(request.model || llmConfig.model);
    const fastModel = sanitizeModel(process.env.JARVIS_FAST_MODEL || "llama-3.1-8b-instant");

    const MAX_ATTEMPTS = 3;
    let response: Response | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const body: Record<string, unknown> = {
        model: currentModel,
        messages: request.messages,
        temperature: request.temperature ?? llmConfig.temperature,
        max_tokens: request.max_tokens ?? llmConfig.maxTokens,
        stream: true,
      };

      try {
        const requestSignal = createRequestSignal(request.signal);
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${llmConfig.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: requestSignal.signal,
        }).finally(requestSignal.cleanup);

        if (response.status === 429) {
          this.handle429Failure();
          if (attempt >= 1) {
            throw new Error("Groq Streaming Rate Limited (429)");
          }
          // PHASE1-LLM-1: Zero sleep on stream 429 — immediate fallback
          console.warn(`[GroqProvider] Streaming Rate limited (429). Falling back to fast model: ${fastModel} immediately.`);
          currentModel = fastModel;
          continue; // No sleep
        }

        if (response.status >= 500) {
          console.warn(`[GroqProvider] Server error (${response.status}). Retrying in 1s…`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        if (!response.ok) {
          throw new Error(`Groq Streaming Error: ${response.status}`);
        }

        this.handle429Success();
        break; // Success
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (request.signal?.aborted || message.includes("LLM_TIMEOUT")) {
          console.warn(`[GroqProvider] LLM stream timed out or was aborted after ${LLM_TIMEOUT_MS}ms.`);
        }
        if (attempt < MAX_ATTEMPTS - 1) {
          console.warn(`[GroqProvider] Stream attempt ${attempt + 1} failed: ${err}. Retrying…`);
          await sleep(RETRY_DELAY_MS);
        } else {
          console.warn(`[GroqProvider] All ${MAX_ATTEMPTS} stream attempts failed.`);
          throw err;
        }
      }
    }

    if (!response || !response.ok) {
        console.warn("[GroqProvider] Falling back to non-streaming chat due to stream failure.");
        const fallbackResponse = await this.chat(request);
        yield fallbackResponse.content;
        return;
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
            if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
              yield data.choices[0].delta.content;
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }
  }
}

export const groqProvider = new GroqProvider();
