# Independent re-review: fixes after the gap-closure review

**Reviewer:** an independent, read-only agent with no part in writing the code, the plan or the earlier reviews.
**Scope:** the source changed after `INDEPENDENT_REVIEW_GAP_CLOSURE.md` (M-A, M-B, L3, L4, L7), as it stands now on `claude/jarvis-repair` (base `c4ac909`, uncommitted), plus regression checks across the whole gap closure.
**Method:** I read the current source of the five production files whose hashes differ from `evidence/gap-review-fixes/production-hashes-before.txt` (`bridge/modelCategories.ts`, `bridge/modelRouter.ts`, `core/agents/agentManager.ts`, `core/agents/behaviors/research.ts`, `core/agents/behaviors/toolLoop.ts`), `bridge/anthropicProvider.ts`, `.env.example`, the tracker, `change_log.md` and the two new tests. No copy of the five files as they were at the last review exists, so I checked the current code against the author's list and the previous review's line references. I ran the typecheck, 31 tests through the runner, the two new tests on the `c4ac909` copy, and four probes. The run folder's documents were read as context only.

---

## 1. Verdicts

**(a) Implementation correctness: correct.** M-A, M-B, L3, L4 and L7 are implemented as the author describes. No strict route that should work is refused, and no regression showed up in the 31 tests or the probes. I found three new Low findings: two are about the non-strict targets and the lookup cost under Claude as primary (R1, R4), and one is about how L3 labels a tool-call budget (R3).

**(b) Independent QA enforcement: enforced; M-A and M-B are closed.**
- An undated Claude alias and its dated id are now one model, both before QA's first call (probe 2a: FAILED, no Claude call) and in the reply check (probe 3g: FAILED on coding's dated id, in another letter case).
- An identity that cannot be looked up counts as "not independent" (probe 2c). The check now looks at the model the strict call would really send (probe 1).
- A false `independent` label is still possible where identity is compared by name, outside Claude's alias lookup (R2, probe 4):
  - the same model under a gateway's id, e.g. `openai:anthropic/claude-opus-5-5` against `anthropic:claude-opus-5-5`;
  - two names for one model on the Gemini/Groq client, if the endpoint reports back the name it was asked for.
- R2 is within the owner's D4 decision (names compared exactly after normalisation, plus Claude's canonical id). Whether it happens depends on what the live providers report.

**(c) Readiness to commit: READY WITH CONDITIONS.**
1. There are no High or Medium findings, so the owner's rule (High and Medium resolved before commit) is met.
2. `FINAL_APPROVAL_REPORT.md` still describes the state before the gap closure (it says "Independent QA: Not enforced"). The previous review set its update as a condition, and so does plan step 7. Two tracker rows say the same (R5).
3. The owner accepts or fixes the open Low findings: L1, L2 and L5 from the previous review, and R1–R5 below.
4. A re-review is needed only if source changes again. Documentation-only changes for condition 2 do not need one.

---

## 2. Checks

### 2.1 M-A: identities, not names

| Check | Result | Evidence |
|---|---|---|
| `sameModelPossible` compares id sets | Yes, after the same-name checks | `modelCategories.ts:209-211` |
| An unresolved identity counts as unknown | Returns a reason ("could not be looked up"), so the pair is not independent. This check comes before the different-provider check, so it holds across providers too | `modelCategories.ts:213` |
| `ModelTarget` carries `ids` and `resolved` | Yes | `modelCategories.ts:233` |
| `qaIndependence` is async and resolves both sides | `Promise.all` over `resolveTargets` for coding and QA | `modelRouter.ts:466-469` |
| `resolveTargets` | `validateModel`, then `modelIdentities`, ids lower-cased and normalised. Any error gives `resolved: false` (fail closed) | `modelRouter.ts:477-488` |
| `qaGate` is awaited at both call sites; `checkServed` uses coding's ids | `toolLoop.ts:166`, `:261`; `:113-116`, `:128` | Probe 3g |
| Floating promises | None. All three in-tree callers of `qaIndependence` await it (`toolLoop.ts:113` and the tests). Probe 2 printed no unhandled rejection, including a task cancelled during the lookup | `rg qaIndependence` |

