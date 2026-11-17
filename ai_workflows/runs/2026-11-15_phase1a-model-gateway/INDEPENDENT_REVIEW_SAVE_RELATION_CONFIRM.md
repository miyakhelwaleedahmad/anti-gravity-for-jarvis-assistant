# Independent review: `save_relation` keeps only what the owner confirms

**Reviewer:** an independent, read-only agent with no part in writing the code, the plan or the earlier reviews.
**Scope:** this round's change to the uncommitted Phase 1A work on `claude/jarvis-repair` (base `c4ac909`):
- `ownerConfirms` and `relationRefusedInGoal` in `core/tools/memoryTool.ts`;
- the `MEMORY_NOT_STORED` check in `core/goalExecutor.ts`;
- the `.env.example` text;
- `tests/saveRelationConfirmTest.ts` and the setup added to `tests/saveRelationProvenanceTest.ts`.

The owner's decisions are in `LR2_L5_PLAN.md` §11.

**Method:**
- I read the changed code and the code it relies on: the approval gate, approval scope, registry dispatch, task-graph retries, goal recovery and goal runtime.
- I re-ran the previous review's probes against the new code and wrote six probes of my own.
- I ran the typecheck and the 18 listed tests.
- I compared the author's full CI run with the baseline.
- The author's documents were read as context only.

---

## 1. Verdicts

**(a) Implementation correctness: the core works, with three Medium defects.**

What works:
- Every `save_relation` with a request in flight asks the owner, in the foreground and in a delegated agent scope.
- Only "yes" stores. "No", no answer, and a stopped call store nothing.
- Inside a goal nothing is stored and nobody is asked.
- A goal step whose `save_relation` call was refused is `needs_review` with `MEMORY_NOT_STORED`, and the goal is `blocked`.

The defects:
- **M-1:** a fact longer than about 158 characters is cut short on the console, and longer than about 59 characters when spoken, so the owner can approve text they were not shown.
- **M-2:** the registry's 25 s limit for low-risk tools keeps running while the owner answers. A "yes" given after 25 s, inside the 30 s window, stores nothing but is recorded as approved.
- **M-3:** in the foreground planner, a "no" or an unanswered question is retried twice by the task graph, so the owner is asked three times.

**(b) Memory trust: closed, apart from what the owner is shown.**
- No path found stores a `relation` fact without the owner's "yes", except code calling the registry with no request in flight. No production caller does that.
- Other writers are unchanged:
  - `promoteToMemory` stores only verified results.
  - Goal lessons are stored with source `lesson`.
- What remains depends on the owner's "yes":
  - M-1: a long fact is approved on what was shown, not on what is stored.
  - L-3: a background agent's question can take a repeated "yes" meant for the question before it.

**(c) Readiness to commit: READY WITH CONDITIONS.**

No regression:
- Typecheck: exit 0.
- The 18 listed tests: 18 passed.
- Full CI: same verdict as the baseline for all 231 baseline tests; the 25 tests added by the programme all pass.

Conditions:
1. Fix M-1 and M-3 in `core/tools/memoryTool.ts` (unprotected).
2. Fix the L-1 pattern in `core/goalExecutor.ts` (unprotected).
3. For M-2, either the owner approves a change to a protected file, or the owner accepts it as a documented limit (see its fix).
4. Correct the `.env.example` wording (L-4).

---

## 2. Checks

