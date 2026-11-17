# Gap closure plan (stage 03, Gate 1): P4, P7, P9, P3, N1, N2

> Plan only. No source file has been edited for this plan. Base: `c4ac909` plus the uncommitted Phase 1A work (`FINAL_APPROVAL_REPORT.md`).
> Approval needed before stage 04: your "approved" / "proceed", plus answers to the decisions in §9.

## 0. Rules re-read

| Rule source | What it requires here |
|---|---|
| `ai_workflows/CLAUDE.md` stage order | 02 diagnosis, 02b reproduction, 03 plan, then **Gate 1**, 04 implementation, 05 verification, 05b independent review, 06 report. No implementation before Gate 1 |
| `ai_workflows/CLAUDE.md` approval points | Any edit to a protected runtime file needs approval |
| `stages/03_patch_plan/CONTEXT.md` | Exact before/after per file, protected files marked, tests via the runner, PC verification stated, risks, approval recorded |
| `_config/RUNTIME_PROTECTED_FILES.md` | Protected here: `bridge/modelRouter.ts`, `bridge/groqProvider.ts`, `bridge/anthropicProvider.ts`, and all of `core/agents/*` |
| Your latest message | Focused regression tests, failing on the original code first. No weakened assertions, no test changed just to pass. Full suite. Blocked and skipped reported separately. Fresh review of the final source; High and Medium resolved; re-review after any later source change |

## 1. Files in scope (★ = protected; needs your approval)

| File | P3 | P4 | P7 | P9 | N1 | N2 |
|---|---|---|---|---|---|---|
| ★`bridge/modelRouter.ts` | ✔ | ✔ | | | | ✔ |
| ★`bridge/groqProvider.ts` | ✔ | | | | | |
| ★`bridge/anthropicProvider.ts` | ✔ | | | | | |
| `bridge/openaiProvider.ts` | ✔ | | | | | |
| `bridge/llmTypes.ts` | ✔ | | | | | |
| `bridge/modelCategories.ts` | | ✔ | | | | ✔ |
| ★`core/agents/agentManager.ts` | | ✔ | | ✔ | ✔ | |
| ★`core/agents/agentContextApi.ts` | | | | ✔ | ✔ | |
| ★`core/agents/behaviors/toolLoop.ts` | | ✔ | | ✔ | ✔ | |
| ★`core/agents/behaviors/common.ts` | | | | ✔ | | |
| ★`core/agents/behaviors/research.ts` | | | | ✔ | | |
| ★`core/agents/specialists.ts` | | ✔ (QA wording only) | | | | |
| ★`core/agents/behaviors/verify.ts` | | | ✔ | | | |
| ★`core/agents/jarvisAgents.ts` | | | ✔ | | | |
| `core/goalVerifier.ts` | | | ✔ | | | |
| `.env.example`, tracker, run record | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |

Not touched: the approval gate, risk engine, tool registry, tool permissions, `pnpm-lock.yaml`, `package.json`, and every tracked test.

## 2. Diagnosis and reproduction, per issue

### P3: in-adapter model switching on strict routes

**Root cause.**
- `groqProvider.ts:181-183` (`startModel`) starts on the fast model while the requested model is cooling down.
- `:390-397` (and `:505-512` for streams) retries a 429 once on the fast model.
- `:239` keys the response cache by the *requested* model, so a cached reply from a swapped call can come back for a later request.
- `anthropicProvider.ts:179-187` sends `fallbacks: 'default'` unless `JARVIS_ANTHROPIC_FALLBACKS=off`.
- No adapter returns the model the server actually used: `ILLMResponse` (`llmTypes.ts:64-74`) has no model field. So the router can't verify identity.
- `openaiProvider.ts:74` always sends `JARVIS_FALLBACK_MODEL`, whatever model a strict `openai:<x>` route names.

**Reproduction.** These swaps run whenever their condition holds, and they don't depend on the route. The first test step of stage 04 shows a strict route answered after a 429 by the fast model (current code), and the same for a cooldown, the cache, Claude fallbacks and `openai:<x>`.