**Network calls and failure modes.**
- **Network calls.** With the real Claude adapter, the gate now calls `models.retrieve` for every Claude target of coding and QA (`anthropicProvider.ts:162-178`). It does so on every QA task, whether or not independence is required (probe 2d).
  - A successful lookup is kept for the process, so a model is looked up once.
  - A failed lookup is not kept, so it is repeated on the next QA task (probe 1o).
- **Required QA.** A failed or unreachable lookup fails required QA closed with a clear reason (probe 2c). The next task succeeds once lookups work again (probe 2c2).
- **QA not required.** A failed lookup only affects the label, `not_independent` (probe 2d).
- **Cancellation.** The lookup takes no abort signal. A task cancelled while a 1.5 s lookup is pending still ends CANCELLED in 202 ms, and no model call follows (probe 2f).
- R1 and R4 below describe the costs.

### 2.2 M-B: the check and the call agree on strict routes

- `possibleTargets` builds a strict target from `strictTarget` and `strictSends` (`modelRouter.ts:444-449`).
- `refuseUnservableStrict` refuses any strict route whose sent model differs from the configured one (`:513-515`). It runs inside the `try` of `categoryChat` (`:232`) and of `routedChat` (`:550`), so a refusal is a `StrictRouteError` with nothing sent.

Strict routes under Claude as primary (probe 1, a stand-in Claude registered under `anthropic` in both maps):

| Route | Result |
|---|---|
| bare `claude-sonnet-5-5` | answered; sent exactly; dated id accepted |
| `anthropic` alone | answered as `claude-opus-5-5` |
| `anthropic:claude-opus-5-5` | answered |
| `openai:gpt-4o-mini` (its own model), `openai:GPT-4o-mini` | answered |
| `openai:gpt-5` (another model) | refused, nothing sent |
| named provider `myprov:some-model` | answered |
| bare `gpt-5-mini` (agent route, `JARVIS_MODEL_CODING` via `categoryChat`, and a strict stream) | refused, nothing sent |
| `JARVIS_MODEL_CODING=claude-sonnet-5-5` via `categoryChat`; strict stream on `claude-sonnet-5-5` | answered |
| non-strict `JARVIS_MODEL_PLANNING=gpt-5-mini` | unchanged: sent as `claude-opus-5-5` |

Under the Gemini primary, the earlier tests cover strict routes (`strictModelIdentityTest`, `modelRouteCorrectionsTest`, `strictHelperRoutingTest`), and all pass.

**Behaviour change, documented:** under Claude as primary, a strict route given as a bare non-Claude name is now refused. This covers the code-repair `JARVIS_MODEL_CODING` / `JARVIS_MODEL_REVIEW` routes and goal checks, which ask as REVIEW. Before, such a route was sent as Claude's brain model. `.env.example:83-86` says so.

### 2.3 L3, L4, L7

- **L3:** `failOnModelFailure` also propagates `BUDGET_EXCEEDED` (`research.ts:83`), on a strict lineage only.
  - Probes 3d and 3d2: the coding task ends FAILED and names the budget.
  - Unconfigured coding research is unchanged (probes 3e and 3f: COMPLETED).
  - Side effect: see R3.
- **L4:**
  - `noteUsage` records `servedModel` only when a model is reported, never the requested model (`modelRouter.ts:622`; probes 3a and 3b, and the test).
  - The old comment "nothing in JARVIS enforces it yet" is gone.
  - `.env.example:77-78` now says a cached strict reply is checked again, which is true: `confirmIdentity` runs on whatever the provider returns.
  - Tracker and change log: see §2.6.
- **L7:**
  - `strictRouteRole`'s JSDoc sits above it, and `spawnChild`'s above `spawnChild` (`agentManager.ts:438-468`).
  - `failOnModelFailure` and `waitWithRetry` each have their own JSDoc (`research.ts:75-88`).

### 2.4 Regressions across the gap closure

- **Strict routing:**
  - chat, `categoryChat`, named providers and streams: probe 1 and the tests listed in §5 pass;
  - chain: `routedChat` → `sendRoute` → `chain` unchanged; `modelRouteCorrectionsTest` and `modelRouteRound3Test` pass;
  - cache: `strictModelIdentityTest` passes.
