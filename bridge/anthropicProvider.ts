/**
 * bridge/anthropicProvider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * An optional Claude provider (self-healing architecture, model-routing phase).
 *
 * Off unless ANTHROPIC_API_KEY is set AND a category names it, e.g.
 *   JARVIS_MODEL_CODING=anthropic                 (claude-opus-5-5)
 *   JARVIS_MODEL_REVIEW=anthropic:claude-sonnet-5-5
 * It is registered with modelRouter as a named provider only: it never joins
 * the failover order, so a key in .env does not move ordinary requests here.
 *
 * Before the first call with a model, the model is looked up in the provider's
 * model list (models.retrieve); an unknown or inaccessible model fails with
 * that reason instead of being assumed to exist.
 *
 * Translation from JARVIS's OpenAI-style messages:
 *   system messages        → the top-level system prompt
 *   assistant tool_calls   → tool_use blocks; tool messages → one user turn of tool_result blocks
 *   tool_choice "required" → "auto" plus an instruction (current models reject a forced choice)
 * Not sent: temperature (rejected by current models). Effort is set
 * explicitly (JARVIS_ANTHROPIC_EFFORT, default high: Claude Opus 5.5 would
 * otherwise default to medium). Server-side fallback is on by default
 * (JARVIS_ANTHROPIC_FALLBACKS=off turns it off): when the model declines on
 * policy grounds the API retries on a fallback model; if the whole chain
 * declines, this throws instead of returning an empty answer.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ILLMMessage, ILLMProvider, ILLMRequest, ILLMResponse, ILLMToolCall } from './llmTypes.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = typeof EFFORTS[number];

function effort(env = process.env): Effort {
  const v = env['JARVIS_ANTHROPIC_EFFORT']?.trim().toLowerCase();
  return (EFFORTS as readonly string[]).includes(v ?? '') ? v as Effort : 'high';
}

function textOf(content: ILLMMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  return '';
}

/** JARVIS messages → the system prompt and Messages API turns. */
export function toAnthropicMessages(messages: ILLMMessage[], forceTool: boolean): { system: string; messages: Anthropic.Beta.BetaMessageParam[] } {
  const system: string[] = [];
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'system') { const t = textOf(m.content); if (t) system.push(t); continue; }
    if (m.role === 'tool') {
      const block: Anthropic.Beta.BetaToolResultBlockParam = { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: textOf(m.content) || '(no output)' };
      const last = out[out.length - 1];
      // All results of one assistant turn go back in a single user message.
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => (b as { type: string }).type === 'tool_result')) {
        (last.content as Anthropic.Beta.BetaContentBlockParam[]).push(block);
      } else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
      const t = textOf(m.content);
      if (t) blocks.push({ type: 'text', text: t });
      for (const c of m.tool_calls ?? []) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>; } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: 'user', content: textOf(m.content) || '(empty)' });
  }
  if (forceTool) system.push('Answer by calling one of the provided tools.');
  return { system: system.join('\n\n'), messages: out };
}

/** OpenAI-style tool definitions → Messages API tools. */
export function toAnthropicTools(tools: any[] | undefined): Anthropic.Beta.BetaToolUnion[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => {
    const f = t?.function ?? t;
    return { name: String(f.name), description: String(f.description ?? ''), input_schema: (f.parameters ?? { type: 'object', properties: {} }) as Anthropic.Beta.BetaTool.InputSchema };
  });
}

/** The Messages API answer → JARVIS's response shape. Throws on a refusal. */
export function fromAnthropicMessage(msg: Anthropic.Beta.BetaMessage): ILLMResponse {
  if (msg.stop_reason === 'refusal') {
    const category = (msg as { stop_details?: { category?: string | null } }).stop_details?.category;
    throw new Error(`Anthropic declined the request${category ? ` (${category})` : ''}`);
  }
  const text: string[] = [];
  const toolCalls: ILLMToolCall[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') text.push(b.text);
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
  }
  const input = typeof msg.usage?.input_tokens === 'number' ? msg.usage.input_tokens : null;
  const output = typeof msg.usage?.output_tokens === 'number' ? msg.usage.output_tokens : null;
  return {
    content: text.join(''),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    usage: { promptTokens: input, completionTokens: output, totalTokens: input !== null && output !== null ? input + output : null },
  };
}

/** A typed API error as a message JARVIS's failure categories read correctly. */
function describe(err: unknown): Error {
  if (err instanceof Anthropic.RateLimitError) return new Error(`Anthropic API error 429: rate limit reached`);
  if (err instanceof Anthropic.AuthenticationError) return new Error(`Anthropic API error 401: unauthorized (check ANTHROPIC_API_KEY)`);
  if (err instanceof Anthropic.NotFoundError) return new Error(`Anthropic API error 404: not found (${err.message})`);
  if (err instanceof Anthropic.BadRequestError) return new Error(`Anthropic API error 400: ${err.message}`);
  if (err instanceof Anthropic.APIError) return new Error(`Anthropic API error ${err.status ?? ''}: ${err.status === 529 ? 'overloaded' : err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}

export class AnthropicProvider implements ILLMProvider {
  private client: Anthropic | null = null;
  private checked = new Map<string, Promise<void>>();

  constructor(private readonly env: Record<string, string | undefined> = process.env, private readonly factory?: () => Anthropic) {}

  isConfigured(): boolean {
    return !!this.env['ANTHROPIC_API_KEY']?.trim() || !!this.factory;
  }

  private api(): Anthropic {
    if (!this.isConfigured()) throw new Error('The Anthropic provider is not configured: set ANTHROPIC_API_KEY to use it.');
    this.client ??= this.factory ? this.factory() : new Anthropic({ apiKey: this.env['ANTHROPIC_API_KEY']!.trim(), maxRetries: 2 });
    return this.client;
  }

  /** The model exists and this key may use it (looked up once per model). */
  validateModel(model: string): Promise<void> {
    let p = this.checked.get(model);
    if (!p) {
      p = this.api().models.retrieve(model).then(() => undefined, (err) => {
        this.checked.delete(model);
        throw err instanceof Anthropic.NotFoundError
          ? new Error(`The model "${model}" is not available to this Anthropic key; set another in JARVIS_MODEL_<CATEGORY>.`)
          : describe(err);
      });
      this.checked.set(model, p);
    }
    return p;
  }

  async chat(request: ILLMRequest): Promise<ILLMResponse> {
    const model = request.model;
    if (!model) throw new Error('The Anthropic provider needs a model (JARVIS_MODEL_<CATEGORY>=anthropic:<model>).');
    await this.validateModel(model);
    const { system, messages } = toAnthropicMessages(request.messages, request.tool_choice === 'required');
    const tools = toAnthropicTools(request.tools);
    const fallbacks = (this.env['JARVIS_ANTHROPIC_FALLBACKS'] ?? '').trim().toLowerCase() !== 'off';
    try {
      const msg = await this.api().beta.messages.create({
        model,
        max_tokens: request.max_tokens ?? 16_000,
        messages,
        ...(system ? { system } : {}),
        ...(tools ? { tools, tool_choice: { type: request.tool_choice === 'none' ? 'none' : 'auto' } } : {}),
        output_config: { effort: effort(this.env) },
        ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      }, { ...(request.signal ? { signal: request.signal } : {}) });
      return fromAnthropicMessage(msg);
    } catch (err) {
      if (request.signal?.aborted) throw err;
      throw describe(err);
    }
  }
}

export const anthropicProvider = new AnthropicProvider();
