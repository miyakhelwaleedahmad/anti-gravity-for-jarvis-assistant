# Independent re-review: low-closure review fixes (M1, L-1, L-2, L-4, L-6)

**Reviewer:** an independent, read-only agent with no part in writing the code, the plan or the earlier reviews.
**Scope:** the follow-up change to the uncommitted Phase 1A work on `claude/jarvis-repair` (base `c4ac909`) made after `INDEPENDENT_REVIEW_LOW_CLOSURE.md` (NOT READY on M1).
**Method:**
- The current source matches `evidence/low-closure/source-hashes-at-rereview.txt` (13 of 13 OK).
- The copies in `scratchpad/at-first-review/` match `evidence/low-closure/source-hashes-at-review.txt`.
- My own diff of those copies against the current files is identical to `evidence/low-closure/review-fixes-source.diff`.
- Every other file in `source-hashes-at-review.txt` is unchanged. Only the four source files and `.env.example` differ.
- I read the changed code and its callers, re-ran the earlier probe 7, wrote three probes of my own (8, 9, 10), and ran the typecheck and 26 tests.
- The author's documents were read as context only.

---

## 1. Verdicts

**(a) Implementation correctness: correct.**
- M1 is fixed. On the split-parts path, a helper's own condition now reaches the goal, with the same code and class as the single-part path (probe 7 A, B, C against A2, B2).
- Parts answered by keyword rules, or not finished, still fail closed as `MODEL_UNAVAILABLE` (probe 8 b, h).
- L-4 is fixed on the research path in both worker orders. A tool budget there is still not a model failure (probe 10).
- One Low concerns which code is chosen in a mixed case (LR-2). It does not affect fail-closed behaviour.

**(b) Independent QA enforcement: enforced and fail-closed.**
- The new folding only adds "same" pairs. A 60 000-name fuzz found no name pair that was "same" before and is "different" now, and no name that was floating before and is not now (probe 9 §2).
- Strict identity confirmation in the router does not use `identityKey` (`bridge/modelRouter.ts:564-571` uses `normModel`). A strict reply that differs from the asked name is still refused, even when the two names now share a key (probe 9 §3).
- `llama3:latest` is now floating. Bedrock `vendor.`/`region.vendor.` ids and dotted versions now fold.
- Residual: a Vertex id whose `-vN` follows a word (`claude-3-5-sonnet-v2@20241022`) and non-Anthropic Bedrock ids (`meta.…-v1:0`) still count as different from the plain name (LR-1). `.env.example` states that only the listed forms are recognised.

**(c) Readiness to commit: READY WITH CONDITIONS.**
- No High or Medium finding remains, so the owner's rule (High and Medium resolved before commit) is met.
- Conditions:
  - `FINAL_APPROVAL_REPORT.md` is rewritten as planned.
  - Two doc statements are corrected: `change_log.md:276` (LR-3) and the tracker's "Vertex forms fold" (LR-1).
  - The owner accepts or fixes LR-2 and the Lows left open by choice (L-3, L-5).
  - The owner confirms that the protected-file edit made for L-4 (`research.ts`) is covered by the Gate 1 approval (Info).

---

## 2. Checks

