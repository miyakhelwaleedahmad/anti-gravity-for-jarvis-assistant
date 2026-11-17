# Change Log — Phase 1A

> Stage: 04_implementation · Approved by the owner 2026-11-15 ("You have conditional approval to begin Phase 1A.")
> Machine: Linux cloud container, Node 22.23.4, pnpm 10.33.0. Not the owner's PC. Nothing committed.

## Order followed (owner's condition 4)

1. `pnpm install --frozen-lockfile`. SHA-256 of `pnpm-lock.yaml` and `package.json` were identical before and after; no dependency was added.
2. Baseline on `c4ac909`, unchanged: typecheck clean; `pnpm test -- --ci` 221 passed · 0 failed · 1 blocked · 9 skipped (`evidence/baseline-ci.txt`).
3. The four new tests were added; production code was still unchanged (`git diff --quiet -- bridge core` checked first).
4. They were run on that code; all four failed (`evidence/fail-before.txt`, `evidence/fail-before-providerIsolation-rerun.txt`, `evidence/fail-before-typecheck.txt`).
5. The source changes were made, then the same tests were run again (`evidence/pass-after.txt`).

### One correction to a new test before implementation

The first fail-before run of `providerIsolationTest` stopped partway: one call in the test was not wrapped in `settle()`, so the old shared breaker threw an uncaught error. I wrapped that one call (test only) and re-ran the test on the **still unchanged** code: it then ran to the end, 9 passed and 10 failed on assertions. Both runs are kept in `evidence/`. No assertion was changed.

## Files changed

| File | Protected | Change (patch plan) |
|---|---|---|
| `bridge/llmTypes.ts` | No | 1: optional `agentRole` on requests; `ProviderCapabilities`; optional `capabilities()` |
| `bridge/modelCategories.ts` | No | 2: `routeFor(category, env, agentRole?)`, `key` / `explicitTimeout` / `explicitMaxTokens`, `STRICT_CATEGORIES`, `agentRouteKey`, `agentIndependence`; usage ledger load/append; `agentRole` in records |
| `bridge/groqProvider.ts` | **Yes (approved)** | 3: state behind `this.state`; default = the class fields (unchanged); `{ isolatedState: true }` for own state; `capabilities()` |
| `bridge/providerGuard.ts` | No (new) | 4: per-provider breaker and optional requests-per-minute limit |
| `bridge/usageLedger.ts` | No (new) | 5: `data/usage/model_usage.jsonl`, rotated at 2 MB, 10 kept, never throws |
| `bridge/modelRouter.ts` | **Yes (approved)** | 6: `chat()` → configured route or `chain()` (the old body); `streamChat()` → configured route or `primaryStream()` (the old body); guards, capabilities, foreground wait for a named provider the conversation uses; `agentRole` in usage |
| `bridge/anthropicProvider.ts` | **Yes (approved)** | 7: `capabilities()` only |
| `bridge/openaiProvider.ts` | No | 8: `capabilities()` |
| `core/agents/agentManager.ts` | **Yes (approved)** | 9: one line, `agentRole: this.agent.role` |
| `.gitignore` | No | 10: `data/usage/` |
| `.env.example` | No | 10: comments for the new settings, no values |
| `tests/modelRoleRoutingTest.ts`, `tests/providerIsolationTest.ts`, `tests/providerCapabilitiesTest.ts`, `tests/usageLedgerTest.ts` | `tests/` (approved, new files only) | regression tests |

**Not changed:** every existing test, `tests/boundary-doubles.json` (not needed), `core/orchestrator.ts`, `core/reflectionEngine.ts`, `core/goal*.ts`, `core/codeRepair.ts`, `core/worktreeExecutor.ts`, `core/toolRegistryV2.ts`, `security/*`, the approval gate, self-healing, voice, `jarvis.ts`, `package.json`, `pnpm-lock.yaml`.

## Deviations from the patch plan

| Plan | Done | Why |
|---|---|---|
| A background call to a named provider always waits for the conversation (6b) | It waits **only when that provider also answers the conversation** (it is the primary, or `JARVIS_MODEL_CONVERSATION` names it) | The owner asked for no unnecessary latency. The wait exists to protect a shared quota (PERF-02). A background Claude call while Gemini serves the conversation uses no shared quota, so it is not held. Tested (`modelRoleRoutingTest` §7). |
| `fallbackFromRoute` as a request field (6a) | a private `fromRoute` parameter of `chain()` / `primaryStream()` | as the plan said it would become, so nothing new can reach a request |
| Explicit route time limit (6a) | applied to `chat()` routes; **not** to streamed routes | a stream's time is already bounded by its provider; adding a second timer to voice streams is out of 1A's scope. Recorded as a remaining item. |

## Not done here

- Independent review (Stage 05b): not done. I wrote the code, so I cannot review it as independent.
- Owner's PC check (live): not done.

---

# Corrections round (after the independent review)

