# Independent review: LR-2 and L-5 follow-up

**Reviewer:** an independent, read-only agent with no part in writing the code, the plan or the earlier reviews.
**Scope:** the LR-2 and L-5 change to the uncommitted Phase 1A work on `claude/jarvis-repair` (base `c4ac909`), as planned in `LR2_L5_PLAN.md` and approved in its §9.
**Method:**
- `sha256sum -c evidence/lr2-l5/source-hashes-at-review.txt`: 50 of 50 OK, before and after my runs.
- The copies in `scratchpad/lr2-before/` match `evidence/lr2-l5/hashes-before.txt`. My own diff of those copies against the current files is identical to `evidence/lr2-l5/source.diff`.
- In `hashes-before.txt`, only the nine files in that diff changed. `core/agents/behaviors/research.ts` keeps `f9a558ff…c1c281`.
- I read the changed code and every reader of `error.code`, `failure.code` and the new `causes`. I re-ran the earlier probes 7 and 8, wrote five probes of my own, and ran the typecheck and the 18 listed tests.
- The author's documents were read as context only.

---

## 1. Verdicts

**(a) Implementation correctness: correct.**
- LR-2 is fixed on the split-parts path. A tool budget mixed with a model that did not answer is now `MODEL_UNAVAILABLE` → `dependency` → retried later. Both causes are on the agent task's error, in the goal failure and in the recovery action text (probe 8 a, a2).
- Identity still leads every mix (probe 8 c1, c2, e, g).
- Pure cases are unchanged: probe 8 b, d, f, h and probe 7 A, A2, B, B2, C give the same code, class and decision as before the change.
- Two budget kinds now give one lead (`llmCalls`) and one class in either order. The failure signature can still differ between runs (Info).

**(b) Memory trust: closed for `promoteToMemory`; model-mediated paths remain, as the plan states.**
- `promoteToMemory` stores only on a `verified` verdict. This holds with `JARVIS_AGENT_VERIFY=0` and for agents that are never verified (browser, PC, memory, QA), on real root tasks (probe 4).
- An unverified result stays in the task archive, which holds the answer (probe 4). With `JARVIS_AGENT_ARCHIVE=0` there is no archive, but the console line still says there is one (Low L-A).
- Residual: in a goal, the Memory agent can still store an unverified earlier result with `save_relation`. The L-5b label is advisory only, and with three or more results it can be cut off (probe 5; Low L-B and L-C).

**(c) Readiness to commit: READY WITH CONDITIONS.**
- No High or Medium finding.
- Conditions:
  - The owner accepts or fixes L-A (wrong archive claim), L-B (label can be cut off) and L-C (residual `save_relation` path).
  - `FINAL_APPROVAL_REPORT.md` is updated, as plan §7 step 6 says.

---

## 2. Checks

