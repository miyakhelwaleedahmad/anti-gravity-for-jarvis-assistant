# Independent Review: Phase 1A corrections round

> Run `2026-11-15_phase1a-model-gateway` · branch `claude/jarvis-repair` · HEAD `c4ac909` · all changes uncommitted
> Reviewed 2026-11-15 in a Linux cloud container. This is not a human review, and nothing here was run on the owner's Windows PC. A pass on Linux does not show behaviour on that PC.

## 1. Reviewer identity and method

I am a separate AI agent with a fresh context. I did not write, plan or review the first round of this change. I treated `change_log.md` ("Corrections round"), `verification.md` ("Corrections round: verification") and the tracker as claims to check.

**Read in full:** `bridge/modelRouter.ts`, `bridge/modelCategories.ts`, `bridge/providerGuard.ts`, `bridge/usageLedger.ts`, `tests/modelRouteCorrectionsTest.ts`, `.env.example` lines 60-101, `INDEPENDENT_REVIEW.md`, the two claim sections above, and every file in `evidence/corrections/`.
**Read in part:** `tests/providerIsolationTest.ts` (header, §3, §4, §6), `tests/usageLedgerTest.ts` (§7-§9), `tests/modelRoleRoutingTest.ts` (stub at 52-70, §4 at 147-195), `core/foregroundGate.ts` (all), `core/goalVerifier.ts:120-158`, `core/agents/behaviors/toolLoop.ts:60-100,120-175`, `core/agents/agentManager.ts:136-150,628-700,1240-1255`, `core/agents/jarvisAgents.ts:225-320`, `core/agents/specialists.ts:100-112`, `core/agents/behaviors/verify.ts:1-30`, `core/codeRepair.ts:130-200` plus grep of its error handling, `bridge/openaiProvider.ts:55-100`, `bridge/anthropicProvider.ts:170-190`, grep of `bridge/groqProvider.ts` for the fast-model swap, and the Phase 1A rows of `docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md`.
**Diffed:** `bridge/modelRouter.ts` against the pre-round copy in my session scratchpad (`modelRouter.before-corrections.ts`). Its SHA-256 (`9806f80b…`) matches the `bridge/modelRouter.ts` line in `production-hashes-before.txt`.

**Ran (exact commands and results):**

| Command | Result |
|---|---|
| `git status --short`, `git diff --stat`, `git log --oneline -3` | 10 tracked files modified, 8 untracked paths; HEAD `c4ac909` |
| `sha256sum` of `bridge/*.ts`, `core/agents/agentManager.ts`, `.env.example`, compared with `production-hashes-before.txt` | changed in this round: `.env.example`, `bridge/modelCategories.ts`, `bridge/modelRouter.ts`, `bridge/providerGuard.ts`, `bridge/usageLedger.ts`. Unchanged: `anthropicProvider`, `groqProvider`, `llmStatus`, `llmTypes`, `nodeBridge`, `openaiProvider`, `agentManager` |
| `git diff --name-only HEAD -- tests` | empty |
| `git diff --check` | exit 0 |
| `grep -nE "[[:space:]]$"` on the 7 untracked code/test files | no matches |
| `git diff --quiet HEAD -- pnpm-lock.yaml package.json` | exit 0 (unchanged) |
| `pnpm run typecheck` | exit 0 |
| `pnpm test -- --only=modelRouteCorrectionsTest,providerIsolationTest,usageLedgerTest,modelRoleRoutingTest,providerCapabilitiesTest` | 5 passed · 0 failed |
| `pnpm test -- --only=` agentRuntimeTest, agentSpecialistsTest, claudeProviderTest, codeRepairTest, docsHygieneTest, foregroundPriorityTest, goalAgentIntegrationTest, goalRuntimeTest, jarvisAgentIntegrationTest, latencySmokeTest, llmCancellationTest, llmClientBehaviourTest, llmProviderConfigTest, llmTimingTest, modelRoutingTest, providerFailoverTest, providerHealthTest, redactionTest, repairRunTest, sevenAgentTest | 20 passed · 0 failed |
| Per-test verdicts extracted from `../baseline-ci.txt` and `corrections/after-ci.txt`, then `diff` | the 231 pre-existing tests have identical verdicts; the only difference is the 5 programme tests, all PASS |
| One inline probe, `node node_modules/tsx/dist/cli.mjs -e "…"`, stub providers only, `JARVIS_DATA_ROOT`/`JARVIS_WORKSPACE_ROOT` set to a folder in my session scratchpad, `JARVIS_USAGE_LEDGER=off`, no network | output quoted in §4 (probes P1-P5) |
| `git status --short` before and after the probe and test runs | identical (sha256 `1f912969…` both times); no `data/usage/` in the repo |

