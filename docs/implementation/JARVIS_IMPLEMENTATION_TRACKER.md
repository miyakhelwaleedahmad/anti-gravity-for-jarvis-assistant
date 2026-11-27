# JARVIS Implementation Tracker — Multi-Model, Decision, Vision Programme

> **Temporary.** Remove only when every condition in "End-of-programme cleanup" (bottom) is met.
> **Scope:** only the multi-model / JEV / code-engineering / vision programme started on 2026-11-15.
> Other findings stay in their own homes and are linked, never copied (`ai_workflows/_config/SOURCES_OF_TRUTH.md`).
> **Branch:** `claude/jarvis-repair`. `main` is not touched. Nothing is committed, pushed or merged without the owner's approval.

## Linked trackers (not duplicated here)

| Category | Home |
|---|---|
| 2026-10 audit findings (54 IDs) | `docs/audit/JARVIS_REPAIR_CHECKLIST.md` |
| Other development findings, PC-nn | `docs/remediation/REMEDIATION_TRACKER.md` |
| Voice findings | `docs/audit/VOICE_AUDIT_CHECKLIST.md` |
| One maintenance run (stages 01–07) | `ai_workflows/runs/<date>_<slug>/` |
| Runtime failures | `data/repairs/issues.json` on the owner's PC |

## Objective

Make JARVIS a supervised multi-model assistant: Gemini for conversation, OpenAI for research, a decision provider (Jev, once verified) for structured advice, Claude for software engineering, independent QA, and local camera perception. Keep `toolRegistryV2` → `riskEngine` → `approvalGate` as the only path to action, and keep JARVIS local-first and cost-efficient.

## Target architecture

See the Gate 0 report, §14 (delivered to the owner 2026-11-15; not in the repository). It is summarised here once the phases make it real; this file records only what the code actually does.

## Status values

`NOT_STARTED` · `INVESTIGATING` · `BLOCKED` · `READY_FOR_APPROVAL` · `APPROVED` · `IMPLEMENTING` · `VERIFYING` · `COMPLETE`.
COMPLETE needs implementation **and** test evidence **and** the approvals; a PC-only behaviour also needs the owner's PC check.

## Phases

| Phase | Status | Gate |
|---|---|---|
| 0 Read-only audit | COMPLETE | approved by the owner 2026-11-15 |
| 1A Gateway foundation | VERIFYING | implemented and tested on Linux; waits for the owner's review, the independent review (05b) and the owner's PC check. Run: `ai_workflows/runs/2026-11-15_phase1a-model-gateway/` |
| 1B Providers (Gemini, OpenAI research, Claude routes) | BLOCKED | waits for 1A implemented, tested and reviewed (owner condition), and docs verification (MM-004) |
| 2 Decisions and arbitration | NOT_STARTED | — |
| 3 Claude software engineering | NOT_STARTED | — |
| 4 Self-healing improvements | NOT_STARTED | — |
| 5 Camera and vision | NOT_STARTED | needs the PC hardware readings first |
| 6 Adaptive infographics | NOT_STARTED | — |
| 7 Observability | NOT_STARTED | — |
| 8 System verification on the PC | NOT_STARTED | — |

## Problems found at Gate 0 (IDs used by the tasks below)