- **Unrouted and non-strict calls:**
  - Unrouted calls are unchanged (probe 3a).
  - A non-strict route under Claude as primary is still mapped as before (probe 1n).
  - The usage record keeps `model` as before and adds `servedModel`.
- **Lineage and N1:** `lineageInheritanceTest`, `strictHelperRoutingTest` and `finalReviewFixesTest` pass. `TaskContext.llm` still strips the caller's `routeAs` (`agentManager.ts:1286-1289`).
- **QA not required:** QA runs and is labelled `not_independent` (probes 2d and 2e).
  - The label is never `independent` when independence is not required (`toolLoop.ts:136-144`).
  - Tracked tests `agentSpecialistsTest` and `sevenAgentTest` pass.
- **P7:** `verificationInconclusiveTest`, `goalAgentIntegrationTest` and `selfHealingHonestyTest` pass.
- **Cancellation, foreground calls and the trial lease:**
  - `llmCancellationTest`, `foregroundPriorityTest` and `providerIsolationTest` pass.
  - The gate's lookups take no guard ticket, so they cannot hold a lease (R4).
- **Approval gate and tool permissions:** untouched.
  - `core/agents/permissions.ts`, `toolRegistryV2`, the risk engine and the approval gate are not in `git status`.
  - `TaskContext.callTool` and `spawnChild`'s checks are not in the gap-closure diff of `agentManager.ts`.

### 2.5 Test integrity

- **No tracked test or lockfile changed:** `git diff --name-only HEAD -- tests`, `git diff --name-only HEAD -- pnpm-lock.yaml package.json` and `git diff --check HEAD` all print nothing.
- **`independentQaTest`:** its only change is three added `await`s (`diff` against `scratchpad/independentQaTest.before-await.ts`), the same as `evidence/gap-review-fixes/independentQaTest-await.diff`. No assertion line changed.
- **`verificationInconclusiveTest`:**
  - The change log says one assertion "was made precise", but I could not find a copy from before that edit.
  - The file's timestamp (13:18) predates the previous review file (13:47), and the file is byte-identical to the copy in `base-c4ac909`.
  - Compared with the approved proposal file, it only adds checks and comments. No assertion from the proposal is removed or loosened.
- **The two new tests fail on `c4ac909`.** I first confirmed that the copy matches `c4ac909` for all 383 tracked files under `bridge`, `core`, `config` and `tests`, plus `package.json` and the lockfile (0 differ). I then ran the tests through that copy's runner: 0 passed, 2 failed (`r.possibleTargets is not a function`, `r.qaIndependence is not a function`).
- **The author's fail-before** on the pre-fix tree shows 7 checks failing in `gapReviewFixesTest` and 4 in `claudePrimaryStrictTest`, each on the finding it targets (`evidence/gap-review-fixes/fail-before.txt`).
- **Verdicts against the baseline.** I joined `evidence/baseline-ci.txt` (231 files: 221 PASS, 1 BLOCKED, 9 SKIP) with `evidence/gap-review-fixes/after-ci.txt` (247 files) per test.
  - All 231 pre-existing tests have the same verdict.
  - The 16 extra tests are the 16 untracked Phase 1A tests, all PASS.
  - The only "401" in `after-ci.txt` is a duration ("4010ms").

### 2.6 Docs against the code

- **`.env.example`** matches the code for:
  - strict refusal under Claude as primary;
  - identity lookup and "a model whose identity cannot be looked up" counting as the same model;
  - L1 marked "Not covered";
  - D1.

  It does not state:
  - that cross-provider matching is by exact id only (R2);
  - that the lookup is a network call made for every QA task.
- **Tracker:** rows MM-1A-P3, P4, P9 and N1N2 and the "Independent QA" status line match the code. Rows MM-1A-06 (`:88`) and MM-1A-17 (`:99`) still say independence is not used by the runtime (R5).
- **`change_log.md`:**
  - The M-A, M-B, L3, L4 and L6 entries match the code.
  - "M-B: the check and the call agree" is true for strict routes; non-strict targets under Claude as primary still disagree (R1).
  - "results are in `FINAL_APPROVAL_REPORT.md`" is not true yet (R5).
  - No overclaim of enforcement was found.