I did not run `pnpm test -- --ci` myself; I compared the implementer's `after-ci.txt` with the baseline. Outside the repository I wrote only temporary files in my session scratchpad (git status snapshots, verdict lists, an empty probe data folder). In the repository I created only this report.

I could not check: anything on Windows or the owner's hard disk, any live provider, the in-adapter model swaps in practice, and the pre-round content of the untracked test files (no copies exist, see §7).

## 2. Overall verdict

The router changes do what M1-M3 asked on the paths the tests cover. The wait for the conversation now comes before any time limit, a queue-wait limit gives a clear error that no other model answers, strict routes fail as `StrictRouteError` on `chat`, `categoryChat` and routed streams, and one routed call asks each provider instance at most once. The protected router changed only for M1-M3. No other protected file changed in this round, no tracked test changed, and the full-suite verdicts match the baseline.

Four things still fall short of what the owner asked, and two of them were introduced in this round:

1. **Agent tasks still end `COMPLETED` after a strict QA or coding failure** (the implementer says so; I confirmed it). This is the main unmet part of M2/M4. The proposed `toolLoop.ts` fix would work but is incomplete as worded.
2. **New in this round: a non-strict conversation or planning route on the primary's own provider has lost its fallback.** The default model is no longer asked when the route's model fails. This contradicts "keep the existing fallback for conversation and planning" and `.env.example:76-77`.
3. **New in this round: a background call that falls back after a failed named route no longer waits for the owner's conversation** (PERF-02 regression in the fallback path).
4. `.env.example` and the module header still claim more than the code does ("really answers with that model", "the default model above answers", QA "checks the work independently"). `agentIndependence()` can still report independence when the same model answers.

None of these is a security problem, and the default path with no configuration behaves as before (apart from one error-text change, R3).

## 3. Per-requirement table