| # | Check | Result |
|---|---|---|
| 1 | Memory trust re-audit | **Met, with M-1 and L-3.** Each path is in the table below. The previous probes, re-run (r1): all 16 rows, foreground and delegated, ask once and show the exact fact. Each stores 0 on "no" and 1 on "yes". This includes M-1 (relation, choice), M-2 (non-Latin, two-letter, common words) and the owner-pasted text f1 |
| 2 | Exact fact shown, relation included | **Met for short facts, not for long ones** (M-1). Up to 158 characters, the TARGET line is `"<the stored fact>"` (r2). Longer facts end in "…" on the console. By voice, the fact is said up to about 59 characters. Line breaks inside an entity are shown as spaces but stored as typed |
| 2 | Asking agent shown | **Partly** (L-3). On the console, inside EXPECTED EFFECT only: "(asked by JARVIS › Memory & Personalization Agent)", 156 of the 160 characters allowed. There is no ASKED BY AGENT line. By voice it says "I need your approval", for a background agent too |
| 2 | Stores only on true | **Met.** r1, r2, r6, and the new test |
| 2 | Denial, timeout, withdrawal, cancelled, aborted store nothing | **Met.** r1 ("no"), r4 (timeout), r3 T3 (call stopped while asking), and `memoryTool.ts:89-92` (aborted before or after asking). The question is not withdrawn when the call stops (M-2) |
| 2 | Time budget paused while asking | **Not met** (M-2). `save_relation` is `riskLevel: 'low'`, so it runs through `_executeRaw` (`toolRegistryV2.ts:960-961, 1050-1069`). There, a fixed 25 s timer (`:279`) aborts it, and no `currentToolCall()` scope exists, so `whileOwnerAnswers` pauses nothing. r3 T4, with the real limit: "yes" after 26 s → decision `approved=true`, tool `ABORTED`, stored 0 |
| 2 | Nothing asked inside a goal or for a credential | **Met.** r1 C and P5, r5 G1: asked 0. The credential case is covered by the new test (refused before asking, `memoryTool.ts:83-85`) |
| 2 | No request in flight unchanged | **Met** (new test: stored, not asked). No production caller found |
| 2 | Background vs foreground, `approvalScope`, nested approvals, `recentDecisions` | **Mostly met; see L-3 and I-2.** <br>• One question is on display at a time; each answer settles only the question shown. <br>• A background question that appears right after a foreground one is answered has no answer grace (`approvalGate.ts:389`: only goal requests get one). In r6, a second "yes" 80 ms after the first approved the background agent's fact. <br>• Decisions carry no `rootTaskId` or `agentId`. <br>• Through the registry, another approved call's scope cannot answer the confirmation: it is stripped at `toolRegistryV2.ts:669-671` (r7). Called directly inside an approved scope, it would be answered `by: scope` (I-2; no production caller) |
| 2 | Voice and console paths | Typed: real gate with only the prompt function scripted (r1, r2, r3, r7), and the CLI-loop mode with scripted `offerConsoleAnswer` (r6). Voice: the request object and `spokenApprovalRequest` text (r2). Risk 1 can be approved by voice under the default `JARVIS_VOICE_APPROVAL_MAX_RISK=2` |
| 3 | L-3: refused step is `needs_review` / `MEMORY_NOT_STORED`, the goal waits | **Met for a step that called `save_relation`** (r1 P5, r5 G1). The goal becomes `blocked` with `blockedReason` "needs review: the fact was not stored…", and `goal_status` shows it (`goalTools.ts:130`, cut to 120 characters) |
| 3 | False positives | **One found** (L-1). Every toolLoop limitation starts "Tool refused or failed:", so the check's `refused\|failed` test always passes. Any limitation that mentions `save_relation` matches. r5 G3: a browser step whose failed tool output quoted "save_relation failed" was marked "the fact was not stored". "Stored one fact, refused another" cannot happen in a goal, since every call there is refused |
| 3 | Residuals | **Two** (L-2). A memory step whose model never calls the tool and says "Saved" ends `completed` (r5 G2). After a restart, `inspectPrevious` takes an archived COMPLETED result without the check (r5 I1, `goalRuntime.ts:1059-1062`) |
| 3 | `goalRecovery` / `goalRuntime` with class `inconclusive` | **Met.** `classifyFailure` returns the given class. `decide` gives `needs_review` / `block` / review, and the attempt is not counted. The signature is built (`goal_task`, includes the code). `onTaskFinished(…, cls)` makes no lesson. `onGoalFinished('blocked')` stores nothing in memory. `PROPOSALS` has no `inconclusive` entry, so a repeated pattern says "look at the failures". `goalManager.ts:659` returns `needs_review` tasks to `ready` on resume, so a resumed memory step is refused again (I-3) |
| 4 | `.env.example` matches the code | **Mostly.** <br>• True: "with JARVIS_AGENT_VERIFY=0 nothing is stored"; "Browser, PC and memory results are verified only when they have conflicts; QA results never are" (`jarvisAgents.ts:235,246-250`); "inside a goal it stores nothing and does not ask". <br>• Not accurate: "it shows you the exact fact" (M-1). "A goal step that tried to keep a fact waits for your review" holds, but also catches steps that did not try (L-1), and a step that only says it saved does not wait (L-2). See L-4 |
| 5 | No regression | **Met.** <br>• `pnpm run typecheck`: exit 0. <br>• `pnpm test -- --only=<the 18>`: 18 passed, 0 failed. <br>• `evidence/save-relation-confirm/after-ci.txt`, read once finished: 256 files, 246 passed, 0 failed, 1 blocked (`realTtsHandoffTest`), 9 skipped. <br>• Per-test verdicts against `evidence/baseline-ci.txt`: 231 of 231 identical; the 25 tests not in the baseline all pass. <br>• Ends "ELIFECYCLE Test failed", as the baseline does, because of the blocked test |
| 6 | Only planned files changed | **Met.** <br>• `sha256sum -c hashes-before.txt`: only `core/tools/memoryTool.ts`, `core/goalExecutor.ts` (listed twice) and `.env.example` differ. <br>• `security/approvalGate.ts`, `security/approvalRequest.ts`, `security/approvalScope.ts`, `core/agents/*`, `core/traceContext.ts`, `core/goalRuntime.ts`, `core/goalRecovery.ts` and `memory/memoryManager.ts` are unchanged. <br>• `sha256sum -c source-hashes-at-review.txt`: all OK. <br>• `src-before/` copies match `hashes-before.txt`, and my diffs of both source files are identical to `source.diff`. <br>• Files newer than `INDEPENDENT_REVIEW_SAVE_RELATION.md` (outside the evidence folder): those three, the two tests, `LR2_L5_PLAN.md`, `change_log.md`, `docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md`. <br>• `git diff HEAD -- tests`: empty. `git diff HEAD -- package.json pnpm-lock.yaml`: empty. `git diff --check HEAD`: clean |