| # | Check | Result |
|---|---|---|
| 1 | M1: a helper's own condition reaches the goal on the split-parts path; parts answered by rules, or unfinished, still fail closed | **Met.** Probe 7 re-run: A (QA, tool budget) → `TOOL_BUDGET_EXHAUSTED` → `budget`; B (QA strict, identity) → `MODEL_IDENTITY_UNCONFIRMED` → `configuration`, blocked; C (strict coding, tool budget) → `TOOL_BUDGET_EXHAUSTED` → `budget`. Each matches its single-part control (A2, B2). Probe 8: model down → `MODEL_UNAVAILABLE` (d, f); both parts by keyword rules → `MODEL_UNAVAILABLE` (b); parent's own part unfinished, helper fine → `MODEL_UNAVAILABLE` (h). Mixed cases are in §3 (LR-2) |
| 2 | L-4: precedence identity > budget > unavailable, budget kind kept; a tool budget is not a model failure on the research path | **Met.** `mostSpecificFailure` (`core/agents/behaviors/common.ts:72-85`). Probe 10, strict coding research with two deep workers: identity + model down, in both orders → `MODEL_IDENTITY_UNCONFIRMED` on the analysis worker, the coding task and the goal; model down + fine → `MODEL_UNAVAILABLE`; one worker out of tool calls, other fine → task COMPLETED (r4); tool budget + identity → `MODEL_IDENTITY_UNCONFIRMED` (r5) |
| 3 | L-1, L-2: folding only adds "same" pairs; router identity confirmation unaffected | **Met.** See (b) and probe 9 §1, §2, §3. Edge cases in §3 (LR-1) and §5 |
| 4 | No regression | **Met.** `pnpm run typecheck`: exit 0. The 17 named tests: 17 passed, 0 failed. The nine other programme tests: 9 passed, 0 failed. In the author's `review-fixes-after-ci.txt`, every test has the same status as in `baseline-ci.txt` (242 against 221 passed, 0 failed in both; same 1 blocked and 9 skipped) |
| 5 | Tests, lock file, package, approval gate, permissions | **Met.** `git diff --name-only HEAD -- tests`: empty. `git diff --stat HEAD -- pnpm-lock.yaml package.json`: empty. Nothing under `security/` modified; `core/agents/permissions.ts` and `registry.ts` unmodified; `agentContextApi.ts` has the same hash as at the first review. `git status --porcelain` was identical before and after all my runs |
| 6 | L-6: tracker and `.env.example` | **Partly met.** The stale tracker text ("a coding helper's own setting is not counted") is gone (`JARVIS_IMPLEMENTATION_TRACKER.md:130`). `.env.example:141-153` lists the recognised forms accurately and warns against cross-provider ids. The same tracker line says "Bedrock and Vertex forms fold", which overstates (LR-1). `FINAL_APPROVAL_REPORT.md` not counted, as instructed |

The fail-before evidence was read, not re-run:
- `review-fixes-fail-before.txt`: 2 passed, 8 failed on the reviewed source.
- `review-fixes-on-original-c4ac909.txt`: the three M1 checks fail, then the test stops on the missing function.

---

## 3. Findings

### High

None.

### Medium

None.

### Low

**LR-1. The tracker and the new test's header say Vertex forms fold; a common Vertex form does not.**
- **Where:** `docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md:130` ("aliases, gateway, Bedrock and Vertex forms fold"). `tests/lowReviewFixesTest.ts:10` says the same. The rule is at `bridge/modelCategories.ts:249` (`(?<=\d)-v\d+$`: a `-vN` is dropped only after a digit).
- **Scenario (probe 9 §1):** each pair below gives `independent: true`.
  - `claude-3-5-sonnet-v2@20241022` vs `claude-3-5-sonnet-20241022`: keys `claude-3-5-sonnet-v2` / `claude-3-5-sonnet`.
  - `claude-x-v2@20261022` vs `claude-x-20261022`: the example the earlier review gave for L-1.
  - `meta.llama3-1-70b-instruct-v1:0` vs `llama3-1-70b-instruct`.
  - `mistral.mistral-7b-instruct-v0:2` vs `mistral-7b-instruct`.
- **Effect:**
  - The test's own Vertex case (`claude-opus-5-5-v2@20261101`) passes only because `-v2` follows a digit.
  - The code comment and `.env.example` say "a '-v2' version after a number", which is accurate, and `.env.example` warns that only the listed forms are recognised. The overstatement is in the tracker and the test header only.
  - A false `independent` still needs the owner to give QA another provider's id for coding's model.
- **Fix:**
  - Correct the tracker line to name the forms that fold: `vendor/`, `models/`, Bedrock `vendor.`/`region.vendor.` prefixes, `:variant`, date stamps, `-NNN`, `-vN` after a number, and dotted versions. Correct the test header the same way.
  - Optionally also drop a `-vN` that comes directly before an `@date` stamp (`-v\d+@\d{8}$`). This would fold the Vertex form; it is fail-closed.