### P4: independent QA not enforced

**Root cause.**
- No runtime caller of `agentIndependence()` / `observedAgentIndependence()`.
- Nothing knows which model actually answered (see P3).
- QA's role text says "independently" (`specialists.ts:110`, `:171`).

**Reproduction.** Final reviewer, verdict (b): QA on the same model as coding runs and completes, and nothing marks it.

### P7: unverified counted as verified

**Root cause.**
- `verify.ts:144-149`: a re-read that didn't run is `ok: true`; the catch path also cuts the reason to 120 characters.
- `verdictOf` (`:90-94`) returns "verified" when every check is `ok`.
- `goalVerifier.ts:91-99` counts every verdict except `issues` as met.
- `verify.ts:121`: a source with no licence "matches" any stated licence.
- `jarvisAgents.ts:202` mentions only `issues` aloud.

**Reproduction.** `proposals/verificationInconclusiveTest.ts.proposal`: 5 passed, 6 failed on the current code. With GitHub returning 503, the result is "Verified: 8 checks passed".

### P9: coding-agent research path

**Root cause.**
- `specialists.ts:85-91` sends GitHub-research requests from `coding_agent` to `githubResearchAgent`.
- Model calls there go through `askJson` (`common.ts:59-84`), which catches every non-abort error (including `StrictRouteError`), keeps 120 characters, and answers by rules. It does the same when the model's answer can't be parsed.
- Its workers (`repo_discovery_worker`, `repo_code_analysis_worker` → `project_deep_analysis_worker`, which calls the model at `research.ts:167`) don't inherit the coding route.
- `waitWithRetry` (`research.ts:76-92`) re-runs a failed child.
- A failed analysis child leaves the parent COMPLETED with "No GitHub candidates".

**Reproduction.** Final reviewer probe P6 and last reviewer probe: COMPLETED through rules after the strict coding model failed.

### N1: helper inheritance validation

**Root cause.**
- Inheritance comes from task input (`toolLoop.ts` `INHERIT_ROUTE`), checked only by helper role.
- The `parentAgentId` check never rejects, because root specialists have `parentAgentId: 'jarvis'` (`agentManager.ts:232`).
- A helper can't look up its parent's role, because `AgentContext` gives no access to the registry.

**Reproduction.** Last reviewer probe B8: a non-QA parent spawned `test_runner_worker` with the key set to `qa_agent`, and the helper ran on QA's model.

### N2: configuration-level independence ignores failover

**Root cause.** `agentIndependence()` (`modelCategories.ts:225-240`) takes one target per agent. An unconfigured (non-strict) agent can be answered by every provider in the failover order (`modelRouter.ts` `failoverOrder`, `chain`), and `openai` always sends `JARVIS_FALLBACK_MODEL`.

**Reproduction.** Last reviewer: coding unset, QA on `openai:…`, `independent=true`, although coding can fail over to that same model.

## 3. P3: exact changes (strict model identity)

**Target behaviour on a strict route:**
- the adapter sends exactly the route's model, with no fast-model swap, no cooldown start, no cached reply from another model, and no Claude fallbacks;
- the adapter reports the model the server says it used;
- the router accepts the reply only when that identity is reported and matches; otherwise it raises `StrictRouteError` ("model identity not confirmed: asked X, provider reported Y" / "…reported none"). There is no fallback (fail closed).

Non-strict calls are unchanged.

`bridge/llmTypes.ts`
```diff
 export interface ILLMRequest {
   …
   routeAs?: string;
+  /**
+   * Set by the router for a strict route: send exactly `model`. The adapter must not
+   * swap models (fast model, cooldown, cache from another model, server-side fallbacks).
+   * Never sent to a provider.
+   */
+  exactModel?: boolean;
 }
 export interface ILLMResponse {
   content: string;
   …
+  /** The model the provider reports it used, as reported; undefined when it reports none. */
+  model?: string;
 }
 export interface ILLMProvider {
   …
+  /** Model ids the provider treats as `requested` (e.g. Claude's alias and its dated id), lower case. */
+  modelIdentities?(requested: string): Promise<string[]> | string[];
 }
```

