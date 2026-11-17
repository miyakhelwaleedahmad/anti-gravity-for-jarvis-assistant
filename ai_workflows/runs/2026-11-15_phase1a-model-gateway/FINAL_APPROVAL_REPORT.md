# Final approval report: Phase 1A (model gateway)

> Branch `claude/jarvis-repair`, base `c4ac909`. Nothing committed, pushed or merged; `main` untouched. No Phase 1B work.
> **All verification here ran on Linux in a cloud container with stand-in providers.**
> **Windows PC verification: PENDING. Live-provider verification: PENDING.** Nothing has been run on the owner's Windows PC or against a live provider (§9, `WINDOWS_VERIFICATION_CHECKLIST.md`).

## 1. Verdicts

| Question | Verdict | Basis |
|---|---|---|
| **Implementation correctness** | **Correct.** No High or Medium finding open | The last review (`INDEPENDENT_REVIEW_FINAL_LOWS.md`) of the final source found 0 High, 0 Medium and 5 new Lows, all fail-safe. Every earlier High and Medium is resolved and confirmed by a later review |
| **Memory trust** | **Unverified information has no path into trusted long-term memory that the reviews found.** <br>• An agent result is stored only after a `verified` verdict.<br>• `save_relation` stores only what the owner confirms, and only the fact the owner was shown.<br>• Nothing is stored inside a goal | Reviews `INDEPENDENT_REVIEW_LR2_L5.md` to `INDEPENDENT_REVIEW_FINAL_LOWS.md`. One open item is protected: a background agent's question has no answer grace (`security/approvalGate.ts:389`) |
| **Independent QA** | **Enforced when required** (`JARVIS_QA_REQUIRE_INDEPENDENT`).<br>• Identities are compared by key.<br>• An unknown or floating identity fails closed.<br>• Look-ups are bounded | Model strings reported by live providers are unchecked (§9) |
| **Readiness to commit** | **Ready with conditions; waiting for the owner's final commit authorization** | Your rule is met: High and Medium findings are resolved before commit. The L-4 change is authorized (§11). The five new Lows are documented (§7). Windows and live verification are PENDING |

## 2. What this programme stage did, after the Low-finding closure

| Item | Owner decision | Resolution | Tests (written first) |
|---|---|---|---|
| Review M1 (split requests), L-1, L-2, L-4 | — | **Split requests:** a split request keeps its helpers' failure code.<br>**Model identity:** alias forms fold to one model, and `:latest` is floating | `lowReviewFixesTest` |
| **LR-2** mixed failure causes | Option A | **Every cause is kept.** A model cause leads over a budget, so recovery never waits for budget when a model did not answer | `mixedFailureCausesTest` |
| **L-5** unverified memory | Option S, L-5b label | **Only verified agent results go to long-term memory.** Unverified ones stay in the task archive. A goal's context marks unverified results | `unverifiedMemoryTest`; `memoryTrustTest:51` changed with your permission |
| **save_relation path** (review L-C) | "Ask me to confirm" | **What is stored:**<br>• during a request, only facts the owner confirms;<br>• inside a goal, nothing;<br>• with no request in flight, unchanged.<br>**Goal steps:** a step that could not keep a fact needs review (`MEMORY_NOT_STORED`) | `saveRelationProvenanceTest`, `saveRelationConfirmTest` |
| Confirmation review M-1, M-3, L-1–L-4 | Fix | **What is shown equals what is stored.** Long, hidden-character or multi-line facts are refused without asking. By voice, long or markdown facts need a typed answer.<br>**A "no" is final.**<br>**The goal check is precise.**<br>**The question names its agent** | `saveRelationConfirmReviewTest`, `saveRelationAskOnceTest` |
| Confirmation review **M-2** | Gate 1 for ★`core/toolRegistryV2.ts` | **A low-risk tool that asks the owner** (`asksOwner`; only `save_relation`) runs under the sandbox's pausable budget.<br>• The question no longer counts against its time.<br>• A stopped call withdraws its question.<br>Every other low-risk tool is unchanged. This is a narrower patch than "all low-risk calls"; the reason is in plan §12.2, and the review agreed | `saveRelationTimeBudgetTest` |
| Final review L-1–L-9 | "Fix all nine" | **Refused without asking:** markdown by voice needs a typed answer; invisible characters and credentials split across the parts are refused.<br>**A "no"** is reported as `APPROVAL_DENIED` ("Cancelled, sir. You did not approve it…").<br>**One question per fact per task or request.** No double store, and a retry after a store error does not ask again.<br>**Also:** the goal classifier is better, the question says "partly undone", and the docs are corrected | `saveRelationLowFixesTest`, `saveRelationRepliesTest` |

