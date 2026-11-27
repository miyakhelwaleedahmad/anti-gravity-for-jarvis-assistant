# Patch Plan — Phase 1A: model gateway foundation

> Stage: 03_patch_plan · Run `2026-11-15_phase1a-model-gateway`
> Status: [ ] Awaiting Approval / [x] Approved (with conditions, 2026-11-15) / [ ] Rejected
> Date: 2026-11-15 · Base commit `c4ac909` · branch `claude/jarvis-repair`
> Each change below is approved separately (owner's condition 2). Changes 1, 2, 4, 5 and 9 touch no protected file.

---

## Summary

Make the role a request already carries (`category`) actually choose its model, **but only when the owner configures that role**: with no new setting, every call goes exactly where it goes today. The run also:

- gives every provider its own circuit breaker and an optional request limit;
- has providers declare what they can take, so an image is refused instead of silently dropped;
- writes each usage record to a file under the data root, so usage survives a restart;
- lets coding_agent and qa_agent each have their own model setting.

No new provider, category, dependency or paid service. The orchestrator, reflection and goal code is **not edited**: routing happens inside the router, keyed on the `category` they already send.

## Before → after behaviour

| Situation | Before | After |
|---|---|---|
| No `JARVIS_MODEL_*` set (today's default) | default primary + failover | **identical** |
| `JARVIS_MODEL_PLANNING` / `_CONVERSATION` / `_INTENT` / `_REPAIR_PLAN` set | ignored by `chat()`/`streamChat()` (label only) | the configured provider/model answers; if it fails, the call falls back to today's default chain (recorded `fallbackUsed`) |
| `JARVIS_MODEL_REVIEW` set | only code-repair review used it | `goalVerifier` review calls use it too (they already send `category: 'review'`) |
| `JARVIS_MODEL_CODING` / `_REVIEW` provider fails | code repair: error | error (strict: never answered by another model silently); unchanged |
| Background (agent/goal) call to a named provider, e.g. Claude | does not wait for the owner's conversation | waits, like every other background call (max `JARVIS_BACKGROUND_YIELD_MS`, default 20 s) |
| Claude or the OpenAI fallback returns 429 twice in a row | every later call still goes out and fails | that provider is skipped for 60 s (failover takes over); then one trial call |
| Gemini/Groq client | one breaker shared by every instance (only one exists) | default instance unchanged (same statics); any new instance can have its own state |
| Optional `JARVIS_PROVIDER_<NAME>_RPM=n` | — | after n calls in 60 s that provider is skipped (no wasted 429; e.g. Gemini free tier `=5`) |
| Request with an image part to Claude | image silently removed, text sent | refused before sending: "Provider "anthropic" cannot take this request: no image input"; failover tries the next provider |
| Provider with no `capabilities()` (test stubs, future adapters) | — | nothing enforced (unknown is not "no") |
| Restart | usage history lost | last 500 records reloaded from `data/usage/model_usage.jsonl` |
| `JARVIS_MODEL_AGENT_CODING_AGENT` / `_QA_AGENT` set | not possible; all agents on 'planning' | that agent's calls use its own route; independence of QA from coding is reported |

---

## Proposed Changes

### Change 1 — capability and role fields on the model interface (not protected)

**File:** `bridge/llmTypes.ts` · **Lines:** 33–48 and 64–68

**Before:**
```typescript
export interface ILLMRequest {
  …
  category?: import("./modelCategories.js").ModelCategory;
}
…
export interface ILLMProvider {
  chat(request: ILLMRequest): Promise<ILLMResponse>;
}
```

**After:**
```typescript
export interface ILLMRequest {
  …
  category?: import("./modelCategories.js").ModelCategory;
  /**
   * The specialist agent making the call (core/agents), for its own route
   * (JARVIS_MODEL_AGENT_<ROLE>) and the usage record. Never sent to a provider.
   */
  agentRole?: string;
}
…
/** What a provider can actually take. Declared by the adapter, never assumed. */
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
  /** Honours AbortSignal. */
  cancellation: boolean;
  /** Has its own rate-limit circuit breaker; the router adds none on top. */
  ownBreaker: boolean;
}

export interface ILLMProvider {
  chat(request: ILLMRequest): Promise<ILLMResponse>;
  /** Optional: a provider that does not declare capabilities has none enforced. */
  capabilities?(): ProviderCapabilities;
}
```

**Reason:** G0-04, G0-06. Both fields are optional, so every existing stub and test double still compiles. `agentRole`, like `category`, is not copied into any request body: each adapter builds its body field by field (`groqProvider.ts:285-293`, `anthropicProvider.ts:166-174`, `openaiProvider.ts:61-73`; `modelRoutingTest.ts:86-87` already checks this for `category`).

---

### Change 2 — role-aware routes and agent overrides (not protected)

**File:** `bridge/modelCategories.ts` · **Lines:** 33–94 (route), 98–147 (usage)

**Before (route):** `routeFor(category, env)` reads `JARVIS_MODEL_<CATEGORY>` and returns `{ category, provider, model, timeoutMs, maxTokens, source, independent? }`.

**After (route):**
```typescript
export interface ModelRoute {
  category: ModelCategory;
  provider: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  source: 'default' | 'config';
  /** The setting that chose this route, e.g. JARVIS_MODEL_PLANNING or JARVIS_MODEL_AGENT_QA_AGENT. */
  key: string;
  /** The time limit / token cap were set explicitly (only then does chat() apply them). */
  explicitTimeout: boolean;
  explicitMaxTokens: boolean;
  independent?: boolean;
}

/** Roles whose configured model must never be replaced silently by another (code repair). */
export const STRICT_CATEGORIES: ReadonlySet<ModelCategory> = new Set(['coding', 'review']);

/** JARVIS_MODEL_AGENT_<ROLE>: "coding_agent" → JARVIS_MODEL_AGENT_CODING_AGENT. */
export function agentRouteKey(role: string): string {
  return `JARVIS_MODEL_AGENT_${role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function routeFor(category: ModelCategory, env = process.env, agentRole?: string): ModelRoute {
  // An agent's own setting wins over its category's; same value syntax.
  const agentKey = agentRole ? agentRouteKey(agentRole) : undefined;
  const key = agentKey && env[agentKey]?.trim() ? agentKey : `JARVIS_MODEL_${category.toUpperCase()}`;
  … // the existing parsing, unchanged, reading env[key], env[`${key}_TIMEOUT_MS`], env[`${key}_MAX_TOKENS`]
  route.key = key;
  route.explicitTimeout = env[`${key}_TIMEOUT_MS`] !== undefined && /* valid */ …;
  route.explicitMaxTokens = env[`${key}_MAX_TOKENS`] !== undefined && /* valid */ …;
  … // the existing review-independence rule, unchanged
}

/** Whether qa_agent checks coding_agent's work on a different model (reported, never enforced). */
export function agentIndependence(env = process.env): { coding: ModelRoute; qa: ModelRoute; independent: boolean } {
  const coding = routeFor('planning', env, 'coding_agent');
  const qa = routeFor('planning', env, 'qa_agent');
  return { coding, qa, independent: !(coding.provider === qa.provider && coding.model === qa.model) };
}
```

**Before (usage):** `recordUsage()` pushes to `records` (max 500); `usageLog()`/`usageSummary()` read it.

**After (usage):**
```typescript
export interface UsageRecord { …existing fields…; agentRole?: string; }

let loaded = false;
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  records.unshift(...readRecentUsage(KEEP));        // bridge/usageLedger.ts (Change 5)
}

export function recordUsage(r): UsageRecord {
  ensureLoaded();
  …existing record building…
  records.push(rec);
  if (records.length > KEEP) records.splice(0, records.length - KEEP);
  appendUsage(rec);                                 // never throws (Change 5)
  return rec;
}
export function usageLog(limit = KEEP) { ensureLoaded(); return records.slice(-limit); }
export function usageSummary() { ensureLoaded(); …unchanged… }
export function clearUsage(): void { records.length = 0; loaded = true; }   // for tests; the file is kept
```

**Reason:** G0-05, G0-06. Existing calls `routeFor(category, env)` are unchanged (third parameter optional). `MODEL_CATEGORIES` stays at six (`modelRoutingTest.ts:48`).

---

### Change 3 — Gemini/Groq client state per instance, default unchanged (PROTECTED)

**File:** `bridge/groqProvider.ts` · **Lines:** 140–251 (state and its users), 309–345, 425–460 (calls `startModel`/`noteLongRateLimit`), new `capabilities()`

**Why not simply make the fields instance fields:** `llmClientBehaviourTest`, `providerHealthTest` and `healthStatusTest` reset `GroqProvider.isCircuitBroken`, `.consecutive429s`, `.circuitBreakerResetTime` and `.modelCooldownUntil` on the **class**. Moving the storage would turn those resets into no-ops and make the tests leak state between cases. Changing the tests is not on the table, so the default storage stays where it is.

**Before:**
```typescript
export class GroqProvider implements ILLMProvider {
  private static isCircuitBroken = false;
  private static circuitBreakerResetTime = 0;
  private static consecutive429s = 0;
  private static modelCooldownUntil = new Map<string, number>();
  private static coolingDown(model) { … GroqProvider.modelCooldownUntil … }
  private static noteLongRateLimit(model, detail) { … }
  private static startModel(requested, fastModel) { … }
  private static responseCache = new AdaptiveLruCache<string, ILLMResponse>(64, 60_000, 'groq-resp');
  private static inFlight = new Map<…>();
  private checkCircuit() { … GroqProvider.isCircuitBroken … }
  …
}
export const groqProvider = new GroqProvider();
```

**After:**
```typescript
/** Rate-limit and cache state of one client. */
interface ClientState {
  isCircuitBroken: boolean;
  circuitBreakerResetTime: number;
  consecutive429s: number;
  modelCooldownUntil: Map<string, number>;
  responseCache: AdaptiveLruCache<string, ILLMResponse>;
  inFlight: Map<string, { promise: Promise<ILLMResponse>; controller: AbortController; waiting: number }>;
}

export class GroqProvider implements ILLMProvider {
  // Unchanged storage for the default instance (and for tests that reset it).
  private static isCircuitBroken = false;
  private static circuitBreakerResetTime = 0;
  private static consecutive429s = 0;
  private static modelCooldownUntil = new Map<string, number>();
  private static responseCache = new AdaptiveLruCache<string, ILLMResponse>(64, 60_000, 'groq-resp');
  private static inFlight = new Map<…>();

  /** The class fields above, seen as one state object (live: reads and writes go to the statics). */
  private static readonly sharedState: ClientState = {
    get isCircuitBroken() { return GroqProvider.isCircuitBroken; }, set isCircuitBroken(v) { GroqProvider.isCircuitBroken = v; },
    get circuitBreakerResetTime() { return GroqProvider.circuitBreakerResetTime; }, set circuitBreakerResetTime(v) { GroqProvider.circuitBreakerResetTime = v; },
    get consecutive429s() { return GroqProvider.consecutive429s; }, set consecutive429s(v) { GroqProvider.consecutive429s = v; },
    get modelCooldownUntil() { return GroqProvider.modelCooldownUntil; },
    get responseCache() { return GroqProvider.responseCache; },
    get inFlight() { return GroqProvider.inFlight; },
  };

  private readonly state: ClientState;

  /**
   * @param opts.isolatedState  this client keeps its own breaker, cooldowns,
   *   cache and in-flight calls (for a second provider served by this class,
   *   Phase 1B). Default: the shared state, exactly as before.
   */
  constructor(opts: { isolatedState?: boolean } = {}) {
    this.state = opts.isolatedState
      ? { isCircuitBroken: false, circuitBreakerResetTime: 0, consecutive429s: 0, modelCooldownUntil: new Map(),
          responseCache: new AdaptiveLruCache<string, ILLMResponse>(64, 60_000, 'groq-resp-isolated'), inFlight: new Map() }
      : GroqProvider.sharedState;
  }

  private coolingDown(model) { … this.state.modelCooldownUntil … }      // was static, same body
  private noteLongRateLimit(model, detail) { … this.state … }           // was static, same body
  private startModel(requested, fastModel) { … this.coolingDown … }     // was static, same body
  private checkCircuit() { … this.state.isCircuitBroken … }             // same body
  private handle429Success() / handle429Failure() { … this.state … }    // same bodies
  // chat(): GroqProvider.responseCache / inFlight → this.state.responseCache / inFlight
  // hashRequest() and follow() stay static (they hold no state)

  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false, audioInput: false,
             audioOutput: false, webSearch: false, reportsUsage: true, reportsStreamUsage: false,
             cancellation: true, ownBreaker: true };
  }
}
export const groqProvider = new GroqProvider();   // shared state: unchanged behaviour
```

`imageInput: false` is deliberate: Gemini's endpoint may accept images, but this adapter has never been tested with them (verified in 1B).

**Reason:** G0-02. Every line that read `GroqProvider.<field>` now reads `this.state.<field>`, which for the default instance **is** that field. Nothing is renamed or removed that a test touches.

---

### Change 4 — per-provider breaker and request limit (new file, not protected)

**File:** `bridge/providerGuard.ts` (new, about 90 lines)

```typescript
/**
 * One provider's own circuit breaker and optional request limit, kept by the
 * router per provider name (so one provider's 429s never stop another's calls).
 *
 *   JARVIS_PROVIDER_<NAME>_BREAKER_429S   consecutive rate limits that open it (default 2, like the Gemini/Groq client)
 *   JARVIS_PROVIDER_<NAME>_BREAKER_MS     how long it stays open (default 60000)
 *   JARVIS_PROVIDER_<NAME>_RPM            at most this many calls a minute (default: no limit)
 *
 * Only rate limits open the breaker: a 5xx or network error is not a quota
 * problem, and an aborted call is the caller's choice (classifyLLMError).
 * After the open period one trial call goes through; another 429 opens it again.
 */