| ID | Problem | Evidence | Label |
|---|---|---|---|
| G0-01 | Role routing is applied only by code repair; every other caller's category is a label | `core/orchestrator.ts:1424,1737,1777,1813,1974,2008`; `core/agents/agentManager.ts:1248`; `core/reflectionEngine.ts:206,366`; `core/goalPlanner.ts:140`; `core/goalVerifier.ts:138` | VERIFIED |
| G0-02 | Gemini/Groq client keeps breaker, cooldowns, cache, in-flight map as static fields | `bridge/groqProvider.ts:141-182` | VERIFIED (latent: one instance today) |
| G0-03 | Claude and the OpenAI fallback have no circuit breaker; no per-provider request limit | `bridge/anthropicProvider.ts`, `bridge/openaiProvider.ts`, `bridge/modelRouter.ts` | VERIFIED |
| G0-04 | No provider capability model; Claude adapter drops image parts silently | `bridge/llmTypes.ts:66-68`; `bridge/anthropicProvider.ts:45-49` | VERIFIED |
| G0-05 | Usage records in memory only (last 500), lost on restart | `bridge/modelCategories.ts:116-147` | VERIFIED |
| G0-06 | coding_agent and qa_agent use the same route as every agent ('planning') | `core/agents/agentManager.ts:1248` | VERIFIED |
| G0-07 | A named-provider category call skips the foreground gate | `bridge/modelRouter.ts:116-139` vs `:191-201` | VERIFIED |
| G0-08 | `streamChat` ignores the category | `bridge/modelRouter.ts:246-281` | VERIFIED |
| G0-09 | Code repair can change protected runtime files (not in `FORBIDDEN_PATHS`) | `core/worktreeExecutor.ts:58-69` | VERIFIED → Phase 3 |
| G0-10 | Code repair writes whole files (16k-token cap) | `core/codeRepair.ts:146` | VERIFIED → Phase 3 |
| G0-11 | "Fails before" accepts any failure, including a compile error | `core/codeRepair.ts:174-187` | VERIFIED → Phase 3 |
| G0-12 | No camera, detector, tracker or object memory | `vision/` | VERIFIED → Phase 5 |
| G0-13 | Owner PC: 2010 iMac, no AVX, likely no DX12 GPU | `docs/history/FINAL_REPORT.md` §13 | DOCUMENTED → Phase 5 |
| G0-14 | `data/usage/` not in `.gitignore` (needed once usage is persisted) | `.gitignore` | VERIFIED → MM-1A-05 |
| G0-15 | Recent voice fixes not verified on the PC | commits `571b6d2`, `50512d8`, `bbed50f` | VERIFIED → owner PC check |

## Tasks

### Phase 0

| ID | Task | Status | Evidence |
|---|---|---|---|
| MM-001 | Read-only Gate 0 audit | COMPLETE | report delivered 2026-11-15; owner approval 2026-11-15 |
| MM-002 | Create this tracker and register it | COMPLETE | this file; row in `ai_workflows/_config/SOURCES_OF_TRUTH.md` (uncommitted) |
| MM-003 | Request access to the official docs | BLOCKED | personal environment "JARVIS multi-model docs" created with `ai.google.dev`, `developers.openai.com`, `jevapi.io`; this running session cannot move onto it. A session started on that environment can read them. `jevapi.io` is not confirmed as Jev's first-party docs host. |
| MM-004 | Verify Gemini, OpenAI and Jev facts from first-party docs | BLOCKED by MM-003 | facts so far are from search snippets only (Gate 0 report §16) |

### Phase 1A — gateway foundation (implemented, reviewed, corrected; uncommitted)

Each task's problem, root cause, before/after behaviour, files, tests and risks are in the plan. Here: status and evidence only.