**Every way into trusted long-term memory, in the current source:**

| Path | Now |
|---|---|
| Main planner → `save_relation` (`planningToolSelection.ts:263-265`) | Asks the owner. "Yes" stores; anything else stores nothing (r1, r4). M-1, M-3 |
| Deterministic routes | No route calls `save_relation` (unchanged) |
| Skills | None calls `save_relation` or `rememberFact` (unchanged) |
| Memory agent in a goal | Refused, nobody asked (r1 C, P5; r5 G1) |
| Memory agent from `delegate_task` (path 3) | Asks the owner, naming the agent on the console (r1 A, B; r2). **Closed**, subject to L-3 |
| Memory agent via the A2A HTTP endpoint | Asks the owner, so a token holder can no longer store without the owner's "yes" |
| `memory_brain` | Owner's words; unchanged this round |
| `promoteToMemory` (`jarvisAgents.ts:296-323`) | Verified results only; unchanged |
| Goal lessons (`goalLearning.ts:129,155`) | Source `lesson`; unchanged. The new `inconclusive` failure creates no lesson |
| No request in flight | Stored without asking; no production caller found |

---

## 3. Findings

### High

None.

### Medium

**M-1. The owner is not always shown the fact that is stored.**
- **Where:**
  - `core/tools/memoryTool.ts:41-46` passes `"<fact>"` as the target.
  - `security/approvalRequest.ts:211` (protected) cuts the target to 160 characters and folds whitespace.
  - `security/approvalRequest.ts:277` says at most 60 characters by voice.
  - `memoryTool.ts:98` stores the whole fact.
- **Scenarios (r2):**
  - **Console.** Fact `User's sister LIVES_IN Lahore, Punjab, Pakistan, near the old city, … and the owner said the research agent verified that fast-tool IS the best library`.
    - Shown: 160 characters, ending "…and the owner …".
    - Stored: all 225 characters, including the claim about fast-tool.
  - **Voice.** A 129-character fact is said as "…User's sister LIVES_IN Lahore, Punjab, Pakistan and the ow…". A spoken "yes" stores all of it.
  - **Line breaks.** An entity "dark theme\n\n\nfast-tool IS the best library" is shown on one line and stored with the line breaks.
- **Effect:** the confirmation is the whole memory-trust control. A model can put a long tail into an entity and get it approved unseen. This is the same unverified-claim path M-1 of the previous review closed.
- **Fix (unprotected, `memoryTool.ts`):**
  - Refuse a fact that does not fit in what the console shows. For example, refuse when the fact is over 150 characters, or contains a line break or control character. Say "keep it shorter".
  - When the request source is voice and the fact is longer than what is spoken (about 55 characters), ask with a risk label above `JARVIS_VOICE_APPROVAL_MAX_RISK` (e.g. `LEVEL_3`), so a typed answer is needed.
  - The alternative, changing the cut in `approvalRequest.ts`, is protected.