export class ProviderUnavailableError extends Error {
  readonly kind = 'rate_limit';
  constructor(provider: string, why: string) { super(`${provider} rate-limited locally (${why}); not sent`); this.name = 'ProviderUnavailableError'; }
}

export class ProviderGuard {
  private consecutive = 0;
  private openUntil = 0;
  private calls: number[] = [];
  constructor(readonly name: string, private readonly env = process.env, private readonly now = Date.now) {}

  /** Throws ProviderUnavailableError when the breaker is open or the minute's limit is used. */
  check(useBreaker: boolean): void { … }
  noteSuccess(): void { this.consecutive = 0; this.openUntil = 0; }
  noteFailure(err: unknown): void { if (classifyLLMError(err).kind === 'rate_limit') { …count; open at the threshold… } }
  snapshot(): { open: boolean; openForMs: number; consecutiveRateLimits: number; callsLastMinute: number; rpm: number | null } { … }
}
```

The message contains "rate-limited", so `classifyLLMError` (`bridge/llmStatus.ts:40`) reports it as `rate_limit`, never as a provider being down.

---

### Change 5 — usage ledger (new file, not protected)

**File:** `bridge/usageLedger.ts` (new, about 80 lines)

```typescript
/**
 * Usage records on disk: <data root>/data/usage/model_usage.jsonl, one JSON
 * record per model call (the UsageRecord fields only: never a message, a
 * prompt, a reply or a key; error texts are already redacted and cut to 200
 * characters). Rotated at 2 MB, the last 10 rotated files kept, like
 * core/issueStore.ts occurrences. JARVIS_USAGE_LEDGER=off writes and reads nothing.
 */