| ID | Task | Fixes | Files (★ protected) | Status | Tests required | Tests run / evidence |
|---|---|---|---|---|---|---|
| MM-1A-01 | Configured category routes applied by `chat()` and `streamChat()`; defaults unchanged | G0-01, G0-08 | ★`bridge/modelRouter.ts`, `bridge/modelCategories.ts`, `bridge/llmTypes.ts` | VERIFYING | new `modelRoleRoutingTest`; existing routing group | new test FAIL→PASS; `--ci` at the end of Phase 1A: 241 files, 231 passed, 0 failed (`evidence/final-review-fixes/after-ci.txt`) |
| MM-1A-02 | Named-provider calls honour the foreground gate | G0-07 | ★`bridge/modelRouter.ts` | VERIFYING | `modelRoleRoutingTest`; `foregroundPriorityTest` | `modelRoleRoutingTest` §7 FAIL→PASS; `foregroundPriorityTest` PASS; scope narrowed: waits only for a provider the conversation uses (`change_log.md`) |
| MM-1A-03 | Per-provider breaker and optional request limit; Gemini/Groq client state per instance | G0-02, G0-03 | ★`bridge/groqProvider.ts`, ★`bridge/modelRouter.ts`, new `bridge/providerGuard.ts` | VERIFYING | new `providerIsolationTest`; `llmClientBehaviourTest`, `providerHealthTest`, `llmCancellationTest` unchanged | `providerIsolationTest` FAIL→PASS; existing Groq/Gemini tests PASS unchanged |
| MM-1A-04 | Provider capabilities; unsupported input refused, not silently dropped | G0-04 | `bridge/llmTypes.ts`, ★`bridge/anthropicProvider.ts`, `bridge/openaiProvider.ts`, ★`bridge/groqProvider.ts`, ★`bridge/modelRouter.ts` | VERIFYING | new `providerCapabilitiesTest`; `claudeProviderTest` | `providerCapabilitiesTest` FAIL→PASS; `claudeProviderTest` PASS |
| MM-1A-05 | Usage records persisted across restarts | G0-05, G0-14 | new `bridge/usageLedger.ts`, `bridge/modelCategories.ts`, `.gitignore` | VERIFYING | new `usageLedgerTest`; `modelRoutingTest` | `usageLedgerTest` FAIL→PASS (restart via a child process) |
| MM-1A-06 | coding_agent and qa_agent configurable separately; independence enforced for QA work when required since the gap closure (MM-1A-P4) | G0-06 | ★`core/agents/agentManager.ts` (1 line), `bridge/modelCategories.ts` | VERIFYING | `modelRoleRoutingTest`; `sevenAgentTest`, `agentSpecialistsTest`, `agentRuntimeTest` | `modelRoleRoutingTest` §5 FAIL→PASS through the real AgentManager; agent tests PASS |
| MM-1A-07 | Docs: `.env.example`, this tracker, run record | — | `.env.example`, run folder | VERIFYING | `docsHygieneTest` | `.env.example`, `.gitignore`, run record; `docsHygieneTest` PASS |
| MM-1A-08 | M1: waiting for the conversation does not use up a route's time limit; `JARVIS_MODEL_QUEUE_WAIT_MS` | review M1 | ★`bridge/modelRouter.ts`, `bridge/modelCategories.ts` | VERIFYING | `modelRouteCorrectionsTest` M1 a–g | FAIL→PASS (`evidence/corrections/`) |
| MM-1A-09 | M2/M4: strict routes for coding, review (code repair, goalVerifier), coding_agent, qa_agent, even as a bare model; `StrictRouteError` with the original reason | review M2, M4 | ★`bridge/modelRouter.ts`, `bridge/modelCategories.ts`, `.env.example` | VERIFYING | `modelRouteCorrectionsTest` M2/M4 | FAIL→PASS |
| MM-1A-10 | M3: a routed call asks each provider once, even under two names; clear error when all failed | review M3 | ★`bridge/modelRouter.ts` | VERIFYING | `modelRouteCorrectionsTest` M3 | FAIL→PASS |
| MM-1A-11 | Independence: effective targets, and the models really used (`observedAgentIndependence`) | review M4, L7 | `bridge/modelCategories.ts` | VERIFYING | `modelRouteCorrectionsTest` M4 | FAIL→PASS; used by the QA gate since the gap closure (MM-1A-P4) |
| MM-1A-12 | L1: one trial call after the open period (lease); L4: restart reads rotated files | review L1, L4 | `bridge/providerGuard.ts`, `bridge/usageLedger.ts` | VERIFYING | `providerIsolationTest` §6, `usageLedgerTest` §8–9 | FAIL→PASS (§9 passed before: already safe) |
| MM-1A-13 | Test gaps: abort during a pending call, route time limit, stream-path refusals, network error | review §6 | tests only | VERIFYING | `modelRoleRoutingTest` §4, `modelRouteCorrectionsTest`, `providerIsolationTest` §6 | PASS |
| MM-1A-14 | Independent review of the corrections | — | — | COMPLETE | — | `INDEPENDENT_REVIEW_CORRECTIONS.md`: APPROVE WITH CONDITIONS; handover `REVIEW_HANDOVER.md` |
| MM-1A-15 | M-3: every fallback attempt of a background routed call waits for the conversation (caller's signal; queue-wait per wait; foreground never waits) | review M-3 | ★`bridge/modelRouter.ts` | VERIFYING | new `modelRouteRound3Test` M-3 | FAIL→PASS (`evidence/round3/`); the stream check is structural (passes on the old code too) |
| MM-1A-16 | M-2: de-duplicate by provider and model; same provider again only after a model-specific failure; strict routes never fall back | review M-2; owner decision 2026-11-15 | ★`bridge/modelRouter.ts`, `.env.example` | VERIFYING | `modelRouteRound3Test` M-2; `modelRouteCorrectionsTest` M3 unchanged | FAIL→PASS; earlier M3 checks still PASS |
| MM-1A-17 | M-1 independence (effective targets, case, fast model, Claude fallbacks, correlation id, unknown = null); M-5 `.env.example`; L-1 trial lease with tickets (cancel, failure, expiry) | review M-1, M-5, L-1 | `bridge/modelCategories.ts`, `.env.example`, `bridge/providerGuard.ts`, ★`bridge/modelRouter.ts` (ticket wiring) | VERIFYING | `modelRouteRound3Test` lease and independence | FAIL→PASS; the QA gate uses it since the gap closure (MM-1A-P4) |
| MM-1A-18 | MM-1A-P1: QA's tool-loop work (not its rule-based check of other results) never ends COMPLETED without its model, including an empty model answer; strict and queue-wait failures, and a configured coding agent's used-up budget, end the task FAILED; full reason kept; `data.answeredBy` / `data.modelUsed` on every tool-loop result | review H-1; owner approval 2026-11-15 | ★`core/agents/behaviors/toolLoop.ts` | VERIFYING | new `qaModelFailureTest`; `agentSpecialistsTest`, `sevenAgentTest`, `agentRuntimeTest`, `jarvisAgentIntegrationTest`, `goalAgentIntegrationTest` unchanged | FAIL→PASS; existing agent tests PASS |
| MM-1A-19 | Independent review of round 3 | — | — | COMPLETE | — | `INDEPENDENT_REVIEW_ROUND3.md`: APPROVE WITH CONDITIONS |
| MM-1A-21 | Helpers inherit a configured coding_agent / qa_agent strict route (`routeAs`, `inheritedRoute`); a strict parent (and QA) fails when any part failed or was not answered by its model, own parts included (closes round-3 L7); unconfigured split behaviour unchanged | owner decision 2026-11-15 (P8) | ★`core/agents/behaviors/toolLoop.ts`, ★`bridge/modelRouter.ts` (1 line), `bridge/modelCategories.ts`, `bridge/llmTypes.ts`, `.env.example` | VERIFYING | new `strictHelperRoutingTest` | FAIL before (11 passed, 11 failed) → PASS (`evidence/final-cycle/`) |
| MM-1A-23 | Final review fixes: M2 (independence uses the model agents really send; two models on the Gemini/Groq client not independent), L1 (a forged inheritModelRoute on a root task or on another role is ignored; inheritance is checked by helper role, not by which agent spawned it: last review N1, open); doc fixes M3, L3 and the research gap | `INDEPENDENT_REVIEW_FINAL.md` | `bridge/modelCategories.ts`, ★`core/agents/behaviors/toolLoop.ts`, `.env.example`, this tracker | VERIFYING | new `finalReviewFixesTest` | FAIL before (2 passed, 8 failed) → PASS (`evidence/final-review-fixes/`) |
| MM-1A-24 | Low-finding closure: L1 helper settings counted; L2 only verified results to long-term memory; L5/R3 distinct codes (MODEL_UNAVAILABLE, MODEL_IDENTITY_UNCONFIRMED, TOOL_BUDGET_EXHAUSTED, VERIFICATION_INCONCLUSIVE) through goal recovery; R1 Claude-primary target names; R2 identity keys and floating aliases; R4 bounded, required-only identity look-ups | `LOW_CLOSURE_PLAN.md`; owner approval 2026-11-16 (D-1 pause for review) | `bridge/modelCategories.ts`, ★`bridge/modelRouter.ts`, ★`core/agents/{types,agentManager,jarvisAgents}.ts`, ★`core/agents/behaviors/{common,research,toolLoop}.ts`, `core/goal{Executor,Recovery,Lifecycle}.ts`, `.env.example` | VERIFYING | new `errorClassificationTest`, `memoryTrustTest`, `identityAliasTest`, `claudePrimaryTargetsTest`, `lowReviewFixesTest` (review M1, L-1, L-2, L-4) | FAIL before → PASS (`evidence/low-closure/`) |
| MM-1A-25 | LR-2: a split request keeps every distinct failure cause; a model cause leads over a budget, so recovery never waits for budget when a model did not answer. L-5: only verified agent results go to long-term memory (option S); unverified ones stay in the task archive; L-5b: goal context marks unverified results | `LR2_L5_PLAN.md`; owner approval 2026-11-17 (option A, option S, L-5b) | ★`core/agents/behaviors/{common,toolLoop}.ts`, ★`core/agents/{types,agentManager,jarvisAgents}.ts`, `core/goal{Recovery,Executor,Runtime}.ts`, `.env.example` | VERIFYING | new `mixedFailureCausesTest`, `unverifiedMemoryTest`; `memoryTrustTest:51` changed with owner permission | FAIL before → PASS (`evidence/lr2-l5/`) |
| MM-1A-26 | save_relation path (review L-C): stores nothing inside a goal, and otherwise only a fact in the words of the request it serves; L-B label first in goal context; L-A docs | `LR2_L5_PLAN.md` §10; owner request 2026-11-17 (no protected file) | `core/tools/memoryTool.ts`, `core/goalRuntime.ts`, `.env.example` | VERIFYING | new `saveRelationProvenanceTest` | FAIL before (5 passed, 6 failed) → PASS (`evidence/save-relation/`) |
| MM-1A-27 | save_relation keeps only what the owner confirms (approval prompt with the exact fact; nothing inside goals); closes review M-1, M-2, the choice case and path 3. L-3: a goal step whose save_relation failed needs review (MEMORY_NOT_STORED) | `LR2_L5_PLAN.md` §11; owner decision 2026-11-17 (no protected file) | `core/tools/memoryTool.ts`, `core/goalExecutor.ts`, `.env.example` | VERIFYING | new `saveRelationConfirmTest`; setup added to `saveRelationProvenanceTest` (no assertion changed) | FAIL before (7 passed, 12 failed) → PASS (`evidence/save-relation-confirm/`) |
| MM-1A-28 | Confirmation review fixes: M-1 shown = stored (length, line breaks, invisible characters; voice needs typed for long facts), M-3 a "no" is final, M-2 answer window inside the call limit (rest needs a protected file), L-1 to L-4 | `LR2_L5_PLAN.md` §12 | `core/tools/memoryTool.ts`, `core/goalExecutor.ts`, `.env.example` | VERIFYING | new `saveRelationConfirmReviewTest`, `saveRelationAskOnceTest` | FAIL before → PASS (`evidence/confirm-review-fixes/`) |
| MM-1A-29 | M-2: a low-risk tool that asks the owner (`asksOwner`; only save_relation) runs under the sandbox's pausable call budget; its question no longer counts against its time, and a stopped call withdraws it | `LR2_L5_PLAN.md` §12.2; owner Gate 1 approval 2026-11-17 for ★`core/toolRegistryV2.ts` | ★`core/toolRegistryV2.ts`, `core/tools/memoryTool.ts`, `.env.example` | VERIFYING | new `saveRelationTimeBudgetTest` | FAIL before (3 passed, 4 failed) → PASS (`evidence/m2-registry/`) |
| MM-1A-30 | Final review Lows L-1 to L-9: markdown by voice needs a typed answer; invisible and split-credential facts refused; a "no" reported as APPROVAL_DENIED; one question per fact per task or request (no repeat asks, no double store, retry after a store error without asking); goal-step classifier; partial undo; docs | `LR2_L5_PLAN.md` §13; owner decision 2026-11-17 | `core/tools/memoryTool.ts`, `core/goalExecutor.ts`, `.env.example` | VERIFYING | new `saveRelationLowFixesTest`, `saveRelationRepliesTest` | FAIL before → PASS (`evidence/final-lows/`) |
| MM-1A-22 | Retry policy kept as implemented (same provider again only after a model-specific failure; route time-out, auth, network, rate limit, server, unrecognised and refusals are provider-wide) | owner decision 2026-11-15 | `.env.example` | COMPLETE | `modelRouteRound3Test`, `reviewRound3FixesTest` | documented in `.env.example` |
| MM-1A-20 | Review fixes M1, M3, L1, L4, L5, L6, N1 (configured coding agent, empty answer); doc fixes L2, L3, N2 | review round 3 | ★`core/agents/behaviors/toolLoop.ts`, ★`bridge/modelRouter.ts`, `bridge/modelCategories.ts`, `bridge/providerGuard.ts` (comment), `.env.example` | VERIFYING | new `reviewRound3FixesTest` | FAIL before (4 passed, 13 failed; N1: 17 passed, 3 failed) → PASS (`evidence/round3-review-fixes/`); follow-up review `INDEPENDENT_REVIEW_ROUND3_FIXES.md`: APPROVE WITH CONDITIONS; N1 fix not re-reviewed |

**Proposals waiting for the owner (not done; protected or outside the M1–M3 approval):**

| ID | Proposal | File(s) | Status |
|---|---|---|---|
| MM-1A-P1 | QA never ends COMPLETED without its model (exact diff in `REVIEW_HANDOVER.md` §5) | ★`core/agents/behaviors/toolLoop.ts` | APPROVED, implemented as MM-1A-18 |
| MM-1A-P2 | goalVerifier keeps the review's failure reason in the check's evidence | `core/goalVerifier.ts:132-158` | READY_FOR_APPROVAL |
| MM-1A-P3 | Strict in-adapter model routing: exact model on strict routes (no Gemini/Groq fast-model swap or cooldown start, no reuse of a non-strict cached reply, no Claude server-side fallbacks); adapters return the reported model; the router accepts a strict reply only when the reported identity matches (fail closed); strict routes not streamed; a strict route that would be sent as another model is refused | ★`bridge/groqProvider.ts`, ★`bridge/anthropicProvider.ts`, `bridge/openaiProvider.ts`, `bridge/llmTypes.ts`, ★`bridge/modelRouter.ts` | VERIFYING: `strictModelIdentityTest`, `claudePrimaryStrictTest`, `gapReviewFixesTest` (fail-before on c4ac909 and on the pre-fix tree; `evidence/gap-closure/`, `evidence/gap-review-fixes/`). Live provider model strings: PC check |
| MM-1A-P4 | Independent QA enforcement: `JARVIS_QA_REQUIRE_INDEPENDENT` (true / false / unset = required when QA has its own setting); fail closed before any model call and after a reply that reports no model or one of coding's; identities compared (alias and dated id); `data.independence`; QA wording | ★`core/agents/behaviors/toolLoop.ts`, ★`bridge/modelRouter.ts`, `bridge/modelCategories.ts`, ★`core/agents/specialists.ts` | VERIFYING: `independentQaTest`, `gapReviewFixesTest` |
| MM-1A-P5 | Router follow-ups L5 (dashboard text), L6 (refuse document/audio parts), L8 (refusal records on streams), L9 (time limit on routed streams) | ★`bridge/modelRouter.ts` | READY_FOR_APPROVAL |
| MM-1A-P6 | Add `bridge/modelCategories.ts`, `bridge/providerGuard.ts`, `bridge/usageLedger.ts` to `RUNTIME_PROTECTED_FILES.md`; code repair's `FORBIDDEN_PATHS` (G0-09, Phase 3) | docs, Phase 3 | READY_FOR_APPROVAL |
| MM-1A-P8 | Helpers of a configured coding_agent / qa_agent inherit its strict route (owner decision 2026-11-15); implemented as MM-1A-21 | ★`core/agents/behaviors/toolLoop.ts`, `bridge/modelCategories.ts`, `bridge/llmTypes.ts`, ★`bridge/modelRouter.ts` | APPROVED, implemented as MM-1A-21 |
| MM-1A-P9 | Research-path inheritance: the research flow keeps its workers; on a strict coding lineage every model call uses the coding model, `askJson` never falls back to rules, model failures and used-up budgets fail the parent, failed model workers are not retried | ★`core/agents/behaviors/common.ts`, ★`core/agents/behaviors/research.ts`, ★`core/agents/agentManager.ts`, ★`core/agents/agentContextApi.ts` | VERIFYING: `lineageInheritanceTest`, `gapReviewFixesTest` (L3) |
| MM-1A-N1N2 | N1: inheritance by lineage from the registry, never task input (the input key is gone). N2: `possibleTargets` lists every model an agent can be answered by, failover included | ★`core/agents/agentManager.ts`, ★`core/agents/agentContextApi.ts`, ★`core/agents/behaviors/toolLoop.ts`, `bridge/modelCategories.ts`, ★`bridge/modelRouter.ts` | VERIFYING: `lineageInheritanceTest`, `independentQaTest` |
| MM-1A-P7 | Verification reliability: a re-read that did not happen (unreachable, worker not completed, not allowed, spawn error, no licence to compare) is `inconclusive`, never passed, with the full reason; goal `verified` criterion met only by verified results; spoken and console wording | ★`core/agents/behaviors/verify.ts`, ★`core/agents/jarvisAgents.ts`, `core/goalVerifier.ts` | VERIFYING: `verificationInconclusiveTest` |

## Model integration status

| Provider / role | Status |
|---|---|
| Gemini conversation | routable (`JARVIS_MODEL_CONVERSATION`, non-strict) since Phase 1A; model IDs unverified (MM-004); no live call made |
| OpenAI research | NOT FOUND (generic Chat Completions fallback only; Responses API is Phase 1B) |
| Claude coding / review | code repair (`JARVIS_MODEL_CODING` / `REVIEW`, strict) and agents (`JARVIS_MODEL_AGENT_CODING_AGENT` / `QA_AGENT`, strict; helpers inherit) since Phase 1A; no live call made |
| Independent QA | Enforced when required (`JARVIS_QA_REQUIRE_INDEPENDENT`; unset = when QA has its own setting) since the gap closure; a coding helper's own setting is counted (MM-1A-24); identity compared by key (the forms listed in `.env.example` fold, including gateway `vendor/` and Anthropic-style Bedrock ids; a Vertex `-vN@date` after a word and other vendors' Bedrock versions do not; floating aliases are unknown); live identity strings: PC check |
| Decision provider (Jev) | NOT FOUND; first-party API not verified |