---

## 3. Findings

### High

None.

### Medium

None.

### Low

**R1. Under Claude as primary, coding's non-strict targets are listed by a name that is never sent.**
- **Where:** `bridge/modelRouter.ts:432-437`. `sends()` returns the name unmapped whenever the provider is in `namedOnly`, and `anthropic` is always in `namedOnly`, including when it is the primary.
- **Scenario (probe 1o, 1p):**
  - Claude primary, coding unset: `possibleTargets('coding_agent')` gives `anthropic llama-3.1-8b-instant`, but the chain sends `claude-haiku-5-5`.
  - With `JARVIS_MODEL_PLANNING=gpt-5-mini`, it also lists `anthropic gpt-5-mini`, which is sent as `claude-opus-5-5`.
  - The gate then looks up `llama-3.1-8b-instant` on Claude. With the real adapter that lookup fails, and because failures are not kept, it is repeated on every QA task (3 lookups in 3 checks).
  - The reason shown is "the identity of anthropic llama-3.1-8b-instant could not be looked up".
- **Effect:**
  - The result is fail-closed, never a false `independent`. In this setup QA could not be independent anyway: coding can be answered by Claude, by the fallback client and by `openai`.
  - The costs are one failing `models.retrieve` per QA task and a misleading reason.
- **Fix:** in `sends()`, map with `modelFor` when `name === this.primary` (as `strictTarget` does), so non-strict targets show the model really sent.

**R2. Outside Claude's alias lookup, identity is the exact name, so a gateway id or a non-Claude alias can still be labelled `independent`.**
- **Where:** `bridge/modelCategories.ts:205-217`. Two different ids on two providers are independent, and two exact routes on one provider are independent. `resolveTargets` (`modelRouter.ts:477-488`) gives `ids: [model]` for providers without `modelIdentities`, which is every provider except Claude.
- **Scenario (probe 4):**
  - Coding `anthropic:claude-opus-5-5` and QA `openai:anthropic/claude-opus-5-5` (an OpenAI-compatible gateway serving the same model): `independent: true`.
  - Coding `gemini:gemini-flash-latest` and QA `gemini:gemini-3.5-flash`: `independent: true`. A strict call is accepted when the endpoint reports back the name it was asked for (probe 4b2).
- **Effect:** within D4 as approved. Whether the Gemini/Groq endpoints report back the requested name or the resolved one decides whether the second case can occur. Only the live providers can show this.
- **Fix:** document in `.env.example` that across providers only identical ids count as one model, and that the owner must not give QA a gateway id for coding's model. Optionally, strip a `vendor/` prefix when comparing ids.

**R3. L3 treats every used-up budget as a model failure, including tool calls.**
- **Where:** `core/agents/behaviors/research.ts:82-84`. The comment says "a used-up model-call budget", but the filter is any `BUDGET_EXCEEDED`, which also covers the `toolCalls` and `tokens` kinds (`agentContextApi.ts:38-44`). The parent is then recorded as `MODEL_UNAVAILABLE` (`agentManager.ts:709`).
- **Scenario (probe 3d):**
  - Strict coding research with `JARVIS_AGENT_BUDGET_TOOL_CALLS=1` ends FAILED `MODEL_UNAVAILABLE`, with the message "…Deep Analysis Worker: The toolCalls budget is used up".
  - The same setting on an unconfigured coding agent ends COMPLETED (probe 3f), as before.
- **Effect:** within the plan's wording ("a used-up budget ends the task FAILED"). The reason text is kept, but the error code and the comment say "model".
- **Fix:** either fix the comment and accept the code, or use a code that keeps the budget kind (for example, rethrow as `BudgetExceededError`, so the manager records `BUDGET_EXCEEDED`).

**R4. The gate's identity lookups run outside the provider guard, with no abort signal or time limit of their own, and also when independence is not required.**
- **Where:**
  - `core/agents/behaviors/toolLoop.ts:111-113`: `qaGate` runs for all QA work.
  - `bridge/modelRouter.ts:481`: `validateModel(t.model)`, with no signal.
  - `bridge/anthropicProvider.ts:162-178`: the SDK client's default timeout and retries.
