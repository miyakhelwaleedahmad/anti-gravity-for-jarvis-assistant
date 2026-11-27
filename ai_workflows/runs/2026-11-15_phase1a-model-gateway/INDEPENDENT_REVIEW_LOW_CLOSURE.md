# Independent review: low-finding closure (L1, L2, L5, R1–R4)

**Reviewer:** an independent, read-only agent with no part in writing the code, the plan or the earlier reviews.
**Scope:** the uncommitted Phase 1A work on `claude/jarvis-repair` (base `c4ac909`), focused on the changes made under `LOW_CLOSURE_PLAN.md` (Gate 1 approved 2026-11-16, D-1 "pause for review").
**Method:**
- I confirmed that the current source matches `evidence/low-closure/source-hashes-at-review.txt` (every file OK) and that the copies in `scratchpad/low-before/` match `evidence/low-closure/production-hashes-before.txt`.
- I diffed the 11 changed production files against those copies and read the surrounding code: router, categories, agent manager, behaviours, goal executor, recovery, runtime and learning.
- I ran the typecheck, 25 tests through the runner and seven probes of my own.
- The author's documents were read as context only.

---

## 1. Verdicts

**(a) Implementation correctness: correct as planned, with one Medium gap.**
- Every planned change is in place and behaves as the plan says on the paths the plan names. Codes and classes that existed before are unchanged (probe 4: same class and same signature as `c4ac909` for every existing code tried).
- The gap (M1) is a path the plan did not name. When QA, or a strict coding agent, splits a request into parts, a helper's tool-budget failure or identity failure is re-recorded on the parent as `MODEL_UNAVAILABLE`.

**(b) Independent QA enforcement: enforced and fail-closed.**
- Look-ups are bounded, made only when independence is required, and not repeated for 60 s after a failure.
- The listed forms of aliases fold into one model.
- A floating `-latest` name, in the setting or in a reply, is never independent.
- A false `independent` is still possible for alias forms the key does not fold (Bedrock- and Vertex-style ids, dotted versions) and for an Ollama-style `:latest` tag (L-1, L-2). This is the residual of the earlier R2, narrowed.

**(c) Readiness to commit: NOT READY.**
- The owner's rule is that High and Medium findings are resolved before commit, and M1 is Medium.
- The fix is small and local to `core/agents/behaviors/toolLoop.ts` (protected, so it needs approval).
- After the fix: re-run the four new tests and the programme tests, then a short re-review of that change.
- The Lows below are for the owner to accept or fix. `FINAL_APPROVAL_REPORT.md` and one tracker line must be updated before commit (L-6).

---

## 2. Requirements checked