> Owner's approval, 2026-11-15: "I approve fixing M1, M2 and M3 in `bridge/modelRouter.ts`"; M4: "QA must fail rather than silently fall back"; strict routing for coding_agent, qa_agent and goalVerifier; fix the test gaps; fix L1–L10 that affect correctness, measure L3 first.
> Machine: the same Linux container. Nothing committed.

## Order followed

1. I re-read `INDEPENDENT_REVIEW.md` and `patch_plan.md`.
2. Tests first, written while the production code was still the reviewed Phase 1A code:
   - new `tests/modelRouteCorrectionsTest.ts`;
   - added sections in `tests/providerIsolationTest.ts` (§6) and `tests/usageLedgerTest.ts` (§8, §9);
   - a cancel-during-a-pending-call check added to `tests/modelRoleRoutingTest.ts` §4 (the already-cancelled check is kept).
3. Hashes of `bridge/*.ts`, `core/agents/agentManager.ts` and `.env.example` were saved (`evidence/corrections/production-hashes-before.txt`). The tests were run against those files, and the hashes were re-checked after the run.
4. Fail-before (`evidence/corrections/fail-before.txt`, `fail-before-rerun.txt`):
   - `modelRouteCorrectionsTest`: 21 passed, 23 failed;
   - `providerIsolationTest`: 23 passed, 3 failed;
   - `usageLedgerTest`: 21 passed, 1 failed;
   - `modelRoleRoutingTest` passed: its new abort check is a gap fix, and the old code already handled that case.
   - One check in the new file had a broken stub ("the unrouted stream retry is unchanged"). I fixed the stub (test only) and re-ran the file on the still-unchanged code; both runs are kept.
5. Fixes in unprotected files, then the authorised M1–M3 fixes in `bridge/modelRouter.ts`. Targeted tests ran after each step.

## Files changed in this round

| File | Protected | Change |
|---|---|---|
| `bridge/modelRouter.ts` | **Yes (M1–M3 approved)** | **M1:** `waitForConversation()`: the wait comes before any time limit, on the caller's signal; `JARVIS_MODEL_QUEUE_WAIT_MS` ends it with `QueueWaitTimeoutError`; `categoryChat` waits first too; a route time-out error now says it timed out. **M2:** `strictRouteError()`; a strict bare-model route asks only the primary (`chainTarget()`); strict routes fail as `StrictRouteError` in `routedChat`, `categoryChat` and routed streams. **M3:** `ChainOptions.attempted`, a map of provider instances, so no provider is asked twice in one routed call, even under two names; `everyProviderFailed()` error. `namedWaits()` removed (replaced by `waitForConversation()`); `STRICT_CATEGORIES` no longer imported (the route carries `strict`). |
| `bridge/modelCategories.ts` | No | `ModelRoute.strict` / `.agentRole`; `STRICT_AGENT_ROLES` (`coding_agent`, `qa_agent`); `queueWaitMs()`; `effectiveTarget()`; `agentIndependence()` compares effective provider/model; new `observedAgentIndependence()` (latest successful calls really made); header text corrected |
| `bridge/providerGuard.ts` | No | L1: exactly one trial call after the open period, with a lease of one open period; a non-quota error on the trial ends it |
| `bridge/usageLedger.ts` | No | L4: `readRecent()` continues into the rotated files, newest first |
| `.env.example` | No | strict and non-strict rules described as they are now; `JARVIS_MODEL_QUEUE_WAIT_MS`; trial call |
| `tests/modelRouteCorrectionsTest.ts` (new), `tests/providerIsolationTest.ts`, `tests/usageLedgerTest.ts`, `tests/modelRoleRoutingTest.ts` | `tests/` | additions only, in this programme's own new test files; no pre-existing test touched |

Unchanged in this round: `bridge/groqProvider.ts`, `bridge/anthropicProvider.ts`, `bridge/openaiProvider.ts`, `bridge/llmTypes.ts`, `core/agents/*`, `core/goalVerifier.ts`, `core/codeRepair.ts`, every pre-existing test, `package.json`, `pnpm-lock.yaml`.

## Decisions on L1–L10

| ID | Decision | Where |
|---|---|---|
| L1 several trial calls at once | **Fixed** | `providerGuard.ts`; `providerIsolationTest` §6 |
| L2 a non-429 error does not reset the count | **Accepted and documented**: the same rule as the Gemini/Groq client's own breaker (only a success resets) | `providerGuard.ts` header |
| L3 synchronous ledger I/O | **Measured, kept**. On Linux: first read of a full 2 MB ledger 6.5 ms (file in the OS cache), append 0.011 ms (`evidence/corrections/ledger-timing-linux.txt`). A cold read on the owner's hard disk will be slower; to be measured on the PC | tracker |
| L4 history after a rotation | **Fixed** (read continues into rotated files). The "lost record when two processes rotate" case was already handled: the rename error is caught and the record still appended (`usageLedgerTest` §9 passed on the old code too) | `usageLedger.ts` |
| L5 dashboard text after a failed fallback | **Not fixed: it needs a `modelRouter.ts` change outside M1–M3.** Proposed | tracker |
| L6 document/audio parts dropped by the Claude adapter | **Not fixed: router change outside M1–M3** (and nothing sends such parts today). Proposed | tracker |
| L7 independence check | **Fixed** in `modelCategories.ts` (effective targets plus `observedAgentIndependence()`). Still not consumed by any part of JARVIS. Proposed for Phase 3 | tracker |
| L8 refused calls recorded on one path only | **Not fixed: router change outside M1–M3.** Proposed | tracker |
| L9 routed stream has no time limit | **Not fixed: router change outside M1–M3.** Proposed | tracker |
| L10 stale tracker heading | **Fixed** | tracker |