★`bridge/groqProvider.ts`
```diff
-  private startModel(requested: string, fastModel: string): string {
-    return this.coolingDown(requested) && !this.coolingDown(fastModel) ? fastModel : requested;
+  private startModel(requested: string, fastModel: string, exact = false): string {
+    if (exact) return requested;   // strict route: never another model
+    return this.coolingDown(requested) && !this.coolingDown(fastModel) ? fastModel : requested;
   }
@@ _chatInternal (and the same in _streamInternal)
-    let currentModel = this.startModel(sanitizeModel(request.model || llmConfig.model), fastModel);
+    let currentModel = this.startModel(sanitizeModel(request.model || llmConfig.model), fastModel, request.exactModel === true);
@@ 429
-        if (usedFastModelFor429 || currentModel === fastModel) throw lastError;
+        if (request.exactModel || usedFastModelFor429 || currentModel === fastModel) throw lastError;
@@ result
-      const result: ILLMResponse = { content, usage };
+      const result: ILLMResponse = { content, usage, ...(typeof data?.model === 'string' ? { model: data.model } : {}) };
@@ tool-call return
-        return { content: "", tool_calls: toolCalls, usage };
+        return { content: "", tool_calls: toolCalls, usage, ...(typeof data?.model === 'string' ? { model: data.model } : {}) };
@@ hashRequest
-      model: req.model ?? llmConfig.model,
+      model: req.model ?? llmConfig.model,
+      exact: req.exactModel === true,
```
- The cache is then keyed per exact/non-exact request, and a cached result keeps its reported `model`.
- Streams: the router doesn't stream strict routes (see the router change), so `_streamInternal` gets only the two swap guards.

★`bridge/anthropicProvider.ts`
```diff
@@ params()
-    const fallbacks = (this.env['JARVIS_ANTHROPIC_FALLBACKS'] ?? '').trim().toLowerCase() !== 'off';
+    // A strict route needs exactly this model: no server-side fallback models.
+    const fallbacks = !request.exactModel && (this.env['JARVIS_ANTHROPIC_FALLBACKS'] ?? '').trim().toLowerCase() !== 'off';
@@ validateModel: keep the id the API returns
-    p = this.api().models.retrieve(model).then(() => undefined, (err) => {
+    p = this.api().models.retrieve(model).then((info) => { if (info?.id) this.canonical.set(model, String(info.id)); }, (err) => {
+  modelIdentities(requested: string): string[] {
+    return [requested, this.canonical.get(requested)].filter((x): x is string => !!x).map((x) => x.toLowerCase());
+  }
@@ fromAnthropicMessage
-  return { content: …, …usage };
+  return { content: …, …usage, ...(typeof msg.model === 'string' ? { model: msg.model } : {}) };
```

`bridge/openaiProvider.ts`
```diff
     return {
       content: message.content ?? '',
+      ...(typeof res.data?.model === 'string' ? { model: res.data.model } : {}),
```

★`bridge/modelRouter.ts`
- **`routedChat` / `categoryChat` / `callNamed`:** for a strict route, send `{ ...req, exactModel: true }` and confirm the identity before returning.
  ```diff
  +  /** A strict route's reply must come from the route's model, as the provider reports it (fail closed). */
  +  private async confirmIdentity(name: string, provider: ILLMProvider, sentModel: string, res: ILLMResponse): Promise<void> {
  +    const norm = (m: string) => m.trim().toLowerCase().replace(/^models\//, '');
  +    if (!res.model) throw new Error(`model identity not confirmed: asked ${name} for ${sentModel}; it did not report which model answered`);
  +    const accepted = new Set([norm(sentModel), ...((await provider.modelIdentities?.(sentModel)) ?? []).map(norm)]);
  +    if (!accepted.has(norm(res.model))) throw new Error(`model identity not confirmed: asked ${name} for ${sentModel}; it answered with ${res.model}`);
  +  }
  ```
  It runs inside the existing `try`, so a mismatch becomes a `StrictRouteError` carrying the reason, with no fallback.