| # | Requirement | Result |
|---|---|---|
| 1 | L1: a coding helper's own setting counts among coding's models; `HELPER_ROLES` matches the registry | **Met.** `HELPER_ROLES` (`bridge/modelCategories.ts:257-260`) equals the registry: coding's `allowedChildRoles` (`specialists.ts:155`), plus `project_deep_analysis_worker` under `repo_code_analysis_worker` (`:214`), and QA's (`:176`). Probe 1d/1e: a helper's own setting is listed. A research worker that is not coding's (`fact_check_worker`) is not listed (1h). Strict roles add nothing, because their helpers inherit the strict route (`modelRouter.ts:456-461`) |
| 2 | L2: inconclusive, unverified, issues, or unfinished verification never reach trusted long-term memory | **Met for `promoteToMemory`** (probe 5). It is the only path from an agent result into long-term memory. The other writers are `save_relation` (the memory agent's tool, for facts the owner asks it to keep) and goal lessons (`goalLearning.ts:155`, text about goals). Residual: results that are never verified (L-5) |
| 3 | L5/R3: the four conditions stay distinct from agent task to goal recovery; a tool budget is never a model failure; existing codes unchanged | **Met on the direct path and the research path; not met on the split-parts path (M1).** Existing codes and classes unchanged (probe 4). The four codes give four signatures. `goalRuntime`, `goalLearning` and `goalTools` (status) need no change: `goalLearning.PROPOSALS` is `Partial`, and status prints the class name. No dashboard switches on failure classes; the typecheck passes |
| 4 | R1: with Claude as primary, the listed models are the models sent | **Met.** Probe 1, eight settings, with Claude failing and not failing: every model sent was listed. The lists also carry extra entries (the `openai` fallback, Claude's fast model after a model-specific failure), which only makes the check stricter |
| 5 | R2: aliases never count as independent; never independent without identity evidence | **Met for the forms the plan lists; residual (L-1, L-2).** When independence is not required, the name-only result is never shown as `independent`: `independenceOf` maps it to `unknown` (`toolLoop.ts:147`, probe 2d) |
| 6 | R4: look-ups bounded, only when required, failures not repeated within a minute; timers cleared; no floating promise | **Met.** Probe 2:<br>• a hanging look-up ends at the limit (1003 ms at 1000; 2502 ms at 2500; below 1000 is clamped to 1000; an invalid value gives 10 s);<br>• no unhandled rejection when the lost look-up fails later;<br>• no router timer left after a won race;<br>• one look-up in three checks, a second after 61 s;<br>• none with `resolve: false`.<br>The lost look-up is not cancelled (Info) |
| 7 | Strict routing fail-closed; no earlier correction regressed | **Met.** The 25 programme tests pass, including `strictModelIdentityTest`, `claudePrimaryStrictTest`, `lineageInheritanceTest`, `independentQaTest`, `gapReviewFixesTest`, `finalReviewFixesTest` and the round-3 tests. In `evidence/low-closure/after-ci.txt` every test that passes in `evidence/baseline-ci.txt` still passes (241 against 221 passed, 0 failed in both) |
| 8 | No tracked test changed; earlier untracked tests unchanged; lock file and package unchanged; approval gate and permission path untouched | **Met.**<br>• `git diff --name-only HEAD -- tests`: empty.<br>• `git diff --stat HEAD -- pnpm-lock.yaml package.json`: empty.<br>• No file under `security/` is modified; `core/agents/permissions.ts`, `registry.ts` and `agentContextApi.ts` have the same hashes before and after the cycle.<br>• Earlier untracked tests: all modified before 2026-11-16 14:28, when this cycle's tests were written. No hash list of them exists, so this rests on file times only |

---

## 3. Findings

### High

None.

### Medium

**M1. On the split-parts path, a helper's tool budget and identity failure become `MODEL_UNAVAILABLE` on the parent.**
- **Where:** `core/agents/behaviors/toolLoop.ts:288-303`.
  - When `needsModel(ctx)` holds (QA, or an agent on a strict route) and any part did not complete by its model, the parent throws a new `ModelUnavailableError`, whatever the helper's `error.code` and `error.budget` were.
  - `agentManager.failureCode` then records `MODEL_UNAVAILABLE` (`agentManager.ts:154`).
- **Scenario (probe 7):**
  - A) QA, "Run the type check; then review the diff", `JARVIS_AGENT_BUDGET_TOOL_CALLS=0`. Both `test_runner_worker` helpers end `BUDGET_EXCEEDED`/`toolCalls`. QA ends `MODEL_UNAVAILABLE` with "QA could not check every part: … The toolCalls budget is used up". The goal sees class `dependency` and retries later. The same request as one part (A2) gives `TOOL_BUDGET_EXHAUSTED` → `budget`.
  - B) QA strict on `qaprov:qa-model`; the helpers' replies report `other-model`. The helpers fail with a `ModelIdentityError`, and QA ends `MODEL_UNAVAILABLE` → `dependency`, retried. One part (B2) gives `MODEL_IDENTITY_UNCONFIRMED` → `configuration`, blocked.
  - C) Strict coding, two parts, tool budget 0 for the `code_analysis_worker` helpers: `MODEL_UNAVAILABLE` → `dependency`.
- **Effect:**
  - Fail-closed: the task still fails and nothing is answered by rules.
  - The approved distinctions are lost on this path. A tool budget is treated as a model failure, which requirement 3 excludes. An identity failure is retried with back-off instead of blocked.
  - `research.ts` received this fix (`failOnModelFailure`), but this second aggregation point did not.