## Owner requirements this round could not meet within the approval (proposals, not done)

1. **QA marked failed or unavailable.** The router now fails a QA route with `StrictRouteError`, carrying the original reason, and never uses the coding model.
   - But `core/agents/behaviors/toolLoop.ts:76-81` catches the model failure and runs keyword rules, and the task ends `COMPLETED` (confidence 0.3, limitation text "Model: the model was not available (<reason>)…", `:156-163`).
   - Proposed change, in protected `core/agents/*`: in that catch, re-throw an error named `StrictRouteError`. The agent manager then marks the task `FAILED` with `AGENT_ERROR` and the original message (`core/agents/agentManager.ts:676-679`).
2. **goalVerifier keeps the reason.** A failed strict review is never "met" (`needs_review`), but `modelJudge` (`core/goalVerifier.ts:132-158`) drops the error text. Proposed: return the reason into the check's evidence.
3. **"Use those models", enforced inside the adapters.** Two existing behaviours can still swap the model inside a strict route:
   - the Gemini/Groq client moves to the fast model on a 429 and during a cooldown (`bridge/groqProvider.ts`);
   - the Claude adapter's server-side fallbacks are on (`bridge/anthropicProvider.ts`).

   Proposed: a strict flag on the request that turns both off. Both files are protected.
4. **"A successful independent review before the coding task counts as verified."**
   - Code repair already requires the reviewer's approval, now strict when configured.
   - For agent work, nothing links a coding result to an independent QA verdict, and `observedAgentIndependence()` has no consumer.

   Proposed for Phase 3.

---

# Round 3: QA failure, M-3, M-2, independence, trial lease

> Owner approval of 2026-11-15 (after `INDEPENDENT_REVIEW_CORRECTIONS.md` and `REVIEW_HANDOVER.md`). Linux cloud container. Uncommitted.

## Order followed

1. Two new tests written first: `tests/qaModelFailureTest.ts`, `tests/modelRouteRound3Test.ts`.
2. Fail-before on the unchanged code: qaModelFailureTest 8 passed / 18 failed; modelRouteRound3Test 20 passed / 23 failed (`evidence/round3/fail-before.txt`). The production file hashes were the same before and after that run (`evidence/round3/production-hashes-before.txt`).
3. Changes, one file at a time, with the targeted tests after each.
4. Typecheck, voice-core group, full suite (`verification.md`, Round 3).

No pre-existing test and no earlier programme test was edited in this round.

## Changes

| File | Change |
|---|---|
| ★`core/agents/behaviors/toolLoop.ts` | The approved `REVIEW_HANDOVER.md` §5 diff. A `StrictRouteError` or `QueueWaitTimeoutError` (any role), and any model failure of `qa_agent`, configured or not, now end the task FAILED with the full original message (no keyword rules). Other roles' model-failure text is kept up to 300 characters instead of 100. QA split across workers: a part that did not complete, or was not answered by its model, makes QA FAILED and is named. Every tool-loop result now carries `data.answeredBy` (`model`, `model_incomplete`, `keyword_rules`) and `data.modelUsed`. One addition to the approved diff: `answeredBy`, which the owner's request (a fallback must be distinguishable) needed; QA's worker check uses `answeredBy === 'model'`, so a worker that hit the step limit also counts as not checked |
| ★`bridge/modelRouter.ts` | **M-3:** a routed call's fallback (chat and stream) waits for the owner's conversation before every attempt, on the caller's signal; `JARVIS_MODEL_QUEUE_WAIT_MS` applies to each such wait and its error is not caught by the fallback. `categoryChat`'s failover attempts also wait, with the time limit paused while they wait. Foreground calls never wait (`yieldToForeground` returns 0). **M-2:** attempts are recorded per provider instance **and** model sent (case-insensitive; `openai` always counts as one pair, since it sends its own model). The route's own attempt is one provider; the fallback may ask the same provider again with the caller's model only after a model-specific failure (`model`, `bad_request`, `bad_response`). Any other failure (auth, network, rate limit, server, time-out, unrecognised) and any refusal (capability, open breaker, request limit) excludes the provider for the rest of the call. Strict routes never fall back (unchanged). **Lease:** every send site passes its `GuardTicket` to `noteSuccess` / `noteFailure`, and a cancelled call calls `noteCancelled(ticket)`. The unrouted path (no route set) is unchanged |
| `bridge/providerGuard.ts` (not protected) | `check()` returns a `GuardTicket`. Only the trial's own ticket can end the trial. A cancelled trial and a trial that fails with a non-rate-limit error free the lease (still half-open); a stalled trial's lease expires after the open period; a failure of an unrelated call leaves the lease alone |
| `bridge/modelCategories.ts` (not protected) | `agentIndependence()` compares effective targets (default → primary; `openai:<x>` → `JARVIS_FALLBACK_MODEL` or `gpt-4o-mini`; case-insensitive), and is false where the same model is possible (same pair; two Claude models, because of server-side fallbacks; the same provider as the primary when either side is the fast model, because of the in-adapter swap). Returns a `reason`. `observedAgentIndependence()` takes an optional `correlationId`, and returns `null` (unknown) without a successful call from both |
| `.env.example` | Policy text corrected: strict routes; ordinary fallback and when the same provider is asked again; what `answeredBy` means; QA never uses keyword rules; independence is neither checked nor enforced; the queue-wait limit applies per wait and its exact scope |