- **`openai:<x>` on a strict route** where `x` differs from `JARVIS_FALLBACK_MODEL`: refused before sending, with "openai sends JARVIS_FALLBACK_MODEL (<y>), not <x>".
- **`streamChat`:** a strict route is answered through `routedChat` (one piece, after the identity check) instead of streaming, so no text from an unconfirmed model is ever shown.
- **`noteUsage`:** records the reported model (`servedModel`) when known. P4 uses this.

## 4. P9 + N1: route inheritance by lineage (replaces the task-input key)

**Target behaviour:**
- Every agent below a specialist whose route is strict (a configured `coding_agent` or `qa_agent`) uses that route: children, grandchildren, research workers included.
- The manager decides this from the registry (who spawned whom), never from task input, so N1 can't be forged.
- On such an agent, `askJson` never answers by rules: a model failure, an unusable answer or a used-up budget ends the task FAILED with the full reason.
- A model failure in a child fails the strict parent.
- Agents without their own setting are unchanged.

★`core/agents/agentManager.ts`
```diff
+  /** The nearest role, this agent or an ancestor below JARVIS, whose route is configured and strict; undefined otherwise. */
+  strictRouteRole(agent: AgentRecord): string | undefined {
+    for (let cur: AgentRecord | undefined = agent; cur && cur.agentId !== JARVIS_AGENT_ID; cur = cur.parentAgentId ? this.registry.get(cur.parentAgentId) : undefined) {
+      if (routeFor('planning', process.env, cur.role).strict && cur.permanent) return cur.role;
+    }
+    return undefined;
+  }
@@ TaskContext.llm
-    const response = await this.manager.withLlmSlot(this.task, () => modelRouter.chat({ ...request, signal: this.signal, category: request.category ?? 'planning', agentRole: this.agent.role }));
+    const routeAs = this.strictRouteRole();
+    const response = await this.manager.withLlmSlot(this.task, () => modelRouter.chat({ ...request, signal: this.signal, category: request.category ?? 'planning', agentRole: this.agent.role, ...(routeAs && routeAs !== this.agent.role ? { routeAs } : {}) }));
+  strictRouteRole(): string | undefined { return this.manager.strictRouteRole(this.agent); }
@@ run catch: a model failure keeps a code of its own
-        error = { code: 'AGENT_ERROR', message: errorMessage(err) };
+        error = { code: MODEL_FAILURES.has((err as Error)?.name) ? 'MODEL_UNAVAILABLE' : 'AGENT_ERROR', message: errorMessage(err) };
+// MODEL_FAILURES = StrictRouteError, QueueWaitTimeoutError, ModelUnavailableError, IndependentQaUnavailableError
```
The registry is used only while the run's agents are alive, which they are during `llm()`.

★`core/agents/agentContextApi.ts`
```diff
+  /** The strict route this agent's model calls use (its own or an ancestor's), if any (owner, 2026-11-15). */
+  strictRouteRole(): string | undefined;
```

★`core/agents/behaviors/toolLoop.ts`
- Remove `INHERIT_ROUTE`, `HELPER_OF`, `inheritedRole`, the `routeAs` field in `runLoop`, the `input` passed at spawn, and the `modelInput` filter.
- `strictRouteRole(ctx)` becomes `ctx.strictRouteRole()`.
- `needsModel` and the split-path check stay the same.