- **Effect:**
  - A task cancelled during a lookup still ends promptly (probe 2f), because the manager races the behaviour against the abort.
  - A slow or hanging `models.retrieve` delays QA until the SDK gives up, and it counts against no breaker or RPM limit.
  - When independence is not required, the lookup only feeds a label, yet QA still waits for it (probe 2d).
- **Fix:** skip `resolveTargets` when not required (use the name-only check for the label), or pass the task's signal and a short time limit to the lookup.

**R5. Docs still describe the state before the gap closure in two places.**
- `ai_workflows/runs/2026-11-15_phase1a-model-gateway/FINAL_APPROVAL_REPORT.md:9-11`:
  - it says "Independent QA: Not enforced" and lists only reviews up to `INDEPENDENT_REVIEW_LAST.md`;
  - `change_log.md` says the gap closure "results are in `FINAL_APPROVAL_REPORT.md`", which is not true yet.
- `docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md:88` and `:99` still say the independence check is not used by the runtime. Row `:93` is still correct for `observedAgentIndependence`.
- **Fix:** update both, as plan step 7 requires.

### Info

- `observedAgentIndependence` still compares the requested `model` of usage records and ignores the new `servedModel` (`modelCategories.ts:315`). A strict reply that `confirmIdentity` rejects is recorded `ok: true` with its `servedModel`, because the record is written before the check. Nothing in the enforcement path reads these records.
- A strict target whose provider is not registered resolves as `resolved: true, ids: [model]` (`modelRouter.ts:479-483`). Its call then fails "not configured", so QA cannot be labelled `independent` through it.

---

## 4. Earlier findings