| Item | Status | Evidence |
|---|---|---|
| **M1** wait does not use the provider time limit; provider called after the conversation; cancel while waiting; separate queue-wait limit with a clear error, no default-provider answer; no delay for the owner | **PARTLY MET** | `waitForConversation()` runs before the timer in `routedChat` (`bridge/modelRouter.ts:317`), `categoryChat` (`:165`) and routed `streamChat` (`:526`), outside the `try`, so its errors are never caught by a fallback. It waits on the caller's signal and throws `AbortError` (`:292`) or `QueueWaitTimeoutError` (`:293`, `:73-77`). `yieldToForeground` returns 0 for foreground calls (`core/foregroundGate.ts:40`). Tests M1 a-g pass; fail-before shows a-d and g failing on the old code. **Gap:** the fallback after a named route that did not wait now skips the wait (finding M-3). |
| **M2** strict coding/review/coding_agent/qa_agent when configured; clear failure, no other provider, not reported as success; keep conversation/planning fallback; `.env.example` accurate | **PARTLY MET** | Router: `route.strict` (`bridge/modelCategories.ts:138`); strict bare model asks only the primary (`bridge/modelRouter.ts:298-301`, `failoverOrder` returns `[name]` at `:397`); `StrictRouteError` in `routedChat:322`, `categoryChat:181`, `streamChat:537`. goalVerifier: error → judge `undefined` → `needs_review` (`core/goalVerifier.ts:153-155`, `:126`). **Not met:** agent tasks end `COMPLETED` (H-1); configured model can still be replaced inside or by the adapter (M-4); fallback lost for routes on the primary's provider (M-2); `.env.example` overclaims (M-4, M-5). |
| **M3** never the same provider twice in one routed call; aliases; order kept; clear error | **MET** (router), with side effect M-2 | `attempted` map keyed by provider instance (`:84`), set at `:196`, `:462`, `:552`, `:606`, checked at `:454`, `:589`; `everyProviderFailed` (`:94-100`, `:487-491`). Tests: "every provider at most once", alias, named-then-chain order, routed stream. Deliberately unchanged: the unrouted stream retries the same provider through `chat()` (`:623`, test "unrouted stream retry … unchanged"); in-adapter retries in `groqProvider.ts:393-395` are outside the router. |
| **M4** QA fails instead of falling back; no coding-model substitute; no false claim of independent QA; original reason kept; independent review required before "verified"; `agentIndependence()` reflects real targets | **PARTLY MET** | Router-level QA failure is strict and keeps `cause` and the message (`:63-70`). Not met: the task still completes via keyword rules (H-1); the reason is cut off in the agent's limitation text (H-1); no rule requires an independent review before a coding result counts as verified (tracker MM-1A-P4, documented); `agentIndependence`/`observedAgentIndependence` can report independence for the same model (M-1). |
| Gap: route timeout | **MET** | `modelRouteCorrectionsTest` M1 b (strict route, `StrictRouteError` with "timed out", no other provider). A non-strict route timeout followed by fallback is not tested. |
| Gap: strict bare-model routing | **MET** | M2 tests for `review` via `chat`, `coding` via `categoryChat`, goalVerifier through the real `modelJudge`. |
| Gap: QA provider failure | **PARTLY MET** | Router level only (`modelRouteCorrectionsTest:230-240`). No test of the agent task's final status, which is where the requirement is not met. |
| Gap: stream-path capability refusals | **MET** | `modelRouteCorrectionsTest:335-350` (default `primaryStream` refusal, routed `streamFrom` refusal). These passed on the old code (gap closure, not a regression proof). A strict routed stream refusal is not tested. |
| Gap: network-error handling | **MET** | `providerIsolationTest` §6 first block. Passed on the old code (gap closure). |
| Gap: simultaneous calls after breaker cooldown | **MET** | `providerIsolationTest` §6 "five calls at once send only one trial call"; failed on old code (5 trials). Does not cover the hole in L-1 below. |
| Gap: abort during a pending operation | **MET** | `modelRouteCorrectionsTest:315-328`: the fallback stub ignores the signal, so removing the check at `routedChat:321` would make it fail. The copy in `modelRoleRoutingTest` §4 is weaker (L-5). |
| L1 single trial | **PARTLY MET** | `bridge/providerGuard.ts:79-105`; an unrelated in-flight error can end the lease early (L-1, probe P3). |
| L2 non-429 does not reset count | **DEFERRED (documented)** | `providerGuard.ts:15-17`, tracker line 129. |
| L3 synchronous ledger I/O | **DEFERRED (documented)** | measured on Linux only, warm cache (`ledger-timing-linux.txt`); cold HDD read not measured. |
| L4 history after rotation | **MET** | `bridge/usageLedger.ts:88-115`; `usageLedgerTest` §8 failed before, passes now. §9 passed on old code too, consistent with the `catch` at `:60-62`. |
| L5 dashboard text after failed fallback | **DEFERRED (documented)** | `recordFallback` unchanged at `:325`, `:540`; tracker MM-1A-P5. This round makes the wrong text more frequent (L-4). |
| L6 capabilities partly enforced | **DEFERRED (documented)** | `refusal()` unchanged (`:231-243`); MM-1A-P5. |
| L7 independence check | **PARTLY MET** | `effectiveTarget()` and `observedAgentIndependence()` added (`modelCategories.ts:170-213`); still no consumer; gaps in M-1. |
| L8 refusal records on one path | **DEFERRED (documented)** | `streamFrom` still throws without a record (`:551`). |
| L9 routed stream time limit | **DEFERRED (documented)** | no timer in `streamChat`/`streamFrom`. |
| L10 tracker heading | **MET** | tracker line 77 now "implemented, reviewed, corrected; uncommitted". Line 36 still says it "waits for … the independent review (05b)", which is now done. |

## 4. Findings by severity

Probe output (stub providers, no network), quoted exactly:

```
P1 bare non-strict planning on the only provider: ERR JARVIS_MODEL_PLANNING: every eligible provider failed (a); last error: 404 model not found | calls a:other-model
P1b conversation route a:lite on the primary a: ERR JARVIS_MODEL_CONVERSATION: every eligible provider failed (a); last error: 404 model not found | calls a:lite
P2 background fallback to primary during a conversation: a answered | after 1 ms | conversation still active: true | calls named:m,a:own
P3 trial: pass refused | after an unrelated 503 result: pass pass
P4 agentIndependence openai:model-a vs openai:model-b -> true {"provider":"openai","model":"model-a"} {"provider":"openai","model":"model-b"}
P4b QA = primary brain model in upper case -> true
P5 strict QA failure name: StrictRouteError | queue-wait error: QueueWaitTimeoutError: JARVIS_MODEL_AGENT_QA_AGENT: waited 200 ms for the owner's conversation (JARVIS_MODEL_QUEUE_WAIT_MS); not sent to q, and not answered by another model
```

### Critical
None.

### High

**H-1 — A strict QA or coding route that fails still yields a `COMPLETED` agent task, and the original reason is lost in the task's text. CONFIRMED (code reading; P5 shows the error names that reach the agent).**
- `core/agents/behaviors/toolLoop.ts:76-81` catches every non-abort error from `ctx.llm`, including `StrictRouteError` and `QueueWaitTimeoutError` (P5), and returns a note. `:156-158` then runs keyword rules. `core/agents/agentManager.ts:662-663` sets `COMPLETED` when the behaviour returns.
- The note keeps only the first 100 characters of the message (`toolLoop.ts:79`). `strictRouteError` puts about 100 characters of prefix before the reason (`bridge/modelRouter.ts:66`; e.g. `JARVIS_MODEL_AGENT_QA_AGENT (anthropic, model claude-opus-5-5) failed; this route is strict, so no other model answered: ` is about 120). So the agent's limitation shows the route but not why it failed. The reason is still on `err.cause` and in the usage record (`:378`).
- The implementer documented this (verification.md "Not verified"; tracker MM-1A-P1). It needs a change to a protected file, so it could not be done in this round.
- **On the proposal:** re-throwing `StrictRouteError` in that `catch` would work. `isAbort` (`agentManager.ts:136-138`) checks only `name === 'AbortError'`, so the error reaches the last `else` and the task becomes `FAILED` / `AGENT_ERROR` with the message (`:677-679`). The proposal should also re-throw `QueueWaitTimeoutError`, or a timed-out queue wait will still be completed by keyword rules. For a multi-part request, a failed worker only lowers the parent's confidence (`toolLoop.ts:146-150`), so the parent still completes.
- Related, and true before this round: the automatic check of a coding result is rule-based and uses no model at all (`core/agents/specialists.ts:105-110`, `core/agents/behaviors/verify.ts:7-11`). `JARVIS_MODEL_AGENT_QA_AGENT` only affects QA tasks that run the tool loop (tests, reviews).

### Medium

**M-1 — `agentIndependence()` and `observedAgentIndependence()` can report independence when the same model answered. CONFIRMED (P4, code reading).**
- `bridge/openaiProvider.ts:71-74` always sends its own `JARVIS_FALLBACK_MODEL` and ignores `request.model`. `effectiveTarget()` (`bridge/modelCategories.ts:170-178`) does not know this, so `openai:model-a` against `openai:model-b` reads as independent (P4). The usage record also stores the requested model (`modelRouter.ts:369`, `:473`), so the observed check makes the same mistake.
- Model IDs are compared as exact strings, so a case difference reads as independent (P4b).
- The Gemini/Groq client switches to the fast model on a 429 or during a cooldown (`bridge/groqProvider.ts:181-182`, `:393-395`, `:508-509`). Claude server-side fallbacks are on by default (`bridge/anthropicProvider.ts`, `fallbacks` set when `JARVIS_ANTHROPIC_FALLBACKS` is not `off`). Neither shows in the usage record, so the observed check cannot see them. This is documented as MM-1A-P3.
- `observedAgentIndependence()` takes the latest successful call of each role across all records (`:201-213`), not within one task. A QA call that failed now is paired with an older successful QA call from another task and can read as independent. The doc comment at `:198-199` ("QA that did not run is never reported as independent") holds only if QA never succeeded within the last 500 records.
- Neither function has a consumer (tracker MM-1A-11), so nothing reports this to the owner today. The owner's requirement ("never report independence when coding and QA actually used the same model") is not met by the functions as written.