Earlier stages (gap closure, Low-finding closure: L1, L2, L5, R1–R4) are in `change_log.md` and plan `LOW_CLOSURE_PLAN.md`. This stage's plan and every owner decision are in `LR2_L5_PLAN.md` §1–§13.

## 3. Exact changed files (whole of Phase 1A since `c4ac909`)

★ = protected. Each was edited only under a Gate 1 approval recorded in the plans.

**Tracked, modified (25 files; +2073 / −116 before the last docs correction):**
- **Root and docs:** `.env.example`, `.gitignore`, `ai_workflows/_config/SOURCES_OF_TRUTH.md`
- **Bridge:**
  - ★`bridge/anthropicProvider.ts`, ★`bridge/groqProvider.ts`, ★`bridge/modelRouter.ts`
  - `bridge/llmTypes.ts`, `bridge/modelCategories.ts`, `bridge/openaiProvider.ts`
- **Agents:**
  - ★`core/agents/agentContextApi.ts`, ★`core/agents/agentManager.ts`, ★`core/agents/jarvisAgents.ts`, ★`core/agents/specialists.ts`, ★`core/agents/types.ts`
  - ★`core/agents/behaviors/common.ts`, ★`core/agents/behaviors/research.ts`, ★`core/agents/behaviors/toolLoop.ts`, ★`core/agents/behaviors/verify.ts`
- **Goals:** `core/goalExecutor.ts`, `core/goalLifecycle.ts`, `core/goalRecovery.ts`, `core/goalRuntime.ts`, `core/goalVerifier.ts`
- **Tools:** ★`core/toolRegistryV2.ts` (the two-hunk M-2 patch only), `core/tools/memoryTool.ts`

**Untracked, new:**
- **Source:** `bridge/providerGuard.ts`, `bridge/usageLedger.ts`
- **Tests (30):** `claudePrimaryStrictTest`, `claudePrimaryTargetsTest`, `errorClassificationTest`, `finalReviewFixesTest`, `gapReviewFixesTest`, `identityAliasTest`, `independentQaTest`, `lineageInheritanceTest`, `lowReviewFixesTest`, `memoryTrustTest`, `mixedFailureCausesTest`, `modelRoleRoutingTest`, `modelRouteCorrectionsTest`, `modelRouteRound3Test`, `providerCapabilitiesTest`, `providerIsolationTest`, `qaModelFailureTest`, `reviewRound3FixesTest`, `saveRelationAskOnceTest`, `saveRelationConfirmReviewTest`, `saveRelationConfirmTest`, `saveRelationLowFixesTest`, `saveRelationProvenanceTest`, `saveRelationRepliesTest`, `saveRelationTimeBudgetTest`, `strictHelperRoutingTest`, `strictModelIdentityTest`, `unverifiedMemoryTest`, `usageLedgerTest`, `verificationInconclusiveTest`
- **Docs:** `docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md` and this run folder.

**Not changed:**
- the approval gate (`security/*`), the sandbox, the orchestrator, the task graph, the reflection engine and the tool catalog;
- `core/agents/permissions.ts` and `registry.ts`;
- every tracked test (`git diff --name-only HEAD -- tests` is empty), including `tests/boundary-doubles.json`;
- `pnpm-lock.yaml` and `package.json`.

## 4. Regression evidence for this stage

Every new test was written before its fix and failed on the code at that point. Each also fails on the original `c4ac909`. Production hashes were unchanged by every fail-before run.

| Test | Before the fix | `c4ac909` | After |
|---|---|---|---|
| `lowReviewFixesTest` | 2 passed, 8 failed | fails | 13/13 |
| `mixedFailureCausesTest` | 5 passed, 12 failed (corrected test: 5 passed, 13 failed) | 4 passed, 13 failed | pass |
| `unverifiedMemoryTest` | 7 passed, 10 failed | 5 passed, 12 failed | pass |
| `saveRelationProvenanceTest` | 5 passed, 6 failed | 5 passed, 6 failed | 11/11 |
| `saveRelationConfirmTest` | 7 passed, 12 failed | 6 passed, 13 failed | 19/19 |
| `saveRelationConfirmReviewTest` | 5 passed, 14 failed | — | 19/19 |
| `saveRelationAskOnceTest` | 1 passed, 2 failed (asked 3 times) | — | 3/3 |
| `saveRelationTimeBudgetTest` | 3 passed, 4 failed | — | 7/7 |
| `saveRelationLowFixesTest` | 6 passed, 21 failed | 4 passed, 23 failed | 27/27 |
| `saveRelationRepliesTest` | 0 passed, 3 failed | 0 passed, 3 failed | 3/3 |