export function usageLedgerFile(): string { return path.join(dataRoot(getWorkspaceRoot()), 'data', 'usage', 'model_usage.jsonl'); }

/** Appends one record; never throws (a full or read-only disk loses the record, not the call). Warns once. */
export function appendUsage(rec: UsageRecord): void { … fs.mkdirSync … rotate if > ROTATE_BYTES … fs.appendFileSync(file, JSON.stringify(rec) + '\n') … }

/** The newest `limit` records of the current file, oldest first; malformed lines are skipped. */
export function readRecentUsage(limit: number): UsageRecord[] { … }
```

Synchronous appends follow `core/issueStore.ts:528-530`. One record is about 300 bytes, written after a call that took seconds. The ledger is read once, on the first usage call. It is not read at import, so no test pays for it.

**Reason:** G0-05. A local file under the existing data root: no database and no dependency.

---

### Change 6 — the router applies configured routes, guards and capabilities (PROTECTED)

**File:** `bridge/modelRouter.ts` · **Lines:** 108–126 (`categoryChat`), 128–139 (`callNamed`), 141–163 (`noteUsage`), 199–238 (`chat`), 246–281 (`streamChat`)

**6a. `chat()`: route only when configured; today's body becomes `chain()`.**

Before:
```typescript
async chat(request: ILLMRequest, providerName?: string): Promise<ILLMResponse> {
  request = redactRequest(request);
  await this.backgroundWaits(request);
  const order = this.failoverOrder(providerName);
  … loop over order …
}
```
After:
```typescript
async chat(request: ILLMRequest, providerName?: string): Promise<ILLMResponse> {
  // An explicit provider is honoured exactly, as before. Otherwise a category
  // the owner configured (JARVIS_MODEL_<CATEGORY>, JARVIS_MODEL_AGENT_<ROLE>)
  // chooses the model; an unconfigured one changes nothing.
  const route = providerName ? undefined : this.configuredRoute(request);
  if (route) return this.routedChat(route, request);
  return this.chain(request, providerName);
}