**M-2 — New in this round: a non-strict route on the primary's own provider no longer falls back to the default model. CONFIRMED (P1, P1b; diff).**
- M3 dedupes by provider instance, not by provider and model (`modelRouter.ts:454`). When `JARVIS_MODEL_PLANNING=other-model` or `JARVIS_MODEL_CONVERSATION=<primary>:<model>` fails, the fallback chain skips the primary, because the route already asked it with a different model. With no second provider configured (the usual Gemini-only setup), the call fails with `every eligible provider failed` (P1, P1b).
- Before this round the fallback `chain(request, undefined, true)` asked the primary with the caller's model and answered. The earlier review's M3 probe shows that sequence: `a:other-model,b:other-model,a:own,b:own`.
- This contradicts the owner's "keep the existing fallback for conversation and planning" and `.env.example:76-77` ("If the set provider fails, the default model above answers"). For a conversation route with a mistyped model ID, every reply now fails where before it was answered by the brain model.
- M3's literal rule and the fallback rule conflict here. The owner should decide: dedupe on (provider, model), allowing one retry of the primary with the caller's model as the earlier review suggested, or keep provider-level dedupe and correct the docs.

**M-3 — New in this round: a background fallback after a failed named route no longer waits for the owner's conversation. CONFIRMED (P2; diff).**
- `waitForConversation` returns at once for a named provider the conversation does not use (`:273`). If that route fails, the fallback runs `chain(…, { skipWait: true })` (`:326`) and asks the primary at once (P2: answered after 1 ms while the conversation was still active).
- Before this round, the fallback `chain()` always ran `backgroundWaits` first. The routed stream fallback changed the same way (`:542`).
- Example: `JARVIS_MODEL_PLANNING=anthropic:…` with Gemini as primary. Claude returns 429 during a conversation, and the agent's planning call goes straight to Gemini and competes with the owner's reply for the same per-minute quota. This works against PERF-02 and the owner's "normal user conversations must never be unnecessarily delayed".
- A fix is to skip the wait in the fallback only when the route already waited.

**M-4 — A configured strict route can still be answered by another model without an error, and the docs say it cannot. CONFIRMED (code reading).**
- `.env.example:70` says "A kind set here really answers with that model". `.env.example:72-75` and `bridge/modelCategories.ts:21-24` say a strict route goes "to that one provider and model … no other provider or model answers it".
- Cases where that is false:
  - in-adapter swaps (Gemini/Groq fast model; Claude server-side fallbacks), documented in the tracker as MM-1A-P3 but not in `.env.example`;
  - `openai:<model>`, which sends `JARVIS_FALLBACK_MODEL` (`bridge/openaiProvider.ts:71-74`);
  - with `JARVIS_LLM_PROVIDER=anthropic`, a strict bare model name that does not start with `claude`, which `modelFor()` replaces with Claude's brain model (`modelRouter.ts:44-46`, applied at `:455`, `:549`).
- In the last case the usage record shows the replaced model; in the first two it shows the requested model.

**M-5 — `.env.example` still describes some behaviour wrongly. CONFIRMED (code reading).**
- `:76-77` (default model answers): false after M-2.
- `:81-82` ("QA on another model than coding, so it checks the work independently"): the automatic check of coding results uses no model (H-1, related).
- `:85-89` presents `JARVIS_MODEL_QUEUE_WAIT_MS` as a limit for any background agent or goal call. It applies only to configured routes and to `categoryChat`. An unconfigured agent call waits through `chain()` → `backgroundWaits()` (`:430`, `:441`) with no queue limit. `modelCategories.ts:153` says "a configured route's", which is also not exact, because `categoryChat` applies the limit to unconfigured code repair too (`:165`).
- `:74` ("that call fails with that reason") is true for the call, but nothing says the agent task still completes (H-1).

### Low

