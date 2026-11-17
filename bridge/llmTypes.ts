/**
 * bridge/llmTypes.ts
 * Extended to support OpenAI-compatible function/tool calling.
 * Groq supports this format for llama-3.3-70b-versatile.
 */

// ─── Tool Call Types ──────────────────────────────────────────────────────────

export interface ILLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded string
  };
}

// ─── Message ──────────────────────────────────────────────────────────────────

export interface ILLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | any[] | null;
  /** Present on assistant messages that triggered tool calls */
  tool_calls?: ILLMToolCall[];
  /** Required on tool-role messages — matches the tool_call id */
  tool_call_id?: string;
  /** Tool name, used on tool-role messages */
  name?: string;
}

// ─── Request ──────────────────────────────────────────────────────────────────

export interface ILLMRequest {
  model?: string;
  messages: ILLMMessage[];
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
  /** Pass tool definitions to enable function calling */
  tools?: any[];
  /** "auto" lets the model decide; "none" disables tool calling */
  tool_choice?: "auto" | "none" | "required";
  /**
   * What kind of work this is (bridge/modelCategories.ts), for the usage
   * record. Never sent to a provider: each builds its request body field by field.
   */
  category?: import("./modelCategories.js").ModelCategory;
  /**
   * The specialist agent making the call (core/agents), for its own route
   * (JARVIS_MODEL_AGENT_<ROLE>) and the usage record. Never sent to a provider.
   */
  agentRole?: string;
  /**
   * A helper agent of a coding_agent or qa_agent with its own model setting:
   * that parent's role. The router uses the parent's route instead of the
   * helper's own, but only when that route is configured and strict
   * (bridge/modelCategories.ts inheritedRoute). Never sent to a provider.
   */
  routeAs?: string;
  /**
   * Set by the router for a strict route: send exactly `model`. The adapter
   * must not move to another model (fast model after a rate limit or during a
   * cooldown, a cached reply of another call, server-side fallback models).
   * Never sent to a provider.
   */
  exactModel?: boolean;
}

// ─── Response ─────────────────────────────────────────────────────────────────

export interface ILLMResponse {
  content: string;
  /** Populated when the LLM chose to call one or more tools */
  tool_calls?: ILLMToolCall[];
  /** null: the provider did not report it (not "zero tokens"). */
  usage?: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
  /**
   * The model the provider reports it used, exactly as reported; undefined
   * when it reports none. Never filled in from the request (owner, 2026-11-16).
   */
  model?: string;
}

// ─── Provider Interface ───────────────────────────────────────────────────────

/**
 * What a provider can actually take, declared by its adapter (never assumed
 * from another provider). The router refuses a request that needs something
 * a provider declared it lacks; a provider that declares nothing has nothing
 * enforced.
 */
export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  /** JSON-schema-constrained output through this adapter. */
  structuredOutput: boolean;
  imageInput: boolean;
  audioInput: boolean;
  audioOutput: boolean;
  /** A provider-side web search tool through this adapter. */
  webSearch: boolean;
  /** Token counts on chat replies / on streamed replies. */
  reportsUsage: boolean;
  reportsStreamUsage: boolean;
  /** Honours the request's AbortSignal. */
  cancellation: boolean;
  /** Has its own rate-limit circuit breaker; the router adds none on top. */
  ownBreaker: boolean;
}

export interface ILLMProvider {
  chat(request: ILLMRequest): Promise<ILLMResponse>;
  /** Optional: a provider that does not declare capabilities has none enforced. */
  capabilities?(): ProviderCapabilities;
  /**
   * Model ids the provider itself treats as `requested` (e.g. Claude's alias
   * and the dated id its model list returned for it). The router compares a
   * reported model against these on a strict route.
   */
  modelIdentities?(requested: string): string[] | Promise<string[]>;
}