/** Today's chat(): redaction, foreground wait, failover — plus each provider's guard and capabilities. */
private async chain(request: ILLMRequest, providerName?: string): Promise<ILLMResponse> {
  request = redactRequest(request);
  await this.backgroundWaits(request);
  const order = this.failoverOrder(providerName);
  …
  for (const name of order) {
    const provider = this.providers.get(name);
    if (!provider) { …unchanged… }
    const sent = withModel(request, modelFor(name, request.model));
    const refused = this.refusal(name, provider, sent);           // capability or guard; undefined = may call
    if (refused) { lastError = refused; continue; }
    try {
      const response = await provider.chat(sent);
      this.guardFor(name).noteSuccess();
      …unchanged (fallback note, usage, return)…
    } catch (err) {
      this.guardFor(name).noteFailure(err);
      …unchanged (abort rethrow, next)…
    }
  }
  …unchanged…
}

/** The route of a configured category, or undefined (default behaviour). */
private configuredRoute(request: ILLMRequest): ModelRoute | undefined {
  if (!request.category) return undefined;
  const route = routeFor(request.category, process.env, request.agentRole);
  return route.source === 'config' ? route : undefined;
}

/**
 * A configured route: its provider and model; its time limit and token cap
 * only when set explicitly. A strict route (coding, review) fails as itself;
 * any other falls back to the default chain, recorded as a fallback.
 */
private async routedChat(route: ModelRoute, request: ILLMRequest): Promise<ILLMResponse> {
  const req: ILLMRequest = {
    ...request,
    model: route.model,
    ...(request.max_tokens === undefined && route.explicitMaxTokens ? { max_tokens: route.maxTokens } : {}),
  };
  try {
    return await this.withRouteTimeout(route, req, (r) => this.sendRoute(route, r));
  } catch (err) {
    if (request.signal?.aborted || STRICT_CATEGORIES.has(route.category)) throw err;
    console.warn(`[ModelRouter] ${route.key} (${route.provider}:${route.model}) failed (${String((err as Error)?.message).slice(0, 120)}); answered by the default model.`);
    llmStatus.recordFallback(route.provider, 'default', String((err as Error)?.message ?? err));
    return this.chain({ ...request, fallbackFromRoute: true } as ILLMRequest);   // usage record: fallbackUsed=true
  }
}