| # | Check | Result |
|---|---|---|
| 1 | LR-2: every distinct cause kept (agent task `causes`, goal `causes`, action text, signature) | **Met.** Probe 8 a: agent error `{code: MODEL_UNAVAILABLE, causes: [MODEL_UNAVAILABLE, BUDGET_EXCEEDED/toolCalls]}`; goal `causes [MODEL_UNAVAILABLE, TOOL_BUDGET_EXHAUSTED]`; action "retry at …: something it needs is unavailable (…); also: the agents' tool budget ran out (JARVIS_AGENT_BUDGET_TOOL_CALLS)"; normalized signature starts `model_unavailable (+tool_budget_exhausted):` |
| 1 | Tool budget + model not answering never waits for budget or says the budget is the reason | **Met.** Probe 8 a, a2 (non-strict QA, both request orders) and the test's strict-QA case: `dependency`, `retry/continue`, `goalWaitingFor` unset. Last attempt: "failed after 3 attempt(s)"; side effects after tool calls: `blocked` (probe 3 v, w). `onBudgetExhausted` is not reached |
| 1 | Identity leads any mix | **Met.** Probe 8 c1, c2, g → `MODEL_IDENTITY_UNCONFIRMED (+MODEL_UNAVAILABLE)`, e → `(+TOOL_BUDGET_EXHAUSTED)`; all `configuration`, blocked, with "also: …" |
| 1 | Pure cases unchanged | **Met.** Probe 8 b, d, f, h: `MODEL_UNAVAILABLE`, `dependency`, no `causes`, as in the earlier `p8.out`. Probe 7 A, A2, C: `TOOL_BUDGET_EXHAUSTED` → `budget`; B, B2: `MODEL_IDENTITY_UNCONFIRMED` → blocked. Identical to the earlier `p7.out` |
| 1 | Two budget kinds: one stable result | **Met for code and class; not for the signature (Info I-1).** `failureCauses` sorts `llmCalls`, `tokens`, `toolCalls`, so the lead is `llmCalls` in either order (probe 8 j) |
| 1 | `agentManager` carries only known codes | **Met.** `carriedCauses` (`core/agents/agentManager.ts:158-167`) keeps entries whose code is in `CARRIED_CODES` and only the three budget names, and drops the list unless it has two or more entries. Only `toolLoop.ts:307` throws with `causes` |
| 1 | Other readers of `error.code` / `failure.code` | **No break; one intended change of meaning.** `research.ts:85-101` reads its own workers' codes; those workers are not split-parts parents (no `workerRole`, `specialists.ts:200-264`), so it never sees a mixed code. `taskManager.ts:285` and `agentManager.ts:1051` only print the code. `a2a.ts:189` passes the error object on, now with `causes`. `goalRuntime.ts:739-797` records class, message, action and signature; a mixed failure now takes the `dependency` path instead of `budget`, as approved. `goalLearning` counts by class. `goalTools.ts:149` prints class and the first 100 characters of the action, which hides "also: …" (Info I-2). No dashboard in the repository reads these codes. The typecheck passes |
| 2 | L-5: no unverified result reaches trusted memory through `promoteToMemory` | **Met.** Probe 4: browser, PC and memory root tasks run on a stand-in provider: 0 stored. Research, data and coding results with `JARVIS_AGENT_VERIFY=0`: 0 stored. A `verified` result: 2 stored. `FAILED`, or `JARVIS_AGENT_MEMORY=0`, with a `verified` object: 0. The only caller (`jarvisAgents.ts:451`) passes a verification made by `verifyRootResult` |
| 2 | Every write path into long-term memory | See §3 L-C and the table below |
| 2 | Unverified results stay available provisionally | **Met with the archive on** (probe 4: the archive file exists and holds the answer). **With `JARVIS_AGENT_ARCHIVE=0`:** no file is written, but the console line still names one (L-A) |
| 3 | `research.ts` unchanged; only planned files changed | **Met.** `research.ts` hash equals `hashes-before.txt`. Files newer than the pre-change copies: the eight source files and `tests/memoryTrustTest.ts` of plan §3/§5, the two new tests, `.env.example`, the tracker, `change_log.md`, `LR2_L5_PLAN.md` and `evidence/lr2-l5/*`. `memoryTrustTest.ts` differs only at line 51 |
| 4 | No regression | **Met.** `pnpm run typecheck`: exit 0. The 18 listed tests: 18 passed, 0 failed. The author's full CI run (`evidence/lr2-l5/after-ci.txt`): the 231 tests in `evidence/baseline-ci.txt` have the same verdicts; the 23 programme tests all pass (§5) |
| 5 | Tracked tests, lock file, package, security | **Met.** `git diff HEAD --name-only -- tests`: empty. `git diff HEAD --stat -- pnpm-lock.yaml package.json security core/agents/permissions.ts core/agents/registry.ts`: empty. `git diff --check HEAD`: clean |

**Write paths into long-term memory (audited in the current source):**

