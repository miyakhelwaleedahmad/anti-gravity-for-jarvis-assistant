# Diagnosis — Phase 1A

> Stage: 02_diagnosis · read-only · commit `c4ac909` · Linux cloud container (not the owner's PC)

| ID | Root cause | Evidence |
|---|---|---|
| G0-01 | `ModelRouter.chat()` records `request.category` but never calls `routeFor()`. Only `categoryChat()` applies a route, and only `core/codeRepair.ts:144,163` calls it. | `bridge/modelRouter.ts:199-238`; callers `core/orchestrator.ts:1424,1737,1813,2008`, `core/reflectionEngine.ts:206,366`, `core/goalPlanner.ts:140`, `core/goalVerifier.ts:138`, `core/agents/agentManager.ts:1248` |
| G0-08 | `streamChat()` takes `providerName || this.primary` and ignores the category. | `bridge/modelRouter.ts:246-281`; callers `core/orchestrator.ts:1777,1974` |
| G0-07 | `categoryChat()` sends a named provider's call through `callNamed()`, which does not call `backgroundWaits()`. | `bridge/modelRouter.ts:116-117,128-139` vs `:191-201` |
| G0-02 | The breaker, 429 counter, model cooldowns, response cache and in-flight map are `private static` on `GroqProvider`, so every instance would share them. Today only one instance exists (`groqProvider`); tests also create `new GroqProvider()` and reset the statics directly. | `bridge/groqProvider.ts:141-182`; `tests/llmClientBehaviourTest.ts:69-71,175,181`; `tests/providerHealthTest.ts:91-95` |
| G0-03 | `AnthropicProvider` and `OpenAICompatibleProvider` have no breaker; nothing limits requests per provider. A 429 storm on Claude is retried by its SDK (2 retries) on every call. | `bridge/anthropicProvider.ts:139`; `bridge/openaiProvider.ts` |
| G0-04 | `ILLMProvider` is `{ chat() }`; streaming is duck-typed. `AnthropicProvider.textOf()` keeps only `text` parts, so an image part disappears without an error. Nothing sends images today (no `image_url` or `type: 'image'` in live code). | `bridge/llmTypes.ts:66-68`; `bridge/anthropicProvider.ts:45-49` |
| G0-05 | `recordUsage()` pushes to an in-memory array capped at 500. | `bridge/modelCategories.ts:116-142` |
| G0-06 | `TaskContext.llm()` sets `category: request.category ?? 'planning'` for every agent; the agent's role is not passed. | `core/agents/agentManager.ts:1248` |
| G0-14 | `data/usage/` is not ignored by Git. | `.gitignore` |

## Constraints found in the tests (they shape the design)

- `tests/modelRoutingTest.ts:48` requires exactly six categories, so 1A adds **no** categories. Research, decision and vision roles wait for 1B/2/5, with an approved test update.
- `tests/modelRoutingTest.ts:108` requires that a configured Claude is **not** used as silent failover. Kept.
- Tests use bare stub providers (`{ chat: async () => … }`), so capabilities must be optional, and an undeclared capability must never be enforced.
- Three tests reset `GroqProvider` static fields directly, so the default instance must keep using them (see the patch plan, Change 3).
- `tests/agentRuntimeTest.ts:79` and `tests/sevenAgentTest.ts:74` replace `modelRouter.chat` wholesale; an extra `agentRole` field in the request is harmless to them.
- `usageLog()` / `usageSummary()` have no consumer outside tests; persisting them changes no display.