- **L-1 — The trial lease can be ended by an unrelated call. CONFIRMED (P3).** Any non-quota, non-abort failure sets `trial = false` (`bridge/providerGuard.ts:115-118`), including one from a call that started before the breaker opened. After that, `check()` lets every call through (`:85-92`) while the real trial is still running. A trial that never reports back is freed after one open period (`:89-91`), so a provider cannot be blocked for ever. RPM is consumed only for calls that are let through (`:93-99` run after the breaker refusals and before the state change), which is correct.
- **L-2 — Background agent and verification task timeouts still include the yield wait.** The agent's own signal (`agentManager.ts:1248`) carries the task timeout while `waitForConversation` waits. Example: `JARVIS_AGENT_VERIFY_TIMEOUT_MS` (default 20 s, `core/agents/jarvisAgents.ts:239-242`) equals the default yield. This is not a provider time limit, so M1 is not violated. SUSPECTED impact, not run.
- **L-3 — QA's sub-work runs on other routes.** Workers QA spawns (`specialists.ts:110`, `test_runner_worker`) call the model as their own role (`agentManager.ts:1248`, `agentRole: this.agent.role`), so they use the non-strict planning route, possibly the coding model. SUSPECTED (worker behaviour not traced).
- **L-4 — Dashboard text after a fallback that never ran.** In the M-2 case `recordFallback(route.provider, this.primary, …)` (`:325`) runs, and then nothing answers. This is the known L5, now hit more often. SUSPECTED (code reading).
- **L-5 — The new abort check in `modelRoleRoutingTest` §4 cannot detect a fallback.** Its stub throws on an aborted signal before logging (`tests/modelRoleRoutingTest.ts:56`), so "…and no fallback model answers it" (`:181`) would pass even without the check at `routedChat:321`. The equivalent test in `modelRouteCorrectionsTest` is sound. CONFIRMED (code reading).
- **L-6 — `categoryChat` now replaces a timed-out provider's error with `"<category> call timed out after N ms"`, also for unconfigured code repair** (`:180`). This is a small default-path change in error text (R3). CONFIRMED (code reading).
- **L-7 — `route.independent` for `review` still compares raw strings** (`modelCategories.ts:140-148`), e.g. `default` against `gemini:<brain model>`. It has no consumer. CONFIRMED (code reading).
- **L-8 — Wall-clock timing in the new tests** (see §7). SUSPECTED flakiness on a slow PC.

## 5. Security concerns

- **No new secret path found.** `StrictRouteError`, `everyProviderFailed` and the timeout reason carry upstream error text unredacted (`modelRouter.ts:66`, `:95-96`). Before this round the same text was thrown as the raw error, so callers see the same content with a prefix.
  - Usage records still redact errors and cut them to 200 characters (`:378`).
  - The new router warnings redact (`:324`, `:539`).
  - The strict path logs nothing new.
  - Code repair redacts before storing (`core/codeRepair.ts:234`, `:298`).
  - The agent limitation text (`toolLoop.ts:79`) was unredacted before and still is.
  - `QueueWaitTimeoutError` holds only the setting name and provider name (`:74`).
- `StrictRouteError` includes `route.model`, a configuration value. That is a risk only if a key were pasted into a `JARVIS_MODEL_*` setting; the same value was already in usage records.
- The approval gate, `security/*`, `core/toolRegistryV2.ts`, `core/codeRepair.ts` and `core/worktreeExecutor.ts` are unchanged against HEAD (`git status --short -- core security jarvis.ts` lists only `core/agents/agentManager.ts`, unchanged in this round).
- Still open from the earlier review: `bridge/modelCategories.ts`, `providerGuard.ts` and `usageLedger.ts` now hold routing and breaker policy but are not protected files (tracker MM-1A-P6).

## 6. Regression risks

- **R1 (M-2):** a configured conversation or planning route on the primary's provider loses its fallback. Check the owner's `.env` for `JARVIS_MODEL_CONVERSATION`, `JARVIS_MODEL_PLANNING` and `JARVIS_MODEL_INTENT` before deploying.
- **R2 (M-3):** background fallbacks can compete with the owner's conversation.
- **R3:** with no configuration, the default path is the same as before this round in what I traced and tested:
  - The unrouted stream still waits first (`:575`), and on failure still retries the same provider through `chain()`, which waits again (`:623`, `:441`). The test "unrouted stream retry … unchanged" covers the retry.
  - Unconfigured code repair is not strict (`modelCategories.ts:138`) and keeps full failover (`chainTarget` returns `undefined`; test "unconfigured code repair keeps its failover").
  - `categoryChat`'s wait moved before the timer, but for a foreground caller `yieldToForeground` returns 0 at once (`foregroundGate.ts:40`), so nothing changes there.
  - The one difference is the error text on a `categoryChat` timeout (L-6).
- **R4:** an explicit route timeout used to surface as `AbortError`, which an agent treated as a cancellation (`TIMED_OUT`/`CANCELLED`). It is now `TimeoutError` or `StrictRouteError`, which the tool loop treats as a model failure and completes (H-1). This is more accurate, but it changes the task's final status in that case.
- **R5:** nothing was run on Windows. Timing-sensitive tests (§7) and the cold ledger read (L3) are untested there.