/** Named provider (never in failover), a registered one, or the default chain with the route's model. */
private async sendRoute(route: ModelRoute, req: ILLMRequest): Promise<ILLMResponse> {
  const named = this.namedOnly.get(route.provider);
  if (named) { await this.backgroundWaits(req); return this.callNamed(route.provider, named, req); }
  if (route.provider !== 'default' && !this.providers.has(route.provider)) {
    throw new Error(`The ${route.key} setting names provider "${route.provider}", which is not configured.`);
  }
  return this.chain(req, route.provider === 'default' ? undefined : route.provider);
}
```
(`fallbackFromRoute` is internal, read only by `noteUsage`. In implementation it becomes a private parameter of `chain()` rather than a request field, so nothing new can leak into a request.)

**6b. `categoryChat()`: unchanged contract (code repair), plus the foreground gate and guards.**

Before (116–121):
```typescript
const named = this.namedOnly.get(route.provider);
if (named) return await this.callNamed(route.provider, named, routed);
…
return await this.chat(routed, route.provider === "default" ? undefined : route.provider);
```
After:
```typescript
const named = this.namedOnly.get(route.provider);
if (named) { await this.backgroundWaits(routed); return await this.callNamed(route.provider, named, routed); }
…
return await this.chain(routed, route.provider === "default" ? undefined : route.provider);
```
`categoryChat` keeps applying the category's default time limit and token cap: code repair relies on them (`coding` 300 s / 16k).

**6c. `callNamed()`: guard and capabilities like any provider.**
```typescript
private async callNamed(name, provider, request) {
  request = redactRequest(request);
  const refused = this.refusal(name, provider, request);
  if (refused) { this.noteUsage(request, name, Date.now(), false, false, false, undefined, refused); throw refused; }
  …unchanged try/catch, plus guardFor(name).noteSuccess()/noteFailure(err)…
}
```

**6d. `streamChat()`: a configured conversation route streams from its provider.**

Before (246–281): streams from `providerName || this.primary`; on a failure before the first piece, answers once through `chat()`.

After:
```typescript
async *streamChat(request: ILLMRequest, providerName?: string): AsyncGenerator<string, void, unknown> {
  const route = providerName ? undefined : this.configuredRoute(request);
  if (!route) { yield* this.primaryStream(request, providerName); return; }       // today's body, unchanged
  const named = this.namedOnly.get(route.provider);
  const name = named ? route.provider : (route.provider === 'default' ? this.primary : route.provider);
  const provider = named ?? this.providers.get(name);
  const req = { ...request, model: route.model };
  if (!provider || typeof (provider as { streamChat?: unknown }).streamChat !== 'function') {
    // Cannot stream: one non-streamed answer through the configured route (with its fallback rule).
    const r = await this.routedChat(route, request); if (r.content) yield r.content; return;
  }
  let yielded = false;
  try {
    if (named) await this.backgroundWaits(req);
    for await (const piece of this.streamFrom(name, provider, req)) { yielded = true; yield piece; }   // guard, capabilities, usage
  } catch (err) {
    if (yielded || request.signal?.aborted || STRICT_CATEGORIES.has(route.category)) throw err;
    console.warn(`[ModelRouter] ${route.key} stream failed before any text; answering with the default model.`);
    yield* this.primaryStream(request);                                            // today's path
  }
}
```
`primaryStream()` is today's `streamChat()` body, moved without changes except the guard/capability check before the provider is asked. `streamFrom()` is the shared "guard → capability → stream → usage record" step.

**6e. Helpers.**
```typescript
private guards = new Map<string, ProviderGuard>();
private guardFor(name: string): ProviderGuard { … one ProviderGuard per name, per router … }

/** Capabilities a provider declared; undefined = none declared (nothing enforced). */
capabilitiesOf(name: string): ProviderCapabilities | undefined { … }