## Vision and camera status

No camera code. Phase 5 starts with the PC hardware readings (Gate 0 report §20).

## Self-healing status

Three levels exist in code (`core/repairRun.ts`, `core/codeRepair.ts`); Phase 4 not started. No change is planned to the approval gate or self-healing security in Phase 1A.

## Outstanding issues

- G0-09 … G0-13 belong to later phases. G0-15 needs the owner's PC.
- Accepted (documented): L2, a non-rate-limit error does not reset the breaker count (the Gemini/Groq client's own rule). L3, synchronous ledger I/O, measured on Linux at 6.5 ms for the first read of a full 2 MB file and 0.011 ms per append; still to be measured cold on the owner's hard disk.
- 1A follow-ups (not regressions):
  - An explicit route time limit is not applied to streamed routes (MM-1A-P5).
  - `AnthropicProvider.lastStreamUsage` is per instance, so two concurrent Claude streams can swap token counts (pre-existing).
  - Usage records are not yet shown anywhere (Phase 7).

## Owner decisions and approvals

| Date | Decision | Owner's words (short) |
|---|---|---|
| 2026-11-15 | Gate 0 approved with conditions; Phase 1 split into 1A and 1B | "Gate 0 is approved, subject to the following conditions" |
| 2026-11-15 | Protected files: inspect and plan only; each change approved separately after files/functions, before/after, tests, risks, rollback are given | "I will review and approve the specific changes separately." |
| 2026-11-15 | Tracker approved; register in SOURCES_OF_TRUTH; link, don't duplicate | "Approved." |
| 2026-11-15 | Phase 1A approved with conditions: the four protected files within the plan's scope only; four new tests, fail-before on unchanged code first; `pnpm install --frozen-lockfile` with the lockfile unchanged; stop at any unexpected failure; no 1B | "You have conditional approval to begin Phase 1A." |
| 2026-11-15 | Review accepted; fix M1–M3 in `bridge/modelRouter.ts` only; M4: QA, coding_agent and goalVerifier fail rather than fall back; fix the test gaps and correctness-affecting L1–L10, measure L3 | "I approve fixing M1, M2 and M3 in `bridge/modelRouter.ts`"; "QA must fail rather than silently fall back" |
| 2026-11-15 | Round 3 approved: toolLoop QA failure (P1), M-3, M-2 (provider+model de-duplication; no retry after provider-wide failures; strict roles never fall back), independence by effective model (no enforcement claim), trial lease, docs; a new independent review | (summary, not a quote) QA is never COMPLETED just because keyword tools succeeded; no commit, push or Phase 1B |
| 2026-11-15 | Phase 1A not approved for commit yet. Helpers inherit the configured coding/QA model (else no split); independence enforcement and the verify.ts issue: proposals only; keep the conservative retry policy; a fresh review after the last change; FINAL_APPROVAL_REPORT.md | (summary, not a quote) |
| 2026-11-16 | Gate 1 for the gap closure approved: P3, P4, P7, P9, N1, N2; decisions D1–D5 (`GAP_CLOSURE_PLAN.md`) | "I approve proceeding with the six approved gap closures." |
| 2026-11-16 | Low-finding closure plan approved ("Approve plan"); D-1: an inconclusive verification pauses the goal for review | approval prompt |
| 2026-11-15 | Standing rules: no test weakening, no broad rewrites, no unneeded dependencies or paid services, local-first, keep approval gate and self-healing security, code repair never edits protected files without approval, `main` untouched, no commit/push/merge without approval, no 1B before 1A is implemented, tested and reviewed | "Additional requirements" |

## Final acceptance criteria

Part 15 of the master prompt (routing, decision, coding, vision, security, voice tests), each with its command, machine and result, plus the owner's PC checks for voice, camera and Windows behaviour.

## End-of-programme cleanup

Delete this file only when: every approved task is COMPLETE; nothing is BLOCKED or INVESTIGATING; applicable tests pass; the PC checks are done or recorded as unavailable; security and approval are intact; the final report exists; permanent architecture docs describe the real implementation; evidence and run records are kept. Report the deletion in the final report. Until then, keep it.