## Decision made inside the approval

The owner's M-2 text allows the same-provider retry except after "provider-wide failures such as authentication errors, network failures, rate-limit cooldown or an open circuit breaker". I chose the narrower rule: retry only after a failure known to be about the model, and treat everything else (server errors, time-outs, unrecognised errors too) as provider-wide. Reasons: an unrecognised error says nothing about the model, and this keeps the earlier M3 tests (`modelRouteCorrectionsTest`, a failure with no status) passing unchanged. The owner can widen it.

## Round 3: fixes after the independent review (`INDEPENDENT_REVIEW_ROUND3.md`)

The reviewer's verdict was APPROVE WITH CONDITIONS (no High, three Medium, eight Low). I re-checked every Medium finding and L1–L6 against the reviewer's probe output before changing anything. A new test, `tests/reviewRound3FixesTest.ts`, was written first: on the unfixed code it showed 4 passed and 13 failed, with the production file hashes unchanged (`evidence/round3-review-fixes/`).

| Finding | Decision | Change |
|---|---|---|
| M1: QA ends COMPLETED via keyword rules when its model returns empty text | **Fixed** | `toolLoop.ts` `runLoop`: an empty final answer from the `qa_agent` model throws `ModelUnavailableError` ("returned an empty answer…, so nothing was checked"). Other roles are unchanged (test: an unconfigured coding agent with an empty answer still uses keyword rules) |
| M2: a configured coding agent's split request goes to `code_analysis_worker` on the planning route and never reaches the configured coding model | **Not fixed: owner decision** (MM-1A-P8). Changing which model workers use is a routing-policy change outside this approval |  — |
| M3: the route's own time limit was not treated as provider-wide | **Fixed** | `modelRouter.ts` `routedChat`: after a `TimeoutError` from the route's own limit, that provider instance is excluded for the rest of the call. `.env.example` and this log were already worded this way; they are now true |
| L1: a configured coding agent out of model-call budget ran keyword rules | **Fixed** | `toolLoop.ts` `endsTask`: a `BudgetExceededError` ends the task when the agent's route is strict (`routeFor('planning', env, role).strict`). Unconfigured agents are unchanged (tested) |
| L2: `.env.example` said only agents without their own setting get keyword fallback | **Fixed (doc)** | names the two strict settings; a browser agent with its own setting can still end on keyword rules |
| L3: guard header overstated the lease | **Fixed (doc)** | `providerGuard.ts` header describes the late rate-limit and late-success cases. Behaviour unchanged |
| L4: a stream stopped by its consumer held a trial lease until it expired | **Fixed** | `streamFrom` and `primaryStream` call `noteCancelled(ticket)` in a `finally` when no outcome was reported |
| L5: a fallback wait's error lost the route's failure | **Fixed** | the queue-wait or abort error from a fallback wait carries the route's error as `cause` |
| L6: `(provider default)` counted as a model for independence | **Fixed** | `observedAgentIndependence` returns `null` (unknown) when either side was recorded without a model |
| L7: QA's own parts in a split request held to a weaker standard than its worker parts | **Not fixed; recorded.** Own parts already fail on any model failure and, after M1, on an empty answer. Only a part that hits the step limit is accepted. I could not trigger own parts in a test without changing the spawn policy | — |
| L8: unconfigured `categoryChat` calls wait before each failover attempt | **Accepted** (bounded; `.env.example` says code repair's calls are covered) | — |
| Q5 (reviewer probe, not a finding): QA's automatic check of another agent's result ends COMPLETED with no model | **Documented** in `.env.example` as a rule check, not AI verification (existing behaviour, `verify.ts`) | — |

No existing or earlier programme test was edited.

## Round 3: follow-up review of the fixes (`INDEPENDENT_REVIEW_ROUND3_FIXES.md`)

Verdict: APPROVE WITH CONDITIONS. All six code fixes were confirmed, and no new risk was found in the guard tickets, `withPriorCause`, the M3 exclusion or the `routeFor` call. There were two new findings; I confirmed both from the reviewer's probes A1 and A5.

| Finding | Decision | Change |
|---|---|---|
| N1 (Medium): a configured coding agent whose model returns empty text ends COMPLETED through keyword rules | **Fixed**, test first: a new N1 section in `tests/reviewRound3FixesTest.ts` failed 3 checks on the unfixed code (`evidence/round3-review-fixes/n1-fail-before.txt`) | `toolLoop.ts` `runLoop`: the empty-answer rule now applies to `qa_agent` and to any agent whose route is strict (the same `routeFor(...).strict` check as L1) |
| N2 (Low): `.env.example` said a configured coding agent always ends FAILED; split requests are the M2 exception | **Fixed (doc)** | `.env.example` names the exception (MM-1A-P8) |

The N1 fix has not been independently reviewed.

---

# Final cycle (owner's decisions after FINAL_HANDOVER_ROUND3.md)

The full account is in `FINAL_APPROVAL_REPORT.md`. In short:
- **Helper inheritance (decision 1):** implemented in `toolLoop.ts`, `modelCategories.ts`, `llmTypes.ts` and `modelRouter.ts` (one line). Test first: `strictHelperRoutingTest` (11 passed, 11 failed before).
- **Independence enforcement (item 2) and the verification issue (item 3):** investigated; proposals only (`proposals/PROPOSALS_ITEMS_2_3.md`). The proposal test showed 5 passed and 6 failed on the current code.
- **Final review (`INDEPENDENT_REVIEW_FINAL.md`):**
  - Fixed: M2 (independence uses the model agents really send; Gemini/Groq same-model rule) and L1 (a forged `inheritModelRoute` on a root task or another role is ignored). Test first: `finalReviewFixesTest` (2 passed, 8 failed before).
  - Proposal, needs protected `specialists.ts`: M1 (MM-1A-P9).
  - Documented: M3 and L3.
- **Last review (`INDEPENDENT_REVIEW_LAST.md`):** READY WITH CONDITIONS.
  - N3 fixed in `.env.example`.
  - N1 and N2 (Low) left open, so the reviewed source is the final source.
- **Retry policy:** kept as implemented.

---

# Gap closure (Gate 1 approved 2026-11-16; `GAP_CLOSURE_PLAN.md`)

The plan is in `GAP_CLOSURE_PLAN.md`; results are in `FINAL_APPROVAL_REPORT.md`. Every item was written test first: each new test was shown failing on the then-current tree and on the original `c4ac909`, then passing.

| Item | Change | Test |
|---|---|---|
| P9 + N1 | The agent manager decides a strict route by lineage (`strictRouteRole`, `lineageRoles`), never from task input; the input key was removed. `askJson` never falls back to rules on a strict lineage. Research propagates model failures and used-up budgets, and does not retry a failed strict worker. A model failure gets the code `MODEL_UNAVAILABLE` | `lineageInheritanceTest` |
| P3 | `exactModel` and the reported `model`. Gemini/Groq: no fast-model swap, no cooldown start, separate cache key. Claude: no server-side fallbacks, canonical id kept. Router: identity confirmed (fail closed); strict routes not streamed; a strict route that would be sent as another model is refused | `strictModelIdentityTest`, `claudePrimaryStrictTest` |
| N2 + P4 | `possibleTargets` (failover included). `qaIndependence` looks up identities. `JARVIS_QA_REQUIRE_INDEPENDENT`. QA gate before the first call and on each reply; `data.independence`; QA wording | `independentQaTest`, `gapReviewFixesTest` |
| P7 | `inconclusive` checks and verdict, also when the re-read worker may not be created or the source states no licence; the goal criterion; speech and console | `verificationInconclusiveTest` |
| D2 | Programme test stand-ins report `model: req.model`; no assertion changed (`evidence/gap-closure/d2-stand-in-changes.diff`) | — |

**Review `INDEPENDENT_REVIEW_GAP_CLOSURE.md`:** READY WITH CONDITIONS; 0 High, 2 Medium, 7 Low.
- **Fixed:**
  - M-A: identities compared, not names; Claude ids looked up before QA starts.
  - M-B: a strict route that would be sent as another model is refused; the check and the call agree.
  - L3: a used-up budget is propagated.
  - L4: `servedModel` is recorded in the usage records; docs and comments corrected.
  - L6: tests added for M-A, M-B, the Gemini tool-call report and the strict stream.
  - L7: comment placement.
  - Test first: `gapReviewFixesTest` and `claudePrimaryStrictTest` failed before the fixes (`evidence/gap-review-fixes/fail-before.txt`).
- **Not fixed; recorded for the owner:**
  - L1: a coding helper's own model setting is not counted as one of coding's models (documented in `.env.example`).
  - L2: an `inconclusive` result is still promoted to long-term memory. The change is outside the approved file list.
  - L5: a non-strict agent's model failure now has the code `MODEL_UNAVAILABLE` instead of `AGENT_ERROR` (goal failure signatures change).
- **Test edits after the review:**
  - `independentQaTest` now awaits `qaIndependence()`, which became async. Three `await`s were added and no assertion changed (`evidence/gap-review-fixes/independentQaTest-await.diff`).
  - `verificationInconclusiveTest`: one assertion in this new file was made precise to the actual reason text.
- **Incident:** before it was corrected, `claudePrimaryStrictTest` reached the real Claude adapter. It used a dummy key (`sk-ant-test-stand-in-…`); the request got 401, and no real key exists in this environment. The test now replaces that adapter with a stand-in, and the final runs contain no 401.

---

# Low-finding closure (Gate 1 approved 2026-11-16; `LOW_CLOSURE_PLAN.md`)

Tests were written first. On the reviewed source they gave:

| Test | Before the fixes | Covers |
|---|---|---|
| `errorClassificationTest` | 2 passed, 13 failed | L5, R3 |
| `memoryTrustTest` | 3 passed, 3 failed | L2 |
| `identityAliasTest` | 1 passed, 16 failed | R2, R4, L1 |
| `claudePrimaryTargetsTest` | 1 passed, 1 failed | R1 |

Evidence: `evidence/low-closure/fail-before.txt`. Production hashes were unchanged by the run.

**Changes:**
- **R3, L5: four conditions, end to end**
  - Agent tasks:
    - `MODEL_IDENTITY_UNCONFIRMED` is new. It comes from a `ModelIdentityError` under a StrictRouteError, or from QA's reply check when the reply has no model or a floating alias.
    - `BUDGET_EXCEEDED` keeps its code (tracked `agentRuntimeTest` asserts it) and now carries `budget`.
    - A worker's code is carried up unchanged (`PropagatedFailure`).
    - A strict research parent fails on a worker's model or model-budget failure, not on a tool budget.
  - Goals:
    - `goalExecutor` maps a tool budget to `TOOL_BUDGET_EXHAUSTED`, and an inconclusive or unfinished verification to `VERIFICATION_INCONCLUSIVE`.
    - `goalRecovery` maps the four codes before the text patterns: `dependency`, new `configuration` (blocked), `budget`, new `inconclusive` (needs review).
    - `goalFailureSignature` includes these codes, so their signatures differ.
- **L2:** a result that needed verification goes to long-term memory only when it was verified.
- **R1:** with Claude as primary, failover targets name the model the router really sends.
- **R2:**
  - `identityKey` folds case, `models/`, gateway `vendor/`, `:variant`, date stamps and `-NNN`.
  - Floating aliases (`-latest`) are unknown.
  - QA's reply check compares keys.
- **R4:**
  - Identity look-ups happen only when independence is required.
  - Each look-up is limited by `JARVIS_QA_IDENTITY_LOOKUP_MS`.
  - A failure is not repeated for 60 s.
- **L1:** a non-strict specialist's targets include the models of its helpers with their own setting (`HELPER_ROLES`, checked against the registry).

No existing test was edited. The four new files are this cycle's.

## Low-closure review fixes (`INDEPENDENT_REVIEW_LOW_CLOSURE.md`: NOT READY, M1)

A new test, `tests/lowReviewFixesTest.ts`, was written first. On the reviewed source it gave 2 passed, 8 failed; on `c4ac909` its three M1 checks fail and it then stops on a missing function (`evidence/low-closure/review-fixes-fail-before.txt`, `review-fixes-on-original-c4ac909.txt`).

**Changes:**
- **M1 (Medium):** a request split into parts now keeps its helpers' own condition. When QA, or an agent on a strict route, fails because a part was not done, the parent fails with the most specific code carried by a failed part (`PropagatedFailure`). A helper's tool budget therefore becomes `TOOL_BUDGET_EXHAUSTED` at goal level, and an unconfirmed identity becomes `MODEL_IDENTITY_UNCONFIRMED` (blocked). Parts answered by keyword rules or not finished by the model still give `MODEL_UNAVAILABLE`. The task still fails, so fail-closed behaviour is unchanged. (★`core/agents/behaviors/toolLoop.ts`)
- **L-4:** `mostSpecificFailure` (★`core/agents/behaviors/common.ts`) picks identity, then budget, then unavailable. The research parent uses it instead of the first worker's code (★`core/agents/behaviors/research.ts`).
- **L-1:** `identityKey` also folds a Bedrock `vendor.` or `region.vendor.` prefix (letters only), a `-vN` version after a number, and a dot between digits (`5.5` = `5-5`). `gpt-4.1` and `gpt-4o`, and `deepseek-v2` and `deepseek-v3`, keep different keys. Folding only makes more pairs "the same".
- **L-2:** `isFloatingAlias` also checks the name before `:variant` is stripped, so `llama3:latest` is floating.
- **L-6:** the tracker line is updated; `FINAL_APPROVAL_REPORT.md` is rewritten after the re-review. `.env.example` lists the recognised name forms and says not to give QA another provider's id for coding's model.

L-3 and L-5 are left as approved in the plan and documented in the final report. No existing test was edited.

## LR-2 and L-5 follow-up (Gate 1 approved 2026-11-17; `LR2_L5_PLAN.md`)

**Decisions:** option A for LR-2, option S for L-5, the L-5b label, and permission to change the assertion at `tests/memoryTrustTest.ts:51`. `core/agents/behaviors/research.ts` was not touched (hash unchanged).

**Tests written first:**

| Test | Unfixed tree | `c4ac909` |
|---|---|---|
| `mixedFailureCausesTest` | 5 passed, 12 failed | 4 passed, 13 failed |
| `unverifiedMemoryTest` | 7 passed, 10 failed | 5 passed, 12 failed |

Evidence: `evidence/lr2-l5/fail-before.txt` and `evidence/lr2-l5/new-tests-on-original-c4ac909.txt`.

**Corrections to `mixedFailureCausesTest` after its first fail-before run** (`evidence/lr2-l5/test-corrections-after-fail-before.diff`):
- **The reversed-order case.** It swapped which part's keyword rules call a tool, so both parts genuinely ran out of tool calls (diagnosed with a probe). It now reverses the request text and keeps each part's behaviour.
- **The "budget as the reason" check.** It matched each part's own error text, which the message must keep. It now checks recovery's own reason ("waiting", "the goal's budget is used up"), with an added positive check.
- **Re-run.** The corrected test fails 13 checks on the unfixed source (`evidence/lr2-l5/corrected-test-fail-before.txt`).

**Changes:**
- **LR-2:**
  - `failureCauses` and `leadingCause` (★`common.ts`) put the causes in recovery order: identity, then model unavailable, then budgets (model budgets before the tool budget).
  - A part with no carried code counts as the model not answering.
  - ★`toolLoop.ts` throws the leading cause together with every cause; `mostSpecificFailure` is no longer used there.
  - ★`types.ts` and ★`agentManager.ts` carry `causes` on the task error.
  - `goalExecutor` maps the causes to goal codes.
  - In `goalRecovery`:
    - a model cause decides the class;
    - the signature includes the other causes;
    - the action ends with "also: …".
- **L-5:** `promoteToMemory` (★`jarvisAgents.ts`) stores a result only when the verdict is `verified`. The console line names the task archive file that keeps the full result.
- **L-5b:** `goalRuntime.contextFor` marks a dependency's result "(not verified; do not store it as a fact)" unless it was verified.
- **Docs:** `.env.example` and tracker MM-1A-25.

**Changed with permission:** `memoryTrustTest.ts:51` now asserts that a never-verified result is not stored. No other existing test was edited.

## The save_relation path (owner request 2026-11-17; `LR2_L5_PLAN.md` §10; review `INDEPENDENT_REVIEW_LR2_L5.md` L-C, L-B, L-A)

**Audit:** see `LR2_L5_PLAN.md` §10.1.
- Only `memory_agent` among the agents holds `save_relation`, and no agent can spawn it.
- Unverified results could get in two ways: through the Memory agent in a goal, and through the main planner after it reads `goal_status`.

**Test written first:** `tests/saveRelationProvenanceTest.ts`. It gave 5 passed, 6 failed on the unfixed tree and the same on `c4ac909`, with the production hashes unchanged by the run (`evidence/save-relation/`).

**Changes (no protected file):**
- **`core/tools/memoryTool.ts`:** `unverifiedRelation()` makes `save_relation` refuse, storing nothing:
  - inside a goal (`getGoalContext()`);
  - with a request in flight, when an entity has a significant word that is not in that request's words (`getRequestText()`).

  Calls with no request in flight are unchanged. The refusal says why and asks the owner to say the fact.
- **`core/goalRuntime.ts`:** the "not verified" label comes before each summary, so the tool loop's 1,500-character cut never splits it (L-B).
- **`.env.example`:**
  - the archive exists unless `JARVIS_AGENT_ARCHIVE=0` (L-A docs);
  - a browser or PC result with conflicts is verified and may be stored;
  - the `save_relation` rule.

**Not done; needs protected-file approval (§10.3):**
- a delegated Memory task whose planner-written text pastes an agent's result;
- the L-A console text in `jarvisAgents.ts:304`.

## save_relation asks the owner (owner decision 2026-11-17; `LR2_L5_PLAN.md` §11; review `INDEPENDENT_REVIEW_SAVE_RELATION.md`)

**Test written first:** `tests/saveRelationConfirmTest.ts`, with a scripted owner answering the approval prompt. It gave 7 passed, 12 failed on the unfixed tree and 6 passed, 13 failed on `c4ac909` (`evidence/save-relation-confirm/`). Production hashes were unchanged by the run.

**Changes (no protected file):**
- **`core/tools/memoryTool.ts`:**
  - Inside a goal: refused, nobody asked (unchanged).
  - During a request: `approvalGate.requestApproval('Keep in long-term memory', "<exact fact>", …)`, naming the agent that asked. Stored only on "yes"; otherwise "you did not confirm …, so nothing was stored".
  - With no request in flight, and for a credential: unchanged.
  - The word check (`unverifiedRelation`) is removed. This closes review M-1, M-2, the choice case, path 3 and the false refusals of L-2.
- **`core/goalExecutor.ts` (L-3):** a completed step whose limitations show a refused or failed `save_relation` is a failure with class `inconclusive` and code `MEMORY_NOT_STORED`. The task needs review and the goal waits for the owner.
- **`.env.example`:**
  - the confirmation rule;
  - which agents' results can be verified (review L-1: QA results never are).

**Test setup added (no assertion changed):** `saveRelationProvenanceTest` now has a stand-in owner. It confirms only the two facts the owner said in that test and answers no to everything else. Without it, the real approval gate answers no in the test environment. The diff is in `evidence/save-relation-confirm/provenance-test-setup.diff`; no `ok(` line changed.

**Open Low (owner's choice):** the L-A console line in `core/agents/jarvisAgents.ts:304`, which is protected.

## Confirmation review fixes (`INDEPENDENT_REVIEW_SAVE_RELATION_CONFIRM.md`; `LR2_L5_PLAN.md` §12)

Fixed in unprotected files, with tests written first:
- **M-1:** what is shown is what is stored.
- **M-3:** a "no" is final.
- **M-2:** partly fixed; the answer window is inside the call limit and a late "yes" says so.
- **L-1, L-2, L-3, L-4.**

Details and evidence: `LR2_L5_PLAN.md` §12, `evidence/confirm-review-fixes/`. The rest of M-2 needs a protected file and waits for the owner (§12.1). No protected file changed.

## M-2 in the registry (owner Gate 1 approval 2026-11-17; `LR2_L5_PLAN.md` §12.2)

**Test written first:** `tests/saveRelationTimeBudgetTest.ts`. On the unpatched registry it gave 3 passed, 4 failed (`evidence/m2-registry/fail-before.txt`):
- a "yes" after 26 s was recorded as approved, but nothing was stored;
- a stopped call's question was recorded as approved.

**Patch (exactly §12.2, `evidence/m2-registry/source.diff`):**
- ★`core/toolRegistryV2.ts`:
  - `AgentTool.asksOwner?: boolean`;
  - a low-risk tool with `asksOwner` runs through `toolExecutionSandbox.run()`, as medium- and high-risk tools already do.
- `core/tools/memoryTool.ts`: `save_relation` sets `asksOwner: true`.

Every other low-risk tool is unchanged; the test checks this as a control.

**After:**
- `saveRelationTimeBudgetTest`: 7/7.
- 33 related tests pass: the approval-gate, nested-approval, late-outcome, kernel-outcome and registry tests, and every save_relation and goal test.
- `.env.example` notes that the question does not count against the tool's time.

**Full suite after these fixes (`evidence/final-review/after-ci.txt`):** 259 files, 248 passed, 1 failed, 1 blocked, 9 skipped.
- **The failure:** `boundaryDoublesTest`, a pre-existing guard. It requires every test that stands in for the speech boundary to be listed in `tests/boundary-doubles.json`, and the new `saveRelationAskOnceTest` used `installFakeTts` without being listed.
- **Fix:** the test no longer uses the speech stand-in; it never checked speech. The tracked list was not edited.
- **Still fails on the pre-fix code:** asked 3 times (`evidence/final-review/ask-once-without-speech-stand-in-fail-before.txt`).
- **Diff:** `ask-once-speech-stand-in-removed.diff`, with no assertion line changed.
- **Hashes:** this test file changed after the final review started; no production source did.

## The final review's nine Lows (owner decision 2026-11-17; `LR2_L5_PLAN.md` §13)

All nine are fixed in unprotected files (`core/tools/memoryTool.ts`, `core/goalExecutor.ts`, `.env.example`), with tests written first:
- `saveRelationLowFixesTest`: 6 passed, 21 failed before; 27/27 after.
- `saveRelationRepliesTest`: 0 passed, 3 failed before; 3/3 after.

Both tests also fail on `c4ac909`. 37 related tests pass, including `boundaryDoublesTest`, and no protected file changed. Details are in the plan, §13.

## Final review (`INDEPENDENT_REVIEW_FINAL_LOWS.md`) and close-out (2026-11-17)

- **Verdict:** READY WITH CONDITIONS, 0 High, 0 Medium. L-1 to L-9 are resolved; L-7 and L-8 only partly. Five new Lows (LL-1 to LL-5), all fail-safe.
- **Full suite on the final source:** 261 files, 251 passed, 0 failed, 1 blocked, 9 skipped. All 231 baseline verdicts are unchanged.
- **Source hashes after the review:** all 86 match.
- **Owner decision:** "Accept, fix docs, report".
  - LL-1 to LL-4 are documented in `FINAL_APPROVAL_REPORT.md` §7.
  - LL-5: `.env.example` now matches the code (`evidence/final-lows/env-example-after-review.diff`). This is the only change after the review, and it is docs only.