**M-2. The confirmation does not pause the tool's time limit, and a stopped call does not withdraw it.**
- **Where:**
  - `save_relation` is `riskLevel: 'low'` (`memoryTool.ts:55`).
  - The registry runs it in `_executeRaw` (`core/toolRegistryV2.ts:960-961, 1050-1069`, protected), with a fixed `EXECUTION_TIMEOUT_MS = 25_000` (`:279`).
  - `approvalGate.requestApproval` pauses and withdraws only through `currentToolCall()` (`approvalGate.ts:214-216`), which exists only for sandboxed (medium/high) calls. `memoryTool.ts:92` then throws `ABORTED`.
- **Scenarios (r3):**
  - T4, the real limit: the owner answers "yes" after 26 s, inside the default 30 s window. The decision is recorded `approved=true by=console`, the tool returns `ABORTED`, and nothing is stored.
  - T3: the caller stops the call 200 ms into the question. The gate receives no stop signal, the question stays on display, the owner's later "yes" is recorded as approved, and nothing is stored.
  - In practice, by voice: up to 10 s for speech to start, plus the time to say it, plus a 20 s answer window. Or a question queued behind another approval: its wait counts against the 25 s.
- **Effect:** fails safe (nothing stored), but the owner's "yes" is lost and the security audit says "approved". The plan's "the tool's time budget is paused while asking" does not hold.
- **Fix:**
  - **Full fix (protected):** either `_executeRaw` runs low-risk calls under the sandbox's pausable call budget (`toolRegistryV2.ts`), or `save_relation` is marked `askOwner` so the registry asks before it starts its timer (`toolCatalog.ts`/`riskEngine.ts`). The second also gives the request the agent and goal ids (L-3).
  - **Unprotected mitigation (`memoryTool.ts`):**
    - pass a typed timeout below the limit (the sixth `requestApproval` argument, e.g. 20 s);
    - when the signal is aborted after a "yes", return "your answer came after the time limit; nothing was stored" instead of throwing `ABORTED`;
    - document the limit for spoken answers.

**M-3. In the foreground planner, a "no" or an unanswered confirmation is asked again twice.**
- **Where:**
  - The refusal `Error: save_relation refused - you did not confirm …` (`memoryTool.ts:91`) has no `error` code.
  - The orchestrator throws its output (`core/orchestrator.ts:1568`, protected).
  - `taskGraphEngine.ts:543-567` (protected) classifies it `transient`, and `:575` retries it (`maxRetries: 2`).
- **Scenario (r4, real orchestrator, scripted planner model):**
  - "Remember that my exam is on Friday", owner says "no": asked 3 times, at +80, +1,084 and +3,088 ms.
  - Owner does not answer: asked 3 times. With the real 30 s window that is about 90 s of questions.
  - The spoken reply is "One of my tools failed, sir. save relation refused …".
  - "Yes": asked once, stored once.
- **Effect:** the owner's "no" is not final. Repeated questions also make an unintended "yes" more likely.
- **Fix (unprotected, `memoryTool.ts`):** word the not-confirmed refusal so the graph treats it as final, as the registry's own denial does ("Action cancelled by user: …", which `taskGraphEngine.ts:549` reads as `abort`). Keep "refused" or "failed" in it, so the goal check still matches (not reachable in goals anyway).

### Low

**L-1. The L-3 check matches any limitation that mentions `save_relation`.**
- **Where:**
  - `core/goalExecutor.ts:189`: `/\bsave_relation\b/` and `/\b(refused|failed)\b/i`.
  - Every tool failure is recorded as `Tool refused or failed: <tool>: <output>` (`toolLoop.ts:223,337`), so the second test always passes.
- **Scenario (r5 G3):** a browser step "Read the CI page and tell me which test failed". Its `browser_read_page` failed with output quoting `saveRelationConfirmTest - save_relation failed`. The result: `needs_review`, "the fact was not stored in long-term memory: browser_read_page: …". This is plausible for a goal working on JARVIS's own code or logs.
- **Fix (unprotected):** match only the tool's own entry, e.g. `/^Tool refused or failed: save_relation:/`.

**L-2. Two ways a "remember" goal step still ends as done without storing.**
- **Where:** `goalExecutor.ts:188-192` reacts only to a `save_relation` call that failed. `inspectPrevious` (`goalExecutor.ts:211-226`) with `goalRuntime.ts:1059-1062` completes a task from the archive without that check.
- **Scenarios (r5):**
  - G2: the Memory agent's model does not call the tool and answers "Saved: your exam is on Friday." The task and goal end `completed` with that summary.
  - I1: an archived COMPLETED run whose limitations hold the refusal is read back as a completed result.