Evidence folders: `evidence/low-closure/`, `lr2-l5/`, `save-relation/`, `save-relation-confirm/`, `confirm-review-fixes/`, `m2-registry/`, `final-review/`, `final-lows/`.

**Test edits after a fail-before run, all recorded with diffs.** None weakens an assertion.
- **`mixedFailureCausesTest`:** two mis-specified checks were corrected (`evidence/lr2-l5/test-corrections-after-fail-before.diff`). The corrected test was re-run and still fails before the fix.
- **`memoryTrustTest:51`:** "never-verified result: not stored", with your permission (L-5 option S).
- **`saveRelationProvenanceTest`:** a stand-in owner was added for the confirmation design. It now reads the request target. No `ok(` line changed.
- **`saveRelationAskOnceTest`:**
  - one process per answer (before its fail-before run);
  - the speech stand-in removed, because the pre-existing `boundaryDoublesTest` requires stand-ins to be listed. It still fails on the pre-fix code.
- **`saveRelationTimeBudgetTest`:** a header note says the prompt stand-in ignores the 20 s answer window.

## 5. Full suite (Linux), on the final source

| Run | Files | Passed | Failed | Blocked | Skipped |
|---|---|---|---|---|---|
| Original baseline `c4ac909` (`evidence/baseline-ci.txt`) | 231 | 221 | 0 | 1 | 9 |
| **Final (`evidence/final-lows/after-ci.txt`)** | **261** | **251** | **0** | **1** | **9** |

- **Baseline tests:** all 231 have the same verdict as in the baseline, compared test by test. The 30 new files all pass.
- **Exit code:** the runner exits 1 whenever a test is blocked, as it does in the baseline.
- **Blocked:** `realTtsHandoffTest` (needs a Python with pygame and websockets).
- **Skipped:** the same 9 as the baseline:
  - Windows, PowerShell 7 and Redis;
  - a live provider;
  - `.venv`;
  - `JARVIS_BRIDGE_TOKEN`.
- **One earlier run failed `boundaryDoublesTest`.** The new `saveRelationAskOnceTest` used a speech stand-in that was not listed. That was fixed without editing the tracked list (§4), and the final run passes it.
- **Other checks:** typecheck exits 0; `git diff --check` is clean.

## 6. Independent reviews of this stage

| Review | Verdict |
|---|---|
| `INDEPENDENT_REVIEW_LOW_CLOSURE.md` | NOT READY: M1 |
| `INDEPENDENT_REVIEW_LOW_CLOSURE_RECHECK.md` | READY WITH CONDITIONS: M1 fixed; LR-1 to LR-3 |
| `INDEPENDENT_REVIEW_LR2_L5.md` | READY WITH CONDITIONS: L-A, L-B, L-C (`save_relation`) |
| `INDEPENDENT_REVIEW_SAVE_RELATION.md` | READY WITH CONDITIONS: M-1, M-2 (word check); led to "Ask me to confirm" |
| `INDEPENDENT_REVIEW_SAVE_RELATION_CONFIRM.md` | READY WITH CONDITIONS: M-1, M-2, M-3, L-1 to L-4 |
| `INDEPENDENT_REVIEW_FINAL_MEMORY.md` | READY WITH CONDITIONS: M-1, M-2, M-3 resolved; L-1 to L-9 |
| **`INDEPENDENT_REVIEW_FINAL_LOWS.md` (final source)** | **READY WITH CONDITIONS: 0 High, 0 Medium; L-1 to L-9 resolved (L-7, L-8 partly); 5 new Lows** |

**Source unchanged after the final review.** All 86 hashes in `evidence/final-lows/source-hashes-at-review.txt` match. After that check, only `.env.example` changed: the review's condition 1, docs only, in `evidence/final-lows/env-example-after-review.diff`.

## 7. Open findings (kept documented by owner instruction, 2026-11-17)

The five new Lows from `INDEPENDENT_REVIEW_FINAL_LOWS.md` stay open and are listed here. None of them lets unverified information into memory.