**LR-2. In a mixed split, a helper's budget code is used even when another part failed for a reason a budget does not explain.**
- **Where:** `core/agents/behaviors/toolLoop.ts:303-304`. A code is carried when any unchecked part has one. Parts with no code (answered by keyword rules, unfinished, or the parent's own part) do not affect the choice.
- **Scenario (probe 8 a):**
  - Request: QA with no setting, "Run the type check; then describe the weather", `JARVIS_AGENT_BUDGET_TOOL_CALLS=0`.
  - Part 1's helper runs out of tool calls. Part 2's model is down, so it is answered by keyword rules.
  - The goal gets `TOOL_BUDGET_EXHAUSTED` → `budget` → task `ready`, goal waits for budget.
  - Raising the tool budget does not address part 2. The next run would fail as `MODEL_UNAVAILABLE`.
  - The same applies when the parent's own part is unfinished and a helper ran out of budget.
- **Effect:**
  - Fail-closed holds: the task fails and the message names every part.
  - Identity winning in a mix (probe 8 c1, c2, e, g) is reasonable, because it blocks for the owner, the most conservative outcome.
  - The earlier review's suggested fix carried a code only when every failed part had one. The author chose "any part".
- **Fix (owner's choice):**
  - Keep identity first in any mix.
  - Carry `BUDGET_EXCEEDED` (or `MODEL_UNAVAILABLE`) only when every unchecked part carries a code and the parent's own parts finished. Otherwise throw `ModelUnavailableError`.
  - Add probe 8 a as a test.

**LR-3. The change log says `FINAL_APPROVAL_REPORT.md` is updated; it is not yet.**
- **Where:** `ai_workflows/runs/2026-11-15_phase1a-model-gateway/change_log.md:276`.
- **Scenario:** the report was last modified 2026-11-16 14:20 UTC. It still lists R1–R4, L1, L2 and L5 as open and does not mention the low closure.
- **Effect:** the run record is inaccurate until the report is rewritten. The rewrite is planned after this review.
- **Fix:** rewrite the report, or change the change-log line to say the rewrite follows this review.

### Info

- **Two budget kinds: the first in result order wins** (probe 8 i).
  - `[toolCalls, llmCalls]` gives `toolCalls` (goal code `TOOL_BUDGET_EXHAUSTED`); the reverse gives `llmCalls` (`BUDGET_EXCEEDED`).
  - Both map to `budget`, but the failure signatures differ between runs of the same request.
  - Possible fix: prefer a model budget (`llmCalls`/`tokens`) over `toolCalls` inside `BUDGET_EXCEEDED`.
- **The `budget` class now also applies to split requests.**
  - `decide` sets the task `ready` without the side-effect check (`core/goalRecovery.ts:170-174`).
  - Before the M1 fix, a split request's helper budget was `dependency`, which does check side effects. A helper that ran `dev:run` and then ran out of tool calls can therefore be run again on resume.
  - This matches the single-part path and the earlier Info item; it is not new behaviour of the `budget` class.
- **Over-folding (fail-closed):**
  - The Bedrock prefix rule drops any leading letters-only dotted segment, so `ab.cd` = `cd`.
  - `-vN` after a number joins different revisions, such as `…-20240620-v1:0` and `…-20241022-v2:0`. These were already joined by the date rule.
  - `model-1.100` = `model-1` (dot to dash, then `-NNN`).
  - These can make QA "unavailable" for two different builds. They never make a pair independent.
- **Forms still not folded, not regressions:**
  - `o1.mini` vs `o1-mini` (a dot between a digit and a letter);
  - `llama3.1:8b` vs `llama-3.1-8b-instant` (different naming schemes).
- **Distinct models stay distinct:** `gpt-4.1`/`gpt-4o`, `gemini-2.5-flash`/`gemini-2.5-pro`, `deepseek-v2`/`deepseek-v3`, `deepseek-v2.5`/`deepseek-v2`, `mistral-7b-v0.1`/`v0.3`, `llama-3.1-8b-instant`/`llama-3.3-70b-versatile`.
- **Floating names:** `latest`, `LATEST`, `llama3:latest`, `qwen@latest`, `models/gemini-latest` and `claude-latest:free` are floating; `latest-model` is not.
- **Approval coverage.**
  - This round edited three protected files: `toolLoop.ts`, `common.ts` and `research.ts`.
  - The Gate 1 approval (`LOW_CLOSURE_PLAN.md`) includes "all High and Medium findings fixed", which covers M1 in `toolLoop.ts` and `common.ts`.
  - The `research.ts` change is for L-4, a Low. The change log cites no separate approval for it. The owner should confirm it is within the approval.
- **Unreachable fallback:** `research.ts:90` `?? { code: 'MODEL_UNAVAILABLE' }` cannot be reached, because the filter above admits only carried codes. Harmless.

---

## 4. Status of earlier findings

| Finding | Status |
|---|---|
| M1 (split-parts path loses the helper's condition) | **Resolved** (probe 7 A/B/C, probe 8; `lowReviewFixesTest`). Mixed-case choice: LR-2 |
| L-1 (alias forms not folded) | **Mostly resolved:** Bedrock Anthropic ids with or without a region, dotted versions, and `-vN` after a number fold. Residual: Vertex `-vN@date` after a word, and non-Anthropic Bedrock ids; the tracker overstates this (LR-1). `.env.example` now carries the limit and the warning |
| L-2 (`:latest` not floating) | **Resolved** (probe 9; `lowReviewFixesTest`) |
| L-3 (setting-derived QA reasons retried as `MODEL_UNAVAILABLE`) | **Open by owner choice**; unchanged, as the plan approved |
| L-4 (research parent carries the first worker's code) | **Resolved** (probe 10 r1/r2; `lowReviewFixesTest`) |
| L-5 (never-verified results reach memory) | **Open by owner choice**; unchanged |
| L-6 (stale docs) | **Partly resolved:** the stale tracker text is gone and `.env.example` is updated. The tracker "Vertex" wording (LR-1) and the change-log claim (LR-3) remain. `FINAL_APPROVAL_REPORT.md` is to be rewritten (not counted) |

---

## 5. What I ran

All runs from the repository root with `pnpm exec tsx <path>`. Every probe:
- sets `JARVIS_WORKSPACE_ROOT` and `JARVIS_DATA_ROOT` to a new folder under the system temporary directory before any import;
- registers a stand-in under `anthropic` before any router use;
- uses stand-in providers and tools, with no network or provider call.

Probes and outputs are in `scratchpad/rereview-low/`.

**Integrity**
- `sha256sum -c evidence/low-closure/source-hashes-at-rereview.txt`: all OK.
- `at-first-review/` copies against `source-hashes-at-review.txt`: OK. My diff equals `review-fixes-source.diff`.
- `git diff --name-only HEAD -- tests`: empty. `git diff --stat HEAD -- pnpm-lock.yaml package.json`: empty.
- `git status --porcelain`: identical before and after all runs.

**Typecheck**
- `pnpm run typecheck`: exit 0.

**Tests**
- `pnpm test -- --only=lowReviewFixesTest,errorClassificationTest,memoryTrustTest,identityAliasTest,claudePrimaryTargetsTest,independentQaTest,gapReviewFixesTest,lineageInheritanceTest,strictModelIdentityTest,verificationInconclusiveTest,goalRecoveryTest,goalRuntimeTest,goalAgentIntegrationTest,agentRuntimeTest,sevenAgentTest,strictHelperRoutingTest,qaModelFailureTest`: 17 passed, 0 failed.
- `pnpm test -- --only=claudePrimaryStrictTest,finalReviewFixesTest,modelRouteCorrectionsTest,modelRouteRound3Test,reviewRound3FixesTest,providerIsolationTest,modelRoleRoutingTest,providerCapabilitiesTest,usageLedgerTest`: 9 passed, 0 failed.
- Not run: `--ci`. I compared the author's `review-fixes-after-ci.txt` with `baseline-ci.txt` instead.

**Probes**

| Probe | Point |
|---|---|
| `p7_splitParts.mts` (copy of the earlier probe 7) | M1 cases A, B, C and the single-part controls A2, B2 |
| `p8_mixedSplit.mts` | Split path, mixed parts: keyword rules plus tool budget; identity plus model down in both orders; model down plus fine; tool budget plus identity; strict coding; one child allowed, with the parent's own part hitting the step limit (with a failing and a fine helper); `mostSpecificFailure` ordering |
| `p9_identityKeys.mts` | 47 name pairs (key, old key, floating, independent now and before); a 60 000-name fuzz of "same before ⇒ same now" and "floating before ⇒ floating now" against verbatim copies of the reviewed functions; strict router replies with same-key names |
| `p10_researchL4.mts` | Strict coding research with two deep workers: identity, model down, fine, tool budget, in combination and in both orders |

---

## 6. What only the owner's Windows PC or live providers can verify

- The model names live providers report (Claude, Gemini, Groq, any OpenAI-compatible gateway, Bedrock or Vertex through a gateway). They decide whether the folded forms match what is really sent and reported.
- Whether real goals hit the per-task tool budget on split QA or coding requests, and how the `budget` wait and resume behave in the owner's use.
- The full suite on Windows, including the tests blocked or skipped here.