- **Effect:** the L-3 case remains for a model that skips the tool, and for a restart between the agent's end and the goal's record.
- **Fix (unprotected):**
  - Since `save_relation` can never store in a goal, have the goal planner not plan memory-store steps (`core/goalPlanner.ts`), or treat a `memory_agent` goal step whose description is a "remember …" (`factToRemember`) as `MEMORY_NOT_STORED`.
  - Apply the same limitation check to the archived result in `inspectPrevious` (`goalExecutor.ts`).

**L-3. The question does not carry the asking agent as an agent request does, and a background question has no answer grace.**
- **Where:** `memoryTool.ts:41-46` calls `requestApproval` with strings, so the request has no `agent`, `agentId`, `rootTaskId` or `tool`. As a result:
  - no ASKED BY AGENT line (`approvalRequest.ts:250`);
  - the voice says "I need" (`:283`);
  - decisions have no `rootTaskId` (`approvalGate.ts:364`).

  Separately, `approvalGate.ts:389` (protected) gives answer grace only to goal requests.
- **Scenarios:**
  - r2: a delegated Memory task's question is said as "Sir, I need your approval to keep in long-term memory on "fast-tool IS the best library"".
  - r6: a foreground and a background question at once. The owner's "yes" settles the foreground one; a second "yes" 80 ms later approves and stores the background agent's fact. The same zero grace applies to the registry's own non-goal agent approvals, so this is not new in kind, but this change adds a new kind of background question.
- **Fix:**
  - **Unprotected (`memoryTool.ts`):** build the request with `buildApprovalRequest({ tool: 'save_relation', title, target, request, effect, risk: 1, source, agent: getAgentPath(), agentIds: getAgentIds() })` and pass the object. This gives the console line, the spoken asker and `rootTaskId`, and limits `coversNested` to the same tool (I-2).
  - **Protected (`approvalGate.ts:389`):** give grace to any request with an `agentId`.

**L-4. `.env.example:143-146` says more than the code does.**
- "It shows you the exact fact" is not true for long facts or by voice (M-1).
- "A goal step that tried to keep a fact waits for your review" also catches steps that did not try (L-1), and misses a step that only says it saved (L-2).
- **Fix:** docs only, after M-1 and L-1 are fixed; otherwise state the limits.

### Info

- **I-1. The provenance test's setup.** `tests/saveRelationProvenanceTest.ts` now has a stand-in owner that confirms exactly the two facts "the owner said". The setup does not weaken the code paths still tested: the goal refusal, L-B labels, no-request and credential controls. But the assertions "a fact not in the request's words is refused" and "a fact read from goal_status … is refused" now pass because the stand-in says no; they check the stand-in's policy, not the code. The confirmation behaviour itself is covered by `saveRelationConfirmTest`. Suggest renaming those two labels, or asserting that the owner was asked.
- **I-2. A direct call inside an approved scope is answered by the scope (r7).**
  - Called through the registry inside another approved call, the confirmation is asked: the scope is stripped (`toolRegistryV2.ts:669-671`).
  - Called as `saveRelationTool.execute` directly inside that scope, with approved values "User" or "Friday", it was answered `by: scope` and stored without asking (`approvalScope.ts:110-115`).
  - No production caller does this. The L-3 fix (setting `tool`) closes it.
- **I-3. Resume and a refused memory step.** `goalManager.ts:659` returns a `needs_review` task to `ready` on resume. A resumed memory step is refused again, so the owner's only way out is to cancel or re-plan the goal.
- **I-4. The new test stands in for `requestApproval`.** `saveRelationConfirmTest` replaces `approvalGate.requestApproval` entirely, so it does not cover what the real gate shows, the time limit (M-2), or the planner retry (M-3).
- **I-5. The previous review's I-4 is still true.** The foreground request is one module-level value (`traceContext.ts:25`). It now only affects the WHY line of a confirmation: the owner is still asked.

---

## 4. Status of the previous review's findings