| Path | Agent results can reach it? |
|---|---|
| `promoteToMemory` → `memoryManager.rememberFact` (`jarvisAgents.ts:296-323`) | Only with a `verified` verdict (probe 4) |
| `save_relation` → `rememberFact(…, 'relation')` and the graph (`core/tools/memoryTool.ts:58-59`) | **Yes, through a model.** The Memory agent has the tool (`specialists.ts:185`). In a goal it receives earlier results as context. Probe 5: it stored "fast-tool IS the best library" from three unverified results (L-C). The planner also has the tool and can read goal results through `goal_status` |
| `memory_brain` (`core/tools/secondBrainTool.ts:98`) | No agent has it. The planner can call it; it is meant for the owner's own words |
| Goal lessons (`core/goalLearning.ts:155`) | No: text about goals and the owner's feedback |
| Second brain mirror (`memory/memoryManager.ts:697`) | Follows `rememberFact`. `noteTaskOutcome` (`memory/secondBrain.ts:617`) writes a daily log line of the request and its outcome, not a fact |
| Vector index (`memoryManager.ts:389-499`) | Built only from stored facts (`rememberFact`, startup rebuild). The older insert path at `memoryManager.ts:701-806` is commented out |
| `agentMemory.rememberFact` (`memory/agentMemory.ts:222`) | No caller outside `_legacy/` |

---

## 3. Findings

### High

None.

### Medium

None.

### Low

**L-A. With `JARVIS_AGENT_ARCHIVE=0`, the "not stored" line says the result is in an archive that does not exist.**
- **Where:**
  - `core/agents/jarvisAgents.ts:304` always prints "The full result is in the task archive (data/agents/<id>.json)".
  - `core/agents/agentManager.ts:1112` writes no archive when `JARVIS_AGENT_ARCHIVE=0`.
  - `.env.example:139-140` says the full result is "kept in the task archive" without the condition, and does not list `JARVIS_AGENT_ARCHIVE`.
- **Scenario (probe 4):** a `browser_agent` root task with the archive off. Nothing is stored in memory, no archive file is written, and the console line names `data/agents/task-….json`.
- **Effect:** the result is still reported and spoken, but the owner is told where to find a file that does not exist. Provisional storage depends on the archive being on.
- **Fix:** use the run's `archivePath` (`agentManager.rootRuns()`), or check the setting. When there is no archive, say "not archived (JARVIS_AGENT_ARCHIVE=0)". Add the condition to `.env.example`.

**L-B. The L-5b label can be cut off before the Memory agent's model sees it.**
- **Where:** `core/goalRuntime.ts:648` puts the label after each result's summary (up to 400 characters). `core/agents/behaviors/toolLoop.ts:183` (protected) cuts the whole input, which is the question plus the goal context as JSON, at 1,500 characters.
- **Scenario (probe 5):** a goal with three unverified research steps and a Memory-agent step that depends on them. The goal context has 3 labels (1,433 characters). The model's message has 2 whole labels; the third ends "(not verified; do not stor". With other lengths, the cut can fall just before a label, so a result is shown with no label at all.
- **Effect:** the label is advisory in any case (L-C). This makes it unreliable even as advice.
- **Fix (unprotected):** put the label before the text, e.g. `- <title> (not verified): <summary>`, in `goalRuntime.ts:648`.