## 7. Missing or weak tests

- Nothing tests an agent task's final status after a strict QA or coding failure (H-1); this would currently fail.
- No test covers a non-strict route on the primary's own provider with a failing model (M-2), a background fallback during an active conversation (M-3), or `JARVIS_MODEL_QUEUE_WAIT_MS` in `categoryChat`.
- No test covers a strict routed stream refusal, or a non-strict route timeout followed by fallback.
- `providerIsolationTest` §6 does not cover an unrelated failure during a trial (L-1), RPM with a trial, or a non-quota error ending a trial.
- The independence tests use hand-made records. They do not cover the OpenAI model swap, case differences, or cross-task pairing (M-1).
- Several checks use wall-clock bounds:
  - `modelRouteCorrectionsTest:136` (900-3000 ms), `:153` (<1000 ms), `:166` (250-1500 ms), `:178` (≥250 ms), `:189` (<200 ms);
  - `tick(1500)` against a 1000 ms limit at `:122`, `:199`;
  - `providerIsolationTest` §6, with an 80 ms open period, `tick(120)` and a 150 ms trial.

  The <200 ms foreground bound is the most likely to flake on a loaded PC.
- Gap-closing checks that also passed on the old code, and so prove coverage but not a fix: stream capability refusals, the network error, the abort tests, `usageLedgerTest` §9, and "a trial that never reported back frees the provider".
- **Pre-existing tests:** `git diff --name-only HEAD -- tests` is empty, so no tracked test changed. The edited files `providerIsolationTest`, `usageLedgerTest` and `modelRoleRoutingTest` are untracked Phase 1A files. There are no pre-round copies, so I cannot prove that no earlier check in them was weakened. Spot checks: the already-aborted check is still at `modelRoleRoutingTest.ts:157-162`, and §3-§4 of `providerIsolationTest` match what the earlier review described.
- **Test-first order:** plausible, not provable. Mtimes: tests 09:41:17-09:41:38, hashes 09:41:46, `fail-before.txt` 09:42:09, a stub fix in `modelRouteCorrectionsTest` 09:42:21, `fail-before-rerun.txt` 09:42:31, production edits 09:43:34-09:48:47, `pass-after.txt` 09:49:37, `after-ci.txt` 10:01:55. Mtimes can be changed. The before-hashes file was written by the implementer; the only independent check is that the scratchpad router copy matches its router line.

## 8. Authorisation-boundary check

- **Changed in this round** (hash differs from `production-hashes-before.txt`): `bridge/modelRouter.ts` (protected, approved for M1-M3), `bridge/modelCategories.ts`, `bridge/providerGuard.ts`, `bridge/usageLedger.ts` and `.env.example` (all unprotected).
- **Unchanged in this round** (hash equal): `bridge/groqProvider.ts`, `bridge/anthropicProvider.ts`, `bridge/openaiProvider.ts`, `bridge/llmTypes.ts`, `bridge/llmStatus.ts`, `bridge/nodeBridge.ts`, `core/agents/agentManager.ts`. Their mtimes (07:56-07:59) are before this round began (09:41). `core/agents/behaviors/toolLoop.ts` and `core/codeRepair.ts` have mtime 2026-10-31 and no diff against HEAD. `jarvis.ts`, `security/*`, `core/toolRegistryV2.ts` and `core/worktreeExecutor.ts` have no diff against HEAD.
- **Router diff content:** every hunk maps to M1, M2 or M3:
  - M1: `waitForConversation`, `queueWaitError`, `skipWait`, the timeout-reason re-throw in `withRouteTimeout:353-355` and `categoryChat:180`;
  - M2: `strictRouteError`, `chainTarget`, `route.strict` replacing `STRICT_CATEGORIES`;
  - M3: `attempted`, `everyProviderFailed`, `ChainOptions`.

  The timeout-reason re-throw in `categoryChat` also changes unconfigured code repair's error text (L-6). I count it as part of M1's clear time-limit error, but it is at the edge of the approval.

  No L5, L6, L8 or L9 fix appears in the router: `recordFallback` is unchanged, `refusal()` is unchanged, `streamFrom` still has no refusal record, and streams have no timer.