★`core/agents/behaviors/common.ts` (`askJson`)
```diff
+  const strict = ctx.agent.role === 'qa_agent' || ctx.strictRouteRole() !== undefined;
   try { … const value = accept(…); if (value !== undefined) return { value, viaModel: true };
-    note = 'the model\'s answer was not usable';
+    if (strict) throw modelUnavailable(`the configured model's answer was not usable`);
+    note = 'the model\'s answer was not usable';
   } catch (err) {
     if (isAbort(err)) throw err;
+    if (strict) throw err instanceof Error && err.name === 'ModelUnavailableError' ? err : modelUnavailable(String((err as Error)?.message ?? err), err);
     note = …
```
(`modelUnavailable(msg, cause)` builds an `Error` named `ModelUnavailableError` and keeps the full message and `cause`. `BudgetExceededError` passes through unchanged so the manager keeps its budget code.)

★`core/agents/behaviors/research.ts`
- `waitWithRetry`: also skip a retry for `MODEL_UNAVAILABLE`, next to `DEPENDENCY_FAILED` / `BUDGET_EXCEEDED`. Re-asking a failed strict model is not done.
- `repoCodeAnalysisWorker` and `githubResearchAgent`: if `ctx.strictRouteRole()` is set and any child ended with `MODEL_UNAVAILABLE`, throw `ModelUnavailableError` naming the child and its reason. Otherwise unchanged; a GitHub read error is still only a limitation.

`bridge/modelCategories.ts` / ★`bridge/modelRouter.ts`: `routeAs` handling as now (honoured only for a configured strict route).

## 5. N2 + P4: what each agent can be answered by, and QA enforcement

### N2 (`bridge/modelCategories.ts`, ★`bridge/modelRouter.ts`)
- New router method `possibleTargets(agentRole): { provider, model, exact }[]`:
  - a **strict** route gives one exact target (verified identity after P3);
  - a **non-strict** or unconfigured route gives its own target plus one target per provider in the failover order, with the model that provider would really send (`modelFor`; `openai` → `JARVIS_FALLBACK_MODEL`; named-only providers excluded, since failover never reaches them).
- `agentIndependence(env, targets?)` compares every coding target with every QA target using `sameModelPossible`. Two different models on the Gemini/Groq client count as independent only when **both** are exact (strict, identity-verified). Called without targets, it keeps today's one-target behaviour; the router supplies the full sets.

### P4 enforcement
- **When independent QA is required:** see decision D1, §9. The recommended rule:
  - `JARVIS_QA_REQUIRE_INDEPENDENT=1` requires it;
  - `0` doesn't;
  - unset means required exactly when `JARVIS_MODEL_AGENT_QA_AGENT` is set.
- **Before QA's first model call** (★`toolLoop.ts`, `qa_agent` and its descendants): if required and `agentIndependence(env, router.possibleTargets(...))` isn't independent, throw `IndependentQaUnavailableError`. The message is "independent QA unavailable: <reason>; human review required". The task ends FAILED with code `MODEL_UNAVAILABLE`, and no model is asked.
- **After each QA model reply:** if required, the reply's reported `model` (P3) must be known and outside every coding target. If not, fail the same way. This is the actual-identity check.
- **QA result `data.independence`:** `{ status: 'independent' | 'not_independent' | 'unknown', required, qaModels, codingTargets, reason }`. Only `independent` when required, configured independent, and every reply's identity was confirmed distinct. Never `independent` when not required.
- **★`specialists.ts:110`, `:171`:** "independently" becomes "separately". This is the only wording change.
- **The rule-based Verification agent** (`input.verify`) is untouched by P4 and never labelled independent QA.

## 6. P7: exact changes

As in `proposals/PROPOSALS_ITEMS_2_3.md` item 3, plus the L4 additions:
- `verify.ts`: `inconclusive` checks and verdict, the full reason kept, the summary "Not fully verified; needs review: …". A source with no licence against a stated licence becomes inconclusive (the worker returns `licenceKnown: false`).
- `jarvisAgents.ts`: `?` marker in the console report, and "needs your review" in the spoken completion.
- `goalVerifier.ts`: anything other than `verified` / `issues` gives needs review, never met.

## 7. Tests

Every new test is written first and run twice before its fix, through the runner: on the current tree, and on the extracted original `c4ac909` copy. Each must fail there (or crash because a symbol is missing) and pass after the fix.

| New test | Covers | Main checks |
|---|---|---|
| `tests/strictModelIdentityTest.ts` (P3) | the adapters plus the router | • strict Gemini/Groq route: a 429 does not move to the fast model (StrictRouteError, the fast model never asked); no cooldown start on the fast model; a cached reply from another model is not returned<br>• non-strict: fast-model retry unchanged<br>• Claude strict: no `fallbacks` in the body; non-strict: still on<br>• reported model kept on the reply<br>• strict reply with no identity: StrictRouteError, no fallback<br>• mismatched identity: StrictRouteError; Claude alias plus dated canonical id accepted<br>• `openai:<x>` ≠ fallback model on a strict route: refused before sending<br>• strict routed stream: no text before identity confirmed |
| `tests/lineageInheritanceTest.ts` (P9, N1) | the agent manager, the research flow | • configured coding agent, research request ("Find TypeScript libraries for Chrome DevTools Protocol"): the query writing and the deep-analysis worker use the coding model; model fails, so FAILED, no rules, the default model never asked, no retry of the failed worker<br>• model ok: COMPLETED<br>• unusable JSON from the strict model: FAILED<br>• unconfigured: research flow unchanged<br>• N1: forged `inheritModelRoute` (now ignored) on a root task and on a non-QA parent's `test_runner_worker` (B8): no inheritance; a grandchild of a strict parent inherits |
| `tests/independentQaTest.ts` (P4, N2) | router targets, `toolLoop` | • required, QA unset or same model (alias, case): FAILED `MODEL_UNAVAILABLE` "independent QA unavailable … human review required", no model asked<br>• required, distinct strict models: COMPLETED, `independence.status === 'independent'`<br>• required, but the reply reports coding's model, or no model: FAILED<br>• not required: QA runs, status never `independent`<br>• N2: coding unset, QA on a failover provider's model: not independent<br>• two distinct exact models on one Gemini/Groq client: independent; non-exact: not |
| `tests/verificationInconclusiveTest.ts` (P7) | the proposal file plus the L4 additions | • match: verified; contradiction: issues<br>• unreachable: inconclusive with full reason, summary not "Verified"<br>• spawn throws: inconclusive<br>• worker times out: inconclusive<br>• no licence vs stated: inconclusive<br>• goal criterion: `inconclusive` / `unverified` / `not verified` need review, `verified` met, `issues` unmet<br>• spoken completion says review is needed |

**After each fix:**
- its own test plus the related groups:
  - routing: `modelRoutingTest`, `llmClientBehaviourTest`, `claudeProviderTest`, `providerHealthTest`, `llmCancellationTest` and the 10 programme tests;
  - agents: `agentSpecialistsTest`, `sevenAgentTest`, `agentRuntimeTest`, `jarvisAgentIntegrationTest`, `goalAgentIntegrationTest`, `backgroundResearchTest`;
  - verification: `selfHealingHonestyTest`, `replyGoldenTest`.

**At the end:**
- `pnpm run typecheck`, the voice-core group, and `pnpm test -- --ci`;
- per-test verdicts compared with `evidence/baseline-ci.txt`, with blocked and skipped tests listed separately;
- lockfile and `package.json` hashes, `git diff --check`, `git diff --name-only HEAD -- tests` (must be empty).

**Fixture change that needs your approval (decision D2):**
- "Unknown identity fails closed" makes the programme's own stand-in providers (untracked tests I wrote in Phase 1A) fail on strict routes, because they don't report a model.
- Proposed: in those files only, a stand-in that answers a strict route also returns `model: req.model`, as real providers do. No assertion is changed or removed.
- I'll list every such edit, with its diff, in the run record.
- Tracked tests need no change: `modelRoutingTest`'s fake Claude reply already reports `claude-opus-5-5`.

## 8. Risks

| Risk | How it would show | Mitigation |
|---|---|---|
| A live provider reports a model string in another form (e.g. Gemini's OpenAI-compatible API) | every strict call to it fails "identity not confirmed" | Normalisation (case, `models/` prefix); Claude canonical ids; **must be checked live on the PC before relying on strict Gemini/Groq routes** |
| Strict Gemini/Groq calls now fail on a 429 instead of answering with the fast model | more strict failures under rate limits | Intended (fail closed); the error says so |
| Strict Claude calls without server-side fallbacks | a policy refusal ends the call | Intended; the refusal reason is kept |
| QA unavailable when required | QA tasks FAILED "human review required" | Intended; only when required (D1) |
| Research under a strict coding model fails more often | a strict coding agent's research ends FAILED on model trouble | Intended; unconfigured agents are unchanged |
| A goal waits for review on an unreachable source | a goal's `verified` criterion is "needs review" | Intended (P7) |
| The lineage walk in `TaskContext.llm` | extra registry lookups per call | At most depth 4–8 lookups, in memory |

**Live verification on the PC is required** for:
- each provider's reported model string;
- the Gemini/Groq 429 behaviour;
- Claude without fallbacks;
- one strict coding and one strict QA run, a research request, and QA independence with real models.

No voice or Windows-control behaviour changes.

## 9. Decisions needed before stage 04

- **D1 (P4): when is independent QA required?**
  - **Recommended:** `JARVIS_QA_REQUIRE_INDEPENDENT` (1/0). When unset, it is required exactly when QA has its own model setting.
  - **Alternative:** always required. Every QA tool-loop task without a distinct model then fails. That includes unconfigured setups and the tracked tests `agentSpecialistsTest` and `sevenAgentTest`, which run QA on the default model. Those tests would break, and you said not to change tests to pass. So I don't recommend it.
- **D2 (P3): fixture change.** Approve updating the programme's own stand-in providers to report the model they answer with (no assertion change). Without it, "unknown identity fails closed" makes those tests fail.
- **D3 (P9): approach.**
  - **Recommended:** keep the research flow and make it strict-aware with lineage inheritance (§4). This meets "research workers inherit the configured coding model".
  - The earlier proposal (send research to the tool loop) would not keep research workers at all.
- **D4 (P3): identity matching.**
  - Exact after lower-casing and stripping `models/`, plus Claude's canonical id from `models.retrieve`.
  - Any other form (e.g. an undated alias answered with a dated id that `models.retrieve` didn't return) fails closed.
- **D5:** approve edits to the protected files in §1.

## 10. Order of work after approval

1. **P9 + N1:** tests first, then manager lineage, `askJson`, research propagation.
2. **P3:** tests first, then types, adapters, router identity. Then the D2 fixture updates, listed one by one.
3. **N2 + P4:** tests first, then targets, enforcement, QA wording.
4. **P7:** the test from the proposal plus the L4 additions, then `verify.ts`, `jarvisAgents.ts`, `goalVerifier.ts`.
5. Full verification (§7).
6. Fresh independent review of the final source. Fix all High and Medium findings, and re-review whatever source changes after that review.
7. Update `FINAL_APPROVAL_REPORT.md` and the tracker.
8. Stop for your commit decision.

No commit, push or merge. `main` untouched. No Phase 1B.

## Approval (Gate 1)

2026-11-16. Owner: "I approve proceeding with the six approved gap closures."

| Decision | Owner's answer |
|---|---|
| D1 | `JARVIS_QA_REQUIRE_INDEPENDENT`: true means mandatory; false means non-independent QA is allowed but explicitly labelled; unset means mandatory when QA has its own model setting |
| D2 | Approved: actual model identity added to the test stand-ins, with no assertion weakened |
| D3 | Keep the research flow and its workers; strict inheritance and failure propagation |
| D4 | Approved. "Never treat the requested model as evidence of the served model": use the identity the provider reports, and fail closed on strict routes when it is unknown |
| D5 | Protected-file edits listed in §1, limited to the approved scope |

Safeguards and boundaries as in the owner's message: tests before source, failing on the original code; existing tests and assertions preserved; no unrelated refactoring; stop on any unexpected protected file or dependency; no commit, push, merge or Phase 1B.