/** Why this provider must not get this request, or undefined. */
private refusal(name: string, provider: ILLMProvider, req: ILLMRequest): Error | undefined {
  const caps = provider.capabilities?.();
  if (caps) {
    if (!caps.imageInput && hasImagePart(req)) return new Error(`Provider "${name}" cannot take this request: no image input.`);
    if (!caps.toolCalling && req.tools?.length) return new Error(`Provider "${name}" cannot take this request: no tool calling.`);
  }
  try { this.guardFor(name).check(!caps?.ownBreaker); } catch (err) { return err as Error; }
  return undefined;
}
```
`hasImagePart` looks for content parts of type `image`, `image_url` or `input_image`.

**6f. `noteUsage()`:** adds `agentRole` when present, and `fallbackUsed: true` for a call answered after a route's fallback. Nothing else changes.

**Reason:** G0-01, G0-03, G0-04, G0-07, G0-08. With no route configured, the only new step on today's path is `refusal()`. For the Gemini/Groq client it does nothing by default: no capability is violated by today's requests, `ownBreaker` skips the router breaker, and there is no RPM unless set.

---

### Change 7 — Claude declares its capabilities (PROTECTED)

**File:** `bridge/anthropicProvider.ts` · after line 134 (`isConfigured`)

Before: no `capabilities()`.

After:
```typescript
/** What this adapter passes through today (images are not translated yet: refused, not dropped). */
capabilities(): ProviderCapabilities {
  return { streaming: true, toolCalling: true, structuredOutput: false, imageInput: false, audioInput: false,
           audioOutput: false, webSearch: false, reportsUsage: true, reportsStreamUsage: true,
           cancellation: true, ownBreaker: false };
}
```
`textOf()` is **not** changed. The router now refuses image requests before they reach it, so its silent drop can no longer happen through the router. Adding real image support to this adapter is a 1B/Phase 5 item.

---

### Change 8 — OpenAI-compatible fallback declares its capabilities (not protected)

**File:** `bridge/openaiProvider.ts` · after line 40

```typescript
capabilities(): ProviderCapabilities {
  return { streaming: false, toolCalling: true, structuredOutput: false, imageInput: false, audioInput: false,
           audioOutput: false, webSearch: false, reportsUsage: true, reportsStreamUsage: false,
           cancellation: true, ownBreaker: false };
}
```

---

### Change 9 — agents pass their role (PROTECTED: `core/agents/*`)

**File:** `core/agents/agentManager.ts` · **Line:** 1248 (one line)

Before:
```typescript
const response = await this.manager.withLlmSlot(this.task, () => modelRouter.chat({ ...request, signal: this.signal, category: request.category ?? 'planning' }));
```
After:
```typescript
const response = await this.manager.withLlmSlot(this.task, () => modelRouter.chat({ ...request, signal: this.signal, category: request.category ?? 'planning', agentRole: this.agent.role }));
```
No permission, spawn limit, budget or tool list changes. Without `JARVIS_MODEL_AGENT_<ROLE>` the call routes exactly as today.

**Reason:** G0-06. Each of the seven specialists, and the worker roles, can now be given its own model.

---

### Change 10 — configuration docs and Git ignore (not protected)

- `.gitignore`: add `data/usage/` next to `data/repairs/` (line 94).
- `.env.example`, section "Model per kind of work" (lines 60–71): document `JARVIS_MODEL_AGENT_<ROLE>` (example `JARVIS_MODEL_AGENT_QA_AGENT=anthropic:claude-sonnet-5-5`), `JARVIS_PROVIDER_<NAME>_RPM`, `_BREAKER_429S`, `_BREAKER_MS`, `JARVIS_USAGE_LEDGER=off`, and that a configured non-strict kind falls back to the default model. These are comments only, with no values filled in.

---

## Files That Will Change

| File | Protected? | Change |
|---|---|---|
| `bridge/llmTypes.ts` | No | Change 1: optional `agentRole`, `ProviderCapabilities`, optional `capabilities()` |
| `bridge/modelCategories.ts` | No | Change 2: agent route keys, explicit-limit flags, strict set, ledger hooks |
| `bridge/groqProvider.ts` | **Yes** | Change 3: state object, opt-in isolated state, `capabilities()` |
| `bridge/providerGuard.ts` | No (new) | Change 4 |
| `bridge/usageLedger.ts` | No (new) | Change 5 |
| `bridge/modelRouter.ts` | **Yes** | Change 6 |
| `bridge/anthropicProvider.ts` | **Yes** | Change 7: `capabilities()` only |
| `bridge/openaiProvider.ts` | No | Change 8 |
| `core/agents/agentManager.ts` | **Yes** | Change 9: one line |
| `.gitignore`, `.env.example` | No | Change 10 |
| `tests/modelRoleRoutingTest.ts`, `tests/providerIsolationTest.ts`, `tests/providerCapabilitiesTest.ts`, `tests/usageLedgerTest.ts` | `tests/` is protected by the owner's rule | **new files only**; no existing test is edited |
| `tests/boundary-doubles.json` | `tests/` | only if the runner requires the new tests' stand-ins to be listed (as `571b6d2` did); additions only |

**Not changed:** `core/orchestrator.ts`, `core/reflectionEngine.ts`, `core/goalPlanner.ts`, `core/goalVerifier.ts`, `core/codeRepair.ts`, `jarvis.ts`, anything in `security/`, `core/toolRegistryV2.ts`, the approval gate, self-healing, voice.

---

## Tests

### New tests (written first; each must fail on the unchanged code)

**`tests/modelRoleRoutingTest.ts`** — routing at the real call sites:
1. No `JARVIS_MODEL_*`: `chat()` and `streamChat()` with each of the six categories reach the primary stub with the request's own model (backward compatibility).
2. `JARVIS_MODEL_PLANNING=alt:m2` with `alt` registered: `chat({category:'planning'})` reaches `alt` with `m2`; the usage record says `alt`/`m2`/`planning`. *(Fails today: it reaches the primary.)*
3. `JARVIS_MODEL_CONVERSATION=named:m3` (a named stub): `streamChat()` streams from it; the record is `streamed: true`. *(Fails today.)*
4. A configured conversation provider that fails falls back to the primary; `fallbackUsed: true`; the reply still arrives.
5. A configured `review` provider that fails throws (strict), and the primary is never called.
6. An explicit `chat(req, 'x')` ignores any route.
7. An abort during a routed call rejects with AbortError, with no fallback call.
8. A bare model name (`JARVIS_MODEL_PLANNING=other-model`) keeps the default provider and sends `other-model`.
9. Time limit and token cap: applied only when `_TIMEOUT_MS` / `_MAX_TOKENS` are set.
10. **Call sites, not just the router:**
    - The real orchestrator, through `tests/scenarios/harness.ts`, with `JARVIS_MODEL_PLANNING` set: a planned request reaches the configured stub.
    - The real `AgentManager` (as `agentRuntimeTest` builds one) with roles `coding_agent` and `qa_agent` whose scripted behaviour calls `ctx.llm()`, with `JARVIS_MODEL_AGENT_CODING_AGENT=a:c` and `JARVIS_MODEL_AGENT_QA_AGENT=b:q`: each call reaches its own stub, and each usage record carries its `agentRole`. *(Fails today: both reach the primary.)*
11. `agentIndependence()`: false when both agent settings resolve to the same provider and model; true when they differ.
12. Background wait: a named-route call made inside a background agent while a conversation is active waits (`foregroundGate` stand-in), and a foreground call does not. *(Fails today for named providers.)*

**`tests/providerIsolationTest.ts`**:
1. Two `new GroqProvider({ isolatedState: true })` instances with a fake `fetch`: two 429s open A's breaker; B still sends; the default `groqProvider` is unaffected. *(Fails today: shared statics.)*
2. Default instances still share state, and resetting `GroqProvider.isCircuitBroken` on the class still resets them (the legacy path the existing tests use).
3. Router guard: a stub without `ownBreaker` returning 429 twice is skipped on the third call, which fails over to a second stub without calling the first. After `JARVIS_PROVIDER_<NAME>_BREAKER_MS` (set to 50 ms in the test), one trial call goes through.
4. A 503 or network error does not open the breaker; an aborted call does not either.
5. `JARVIS_PROVIDER_STUB_RPM=2`: the third call within a minute is skipped, and the guard error classifies as `rate_limit`.
6. Guards are per router: a new `ModelRouter` starts closed.

**`tests/providerCapabilitiesTest.ts`**:
1. `anthropicProvider.capabilities().imageInput === false`; `groqProvider` and `openaiProvider` declare theirs.
2. An image request through a router whose only provider declares `imageInput: false` is refused with "no image input", and the provider's `chat` is never called. *(Fails today: the Claude adapter drops the image and sends the text.)*
3. Failover skips the incapable provider and reaches a capable one.
4. A stub with no `capabilities()` is still called with images and tools (unknown is not "no").
5. Tools to a provider declaring `toolCalling: false` are refused.

**`tests/usageLedgerTest.ts`**:
1. One call: one line in `<data root>/data/usage/model_usage.jsonl` with only the `UsageRecord` keys (no `messages`, `content` or `prompt`).
2. Restart: a child process with the same `JARVIS_DATA_ROOT` sees the earlier records in `usageLog()`/`usageSummary()`. *(Fails today.)*
3. An error text containing a fake key is stored redacted.
4. Rotation at the size limit; at most 10 rotated files are kept. The limit is lowered only through a test-only constructor parameter, not an env var the owner could mistype.
5. Malformed lines are skipped.
6. `JARVIS_USAGE_LEDGER=off` writes nothing.
7. A ledger that cannot be written (a read-only directory) does not fail the model call.

### Commands (through the runner only)

```powershell
pnpm run typecheck
pnpm test -- --only=modelRoleRoutingTest,providerIsolationTest,providerCapabilitiesTest,usageLedgerTest
pnpm test -- --only=modelRoutingTest,providerFailoverTest,claudeProviderTest,llmClientBehaviourTest,llmCancellationTest,providerHealthTest,healthStatusTest,llmTimingTest,llmProviderConfigTest,foregroundPriorityTest,noGroqForLocalCommandsTest,backgroundResearchTest,sevenAgentTest,agentSpecialistsTest,agentRuntimeTest,codeRepairTest,secretSinksTest,redactionTest,promptInjectionFlowTest,docsHygieneTest
pnpm test -- --only=nodeBridgeSingletonTest,voiceRouteMockTest,interruptGatingTest,openAppSmokeTest,latencySmokeTest,deterministicCommandRouteTest
pnpm test -- --ci
```

**Running them here needs one approval:** the cloud clone has no `tsx`/`typescript`. `pnpm install --frozen-lockfile` installs exactly what `pnpm-lock.yaml` already lists: no new dependency, and the lockfile is unchanged. Without it, the tests can only run on your PC.

**Baseline first:** before any change, the full `pnpm test -- --ci` and `typecheck` run on `c4ac909` and their counts are recorded. An existing test that already fails is reported, not fixed in this run.

---

## Live Verification Required?

- [x] Yes. No voice code changes, but every LLM reply passes through the router. On your PC, after the tests pass:
  1. With **no new settings**, start JARVIS and say "hello" and one tool command ("open notepad"). Expect the same replies and timing as now, and `[LLM usage]` lines as now.
  2. Check that `data\usage\model_usage.jsonl` appears (CMD: `dir data\usage`).
  3. Restart JARVIS and ask for a self-check. Nothing should change (usage is not yet shown anywhere; Phase 7).
- [ ] Not required: Windows control, browser, microphone. No change there.

---

## Risk Assessment

| Risk | Likelihood | How it would show | Mitigation |
|---|---|---|---|
| An existing `JARVIS_MODEL_*` line in your `.env` starts taking effect | Medium (the lines are documented in `.env.example`) | replies from another model | check before deploying, CMD: `findstr /B "JARVIS_MODEL_" .env` (prints only those lines; values are model names) |
| The configured conversation provider is slower or fails | Low until 1B | slower voice replies | non-strict fallback to today's model; leave conversation unconfigured until 1B |
| The router's new step changes timing on the hot path | Low | `latencySmokeTest`, `endToEndLatencyTest` | `refusal()` is in-memory checks only |
| Shared-state shim mis-wired | Low | Groq/Gemini breaker tests fail | the existing breaker tests run unchanged; new isolation test |
| Claude breaker opens on a real quota limit | Medium | "anthropic rate-limited locally" in the log, failover answers | intended; tunable `JARVIS_PROVIDER_ANTHROPIC_BREAKER_429S` / `_MS` |
| Code repair now waits for a live conversation | Low | repair starts up to 20 s later | intended (PERF-02); `JARVIS_BACKGROUND_YIELD_MS` |
| Ledger write fails (disk full, permissions) | Low | one warning; the call works | `appendUsage` never throws |
| Ledger grows on the HDD | Low | at most about 22 MB (11 files × 2 MB) | rotation |
| Test stubs that replace `modelRouter.chat` bypass routing | Certain | none (by design) | the new test uses the real router and real call sites |
| A second, competing routing system | — | — | none added: same `routeFor()`, same `categoryChat()`; `chat()` uses them |

---

## Rollback

Nothing is committed until you approve.

- **Before commit:** restore the four protected and four other modified files to `c4ac909`, then delete the two new bridge files and the four new tests. I will list the exact commands and ask before running any of them, since they discard work.
- **After an approved commit:** `git revert <commit>` adds a new commit that undoes it; history is not rewritten.
- **At runtime, without code changes:**
  - Remove the `JARVIS_MODEL_*` / `JARVIS_MODEL_AGENT_*` lines to get today's routing.
  - `JARVIS_USAGE_LEDGER=off` stops the file.
  - `JARVIS_PROVIDER_<NAME>_BREAKER_429S=1000` effectively disables a breaker.
- **Data:** `data\usage\` only holds derived records and can be deleted safely. No other data file changes.

## Order of work in Stage 04 (after approval)

1. `pnpm install --frozen-lockfile` (only if you approve it), then record the baseline.
2. Write the four new tests and run them on the unchanged code. They must fail; record the output.
3. Change 1, 2, 4, 5, 8, 10 (not protected). Typecheck.
4. Change 3, then 7, then 6, then 9, each only if approved. Run the new and existing groups after each.
5. Run the full `--ci` suite and typecheck, then update the tracker and write `change_log.md` and `verification.md`.
6. An independent review (05b), not by the session that wrote the code.
7. Stop and report. No commit or push without your approval.

---

## Approval

**Status:** [x] Awaiting human approval, per change

| Change | File | Protected | Approved |
|---|---|---|---|
| 1 | `bridge/llmTypes.ts` | No | [ ] |
| 2 | `bridge/modelCategories.ts` | No | [ ] |
| 3 | `bridge/groqProvider.ts` | **Yes** | [ ] |
| 4 | `bridge/providerGuard.ts` (new) | No | [ ] |
| 5 | `bridge/usageLedger.ts` (new) | No | [ ] |
| 6 | `bridge/modelRouter.ts` | **Yes** | [ ] |
| 7 | `bridge/anthropicProvider.ts` | **Yes** | [ ] |
| 8 | `bridge/openaiProvider.ts` | No | [ ] |
| 9 | `core/agents/agentManager.ts:1248` | **Yes** | [ ] |
| 10 | `.gitignore`, `.env.example` | No | [ ] |
| Tests | 4 new files in `tests/` (no existing test edited) | `tests/` rule | [ ] |
| Install | `pnpm install --frozen-lockfile` in the cloud clone | — | [ ] |
| Exception | Reproduction INFERRED; fail-before shown at the start of Stage 04 | — | [ ] |

> Not implemented until the owner approves. Silence, a report, a test result or an automated agent is never approval.

Human approval recorded: [x] Yes — Date: 2026-11-15
Owner's words: "I approve the proposed changes to these four files, strictly within the scope described in patch_plan.md" (groqProvider, modelRouter, anthropicProvider, agentManager); "Approved: four new test files"; "Approved: pnpm install --frozen-lockfile, provided it uses the existing lockfile"; reproduction exception "Approved only with this sequence: add the new tests, run them against unchanged production code, record the failures, implement, run the same tests again"; "You have conditional approval to begin Phase 1A."
Changes 1, 2, 4, 5, 8, 10 (not protected) were covered by that approval of Phase 1A within the plan's scope.