- `package.json` and `pnpm-lock.yaml` are unchanged against HEAD.

## 9. Evidence verification

| File | What it shows | What it cannot prove |
|---|---|---|
| `production-hashes-before.txt` | Pre-round hashes. The router line matches the scratchpad copy; the current hashes of the 7 unchanged files match | That the other lines were not edited after the fact |
| `fail-before.txt` | Assertion failures, not crashes: 20 passed / 24 failed, 23/3 and 21/1, with plausible old-code values (`a:chat,b:chat,a:chat,b:chat`; `5 trial call(s)`; `6 record(s)`). `modelRoleRoutingTest` passed. One failure ("unrouted stream retry", `a streamed / a:stream`) came from a broken stub | That it ran on the unchanged code ("production hashes recorded" is the implementer's text) |
| `fail-before-rerun.txt` | After the stub fix, 21/23. The stub check now passes and the other 23 still fail | The same |
| `pass-after.txt` | 5/5 pass; I reproduced it | — |
| `typecheck-after.txt` | exit 0; I reproduced it | — |
| `voice-core-after.txt` | 6/6 pass; I did not re-run the voice group, though `latencySmokeTest` passed in my run | Windows or real audio |
| `after-ci.txt` | 236 files: 226 pass, 1 blocked, 9 skipped, 0 failed. Per-test verdicts match the baseline for all 231 pre-existing tests; the 5 new ones pass | That the skipped and blocked tests would pass |
| `ledger-timing-linux.txt` | first read of a full 2 MB file 6.54 ms, append 0.011 ms | A cold read on the owner's HDD; that the file was not in the OS cache (it says it was) |
| `change_log.md` / `verification.md` | Accurate on files changed, the order of work, the toolLoop gap, the in-adapter swaps and the deferred L-items. The fail-before counts quote the rerun (21/23), not the first run (20/24), which the text explains | They do not mention M-2, M-3, the OpenAI/Claude-primary model replacement (M-4), or the reason cut-off (H-1) |

`git diff --check` is clean, the untracked files have no trailing whitespace, and the lockfile and `package.json` are unchanged.

## 10. Required corrections

1. **H-1 (owner approval needed, protected file):** apply MM-1A-P1 and extend it to `QueueWaitTimeoutError`. Make the agent-visible text keep the original reason: either a shorter `StrictRouteError` prefix or a longer slice in the tool loop. Add a test that a failing configured `qa_agent` route ends the task `FAILED` with the reason.
2. **M-2 (owner decision, router):** either dedupe on (provider, model), allowing the default model on the primary once after a route on the same provider fails, or keep provider-level dedupe and correct `.env.example:76-77` and the module header. Add a test either way.
3. **M-3 (router, M1 scope):** the fallback after a route that did not wait must wait for the conversation, with the same queue-wait rule. Add a test.
4. **M-4/M-5 (docs):** make `.env.example:70-89` and `bridge/modelCategories.ts:20-26` say what happens:
   - in-adapter swaps;
   - the OpenAI fallback's fixed model;
   - Claude-primary mapping of bare names;
   - the agent task still completing until MM-1A-P1;
   - the automatic QA check of coding results using no model;
   - where the queue-wait limit applies.
5. **M-1:** before any consumer relies on them, make `effectiveTarget()` aware of the OpenAI provider's fixed model, compare model IDs without case, and scope `observedAgentIndependence()` to one task or correlation id. Until then, docs should say both functions can report a false "independent".
6. **L-1:** end the trial only on the trial call's own result, for example with a token returned by `check()`.
7. Tracker: line 36 still describes 05b as pending. Record M-2 and M-3 as known issues until fixed.

## 11. Final recommendation

**APPROVE WITH CONDITIONS.**

- Before commit: fix M-3, and either fix M-2 or have the owner accept it with corrected docs. Correct the `.env.example` and header claims (M-4, M-5). Add the tests from §10.
- Before the owner relies on "QA must fail": approve and apply MM-1A-P1, including `QueueWaitTimeoutError` and the reason text (H-1).
- Before anything reports QA independence to the owner: fix M-1.
- On the owner's PC: run `findstr /B "JARVIS_MODEL_" .env` (R1); run the no-configuration check from `patch_plan.md`; time the first reply after start (L3); run the five programme tests there (timing, §7).
- No commit, push or merge until the owner approves.
