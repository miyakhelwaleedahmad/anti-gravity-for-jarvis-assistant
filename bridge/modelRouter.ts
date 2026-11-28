import { llmConfig, type LLMConfig } from "../config/llmconfig.js";
import { groqProvider } from "./groqProvider.js";
import { openaiProvider } from "./openaiProvider.js";
import { anthropicProvider } from "./anthropicProvider.js";
import type { ILLMMessage, ILLMProvider, ILLMRequest, ILLMResponse, ProviderCapabilities } from "./llmTypes.js";
import { classifyLLMError, llmStatus } from "./llmStatus.js";
import { redact } from "../security/redactor.js";
import { yieldToForeground } from "../core/foregroundGate.js";
import { agentIndependence, HELPER_ROLES, inheritedRoute, qaIndependenceRequired, queueWaitMs, recordUsage, routeFor, type ModelCategory, type ModelRoute, type ModelTarget } from "./modelCategories.js";
import { getTraceId } from "../core/traceContext.js";
import { ProviderGuard, type GuardTicket } from "./providerGuard.js";

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

/** A message part that is an image, in any of the shapes JARVIS or a provider uses. */
export function hasImagePart(request: ILLMRequest): boolean {
  return request.messages.some((m) => Array.isArray(m.content) && m.content.some((part) =>
    !!part && typeof part === "object" && ["image", "image_url", "input_image"].includes(String((part as { type?: unknown }).type))));
}

/**
 * A strict route failed (bridge/modelCategories.ts: configured coding,
 * review, coding_agent, qa_agent): no other provider or model answered it.
 * Keeps the original reason (message, `cause`) and HTTP status.
 */
export function strictRouteError(route: ModelRoute, err: unknown): Error {
  const original = err as { message?: unknown; status?: unknown } | null;
  const target = route.provider === "default" ? "the default provider" : route.provider;
  const e = new Error(`${route.key} (${target}, model ${route.model}) failed; this route is strict, so no other model answered: ${String(original?.message ?? err)}`, { cause: err });
  e.name = "StrictRouteError";
  if (typeof original?.status === "number") (e as Error & { status?: number }).status = original.status;
  return e;
}

/** A background call that waited longer than JARVIS_MODEL_QUEUE_WAIT_MS for the owner's conversation: not sent. */
function queueWaitError(key: string, target: string, ms: number): Error {
  const e = new Error(`${key}: waited ${ms} ms for the owner's conversation (JARVIS_MODEL_QUEUE_WAIT_MS); not sent to ${target}, and not answered by another model`);
  e.name = "QueueWaitTimeoutError";
  return e;
}

/** The provider did not confirm the configured model: MODEL_IDENTITY_UNCONFIRMED (wrapped by StrictRouteError). */
function identityError(message: string): Error {
  const e = new Error(message);
  e.name = "ModelIdentityError";
  return e;
}