**L-C. Residual: the Memory agent can store an unverified earlier result with `save_relation` (documented in the plan, not enforced).**
- **Where:** `core/tools/memoryTool.ts:58` (`rememberFact(…, 'relation', 6)`), `specialists.ts:185`, the goal context at `goalRuntime.ts:648`.
- **Scenario (probe 5):** the Memory agent's model ignores the label and calls `save_relation` with a claim taken from the unverified results. `rememberFact` stores "fast-tool IS the best library". The planner can do the same after reading `goal_status`.
- **Effect:** an unverified claim can become a trusted fact (source `relation`), outside `promoteToMemory`. Plan §5.3 states that the label is not enforcement.
- **Fix (owner's choice):** accept and document it. To enforce it, the Memory agent or `save_relation` would need to know where a fact came from, for example by refusing `save_relation` in a goal task whose dependencies are not all verified.

### Info

- **I-1. Two budget kinds: the code is stable, the signature is not guaranteed** (probe 3 k1–k3).
  - The goal code is `BUDGET_EXCEEDED`, which is not in `CODE_CLASS` (`core/goalRecovery.ts:46-51`), so the signature has no code prefix and ignores `causes` (`:58`).
  - The signature is built from the message, which lists each part with its own budget. If the two parts' budgets swap between runs of one request, the signatures differ.
  - I could not produce this mix end to end: budgets are charged up the chain, so a parent's own budget or a shared one ran out first (probe 8 k, probe 8b g3). The plan's claim that "the same request always gets the same signature" holds when the same parts hit the same budgets. The `budget` class does not create an issue record, so the effect is small.
- **I-2. `goal_status` hides the other causes.** `core/goalTools.ts:149` shows `f.action.slice(0, 100)`. "also: …" comes after "retry at <time>: something it needs is unavailable (<message>)", so it is never in the status line (probe 3 s). The record and the history keep it. Plan §4.1 says the action text is what the goal "records and shows".
- **I-3. The wording for `BUDGET_EXCEEDED` says "model-call budget" also for a token budget** (`core/goalRecovery.ts:147`; `goalExecutor.ts:181` maps `tokens` to `BUDGET_EXCEEDED`).
- **I-4. Non-carried codes count as "the model did not answer".** `failureCauses` (`core/agents/behaviors/common.ts:91-96`) maps `AGENT_ERROR`, `TIMEOUT`, `CANCELLED` and parts with no code to `MODEL_UNAVAILABLE` (probe 8 j). This matches the plan ("or another failure") and the earlier single-cause behaviour. A helper timeout mixed with a tool budget is now retried, not left waiting for budget.
- **I-5. A parent whose own part throws stops before its helpers' causes are combined** (probe 8b g4). On strict QA, the parent's own model failure ends the task as `MODEL_UNAVAILABLE` at once, and a helper's tool budget is not recorded. The lead is still right. Behaviour from before this change.
- **I-6. Research path (frozen).** `research.ts` still uses `mostSpecificFailure`, so a model budget leads over a model that did not answer there (plan §4.3). `.env.example:143-146` describes the new rule for "a split request" without this exception.
- **I-7. `.env.example:137-139` says nothing is stored from browser, PC, memory or QA agents.** A browser or PC result with conflicts is verified (`shouldVerify`, `jarvisAgents.ts:249`) and is stored when the verdict is `verified`. The code follows option S; the sentence is slightly broader.
- **I-8. Tests.**
  - The two corrections in `test-corrections-after-fail-before.diff` do not weaken the test.
    - The first reversed-order setup would have made both parts run out of tool calls: the type-check part's keyword rule also calls a tool. I reproduced this (probe 6: `TOOL_BUDGET_EXHAUSTED` with no mix). The new version reverses the request and keeps each part's behaviour.
    - The old "no `budget is used up`" check could not pass, because the action quotes each part's own error. The new check tests recovery's own reason, and a positive check was added.
  - The reversed-order check compares only with the first mix. It passes on the unfixed source (`corrected-test-fail-before.txt` does not list it as failing), so it adds no fail-before evidence of its own.
  - Two budget kinds and "parent's own part unfinished plus a helper budget" are tested only at function level (`failureCauses`/`leadingCause`), not end to end.
  - `unverifiedMemoryTest` checks that the console line names the archive, not that the archive holds the result (probe 4 does).
  - `tests/memoryTrustTest.ts:7-8` (header) still says "A result that did not need verification is stored as before." The permission covered line 51 only.

---

## 4. Status

| Item | Status |
|---|---|
| LR-2 (mixed split chose the budget) | **Resolved** on the split-parts path (probe 8 a, a2; `mixedFailureCausesTest`). Open on the frozen research path (I-6) |
| Two budget kinds (earlier Info) | **Resolved** for code and class; signature can still vary (I-1) |
| L-5 (never-verified results promoted) | **Resolved** for `promoteToMemory`, including `JARVIS_AGENT_VERIFY=0` and never-verified agents (probe 4). Residual model-mediated path (L-C) |
| L-5b (label in goal context) | **Implemented** (`unverifiedMemoryTest`). Can be cut off (L-B) |
| M1 (helper condition on the split path) | **Still resolved.** Probe 7 A/B/C and probe 8 b, d, f, h unchanged |
| L2 (inconclusive/unverified not stored) | **Still resolved** (`memoryTrustTest`, probe 4) |
| Earlier Info: `budget` class re-runs a task without the side-effect check | Mixed cases now take the `dependency` path, which checks side effects (probe 3 w). Pure budget cases are unchanged |
| L-4, L-3 and earlier rounds | No regression found in the 18 tests run |

---

## 5. What I ran

All runs from the repository root with `pnpm exec tsx`. Every probe sets `JARVIS_WORKSPACE_ROOT` and `JARVIS_DATA_ROOT` to a new temporary folder before any import, registers a stand-in under `anthropic` before any router call, and makes no network or provider call. Probes 4 and 5 replace `memoryManager.rememberFact` with a stand-in before anything can call it. `git status --porcelain` was the same before and after, and no file under `data/` or `logs/` changed.

**Probes** (`scratchpad/review-lr2-l5/`, outputs in `*.out`):

| Probe | What it covers |
|---|---|
| `p8_rerun.mts` | The earlier probe 8 (a–h, i) against the new code, printing causes, the agent error, the action and the signature. Added: a2 (a in the other order), g2, k1–k3 (two budget kinds; the parent took the request itself), l (strict coding), j (`failureCauses`/`leadingCause` on 7 inputs) |
| `p7_rerun.mts` | The earlier probe 7, unchanged |
| `p8b_ownPart.mts` | Parent's own part unfinished or failed together with a helper budget (g3 with tool budgets 4 and 5, g4) |
| `p3_recoveryUnits.mts` | `classifyFailure`/`decideRecovery`/`goalFailureSignature` on built inputs: two budget kinds with swapped parts, wording, last attempt, side effects, single causes, an unknown cause, the `goal_status` view |
| `p4_memoryTrust.mts` | Real root tasks (browser, PC, memory) through `promoteToMemory`, archive on and off; research, data and coding results with `JARVIS_AGENT_VERIFY=0`; verified, failed and `JARVIS_AGENT_MEMORY=0` controls |
| `p5_goalMemoryPath.mts` | A goal with three unverified steps and a Memory-agent step through the real executor: what its model receives, and whether `save_relation` stores |
| `p6_originalMixA2.mts` | The first version of the test's reversed-order case, to check the author's correction |

**Tests and typecheck:**
- `pnpm run typecheck`: exit 0.
- `pnpm test -- --only=mixedFailureCausesTest,unverifiedMemoryTest,memoryTrustTest,lowReviewFixesTest,errorClassificationTest,identityAliasTest,independentQaTest,gapReviewFixesTest,lineageInheritanceTest,strictModelIdentityTest,verificationInconclusiveTest,goalRecoveryTest,goalRuntimeTest,goalAgentIntegrationTest,agentRuntimeTest,sevenAgentTest,strictHelperRoutingTest,qaModelFailureTest`: 18 passed, 0 failed.

**Full CI (not run by me):** the author's `pnpm test -- --ci` ran during this review (started 10:27 UTC) and finished while I worked. My test runs overlapped with it.
- `evidence/lr2-l5/after-ci.txt`: 254 files: 244 passed, 0 failed, 1 blocked (`realTtsHandoffTest`), 9 skipped.
- I extracted per-test verdicts from it and from `evidence/baseline-ci.txt` and compared them. The 231 baseline tests have identical verdicts. The 23 tests added by the programme, including the two new ones, all pass.
- The run ends with "ELIFECYCLE Test failed", as the baseline does, because of the blocked test.

**Only the owner's Windows PC or live providers can verify:**
- How a real model treats the L-5b label, and whether the real Memory agent or planner stores unverified claims through `save_relation` or `memory_brain`.
- Real budget timing: whether two budget kinds ever split across parts in one request (I-1).
- The archive on the PC's data folder, and the console and speech output when a result is not stored.
- The Windows-only and live-provider tests that CI skips or blocks.