| Finding | What happens | Why it fails safe | Where a fix would go |
|---|---|---|---|
| **LL-1** | **Same fact asked twice:** two `save_relation` calls for the same fact at the same moment are both asked. On "yes" it is stored twice.<br>**Planner and agent:** in one request, the planner and an agent it started ask separately | A fact is stored only on "yes" to a question showing that exact fact; at worst the same confirmed fact is stored twice, or the owner is asked twice. | Unprotected for the first case. The second needs protected `core/agents` files |
| **LL-2** | **The goal-step classifier is phrasing-based:**<br>• it misses "Remember when/who/where…", wordings later in the step, and other languages;<br>• it may hold "Add up…", "Record the answer…" or "Remember to…" for review.<br>A step that calls `save_relation` is always caught | A missed step can only say "saved" without storing, because nothing can be stored inside a goal. A wrongly held step waits for the owner's review | Unprotected |
| **LL-3** | **Ordinary text refused** as invisible characters:<br>• Persian or Urdu with a zero-width non-joiner;<br>• text or emoji joined with a zero-width joiner;<br>• keycaps;<br>• subdivision flags | The text is refused, not stored; the owner can restate the fact | Unprotected |
| **LL-4** | **A credential refusal is retried** twice by the task graph (about 3 s), and JARVIS says "One of my tools failed". Nothing is stored | Nothing is asked or stored: the credential is refused on every attempt | Unprotected (wording) |
| **LL-5** | Four `.env.example` sentences said slightly more than the code (LL-1, LL-2, LL-3 cases; second-brain notes after `forget_memory`) | Documentation only | **Corrected** after the review, docs only (`evidence/final-lows/env-example-after-review.diff`). It stays listed here because the limits it now states are LL-1 to LL-3 |
| L-A | The console line names the task archive even when `JARVIS_AGENT_ARCHIVE=0` | Message wording only | Protected `core/agents/jarvisAgents.ts:304` |
| Answer grace | A background agent's approval question has no answer grace | A misattributed "yes" approves only a fact that question showed | Protected `security/approvalGate.ts:389` |
| L-3 (earlier) | A QA setting that can never be independent is retried, not blocked | The task fails; it never reports independence | As approved in the plan |
| `asksOwner` | A future low-risk tool that asks the owner must set `asksOwner` | Without it, the question runs against the 25 s limit; a late "yes" stores nothing | Design note |

**Earlier proposals still open, outside this programme:**
- P2: `goalVerifier` keeps the review reason;
- P5: router follow-ups;
- P6: the protected-file list.

## 8. Remaining risks

- **Live model strings.** Strict routes and QA independence depend on how each live provider reports its model. A mismatch fails closed but can block work until the setting matches.
- **Strict calls fail where a fallback used to answer.** On Gemini/Groq this happens on a rate limit; on Claude, on a refusal.
- **"Remember" now asks you every time** during a request. Inside a goal nothing can be remembered. You have 20 s to answer.
- **Goal steps that ask to remember something** wait for your review.
- **Real-model behaviour is untested:** what real models put into facts, whether they retry after "cancelled", and which phrasings the real goal planner uses.

## 9. Linux results vs Windows / live checks (Windows: PENDING; live providers: PENDING)

**Verified on Linux with stand-in providers:**
- routing and strict identity;
- inheritance and the QA gate;
- error codes through goal recovery;
- the memory rules and the `save_relation` confirmation through the real registry, approval gate and orchestrator;
- the full test suite.

**Only the owner's Windows PC or live providers can verify:**
- the model strings Claude, Gemini, Groq and the fallback report;
- independence with real providers;
- fallback under real rate limits and refusals;
- how the Windows console and real TTS show the confirmation (unusual characters, emoji, voice timing);
- what real models do with `save_relation`;
- `forget_memory` with a vault configured;
- `realTtsHandoffTest` and the 9 skipped tests.

**None of the second list has been run.** `WINDOWS_VERIFICATION_CHECKLIST.md` gives the PowerShell steps: build and suite, Claude identity, Gemini/Groq identity, strict coding routing, research-worker inheritance, independent QA, fallback, verification failures, and voice after a provider failure.

## 10. Git status

- Branch `claude/jarvis-repair` at `c4ac909`, the same as `origin/claude/jarvis-repair`.
- Nothing committed, pushed or merged. No local `main`.
- 25 tracked files modified; new files untracked (§3).

## 11. Decision record and what remains

| Item | Status |
|---|---|
| L-4 change in the protected `core/agents/behaviors/research.ts` (the parent keeps the most specific worker code) | **Authorized by the owner, 2026-11-17: retained as reviewed.** Unchanged since its review: the hash matches all seven review hash records |
| The five new Lows LL-1 to LL-5 | **Kept documented** (§7), by owner instruction. Not dismissed |
| Windows PC verification | **PENDING** |
| Live-provider verification | **PENDING** |
| Phase 1B | **Not started** |
| Merge into `main` | **Not done, and not to be done** |
| Commit and push | **Waiting for the owner's final commit authorization** |