- **Fix:**
  - Before throwing, look at the failed parts. If every failed part carries one of the carried codes, throw `PropagatedFailure` with that code and budget, using the same precedence as L-4.
  - A part that ran out of tool calls should not be counted as "not answered by its model". Record it as a limitation, as `failOnModelFailure` does, or carry `BUDGET_EXCEEDED`/`toolCalls`.
  - Keep `ModelUnavailableError` for parts answered by keyword rules or not finished by the model.
  - Add the probe 7 cases A and B as tests.

### Low

**L-1. Alias forms outside the identity key's rules are still counted as independent (R2 residual).**
- **Where:** `bridge/modelCategories.ts:238-244` (`identityKey`). The same key is used in the reply check (`toolLoop.ts:132`).
- **Scenario (probe 3), coding `p1:<a>` and QA `p2:<b>`, all `independent: true`:**
  - `claude-opus-5-5` vs `anthropic.claude-opus-5-5-v1:0`, and vs `us.anthropic.claude-opus-5-5-v1:0` (Bedrock-style ids through a gateway);
  - `claude-x-20261022` vs `claude-x-v2@20261022` (Vertex-style);
  - `claude-opus-5-5` vs `claude-opus-5.5`.
- **Effect:**
  - This happens only if the owner gives QA a gateway id for coding's model. The plan's own forms (vendor `/`, `models/`, `:variant`, date stamps, `-NNN`) do fold.
  - Name rules cannot be complete, but `.env.example:142-147` reads as if every alias were covered.
- **Fix:**
  - State in `.env.example` that only the listed forms are recognised, and that QA must not be given another provider's id for coding's model.
  - Optionally strip a leading `<vendor>.` segment, a region prefix and a `-v<N>(:<N>)?` suffix.

**L-2. An Ollama-style `:latest` tag is not treated as a floating alias.**
- **Where:** `bridge/modelCategories.ts:247-249`. `isFloatingAlias` tests the key, and the key has already lost the `:latest` suffix (`:241`).
- **Scenario (probe 3):** `llama3:latest` vs `llama3.1:8b` gives `independent: true`, with keys `llama3` / `llama3.1`.
- **Fix:** test the raw lower-cased name with `/(?:^|[-_.:])latest$/` before stripping.

**L-3. A QA setting that can never be independent is recorded as `MODEL_UNAVAILABLE` and retried.**
- **Where:** `core/agents/behaviors/toolLoop.ts:118`. Every "not independent" reason before the first call goes out without `identity`.
- **Scenario (probe 6):**
  - A) QA set to `qaprov:qa-model-latest`;
  - B) QA set to `qaprov:llama-3.1-8b-instant-001` while coding uses `llama-3.1-8b-instant`.
  - Both end `MODEL_UNAVAILABLE` → `dependency`, retried later up to the attempt limit, although no retry can change the setting.
  - A floating alias reported in a reply (F) ends `MODEL_IDENTITY_UNCONFIRMED` → `configuration`, blocked.