/** A model name as compared for identity: no case, no surrounding space, no "models/" prefix. */
function normModel(model: string): string {
  return model.trim().toLowerCase().replace(/^models\//, "");
}

/** A fallback that could not be sent (queue wait, cancellation) keeps the route's own failure as its cause. */
function withPriorCause(err: unknown, prior: unknown): unknown {
  if (prior !== undefined && err instanceof Error && err.cause === undefined) Object.defineProperty(err, "cause", { value: prior, configurable: true, writable: true });
  return err;
}

/**
 * Failures that are about the model, not the provider: the model is not
 * offered (404), or the provider refused or garbled this request for it.
 * Only after one of these may a routed call ask the same provider again,
 * with a different model (M-2). Every other failure (sign-in, network,
 * rate limit, open breaker, server error, time-out, an unrecognised error)
 * counts as provider-wide: that provider is not asked again in the call.
 */
const MODEL_SPECIFIC_FAILURES: ReadonlySet<string> = new Set(["model", "bad_request", "bad_response"]);

/**
 * What one routed call has asked so far (M3, M-2, owner 2026-11-15): each
 * provider-and-model pair is sent at most once, even under another provider
 * name; a provider with a provider-wide failure, or one that cannot take the
 * request, is not asked again with any model.
 */
interface AttemptLog {
  pairs: Set<string>;
  wide: Set<ILLMProvider>;
  /** "name:model" of every attempt, in order, for the final error. */
  names: string[];
}
const newAttemptLog = (): AttemptLog => ({ pairs: new Set(), wide: new Set(), names: [] });

/** Waiting for the owner's conversation before each attempt (a routed call's fallback, M-3). */
interface AttemptWait {
  /** The route's setting, for a queue-wait error. */
  key: string;
  /** The caller's own signal (not a time limit's): cancelling it ends the wait. */
  signal?: AbortSignal;
  /** A time limit that must not run while waiting (categoryChat). */
  pause?: () => void;
  resume?: () => void;
  /** The first attempt has already waited. */
  skipFirst?: boolean;
}

/** How one call moves through the failover order. */
interface ChainOptions {
  /** Answering for a configured route that failed (recorded as a fallback). */
  fromRoute?: boolean;
  /** This routed call's attempts so far (see AttemptLog). */
  attempted?: AttemptLog;
  /** The call has already waited for the owner's conversation. */
  skipWait?: boolean;
  /** Wait for the owner's conversation before every attempt. */
  waitEach?: AttemptWait;
  /** The route's setting, for the error after every eligible provider failed. */
  routeKey?: string;
  /** The route's own failure, for that error when nothing is left to try. */
  priorError?: unknown;
  /** The route's provider (the primary for a model-only route): the one the dashboard names as failed once the fallback has answered (review L5). */
  routeProvider?: string;
}

/** After a routed call asked every eligible provider: which ones, and the last reason. */
function everyProviderFailed(routeKey: string | undefined, names: string[], lastError: unknown): Error {
  const reason = String((lastError as Error)?.message ?? lastError ?? "no reason given");
  const e = new Error(`${routeKey ?? "The call"}: every eligible provider failed (${names.join(", ") || "none left"}); last error: ${reason}`, { cause: lastError });
  const status = (lastError as { status?: unknown } | null)?.status;
  if (typeof status === "number") (e as Error & { status?: number }).status = status;
  return e;
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
  /** Each provider's own breaker and request limit, per router (bridge/providerGuard.ts). */
  private guards: Map<string, ProviderGuard> = new Map();
  /** A number per provider instance, so two names for one provider are one provider in an AttemptLog. */
  private providerIds = new WeakMap<ILLMProvider, number>();
  private nextProviderId = 1;

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
    // The wait for the owner's conversation comes first, on the caller's own
    // signal: the time limit below counts only the provider's work (M1).
    await this.waitForConversation(route, request);
    const timeout = new AbortController();
    const fire = () => timeout.abort(Object.assign(new Error(`${category} call timed out after ${route.timeoutMs} ms`), { name: "TimeoutError" }));
    // The time limit counts the providers' work only: it is paused while a
    // later failover attempt waits for the owner's conversation (M-3).
    let remaining = route.timeoutMs;
    let since = Date.now();
    let timer = setTimeout(fire, remaining);
    const pause = () => { clearTimeout(timer); remaining -= Date.now() - since; };
    const resume = () => { since = Date.now(); timer = setTimeout(fire, Math.max(0, remaining)); };
    const onAbort = () => timeout.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const routed: ILLMRequest = { ...request, model: route.model, max_tokens: request.max_tokens ?? route.maxTokens, category, signal: timeout.signal, ...(route.strict ? { exactModel: true } : {}) };
    try {
      this.refuseUnservableStrict(route);
      const named = this.namedOnly.get(route.provider);
      if (named) {
        const res = await this.callNamed(route.provider, named, routed);
        if (route.strict) await this.confirmIdentity(route, res);
        return res;
      }
      if (route.provider !== "default" && !this.providers.has(route.provider)) {
        throw new Error(`The ${category} category names provider "${route.provider}", which is not configured.`);
      }
      const res = await this.chain(routed, this.chainTarget(route), {
        skipWait: true,
        waitEach: { key: route.key, ...(request.signal ? { signal: request.signal } : {}), pause, resume, skipFirst: true },
      });
      if (route.strict) await this.confirmIdentity(route, res);
      return res;
    } catch (err) {
      if (request.signal?.aborted) throw err;
      const failure = timeout.signal.aborted ? timeout.signal.reason ?? err : err;
      throw route.strict ? strictRouteError(route, failure) : failure;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async callNamed(name: string, provider: ILLMProvider, request: ILLMRequest, attempted?: AttemptLog): Promise<ILLMResponse> {
    request = redactRequest(request);
    const started = Date.now();
    const admitted = this.admit(name, provider, request);
    if (admitted.refused) {
      if (attempted) attempted.wide.add(provider);
      this.noteUsage(request, name, started, false, false, false, undefined, admitted.refused);
      throw admitted.refused;
    }
    if (attempted) this.markAttempt(attempted, name, provider, request.model);
    try {
      const response = await provider.chat(request);
      this.guardFor(name).noteSuccess(admitted.ticket);
      this.noteUsage(request, name, started, true, false, false, response);
      return response;
    } catch (err) {
      this.noteOutcomeFailure(name, admitted.ticket, err, request.signal, attempted, provider);
      this.noteUsage(request, name, started, false, false, false, undefined, err);
      throw err;
    }
  }

  // ─── Guards and capabilities (Phase 1A) ────────────────────────────────────

  private guardFor(name: string): ProviderGuard {
    let g = this.guards.get(name);
    if (!g) { g = new ProviderGuard(name); this.guards.set(name, g); }
    return g;
  }

  /** What a provider declared it can take; undefined when it declared nothing (nothing is then enforced). */
  capabilitiesOf(nameOrProvider: string | ILLMProvider): ProviderCapabilities | undefined {
    const provider = typeof nameOrProvider === "string"
      ? this.providers.get(nameOrProvider) ?? this.namedOnly.get(nameOrProvider)
      : nameOrProvider;
    try { return provider?.capabilities?.(); } catch { return undefined; }
  }

  /**
   * Why this provider must not be sent this request now, or undefined: an
   * image or tools it declared it cannot take, its open breaker, or its
   * request limit. Checked just before sending, so a refused call is not sent
   * and is not counted against the provider.
   */
  private admit(name: string, provider: ILLMProvider, request: ILLMRequest): { refused: Error; ticket?: undefined } | { refused?: undefined; ticket: GuardTicket } {
    const caps = this.capabilitiesOf(provider);
    if (caps) {
      if (!caps.imageInput && hasImagePart(request)) return { refused: new Error(`Provider "${name}" cannot take this request: no image input.`) };
      if (!caps.toolCalling && request.tools?.length) return { refused: new Error(`Provider "${name}" cannot take this request: no tool calling.`) };
    }
    try {
      return { ticket: this.guardFor(name).check(!caps?.ownBreaker) };
    } catch (err) {
      return { refused: err as Error };
    }
  }

  /** A sent call failed: the guard hears it with the call's ticket (a cancellation is not a failure); a routed call records it. */
  private noteOutcomeFailure(name: string, ticket: GuardTicket, err: unknown, signal: AbortSignal | undefined, attempted?: AttemptLog, provider?: ILLMProvider): void {
    if (signal?.aborted) { this.guardFor(name).noteCancelled(ticket); return; }
    this.guardFor(name).noteFailure(err, ticket);
    if (attempted && provider && !MODEL_SPECIFIC_FAILURES.has(classifyLLMError(err).kind)) attempted.wide.add(provider);
  }

  /**
   * The model a pair is known by: the model sent, without case. The
   * OpenAI-compatible fallback ("openai") always sends its own model
   * (bridge/openaiProvider.ts), so for it every request is the same pair.
   */
  private pairKey(name: string, provider: ILLMProvider, model: string | undefined): string {
    let id = this.providerIds.get(provider);
    if (id === undefined) { id = this.nextProviderId++; this.providerIds.set(provider, id); }
    return `${id}|${name === "openai" ? "(its own model)" : (model ?? "").trim().toLowerCase()}`;
  }

  private mayAttempt(log: AttemptLog, name: string, provider: ILLMProvider, model: string | undefined): boolean {
    return !log.wide.has(provider) && !log.pairs.has(this.pairKey(name, provider, model));
  }

  private markAttempt(log: AttemptLog, name: string, provider: ILLMProvider, model: string | undefined): void {
    log.pairs.add(this.pairKey(name, provider, model));
    log.names.push(model ? `${name}:${model}` : name);
  }

  // ─── Configured routes (Phase 1A) ──────────────────────────────────────────

  /** The route of a category the owner configured, or undefined: an unconfigured category changes nothing. */
  private configuredRoute(request: ILLMRequest): ModelRoute | undefined {
    if (!request.category) return undefined;
    // A helper of a configured coding_agent / qa_agent uses its parent's strict route.
    const route = inheritedRoute(request.category, request.routeAs) ?? routeFor(request.category, process.env, request.agentRole);
    return route.source === "config" ? route : undefined;
  }

  /**
   * Whether a named provider also answers the owner's conversation, so a
   * background call to it competes with the owner for the same quota and
   * waits (core/foregroundGate.ts). One the conversation does not use is not held.
   */
  private servesConversation(name: string): boolean {
    return name === this.primary || routeFor("conversation").provider === name;
  }

  /**
   * The wait for the owner's conversation before a routed call (M1). It runs
   * on the caller's own signal, before any time limit starts, so waiting never
   * uses up the provider's time. A named provider the conversation does not
   * use is not held. The wait ends when the conversation does, when the
   * background yield limit passes (then the call goes ahead, PERF-02), or when
   * JARVIS_MODEL_QUEUE_WAIT_MS passes first: then the call fails with a clear
   * error and is sent to no provider. The owner's own calls never wait.
   */
  private async waitForConversation(route: ModelRoute, request: ILLMRequest): Promise<void> {
    if (this.namedOnly.has(route.provider) && !this.servesConversation(route.provider)) return;
    await this.waitForTurn(route.key, route.provider === "default" ? "the default provider" : route.provider, request.signal);
  }

  /**
   * One wait for the owner's conversation, before one attempt. A foreground
   * call returns at once. A background call waits until the conversation
   * ends, or the background yield limit passes (then it goes ahead), or
   * JARVIS_MODEL_QUEUE_WAIT_MS passes first (then QueueWaitTimeoutError: not
   * sent). Cancelling `signal` ends it with an AbortError. Never unbounded:
   * the yield limit is at most 120 s (core/foregroundGate.ts).
   */
  private async waitForTurn(key: string, target: string, signal?: AbortSignal): Promise<void> {
    const limit = queueWaitMs();
    if (limit === undefined) {
      await this.backgroundWaits({ ...(signal ? { signal } : {}) });
      return;
    }
    let timedOut = false;
    const gate = new AbortController();
    const timer = setTimeout(() => { timedOut = true; gate.abort(); }, limit);
    const onAbort = () => gate.abort();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    let waited = 0;
    try {
      waited = await yieldToForeground(gate.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted) throw Object.assign(new Error("Request aborted before it was sent"), { name: "AbortError" });
    if (timedOut) throw queueWaitError(key, target, limit);
    if (waited > 0) console.log(`[ModelRouter] Background call waited ${waited} ms for the owner's request.`);
  }

  /** The provider a route's chain starts with: a strict bare-model route asks only the primary (M2). */
  private chainTarget(route: ModelRoute): string | undefined {
    if (route.provider !== "default") return route.provider;
    return route.strict ? this.primary : undefined;
  }

  /** The provider a strict route sends to, and the model it sends (P3). */
  private strictTarget(route: ModelRoute): { name: string; provider: ILLMProvider; model: string } | undefined {
    const named = this.namedOnly.get(route.provider);
    if (named) return { name: route.provider, provider: named, model: route.model };
    const name = route.provider === "default" ? this.primary : route.provider;
    const provider = this.providers.get(name);
    return provider ? { name, provider, model: modelFor(name, route.model) ?? route.model } : undefined;
  }

  /**
   * Every provider and model an agent's call can be answered by (N2, owner
   * 2026-11-16). A strict route: exactly its target. Otherwise its configured
   * target, if any, and every provider in the failover order with the model
   * that provider really sends (the agent sends agentModel(): JARVIS_AGENT_MODEL,
   * else the fast model; the OpenAI-compatible provider sends its own model).
   * A named-only provider is reached only by a route naming it.
   */
  possibleTargets(agentRole: string, env: Record<string, string | undefined> = process.env): ModelTarget[] {
    const route = routeFor("planning", env, agentRole);
    // The model a provider really sends: a route naming a named-only provider
    // sends its model as is (callNamed); the failover order maps it (modelFor,
    // e.g. to a Claude model when Claude is the primary: R1); the
    // OpenAI-compatible provider always sends its own.
    const sends = (name: string, provider: ILLMProvider | undefined, model: string, viaNamed: boolean): string => {
      if (name === "openai") {
        const own = (provider as { model?: unknown } | undefined)?.model;
        return typeof own === "string" && own ? own : (env["JARVIS_FALLBACK_MODEL"] ?? "gpt-4o-mini");
      }
      return viaNamed ? model : (modelFor(name, model) ?? model);
    };
    const routeTarget = (r: ModelRoute, exact: boolean): ModelTarget => {
      const viaNamed = r.provider !== "default" && this.namedOnly.has(r.provider);
      const name = viaNamed ? r.provider : (r.provider === "default" ? this.primary : r.provider);
      const provider = viaNamed ? this.namedOnly.get(name) : this.providers.get(name);
      return { provider: name, model: normModel(sends(name, provider, r.model, viaNamed)), exact };
    };
    if (route.strict) {
      // Exactly what the call path sends (strictTarget), so the check and the call agree (review M-B).
      const t = this.strictTarget(route);
      if (!t) return [routeTarget(route, true)];
      return [{ provider: t.name, model: normModel(this.strictSends(t)), exact: true }];
    }
    const out: ModelTarget[] = [];
    const add = (t: ModelTarget) => { if (!out.some((o) => o.provider === t.provider && o.model === t.model)) out.push(t); };
    if (route.source === "config") add(routeTarget(route, false));
    const asked = env["JARVIS_AGENT_MODEL"]?.trim() || llmConfig.fastModel;
    for (const name of this.failoverOrder(undefined)) {
      const provider = this.providers.get(name);
      if (!provider) continue;
      add({ provider: name, model: normModel(sends(name, provider, asked, false)), exact: false });
    }
    // Not strict: its helpers keep their own model settings, so those models answer part of its work too (L1).
    for (const helper of HELPER_ROLES[agentRole] ?? []) {
      const hr = routeFor("planning", env, helper);
      if (hr.agentRole === helper) add(routeTarget(hr, false));
    }
    return out;
  }

  /**
   * Whether QA can run on a model distinct from coding's, over every model
   * either can be answered by (failover included), and whether that is
   * required (JARVIS_QA_REQUIRE_INDEPENDENT; owner, 2026-11-16).
   */
  async qaIndependence(env: Record<string, string | undefined> = process.env, opts: { resolve?: boolean } = {}): Promise<ReturnType<typeof agentIndependence> & { required: boolean }> {
    // Identities are looked up only when asked (R4: the QA gate asks only when independence is required).
    const resolve = opts.resolve ?? true;
    const [coding, qa] = resolve
      ? await Promise.all([this.resolveTargets(this.possibleTargets("coding_agent", env), env), this.resolveTargets(this.possibleTargets("qa_agent", env), env)])
      : [this.possibleTargets("coding_agent", env), this.possibleTargets("qa_agent", env)];
    return { ...agentIndependence(env, { coding, qa }), required: qaIndependenceRequired(env) };
  }

  /** Identity look-ups that failed or timed out, not repeated until this time (R4). */
  private failedLookups = new Map<string, number>();

  /**
   * Each target's identities as its provider knows them (review M-A): a
   * provider that looks models up (Claude: models.retrieve) is asked, and the
   * ids it treats as the model are kept (alias and dated id). A model it cannot
   * look up is marked unresolved, which never counts as a different model.
   */
  private async resolveTargets(targets: readonly ModelTarget[], env: Record<string, string | undefined> = process.env): Promise<ModelTarget[]> {
    // Each look-up is bounded (R4): JARVIS_QA_IDENTITY_LOOKUP_MS (default 10 s,
    // 1–60 s). A time-out or failure leaves the identity unresolved (never
    // "different"), and is not tried again for a minute.
    const raw = Number(env["JARVIS_QA_IDENTITY_LOOKUP_MS"]);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(60_000, Math.max(1_000, raw)) : 10_000;
    const now = Date.now();
    return Promise.all(targets.map(async (t) => {
      const key = `${t.provider}|${t.model}`;
      if ((this.failedLookups.get(key) ?? 0) > now) return { ...t, ids: [t.model], resolved: false };
      const provider = (this.namedOnly.get(t.provider) ?? this.providers.get(t.provider)) as (ILLMProvider & { validateModel?: (m: string) => Promise<void> }) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const lookup = (async () => {
          if (provider?.validateModel) await provider.validateModel(t.model);
          return (await provider?.modelIdentities?.(t.model)) ?? [t.model];
        })();
        const ids = await Promise.race([lookup, new Promise<never>((_r, rej) => { timer = setTimeout(() => rej(new Error(`identity look-up took longer than ${limit} ms`)), limit); })]);
        return { ...t, ids: [...new Set([t.model, ...ids.map(normModel)])], resolved: true };
      } catch {
        this.failedLookups.set(key, Date.now() + 60_000);
        return { ...t, ids: [t.model], resolved: false };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
  }

  /** The model a strict target really sends: the OpenAI-compatible provider always its own (bridge/openaiProvider.ts). */
  private strictSends(target: { name: string; provider: ILLMProvider; model: string }): string {
    if (target.name !== "openai") return target.model;
    const own = (target.provider as { model?: unknown }).model;
    return typeof own === "string" && own ? own : (process.env["JARVIS_FALLBACK_MODEL"] ?? "gpt-4o-mini");
  }

  /**
   * Before a strict route is sent, it must be sent with exactly its model. With
   * Claude as the primary, a bare non-Claude name would be mapped to a Claude
   * model (modelFor): refused. The OpenAI-compatible fallback always sends
   * its own model (bridge/openaiProvider.ts), so a strict "openai:<x>" for
   * another model cannot be honoured and is refused (owner, 2026-11-16).
   */
  private refuseUnservableStrict(route: ModelRoute): void {
    if (!route.strict) return;
    const target = this.strictTarget(route);
    if (!target) return;
    const sends = this.strictSends(target);
    if (target.name === "openai" && normModel(sends) !== normModel(target.model)) {
      throw new Error(`${route.key} names openai:${target.model}, but the OpenAI-compatible provider always sends JARVIS_FALLBACK_MODEL (${sends}); not sent`);
    }
    // With Claude as the primary, a bare non-Claude name would be sent as a Claude model (modelFor): refused (review M-B).
    if (normModel(sends) !== normModel(route.model)) {
      throw new Error(`${route.key} names the model ${route.model}, but ${target.name} would send ${sends} instead; not sent`);
    }
  }

  /**
   * A strict route's reply must come from the route's model, as the provider
   * reports it: the requested model is never taken as evidence (owner,
   * 2026-11-16). No report, or another model: an error, which the caller turns
   * into a StrictRouteError with no fallback (fail closed).
   */
  private async confirmIdentity(route: ModelRoute, res: ILLMResponse): Promise<void> {
    const target = this.strictTarget(route);
    const sent = target?.model ?? route.model;
    const who = target?.name ?? route.provider;
    if (!res.model) throw identityError(`model identity not confirmed: ${who} did not report which model answered (asked for ${sent})`);
    const accepted = new Set([normModel(sent), ...((await target?.provider.modelIdentities?.(sent)) ?? []).map(normModel)]);
    if (!accepted.has(normModel(res.model))) throw identityError(`model identity not confirmed: ${who} answered with ${res.model}, not ${sent}`);
  }

  /**
   * A configured route: its provider and model; its token cap and time limit
   * only when set explicitly, the time limit counting from after the wait for
   * the conversation (M1). A strict route fails as itself with a
   * StrictRouteError (M2); any other is answered by the providers this call
   * has not asked yet, recorded as a fallback (M3). A caller's cancellation,
   * and a queue-wait timeout, are never answered by another model.
   */
  private async routedChat(route: ModelRoute, request: ILLMRequest, attempted: AttemptLog = newAttemptLog()): Promise<ILLMResponse> {
    const req: ILLMRequest = {
      ...request,
      model: route.model,
      ...(request.max_tokens === undefined && route.explicitMaxTokens ? { max_tokens: route.maxTokens } : {}),
      ...(route.strict ? { exactModel: true } : {}),
    };
    await this.waitForConversation(route, request);
    try {
      this.refuseUnservableStrict(route);
      const res = await this.withRouteTimeout(route, req, (r) => this.sendRoute(route, r, attempted));
      if (route.strict) await this.confirmIdentity(route, res);
      return res;
    } catch (err) {
      if (request.signal?.aborted) throw err;
      if (route.strict) throw strictRouteError(route, err);
      // The route's own time limit fired: the provider did not answer in
      // time, so this call asks it nothing more, with any model (M-2).
      if ((err as Error | null)?.name === "TimeoutError" && route.explicitTimeout) {
        const own = this.namedOnly.get(route.provider) ?? this.providers.get(route.provider === "default" ? this.primary : route.provider);
        if (own) attempted.wide.add(own);
      }
      const reason = String((err as Error)?.message ?? err);
      console.warn(`[ModelRouter] ${route.key} (${route.provider}:${route.model}) failed (${redact(reason).slice(0, 120)}); answering with the default model.`);
      // The fallback: every attempt waits for the owner's conversation first (M-3). It is recorded for the
      // dashboard only once it has answered (review L5).
      return this.chain(request, undefined, { fromRoute: true, attempted, skipWait: true, waitEach: { key: route.key }, routeKey: route.key, priorError: err, routeProvider: route.provider === "default" ? this.primary : route.provider });
    }
  }

  /**
   * The route's own attempt: one provider with the route's model. A bare
   * model name is the primary's (M-2: the other providers are reached, if at
   * all, by the fallback, with the caller's model).
   */
  private async sendRoute(route: ModelRoute, request: ILLMRequest, attempted: AttemptLog): Promise<ILLMResponse> {
    const named = this.namedOnly.get(route.provider);
    if (named) return this.callNamed(route.provider, named, request, attempted);
    if (route.provider !== "default" && !this.providers.has(route.provider)) {
      throw new Error(`The ${route.key} setting names provider "${route.provider}", which is not configured.`);
    }
    return this.chain(request, route.provider === "default" ? this.primary : route.provider, { attempted, skipWait: true, routeKey: route.key });
  }

  /**
   * The route's own time limit, only when the owner set one
   * (JARVIS_MODEL_<KIND>_TIMEOUT_MS). It starts after the wait for the
   * conversation; when it passes, the error says so (not the provider's "aborted").
   */
  private async withRouteTimeout(route: ModelRoute, request: ILLMRequest, send: (r: ILLMRequest) => Promise<ILLMResponse>): Promise<ILLMResponse> {
    if (!route.explicitTimeout) return send(request);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(Object.assign(new Error(`${route.key} call timed out after ${route.timeoutMs} ms`), { name: "TimeoutError" })), route.timeoutMs);
    const onAbort = () => timeout.abort(request.signal?.reason);
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await send({ ...request, signal: timeout.signal });
    } catch (err) {
      if (timeout.signal.aborted && !request.signal?.aborted) throw timeout.signal.reason ?? err;
      throw err;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
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
        ...(request.agentRole ? { agentRole: request.agentRole } : {}),
        ...(response?.model ? { servedModel: response.model } : {}),
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
  private async backgroundWaits(request: { signal?: AbortSignal }): Promise<void> {
    const waited = await yieldToForeground(request.signal);
    if (waited > 0) console.log(`[ModelRouter] Background call waited ${waited} ms for the owner's request.`);
    if (request.signal?.aborted) {
      throw Object.assign(new Error("Request aborted before it was sent"), { name: "AbortError" });
    }
  }

  /**
   * A model call. An explicitly named provider is honoured exactly. Otherwise
   * a category the owner configured (JARVIS_MODEL_<CATEGORY>,
   * JARVIS_MODEL_AGENT_<ROLE>) chooses the provider and model; an unconfigured
   * one goes exactly where it always did (bridge/modelCategories.ts).
   */
  async chat(request: ILLMRequest, providerName?: string): Promise<ILLMResponse> {
    const route = providerName ? undefined : this.configuredRoute(request);
    if (route) return this.routedChat(route, request);
    return this.chain(request, providerName);
  }

  /**
   * The default path (chat() before Phase 1A): redaction, the foreground wait,
   * the failover order, and now each provider's capabilities and guard.
   * Within a routed call (`opts.attempted`), a provider already asked is
   * skipped, even under another name (M3); see ChainOptions.
   */
  private async chain(request: ILLMRequest, providerName?: string, opts: ChainOptions = {}): Promise<ILLMResponse> {
    request = redactRequest(request);
    if (!opts.skipWait) await this.backgroundWaits(request);
    const order = this.failoverOrder(providerName);
    const fromRoute = opts.fromRoute ?? false;
    let lastError: unknown;
    let tried = 0;
    let waitedOnce = false;
    const started = Date.now();

    for (const name of order) {
      const provider = this.providers.get(name);
      if (!provider) {
        lastError = new Error(`LLM Provider '${name}' is not registered or supported.`);
        continue;
      }
      const sent = withModel(request, modelFor(name, request.model));
      // This routed call already sent this pair, or the provider failed provider-wide (M3, M-2).
      if (opts.attempted && !this.mayAttempt(opts.attempted, name, provider, sent.model)) continue;
      if (opts.waitEach && !(opts.waitEach.skipFirst && !waitedOnce)) {
        opts.waitEach.pause?.();
        try {
          await this.waitForTurn(opts.waitEach.key, name, opts.waitEach.signal ?? request.signal);
        } catch (err) {
          throw withPriorCause(err, opts.priorError);
        } finally {
          opts.waitEach.resume?.();
        }
      }
      waitedOnce = true;
      const admitted = this.admit(name, provider, sent);
      if (admitted.refused) {
        lastError = admitted.refused;
        if (opts.attempted) opts.attempted.wide.add(provider);
        if (name !== order[order.length - 1]) console.warn(`[ModelRouter] ${admitted.refused.message} Trying next.`);
        continue;
      }
      if (opts.attempted) this.markAttempt(opts.attempted, name, provider, sent.model);
      tried++;
      try {
        const response = await provider.chat(sent);
        this.guardFor(name).noteSuccess(admitted.ticket);
        if (name !== order[0] || fromRoute) {
          // Visible on the dashboard too (bridge/llmStatus.ts), not only in the log; for a route's fallback, the
          // route's provider is the one that failed (review L5).
          // The reason is the failed provider's own error: for a route, its error, not that of a fallback asked before this one.
          const failedProvider = fromRoute ? opts.routeProvider ?? order[0]! : order[0]!;
          const first = fromRoute ? opts.priorError ?? lastError : lastError;
          const reason = String((first as Error)?.message ?? first ?? "failed");
          console.warn(`[ModelRouter] ${failedProvider} failed (${redact(reason).slice(0, 120)}); answered by the fallback "${name}".`);
          llmStatus.recordFallback(failedProvider, name, reason);
        }
        this.noteUsage(sent, name, started, true, name !== order[0] || fromRoute, false, response);
        return response;
      } catch (err) {
        lastError = err;
        this.noteOutcomeFailure(name, admitted.ticket, err, request.signal, opts.attempted, provider);
        // An aborted request is the caller's decision, not a provider failure —
        // failing over would run the same work again against a second provider.
        if (request.signal?.aborted) throw err;
        if (name !== order[order.length - 1]) {
          console.warn(`[ModelRouter] Provider "${name}" failed (${(err as Error)?.message}); trying next.`);
        }
      }
    }

    if (opts.attempted && fromRoute) {
      // A route's fallback: every provider this call could use has failed (or none was left).
      if (tried > 0) this.noteUsage(request, order[order.length - 1] ?? "none", started, false, true, false, undefined, lastError);
      throw everyProviderFailed(opts.routeKey, opts.attempted.names, tried > 0 ? lastError : opts.priorError ?? lastError);
    }
    this.noteUsage(request, order[order.length - 1] ?? "none", started, false, order.length > 1 || fromRoute, false, undefined, lastError);
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
    const route = providerName ? undefined : this.configuredRoute(request);
    if (!route) {
      yield* this.primaryStream(request, providerName);
      return;
    }
    if (route.strict) {
      // A strict route is not streamed: its answer is shown only after the
      // provider has reported the model that wrote it (owner, 2026-11-16).
      const response = await this.routedChat(route, request);
      if (response.content) yield response.content;
      return;
    }
    // A configured route (e.g. JARVIS_MODEL_CONVERSATION) streams from its own provider.
    const named = this.namedOnly.get(route.provider);
    const name = named ? route.provider : (route.provider === "default" ? this.primary : route.provider);
    const provider = named ?? this.providers.get(name);
    if (!provider || typeof (provider as { streamChat?: unknown }).streamChat !== "function") {
      // It cannot stream: one answer through the route, with the route's fallback rule.
      const response = await this.routedChat(route, request);
      if (response.content) yield response.content;
      return;
    }
    const req: ILLMRequest = {
      ...request,
      model: route.model,
      ...(request.max_tokens === undefined && route.explicitMaxTokens ? { max_tokens: route.maxTokens } : {}),
    };
    // The wait for the conversation, on the caller's signal (M1); its errors are not answered by another model.
    await this.waitForConversation(route, request);
    const attempted = newAttemptLog();
    let yielded = false;
    // The route's time limit, when set, applies to its own stream as a limit on silence (review L9): the
    // stream stops when the provider sends nothing for that long, before the first text or between pieces.
    const silenceLimit = route.explicitTimeout ? { ms: route.timeoutMs, key: route.key } : undefined;
    try {
      for await (const piece of this.streamFrom(name, provider, req, attempted, silenceLimit)) {
        yielded = true;
        yield piece;
      }
    } catch (err) {
      // Text already spoken or a cancellation: not answered again. A strict route fails as itself (M2).
      if (yielded || request.signal?.aborted) throw err;
      if (route.strict) throw strictRouteError(route, err);
      // The route's own time limit passed: this call asks that provider nothing more (M-2).
      if ((err as Error | null)?.name === "TimeoutError") attempted.wide.add(provider);
      const reason = String((err as Error)?.message ?? err);
      console.warn(`[ModelRouter] ${route.key} stream (${route.provider}:${route.model}) failed before any text (${redact(reason).slice(0, 120)}); answering with the default model.`);
      // The providers this call has not asked yet (M3): the route's own is not asked again. Recorded for the
      // dashboard only once the fallback has answered (review L5).
      yield* this.primaryStream(request, undefined, { fromRoute: true, attempted, skipWait: true, waitEach: { key: route.key }, routeKey: route.key, priorError: err, routeProvider: route.provider === "default" ? this.primary : route.provider });
    }
  }

  /**
   * The next piece of a stream, or a TimeoutError when the provider sends nothing for `ms` (review L9). On the
   * time-out the provider's request is cancelled; the piece still pending is dropped.
   */
  private async nextWithin(it: AsyncIterator<string>, ms: number, key: string, cancel: AbortController): Promise<IteratorResult<string>> {
    const pending = it.next();
    pending.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silence = new Promise<never>((_res, rej) => {
      timer = setTimeout(() => {
        const err = Object.assign(new Error(`${key} stream sent nothing for ${ms} ms`), { name: "TimeoutError" });
        cancel.abort(err);
        void it.return?.(undefined)?.catch(() => undefined);
        rej(err);
      }, ms);
    });
    try {
      return await Promise.race([pending, silence]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** One provider's stream for a configured route: capabilities and guard, then the usage record. */
  private async *streamFrom(name: string, provider: ILLMProvider, request: ILLMRequest, attempted?: AttemptLog, silenceLimit?: { ms: number; key: string }): AsyncGenerator<string, void, unknown> {
    request = redactRequest(request);
    let sent = withModel(request, modelFor(name, request.model));
    const admitted = this.admit(name, provider, sent);
    if (admitted.refused) {
      if (attempted) attempted.wide.add(provider);
      // Recorded as a failed call, as a refused routed chat is (review L8).
      this.noteUsage(sent, name, Date.now(), false, false, true, undefined, admitted.refused);
      throw admitted.refused;
    }
    if (attempted) this.markAttempt(attempted, name, provider, sent.model);
    const stream = (provider as unknown as { streamChat: (r: ILLMRequest) => AsyncGenerator<string, void, unknown> }).streamChat;
    const started = Date.now();
    let reported = false;
    // With a time limit, the provider's request runs on its own signal, which the caller's cancellation also ends.
    const cancel = silenceLimit ? new AbortController() : undefined;
    const onAbort = () => cancel?.abort(request.signal?.reason);
    if (cancel) {
      if (request.signal?.aborted) onAbort();
      else request.signal?.addEventListener("abort", onAbort, { once: true });
      sent = { ...sent, signal: cancel.signal };
    }
    let it: AsyncIterator<string> | undefined;
    let finished = false;
    try {
      if (silenceLimit && cancel) {
        it = stream.call(provider, sent)[Symbol.asyncIterator]();
        for (let next = await this.nextWithin(it, silenceLimit.ms, silenceLimit.key, cancel); !next.done; next = await this.nextWithin(it, silenceLimit.ms, silenceLimit.key, cancel)) {
          yield next.value;
        }
        finished = true;
      } else {
        for await (const chunk of stream.call(provider, sent)) yield chunk;
      }
      reported = true;
      this.guardFor(name).noteSuccess(admitted.ticket);
      const usage = (provider as { lastStreamUsage?: ILLMResponse["usage"] | null }).lastStreamUsage;
      this.noteUsage(sent, name, started, true, false, true, usage ? { content: "", usage } : undefined);
    } catch (err) {
      reported = true;
      this.noteOutcomeFailure(name, admitted.ticket, err, request.signal, attempted, provider);
      this.noteUsage(sent, name, started, false, false, true, undefined, err);
      throw err;
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      // The consumer stopped reading early: no outcome, but the call is over (a trial frees its lease). A stream
      // read piece by piece is closed here, as for-await closes the other.
      if (!reported) {
        this.guardFor(name).noteCancelled(admitted.ticket);
        if (it && !finished) { cancel?.abort(new Error("stream closed by its reader")); void it.return?.(undefined)?.catch(() => undefined); }
      }
    }
  }

  /**
   * The default stream (streamChat() before Phase 1A), plus the provider's
   * capabilities and guard. With `opts.fromRoute`: answering for a configured
   * route whose stream failed (recorded as a fallback), never asking a
   * provider that route already asked (M3).
   */
  private async *primaryStream(request: ILLMRequest, providerName?: string, opts: ChainOptions = {}): AsyncGenerator<string, void, unknown> {
    request = redactRequest(request);
    if (!opts.skipWait) await this.backgroundWaits(request);
    const fromRoute = opts.fromRoute ?? false;
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
    if (opts.attempted && !this.mayAttempt(opts.attempted, selectedProviderName, provider, sent.model)) {
      // This routed call already sent this pair, or the provider failed provider-wide (M3, M-2).
      const response = await this.chain(request, providerName, { ...opts, skipWait: true });
      if (response.content) yield response.content;
      return;
    }
    if (opts.waitEach) {
      try {
        await this.waitForTurn(opts.waitEach.key, selectedProviderName, opts.waitEach.signal ?? request.signal);
      } catch (err) {
        throw withPriorCause(err, opts.priorError);
      }
    }
    const admitted = this.admit(selectedProviderName, provider, sent);
    if (admitted.refused) {
      // Not sent (a capability it lacks, its open breaker or request limit): answered once through the failover order.
      if (opts.attempted) opts.attempted.wide.add(provider);
      console.warn(`[ModelRouter] ${admitted.refused.message} Answering without streaming.`);
      const response = await this.chain(request, providerName, opts);
      if (response.content) yield response.content;
      return;
    }
    if (opts.attempted) this.markAttempt(opts.attempted, selectedProviderName, provider, sent.model);
    // A route's fallback that answered: now the dashboard may say so, naming the route's provider (review L5).
    const recordRouteFallback = () => {
      if (fromRoute) llmStatus.recordFallback(opts.routeProvider ?? selectedProviderName, selectedProviderName, String((opts.priorError as Error)?.message ?? opts.priorError ?? "failed"));
    };
    let reported = false;
    try {
      for await (const chunk of stream.call(provider, sent)) {
        yielded = true;
        yield chunk;
      }
      reported = true;
      this.guardFor(selectedProviderName).noteSuccess(admitted.ticket);
      // Token counts when the provider reports them for a stream (Claude does); else null, not 0.
      const usage = (provider as { lastStreamUsage?: ILLMResponse["usage"] | null }).lastStreamUsage;
      this.noteUsage(sent, selectedProviderName, started, true, fromRoute, true, usage ? { content: "", usage } : undefined);
      recordRouteFallback();
    } catch (err) {
      reported = true;
      this.noteOutcomeFailure(selectedProviderName, admitted.ticket, err, request.signal, opts.attempted, provider);
      if (yielded || request.signal?.aborted) this.noteUsage(sent, selectedProviderName, started, false, fromRoute, true, undefined, err);
      // Mid-reply failures and cancellations are not retried: the caller has
      // already spoken part of the answer, or asked for it to stop.
      if (yielded || request.signal?.aborted) throw err;
      console.warn(`[ModelRouter] Stream from "${selectedProviderName}" failed (${(err as Error)?.message}); answering without streaming.`);
      const response = await this.chain(request, providerName, opts);
      if (response.content) yield response.content;
    } finally {
      // The consumer stopped reading early: no outcome, but the call is over (a trial frees its lease).
      // Text it already read came from the fallback, so a route's fallback still answered.
      if (!reported) {
        this.guardFor(selectedProviderName).noteCancelled(admitted.ticket);
        if (yielded) recordRouteFallback();
      }
    }
  }
}

export const modelRouter = new ModelRouter();
