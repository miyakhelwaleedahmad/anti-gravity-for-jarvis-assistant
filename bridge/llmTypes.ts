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
}

// ─── Response ─────────────────────────────────────────────────────────────────

export interface ILLMResponse {
  content: string;
  /** Populated when the LLM chose to call one or more tools */
  tool_calls?: ILLMToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ─── Provider Interface ───────────────────────────────────────────────────────

export interface ILLMProvider {
  chat(request: ILLMRequest): Promise<ILLMResponse>;
}