- **Effect:** this follows the approved plan table ("IndependentQaUnavailableError (no distinct model) → MODEL_UNAVAILABLE"). The same alias gives different outcomes depending on where it is seen.
- **Fix (owner's choice):** give setting-derived reasons (floating alias, same key, same model) a configuration code or the `configuration` class. Keep a failed or timed-out look-up as `MODEL_UNAVAILABLE`.

**L-4. With several failed workers, the strict research parent carries the first worker's code only.**
- **Where:** `core/agents/behaviors/research.ts:90`.
- **Scenario (by reading; not probed):** if the first failed worker has `MODEL_UNAVAILABLE` and a later one `MODEL_IDENTITY_UNCONFIRMED`, the parent is `MODEL_UNAVAILABLE` and the goal retries instead of blocking. Workers of one strict lineage share one route, so mixed codes need two different provider failures in one run.
- **Fix:** choose by precedence: `MODEL_IDENTITY_UNCONFIRMED`, then `BUDGET_EXCEEDED` (model), then `MODEL_UNAVAILABLE`.

**L-5. Results that are never verified still go to long-term memory.**
- **Where:**
  - `core/agents/jarvisAgents.ts:235`: only `research_agent`, `data_agent` and `coding_agent` are verified;
  - `:247`: `JARVIS_AGENT_VERIFY=0` turns verification off;
  - `:304`: a result that did not need verification is stored.
- **Scenario (probe 5):** with `JARVIS_AGENT_VERIFY=0`, a research result is stored (2 items). A `browser_agent` or `pc_agent` result without conflicts is stored without verification.
- **Effect:** this follows the plan ("a result that did not need verification is stored as today"). The owner's wording, "unverified … never reach trusted long-term memory", can be read to include these.
- **Fix (owner's choice):** with `JARVIS_AGENT_VERIFY=0`, store nothing from verified roles, or store with a lower confidence and an "unverified" mark.

**L-6. Docs not yet updated for this cycle.**
- `FINAL_APPROVAL_REPORT.md:9-11` still lists R1–R4, L1, L2 and L5 as open and does not mention this cycle.
- `docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md:130` still says "a coding helper's own setting is not counted (review L1)".
- The earlier R5 rows (`:88`, `:99`) no longer contain the stale text.
- **Fix:** update both after the M1 fix.

### Info

- **Goal state for `inconclusive` and `configuration`.** The goal becomes `blocked` with the reason "needs review: …" (or "blocked: … check the model setting"). `goalWaitingFor: 'review'` from `decide` is used only on the `wait` branch (`goalRuntime.ts:776-786`), so the goal does not show "waiting for review". This matches how `outcome_unknown` already behaves and satisfies D-1 ("pause").
- **`TOOL_BUDGET_EXHAUSTED` goes to the existing `budget` handling.**
  - The goal waits for, or is blocked on, "its budget is used up; raise the budget", although the limit that ran out is the agent task's tool-call budget (`JARVIS_AGENT_BUDGET_TOOL_CALLS`).
  - The `budget` case sets the task `ready` before the side-effect check (`goalRecovery.ts:170-174`). A task with possible side effects may therefore run again after its tool calls.
  - Both behaviours are unchanged from `BUDGET_EXCEEDED` before this cycle.
- **A lost look-up is not cancelled.** The router stops waiting at the limit, but the provider call (Claude `models.retrieve`, no signal) runs on until the SDK gives up. Its later rejection is handled (probe 2a). The gate's look-ups still take no provider-guard ticket.
- **The `unverified` verdict passes a goal task** (`goalExecutor.ts:191-198`). It cannot occur there, because it requires a task that did not complete (`verify.ts:68`, `:102`), and goal verification runs only on completed tasks.
- **A propagated `BUDGET_EXCEEDED`** (`PropagatedFailure`) is recorded through the generic branch (`agentManager.ts:724-727`), so `truncated` is not set, unlike a direct `BudgetExceededError`. Cosmetic.

---

## 4. Earlier findings

| Finding | Status |
|---|---|
| L1 (coding helpers' own routes) | **Resolved** (probe 1d, 1e; `identityAliasTest`). Tracker line stale (L-6) |
| L2 (inconclusive result promoted to memory) | **Resolved** for every verdict and for an unfinished verification (probe 5; `memoryTrustTest`). Residual: never-verified results (L-5) |
| L5 (`MODEL_UNAVAILABLE` for non-strict agents; distinct codes) | **Resolved** on direct and research paths (probes 4, 6; `errorClassificationTest`). **Open** on the split-parts path (M1) |
| R1 (Claude-primary target names) | **Resolved** (probe 1; `claudePrimaryTargetsTest`) |
| R2 (alias counted as independent) | **Partly resolved:** listed forms fold, and `-latest` is unknown (probe 3; `identityAliasTest`). Residual L-1, L-2 |
| R3 (tool budget labelled a model failure) | **Resolved** in `research.ts` (`errorClassificationTest`). **Open** in `toolLoop.ts` (M1) |
| R4 (look-ups unbounded, always made) | **Resolved** (probe 2; `identityAliasTest`). Not cancelled, and outside the guard (Info) |
| R5 (stale docs) | **Partly resolved:** tracker rows `:88`/`:99` fixed. `FINAL_APPROVAL_REPORT.md` and tracker `:130` open (L-6) |
| P3, P4, P7, P9, N1, N2, M-A, M-B, earlier rounds | **No regression found:** their tests pass, and the baseline comparison holds |

---

## 5. What I ran

All runs from the repository root. Probes live under `scratchpad/review-low/`, set `JARVIS_WORKSPACE_ROOT` and `JARVIS_DATA_ROOT` to a fresh temporary folder, and register a stand-in under `anthropic` before any router use. No network or provider call was made. `git status --porcelain` was identical before and after every run, and no file under `data/` or `logs/` changed during the review.

**Integrity**
- `sha256sum -c evidence/low-closure/source-hashes-at-review.txt`: all OK.
- The `low-before` copies match `production-hashes-before.txt`.
- `git diff --name-only HEAD -- tests`: empty. `git diff --stat HEAD -- pnpm-lock.yaml package.json`: empty.

**Typecheck**
- `pnpm run typecheck`: exit 0.

**Tests**
- `pnpm test -- --only=errorClassificationTest,memoryTrustTest,identityAliasTest,claudePrimaryTargetsTest,independentQaTest,gapReviewFixesTest,lineageInheritanceTest,strictModelIdentityTest,verificationInconclusiveTest,goalRecoveryTest,goalRuntimeTest,goalAgentIntegrationTest,agentRuntimeTest,sevenAgentTest`: 14 passed, 0 failed.
- `pnpm test -- --only=claudePrimaryStrictTest,finalReviewFixesTest,modelRouteCorrectionsTest,modelRouteRound3Test,reviewRound3FixesTest,strictHelperRoutingTest,qaModelFailureTest,providerIsolationTest,modelRoleRoutingTest,providerCapabilitiesTest,usageLedgerTest`: 11 passed, 0 failed.
- Not run (per instructions): `--ci`. I compared the author's `after-ci.txt` with `baseline-ci.txt` instead.

**Probes** (`pnpm exec tsx <path>`)

| Probe | Point |
|---|---|
| `p1_claudePrimaryTargets.mts` | R1, L1 under Claude as primary: listed against sent, eight settings, with and without a Claude failure (failover to a stand-in Groq) |
| `p2_lookups.mts` | R4: hanging and late-failing look-ups, clamp values, 60 s cache (clock moved), `resolve: false`, timers and unhandled rejections |
| `p3_aliases.mts` | R2: alias forms that fold and do not fold; floating forms; exact routes on one provider |
| `p4_goalClasses.mts` | L5/R3: class, recovery and signature for existing and new codes, current tree against `c4ac909` |
| `p5_memory.mts` | L2: `promoteToMemory` per verdict, role and setting, with a stand-in memory |
| `p6_endToEnd.mts` | QA gate and identity failures through agent task, goal executor and recovery |
| `p7_splitParts.mts` | M1: two-part QA and strict coding requests with a helper's tool budget or identity failure |

---

## 6. What only the owner's Windows PC or live providers can verify

- The model names live providers report: Claude (alias or dated id), Gemini, Groq and any OpenAI-compatible gateway. They decide whether strict replies are confirmed, whether aliases fold (L-1, L-2), and whether a floating alias is reported as asked or resolved.
- The latency and failure rate of Claude's `models.retrieve` at QA start, against the 10 s default limit, and how often the 60 s failure cache then blocks QA.
- Whether real goals hit the per-task tool budget, and how the `budget`, `blocked` and `needs_review` states read and resume ("resume goal") in the owner's own use.
- The full suite on Windows, including the tests blocked or skipped here: `windowControlTest`, `windowsScriptsTest` (PowerShell 7) and `realTtsHandoffTest` (Python with pygame).