| Finding | Status |
|---|---|
| M-A (alias and dated id counted as independent) | **Resolved** (probes 2a, 3g; `gapReviewFixesTest`). Residual by name outside Claude: R2 |
| M-B (bare non-Claude name under Claude as primary) | **Resolved** for strict routes (probe 1; `claudePrimaryStrictTest`). Non-strict target listing: R1 |
| L1 (coding helpers' own routes) | Open, documented in `.env.example:141-142`; owner's decision |
| L2 (inconclusive result promoted to memory) | Open; outside the approved file list; owner's decision |
| L3 (budget not propagated) | **Resolved**; label side effect R3 |
| L4 (docs; `servedModel`) | **Resolved** for code, comments, `.env.example`, change log and the tracker's P-rows. Open: `FINAL_APPROVAL_REPORT.md` and two tracker rows (R5) |
| L5 (`MODEL_UNAVAILABLE` for non-strict agents) | Open, recorded in the change log; owner's decision |
| L6 (test gaps) | **Resolved** for M-A, M-B, the Gemini tool-call report and the strict stream. TIMED_OUT/CANCELLED for the verifier still share one branch |
| L7 (JSDoc placement) | **Resolved** |

---

## 5. What I ran

**Integrity**
- `git status --porcelain` and the sha256 of 376 source, test and config files were recorded before my runs and compared after: identical.
- `git diff --name-only HEAD -- tests`, `git diff --name-only HEAD -- pnpm-lock.yaml package.json` and `git diff --check HEAD`: empty.
- `sha256sum -c evidence/gap-review-fixes/production-hashes-before.txt`: the five files listed in the brief changed, and no others did.

**Typecheck:** `pnpm run typecheck`, exit 0.

**Tests (runner only)**
- The ten named in the brief: 10 passed, 0 failed.
- A further 21, run with `--only`, all passed: `modelRouteCorrectionsTest`, `modelRouteRound3Test`, `reviewRound3FixesTest`, `finalReviewFixesTest`, `modelRoleRoutingTest`, `providerIsolationTest`, `providerCapabilitiesTest`, `usageLedgerTest`, `qaModelFailureTest`, `claudeProviderTest`, `providerHealthTest`, `llmCancellationTest`, `llmClientBehaviourTest`, `foregroundPriorityTest`, `agentRuntimeTest`, `jarvisAgentIntegrationTest`, `goalAgentIntegrationTest`, `codeRepairTest`, `backgroundResearchTest`, `selfHealingHonestyTest`, `replyGoldenTest`.
- On the `c4ac909` copy: `gapReviewFixesTest` and `claudePrimaryStrictTest` gave 0 passed, 2 failed.
- No output contains a 401. `--ci` was not run.

**Probes** (in `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review-recheck/`, run with `pnpm exec tsx <path>` from the repo root; every probe registers its stand-in under `anthropic` before any call):
- `probe1_claude_primary.mts` (`probe1.out`): the strict-route matrix under Claude as primary, and target listing and lookups with coding unset.
- `probe2_real_claude_adapter_qa.mts` (`probe2.out`, `probe2.full.out`): the real `AnthropicProvider` class with a fake SDK client, and QA tasks through the agent manager. Covers alias/dated, two models, failing lookups, not required, and cancellation during a slow lookup.
- `probe3_l3_l4_regressions.mts` (`probe3.out`): usage records, L3 with model-call and tool-call budgets (strict and unconfigured), and the QA reply check against coding's ids.
- `probe4_name_only_identity.mts` (`probe4.out`): a gateway id, and a Gemini name pair.

Selected output:
```
1.i bare non-Claude gpt-5-mini: StrictRouteError: … names the model …; sent nothing
1.o possibleTargets(coding_agent), coding unset: [{"provider":"anthropic","model":"llama-3.1-8b-instant","exact":false},{"provider":"openai","model":"gpt-4o-mini","exact":false}]
1.o model lookups over 3 QA checks: llama-3.1-8b-instant, llama-3.1-8b-instant, llama-3.1-8b-instant
2.a alias (coding) vs dated id (QA), required: FAILED | independent QA unavailable: anthropic claude-opus-5-5 and anthropic claude-opus-5-5-20261101 are the same model … | Claude calls none
2.c lookups fail (500), required: FAILED | … the identity of anthropic claude-opus-5-5 could not be looked up …
2.f slow lookup (1.5 s), task cancelled at 200 ms: CANCELLED in 202 ms | Claude calls none
3.d strict coding research, tool-call budget 1: FAILED MODEL_UNAVAILABLE | … The toolCalls budget is used up …
3.g QA reply reports coding's dated id (other case): FAILED MODEL_UNAVAILABLE | independent QA unavailable: QA was answered by Claude-Opus-5-5-20261101 …
4.a coding anthropic:claude-opus-5-5, QA openai:anthropic/claude-opus-5-5 (gateway id): independent=true
```

**A side effect of my probes.** Probes 1 and 4 did not set `JARVIS_DATA_ROOT`. The usage ledger follows the workspace root, not the working directory, so those probes appended 21 stand-in usage records to the git-ignored `data/usage/model_usage.jsonl`: lines 3–23, timestamps 2026-11-16T14:12:10Z to 14:16:27Z. Lines 1–2, from 13:44–13:45, predate my run. The file is not tracked and holds no message text. I did not edit it further, because the brief forbids other edits. Remove those lines if the ledger in this container matters.

---

## 6. What only the owner's Windows PC or live providers can verify

- **Claude:**
  - whether `models.retrieve(alias)` returns the dated id that `messages.create` then reports. M-A's fix relies on it: if retrieve returned the alias itself, an alias/dated pair would again look like two models;
  - the latency and failure rate of that lookup at QA start (R4).
- **Gemini's OpenAI-compatible endpoint, Groq and the `openai` fallback:**
  - the exact `model` string each reports for each configured name;
  - whether an alias is reported as asked or resolved (R2). Strict routes fail closed on any other form.
- **Strict routes under Claude as primary with the real adapter:** that every configured Claude name is accepted, and that the refusal of bare non-Claude names matches the owner's settings, including `JARVIS_MODEL_CODING` / `REVIEW` for code repair and goal checks.
- **End-to-end runs with real models:**
  - one strict coding run and one strict QA run;
  - a GitHub research request under a strict coding agent, including a budget stop;
  - QA independence in each D1 setting.
- **The tests blocked or skipped on Linux:** the Windows/PowerShell, Redis, `.venv`, bridge-token, live-provider and TTS tests listed in `after-ci.txt`.