| Item | Status |
|---|---|
| **M-1** (relation not checked; choice between named entities) | **Resolved by confirmation.** Each such fact is shown with its relation and stored only on "yes" (r1 a1, a2, b1–b4, h3). New M-1 limits "shown" for long facts |
| **M-2** (non-Latin, short and common-word entities passed) | **Resolved.** No word check is left; every fact is asked (r1 c1–c4, d1–d3, e1) |
| **L-1** (`.env.example` claims) | **Resolved as worded then**: the QA parenthetical is fixed, and the word-check claim is gone. New wording issues: L-4 |
| **L-2** (false refusals) | **Resolved.** The owner's own facts in other words are stored on "yes" (new test; r1) |
| **L-3** (goal "remember" step completes) | **Resolved for a step that called `save_relation`** (r1 P5, r5 G1). Residuals: L-1 (false positive) and L-2 (no tool call; restart) |
| **I-1 / path 3** (delegated Memory task) | **Closed**: asked, with the agent named on the console (r1 A, B; r2). Subject to L-3 |
| I-2 (dependency summary line) | Unchanged; advisory, and `save_relation` is refused in goals |
| I-3 (message grammar) | Resolved: that message is gone |
| I-4 (`currentRequest` is module-level) | Unchanged; see I-5 above |
| I-5 (test coverage) | The new test covers M-1, M-2, path 3 and L-3; see I-1 and I-4 above |
| L-A (archive named when `JARVIS_AGENT_ARCHIVE=0`, `jarvisAgents.ts:304`) | Open, as the owner decided (§11): protected file |

---

## 5. What I ran

All probes are in `scratchpad/review-confirm/`, outputs in `*.out` (full logs in `*.full`). Each ran with `pnpm exec tsx` from the repository root. Every probe:
- sets `JARVIS_WORKSPACE_ROOT` and `JARVIS_DATA_ROOT` to a new temporary folder before any import;
- replaces `memoryManager.rememberFact` with a stand-in before anything can store;
- registers a stand-in provider under `anthropic`;
- makes no network or provider call. r4 also tried a local Redis connection and went on without a cache;
- never waits on a real console or voice prompt: either the gate's prompt functions are scripted, or the gate is in CLI-loop mode answered by `offerConsoleAnswer` with a 10 s window (r6).

`git status --porcelain` was the same before and after, and no file under `data/`, `logs/` or `memory/` changed.

| Probe | What it covers |
|---|---|
| `r1_rerun.mts` | Previous probes 1 (16 rows × foreground and delegated × "no" and "yes"), 2 A/B/C (real `AgentManager`, default executor `toolRegistryV2`, real Memory agent) and 5 (one-step "remember" goal), through the real `requestApproval` |
| `r2_display.mts` | Console block, spoken text and decision record for short, long and multi-line facts, foreground and delegated, typed and voice |
| `r3_timeBudget.mts` | The registry limit while the owner answers: control; limit lowered to 300 ms; call stopped while asking; the real 25 s limit with a "yes" at 26 s |
| `r4_plannerRepeat.mts` | A "remember" request through the real orchestrator (scripted planner model): "no", no answer, "yes" |
| `r5_goalL3.mts` | `GoalRuntime` + `AgentGoalExecutor`: refused call (G1), no tool call (G2), unrelated limitation (G3), `inspectPrevious` on an archived result (I1); class, signature, `blockedReason` |
| `r6_queue.mts` | A foreground and a background confirmation at once; a repeated "yes" |
| `r7_scope.mts` | Another approved call's scope, through the registry and by a direct call |

**Tests and typecheck:**
- `pnpm run typecheck`: exit 0.
- `pnpm test -- --only=saveRelationConfirmTest,saveRelationProvenanceTest,unverifiedMemoryTest,memoryTrustTest,mixedFailureCausesTest,secretSinksTest,verifyAfterActTest,executionDispatchAuditTest,sevenAgentTest,jarvisAgentIntegrationTest,goalRuntimeTest,goalAgentIntegrationTest,goalRecoveryTest,toolDiscoverabilityAuditTest,plannerDecisionAuditTest,fullSystemIntegrationTest,adminControlTest,approvalBudgetR31Test`: 18 passed, 0 failed.
- `fail-before.txt` (12 of 19 fail) and `on-original-c4ac909.txt` (13 of 19 fail) show the new test fails without the change.

**Full CI (not run by me):** the author's `--ci` run was still running when I started. I read it once it had finished; the comparison is in §2, check 5.

**Only the owner's Windows PC or live providers can verify:**
- How the confirmation looks in the owner's console and sounds through the real speaker and microphone: the voice cut (M-1), and how long a spoken confirmation takes against the 25 s limit (M-2).
- Whether real planner and Memory-agent models put long text into entities (M-1).
- What real models say after a "no", and whether they call the tool again.
- Whether the goal planner plans memory steps whose model skips the tool (L-2).
- How often background and foreground questions overlap in real use (L-3).
- The Windows-only and live-provider tests that CI skips or blocks (`realTtsHandoffTest` is blocked here).
