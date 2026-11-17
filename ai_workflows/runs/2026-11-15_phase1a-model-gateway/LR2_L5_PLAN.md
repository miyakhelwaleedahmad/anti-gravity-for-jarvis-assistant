# Patch plan: LR-2 and L-5 follow-up (Phase 1A)

> Status: **investigation only. No source or test file has been changed.** Both fixes need protected files, so this plan stops for Gate 1 approval.
> Branch `claude/jarvis-repair`, base `c4ac909`, nothing committed. `core/agents/behaviors/research.ts` is frozen by the owner and is not touched by this plan.

## 1. What was investigated

| Finding | Root cause | Reproduction (reviewer's probes, current source) |
|---|---|---|
| **LR-2** | `core/agents/behaviors/toolLoop.ts:303-304` (protected). When a split request fails, the parent takes one code from `mostSpecificFailure`, which puts a budget ahead of "model unavailable". Parts with no code (answered by keyword rules, unfinished, the parent's own part) do not count | Probe 8 a: QA, part 1 out of tool calls, part 2 answered by rules because its model was down. Goal code `TOOL_BUDGET_EXHAUSTED`, class `budget`, "waiting: the goal's budget is used up" |
| **L-5** | `core/agents/jarvisAgents.ts:296-308` (protected). `promoteToMemory` stores any completed result unless a verification ran and was not `verified`, or one was required and did not finish. With `JARVIS_AGENT_VERIFY=0`, `shouldVerify` is false, so nothing is "required" | Probe 5: research result with `JARVIS_AGENT_VERIFY=0`: stored (2 items). `browser_agent` and `pc_agent` results, never verified: stored (2 items each) |

## 2. Audit: every write path into long-term memory

| # | Path | What it writes | Verified first? |
|---|---|---|---|
| 1 | `promoteToMemory` (★`core/agents/jarvisAgents.ts:312,319`). Only caller: the `delegate_task` completion handler in the same file (`:452`) | The answer and up to three strong findings of an agent result, source `agents` | **Gap (L-5).** Stored unverified when verification is off, or when the role is never verified |
| 2 | `save_relation` tool (`core/tools/memoryTool.ts:58-59`): fact store and graph. Callable by the planner and, among agents, only by the Memory agent (`specialists.ts:185`) | A fact the request asks to keep, source `relation` | **Partial gap.** In a goal, a Memory-agent task receives earlier task results as context (`core/goalRuntime.ts:647`). With `JARVIS_AGENT_VERIFY=0` those results are unverified, and the Memory agent may store them |
| 3 | Goal lessons (`core/goalLearning.ts:155`) | JARVIS's own experience of a goal (failed goal, repeated problem) and the owner's feedback, source `lesson` | Not agent results. No change proposed |
| 4 | Second brain (`memory/secondBrain.ts:701`) | A mirror of every `rememberFact` call | Follows paths 1–3 |
| 5 | `memory_brain` tool (`core/tools/secondBrainTool.ts:98`) | The owner's explicit "remember this" | Owner's own words |
| 6 | `agentMemory.rememberFact` (`memory/agentMemory.ts:222`) | — | No caller in the source |
| 7 | `ingest_documents` (Memory agent) | The owner's documents into the search index | Not agent results |

**Provisional results.** The existing architecture already keeps every root task's full result outside long-term memory: the task archive `data/agents/<rootTaskId>.json` (`agentManager.ts:1098`, off only with `JARVIS_AGENT_ARCHIVE=0`). The plan uses that; it adds no new store.

**Observation, no change proposed.** The fact store labels every `agents` fact "from research, unverified" when it is recalled (★`memory/memoryManager.ts:1030`), including facts stored after a `verified` verdict.

## 3. Protected files needed

| Fix | Protected files | Unprotected route? |
|---|---|---|
| **L-5** | ★`core/agents/jarvisAgents.ts` | **None.** The writer and its only caller are in this file. The store below it (`memory/memoryManager.ts`) is also protected |
| **LR-2**, option A | ★`core/agents/behaviors/toolLoop.ts`, ★`core/agents/behaviors/common.ts`, ★`core/agents/types.ts`, ★`core/agents/agentManager.ts` | See option B |
| **LR-2**, option B | none | The goal layer rebuilds the causes from the task records (§4.2) |

## 4. LR-2: proposed change

### 4.1 Option A (recommended): fix where the code is chosen

**Rule.** A split request that fails records every distinct cause, and leads with the one recovery must act on first:

1. `MODEL_IDENTITY_UNCONFIRMED` (the owner must fix the setting);
2. `MODEL_UNAVAILABLE` (a part's model did not answer; this includes parts answered by keyword rules, unfinished parts and the parent's own unfinished part);
3. a budget (`llmCalls`, then `tokens`, then `toolCalls`), only when every failed part failed for a budget.

`mostSpecificFailure` and `research.ts` are not changed.

**★`core/agents/behaviors/common.ts`** (new code only):

```ts
export type FailureCause = { code: string; budget?: 'llmCalls' | 'toolCalls' | 'tokens' };

export class PropagatedFailure extends Error {
  constructor(message: string, readonly code: string, readonly budget?: 'llmCalls' | 'toolCalls' | 'tokens',
    /** Every distinct cause, when the parts failed for more than one (review LR-2). */
    readonly causes?: FailureCause[]) { … }
}

/** The distinct causes of a split request's failed parts; a part with no carried code is MODEL_UNAVAILABLE. */
export function failureCauses(parts: ReadonlyArray<FailureCause | undefined>): FailureCause[]

/** The cause recovery acts on first: identity, then the model not answering, then a budget. */
export function leadingCause(causes: FailureCause[]): FailureCause
```

**★`core/agents/behaviors/toolLoop.ts:302-307`:**

```diff
-              const carried = mostSpecificFailure(unchecked.map((r) => r.error));
-              if (carried) throw new PropagatedFailure(message, carried.code, carried.budget);
+              // Every distinct cause is kept; a budget leads only when every failed part failed for a budget (review LR-2).
+              const causes = failureCauses([...unchecked.map((r) => r.error), ...(ownByModel ? [] : [undefined])]);
+              const lead = leadingCause(causes);
+              if (causes.length > 1 || lead.code !== 'MODEL_UNAVAILABLE' || unchecked.some((r) => r.error?.code === 'MODEL_UNAVAILABLE')) {
+                throw new PropagatedFailure(message, lead.code, lead.budget, causes.length > 1 ? causes : undefined);
+              }
               const e = new Error(message);
               e.name = 'ModelUnavailableError';
               throw e;
```

The import of `mostSpecificFailure` in `toolLoop.ts` is replaced by the two new functions.

**★`core/agents/types.ts:343`:** the error gains `causes?: { code: string; budget?: … }[]`.

**★`core/agents/agentManager.ts:726-727`:** the generic branch copies `causes` from the thrown error when it is a list of carried codes.

**Unprotected:**
- `core/goalRecovery.ts`:
  - `FailureInfo` gains `causes?: string[]`.
  - `goalFailureSignature` includes the sorted causes, so a mixed failure has its own signature.
  - `classifyFailure` never returns `budget` when the causes include a model cause.
  - `decide` appends the other causes to the action text, for example "…; also: the agents' tool budget ran out (JARVIS_AGENT_BUDGET_TOOL_CALLS)". The action text is what the goal records and shows.
- `core/goalExecutor.ts:182-186`: maps the agent causes to goal codes (`BUDGET_EXCEEDED`/`toolCalls` → `TOOL_BUDGET_EXHAUSTED`) and passes them on.

**Behaviour that changes:**
- **Mixed tool budget + model unavailable:** `MODEL_UNAVAILABLE` (class `dependency`, retry later). The record names both causes. Today it is `TOOL_BUDGET_EXHAUSTED`, "waiting: the goal's budget is used up".
- **Mixed model budget + model unavailable** on the split path: also `MODEL_UNAVAILABLE`.
- **Two budget kinds:** the order is fixed, so the same request always gets the same signature (the re-review's Info item).
- **Unchanged:** pure cases (probe 7 A, B, C; probe 8 b, d, f, h) and every identity mix.

### 4.2 Option B: no protected file

`core/goalExecutor.ts` reads `manager.tasksOfRoot(rootTaskId)` after a failure and rebuilds the causes:
- each failed helper's `error.code`;
- `MODEL_UNAVAILABLE` for a completed helper whose `data.answeredBy` is not `model`;
- `MODEL_UNAVAILABLE` when the parent's message contains "a part it did itself: its model did not finish".

It then leads with the same order as option A. `goalRecovery.ts` changes as in option A.

**Costs:**
- The agent task itself stays recorded as `BUDGET_EXCEEDED`/`toolCalls` (console report, archive, `delegate_task`).
- The goal layer repeats knowledge that belongs to the tool loop (the `answeredBy` values and one message string), so it can drift.

### 4.3 Residual on the research path (frozen)

The same mix exists in strict research: one worker `MODEL_UNAVAILABLE`, another out of model calls. `mostSpecificFailure` puts the budget first, so the goal waits for budget. Fixing it needs `research.ts` or `mostSpecificFailure`, and `lowReviewFixesTest` asserts the current order ("unavailable then budget: budget is kept"). **Not changed by this plan.** It stays an open Low until you decide on L-4.

## 5. L-5: proposed change

### 5.1 Option S (recommended): only verified results are stored

**★`core/agents/jarvisAgents.ts:296-308`:**

```diff
   if (result.status !== 'COMPLETED' || process.env['JARVIS_AGENT_MEMORY'] === '0') return 0;
-  // Unverified information never becomes trusted long-term memory (owner, 2026-11-16, L2):
-  // a result that needed verification is kept only when the Verification agent verified it.
-  if (verification && verification.verdict !== 'verified') {
-    console.log(`[Agents] Not stored in long-term memory: the verification was ${verification.verdict}, not verified.`);
-    return 0;
-  }
-  if (!verification && verificationRequired) {
-    console.log('[Agents] Not stored in long-term memory: it needed verification and the check did not finish.');
-    return 0;
-  }
+  // Unverified information never becomes trusted long-term memory (owner, 2026-11-16 L2, 2026-11-17 L-5):
+  // a result is kept only when the Verification agent verified it. Anything else stays in the task archive.
+  if (verification?.verdict !== 'verified') {
+    const why = verification ? `the verification was ${verification.verdict}, not verified`
+      : verificationRequired ? 'it needed verification and the check did not finish'
+      : 'it was not verified (verification is off, or this agent\'s results are not verified)';
+    console.log(`[Agents] Not stored in long-term memory: ${why}. The full result is in the task archive (data/agents/${result.rootTaskId}.json).`);
+    return 0;
+  }
```

**Effect:**
- With `JARVIS_AGENT_VERIFY=0`, no agent result is promoted.
- Results of agents that are never verified are no longer promoted: browser, PC, memory and QA agents, unless a conflict triggers verification.
- The result is still reported, spoken and archived.

**Conflict with an existing test.** `tests/memoryTrustTest.ts:51` (written last cycle, untracked) asserts "a result that did not need verification: stored as before". Option S replaces exactly that rule, so the assertion would have to change to "not stored". **This needs your explicit permission.** No tracked test is affected.

### 5.2 Option V: only the `JARVIS_AGENT_VERIFY=0` case

`shouldVerify` is split into "would be verified" and "verification is on". `promoteToMemory` and its caller use "would be verified", so with verification off, results of the research, data and coding agents are not stored.

- **Still stored:** results of agents that are never verified, as today.
- **Tests:** no existing assertion changes.
- **Same file:** ★`core/agents/jarvisAgents.ts`.

### 5.3 L-5b (optional, unprotected): label unverified results in goal context

`core/goalRuntime.ts:647`: a result a task builds on that was not verified is marked "(not verified; do not store it as a fact)", as the same function already does for earlier partial results (`:648`).

This is a label for the Memory agent's model, **not enforcement**. Enforcing it would need the Memory agent's behaviour or `save_relation` to know where a fact came from, which is a larger change and is not proposed.

## 6. Tests (written before any fix; fail-before recorded on the current tree and on `c4ac909`)

**New `tests/mixedFailureCausesTest.ts`:**
- **Mixed, tool budget + model down** (QA split: one part out of tool calls, one answered by rules):
  - the goal code is not `TOOL_BUDGET_EXHAUSTED` and the class is not `budget`;
  - the decision does not wait for budget, and its action does not say the budget is used up as the reason;
  - both causes are in the failure record;
  - its signature differs from the pure tool-budget and pure unavailable ones.
- **Parent's own part unfinished + helper out of tool calls:** the same.
- **Identity + anything:** still `MODEL_IDENTITY_UNCONFIRMED`, blocked.
- **Controls, unchanged:**
  - pure tool budget → `TOOL_BUDGET_EXHAUSTED`, waits for budget;
  - pure model down → `MODEL_UNAVAILABLE`.
- **Two budget kinds:** the same code and signature in both orders.

**New `tests/unverifiedMemoryTest.ts`:**
- `JARVIS_AGENT_VERIFY=0`: research, data and coding results are not stored.
- Option S only: browser, PC, memory and QA results without verification are not stored.
- A `verified` result is stored (control).
- The "not stored" console line names the archive file, and the archive holds the result.
- L-5b, if approved: the goal context marks an unverified dependency.

**Existing tests:** no assertion weakened or removed. The one change is `memoryTrustTest.ts:51`, only under option S and only with your permission.

## 7. Verification after the fix

1. Focused tests: the two new tests, plus `lowReviewFixesTest`, `errorClassificationTest`, `memoryTrustTest`, the goal tests and the agent tests.
2. `pnpm run typecheck`.
3. `pnpm test -- --ci`, compared test by test with `evidence/baseline-ci.txt`.
4. A fresh independent review of the final source.
5. Source hashes recorded at review and checked again after it.
6. `FINAL_APPROVAL_REPORT.md` updated.

No commit, push or merge. Phase 1B is not started.

## 8. Decisions needed

1. **Gate 1:** approval to edit the protected files in §3.
2. **LR-2:** option A (four protected files, fixed at the source) or option B (no protected file, rebuilt in the goal layer).
3. **L-5:** option S (only verified results stored; changes one assertion in `memoryTrustTest`) or option V (only the verification-off case).
4. **L-5b:** include the goal-context label or leave it documented.

## 9. Owner's decisions (2026-11-17)

| Decision | Answer |
|---|---|
| Gate 1: protected edits | **Approved**, limited to the files and diffs in this plan. `research.ts` stays untouched |
| LR-2 design | **Option A** |
| L-5 rule | **Option S**, with permission to change the one assertion at `tests/memoryTrustTest.ts:51` to "not stored" |
| L-5b | **Include the label** |

## 10. Follow-up: the `save_relation` path (owner request 2026-11-17; review `INDEPENDENT_REVIEW_LR2_L5.md` L-C)

### 10.1 Audit: every way to reach `save_relation`

| # | Caller | Whose words reach the tool | Can an unverified agent result get in? |
|---|---|---|---|
| 1 | Main planner (`planningToolSelection.ts:263`, offered when the owner's words mention memory or remember) | The owner's request (`traceContext` request) | **Yes.** The planner can read `goal_status` or `agent_status` and save what an agent found (review L-C) |
| 2 | Memory agent in a goal (`goalExecutor` → `memory_agent`) | The goal planner's task text, plus earlier task results as context | **Yes.** Reviewer probe 5 stored "fast-tool IS the best library" |
| 3 | Memory agent from `delegate_task` | The task text the planner wrote for the request | **Yes, if the planner pastes an agent's result into the task text.** Not closable in the tool (§10.3) |
| 4 | Memory agent through the A2A HTTP endpoint (off by default; localhost; token) | The caller's text, which acts as the owner | As 3 |
| 5 | Other agents | — | None: only `memory_agent` holds the tool (`specialists.ts:185`), and no agent can spawn it |
| 6 | Code calling the registry directly, with no request in flight (tests, tools) | — | No agent output involved |

### 10.2 Fix: unprotected only

**`core/tools/memoryTool.ts`.** `save_relation` checks where the fact comes from, using `core/traceContext.ts`, which is read only:
- **Inside a goal (`getGoalContext()`):** refused; nothing is stored. A goal's facts come from other agents' results, which are not verified. They stay in the goal's record and the task archive.
- **Otherwise, when a request is in flight (`getRequestText()`):** each entity must be a generic subject (user, owner, me, I, JARVIS) or share a word with that request. A fact that is not in the request's own words is refused, and nothing is stored.
- **With no request in flight:** unchanged.

**Also in this round:**
- **L-B (`core/goalRuntime.ts:648`):** the label goes before the summary, so cutting the context never cuts the label.
- **L-A and the over-broad sentence (`.env.example`):** the archive exists only when `JARVIS_AGENT_ARCHIVE` is not 0, and a verified result of any agent (one with conflicts) is stored.

**No protected file is changed.**

### 10.3 Needs protected-file approval: not done

- **Path 3.** Inside a delegated Memory task, the tool sees the planner's task text, not the owner's own words. A planner that pastes an agent's result into "remember that …" passes the word check. Closing it needs `core/agents/jarvisAgents.ts` (`delegate_task` passes the owner's words to the root task) or the agent scope, both protected.
- **L-A console text** (`core/agents/jarvisAgents.ts:304`): the console line names the archive even when `JARVIS_AGENT_ARCHIVE=0`. This is outside the approved diff.

## 11. Owner's decisions after `INDEPENDENT_REVIEW_SAVE_RELATION.md` (2026-11-17)

**The review:** READY WITH CONDITIONS, with two Medium findings in the §10.2 word check:
- **M-1:** the relation's words were not checked.
- **M-2:** non-Latin and two-letter names passed.

It also showed a case no word check can close: a request that names two things and asks to remember the answer.

| Decision | Answer |
|---|---|
| How `save_relation` decides | **Ask the owner to confirm.** During a request, the owner's or an agent's task, it shows the exact fact, relation included, through the existing approval prompt. Only "yes" stores it. Inside a goal it stores nothing and asks nobody. With no request in flight, nothing changes. The word check of §10.2 is removed |
| L-3: a "remember" goal ends `completed` with nothing stored | **Fix it** in `core/goalExecutor.ts`. A step whose `save_relation` failed or was refused does not count as done: it is `needs_review`, code `MEMORY_NOT_STORED` |
| The two `jarvisAgents.ts` items (§10.3) | **Leave them as open Lows.** No protected-file change. With confirmation, path 3 (a delegated Memory task) is asked too, so only the L-A console line is left |

**Files:** `core/tools/memoryTool.ts`, `core/goalExecutor.ts` and `.env.example`. None is protected. `security/approvalGate.ts` is only called, through its existing `requestApproval`.

## 12. After `INDEPENDENT_REVIEW_SAVE_RELATION_CONFIRM.md` (2026-11-17)

**The review:** READY WITH CONDITIONS, with no High findings and three Medium findings (M-1, M-2, M-3).

**Fixed, in unprotected files only, with tests written first:**

| Finding | Fix | File |
|---|---|---|
| **M-1** The owner did not always see the stored fact | Refused without asking: a fact over 150 characters, or with a line break, a control, invisible or direction character, or a run of spaces. By voice, a fact over 56 characters asks with a risk above the voice limit, so it needs a typed answer | `core/tools/memoryTool.ts` |
| **M-3** A "no" was asked three times | The refusal says "cancelled by user", like the registry's own denial. The task graph and the repair step treat that as final. The fact is not quoted, so its words cannot match another repair rule | `core/tools/memoryTool.ts` |
| **M-2** (partial) The question ran against the call's 25 s limit | Answer window of 20 s. A "yes" after the call was stopped stores nothing and says so (no ABORTED throw) | `core/tools/memoryTool.ts` |
| **L-1** The goal check matched any mention of save_relation | Matches only save_relation's own failure entry | `core/goalExecutor.ts` |
| **L-2** A "remember" step could end as done without storing | A Memory-agent step asked to keep a fact ("remember that …", "keep/store/save/add … in memory") is `MEMORY_NOT_STORED`. An archived run whose save_relation failed, or such a step, is not taken back as done | `core/goalExecutor.ts` |
| **L-3** The question did not name the tool or the agent | The question is a full request: tool `save_relation`, the agent path, the agent, task and root ids. The spoken question names the agent | `core/tools/memoryTool.ts` |
| **L-4** `.env.example` overclaimed | States the limits above | `.env.example` |

**Tests:** `saveRelationConfirmReviewTest` and `saveRelationAskOnceTest`, both new.
- **Fail-before:** 5 passed, 14 failed; and 1 passed, 2 failed (`evidence/confirm-review-fixes/`).
- **Ask-once test restructured before its fail-before run:** in one process the later cases were never asked, so each answer now runs in its own process (`ask-once-test-restructure.diff`).
- **Stand-in owner in `saveRelationProvenanceTest`:** it now reads the request's target, since the question is a request object. No assertion line changed (`provenance-test-setup.diff`).

### 12.1 Needs a decision: the rest of M-2 (protected)

`save_relation` is a low-risk tool, so the registry runs it with a fixed 25 s limit that does not pause while the owner answers (`core/toolRegistryV2.ts:279`, protected). The 20 s answer window keeps an ordinary answer inside that limit. Two cases remain:
- **A question that waits in the approval queue** behind another one: the wait counts against the 25 s limit. A "yes" that then arrives after the limit stores nothing, says so, and the gate's own record still shows "approved".
- **A caller that stops the call:** the question is not withdrawn.

Both fail safe: nothing is stored. Closing them needs one of:
- `core/toolRegistryV2.ts`: run low-risk calls under the sandbox's pausable call budget;
- `core/toolCatalog.ts` or `core/riskEngine.ts`: make the registry ask before its timer starts.

**Owner's decision (2026-11-17):** "Approve registry change". Gate 1 covers `core/toolRegistryV2.ts` only: low-risk calls run under the sandbox's pausable call budget. The test comes first, and the exact diff goes in this plan before the edit (§12.2).

### 12.2 Exact patch: M-2 in `core/toolRegistryV2.ts` (protected, Gate 1 approved 2026-11-17)

**Why the narrow form.** Sending every low-risk call through `toolExecutionSandbox.run()` would change two things for all of them, which the review did not ask for:
- **Time limit:** each low-risk tool's 25 s limit becomes the sandbox's 30 s.
- **Outcome unknown:** a read-only tool that ignores its signal, such as a slow search, would be reported as "outcome unknown, may have acted". That stops goals for review and writes to the action log.

The pausable budget and its scope are private to `core/toolExecutionSandbox.ts`, which is protected and not part of this approval. So only a low-risk tool that declares it may ask the owner goes through the sandbox, as medium- and high-risk tools already do. Today that is only `save_relation`.

**`core/toolRegistryV2.ts`** (protected; the only edits):

```diff
 export interface AgentTool {
   name: string;
   description: string;
   riskLevel: RiskLevel;
+  /**
+   * The tool may ask the owner a question while it runs (approvalGate): it runs
+   * under the sandbox's pausable call budget even when its risk is low, so the
+   * question does not count against its time, and a stopped call withdraws it
+   * (review INDEPENDENT_REVIEW_SAVE_RELATION_CONFIRM.md M-2).
+   */
+  asksOwner?: boolean;
```

```diff
-          if (currentTool.riskLevel === 'low') {
+          if (currentTool.riskLevel === 'low' && !currentTool.asksOwner) {
             output = await this._executeRaw(currentTool, args, externalSignal);
           } else {
             output = await toolExecutionSandbox.run(currentTool, args, externalSignal);
           }
```

**`core/tools/memoryTool.ts`** (unprotected): `saveRelationTool` gains `asksOwner: true,`.

**What changes for `save_relation`:**
- Its time limit becomes the sandbox's low-risk budget: 30 s, or `JARVIS_TOOL_BUDGET_LOW_MS`.
- The budget is paused while a question is queued or on display.
- A stopped call withdraws its question, recorded as "cancelled", not approved.

Every other low-risk tool is unchanged.

**Test first:** `tests/saveRelationTimeBudgetTest.ts` checks:
- a "yes" given after 26 s is stored;
- a stopped call's question is withdrawn and not approved;
- a tool marked `asksOwner` runs inside a sandbox call;
- an ordinary low-risk tool does not (control).

## 13. The final review's Lows (owner decision 2026-11-17: "Fix all nine")

`INDEPENDENT_REVIEW_FINAL_MEMORY.md`: READY WITH CONDITIONS, 0 High, 0 Medium, nine Lows. All are fixed in unprotected files (`core/tools/memoryTool.ts`, `core/goalExecutor.ts`, `.env.example`), with tests written first.

| Low | Fix |
|---|---|
| L-1 Markdown by voice | A fact that speech would not say exactly as stored (`stripMarkdown(fact) !== fact`) needs a typed answer, like a long one |
| L-2 Invisible characters | Also refused: default-ignorable characters (variation selectors, Hangul fillers) and U+2800. An emoji's own U+FE0F is allowed |
| L-3 A credential split across the parts | `hasSecret` on the whole fact: refused with the credential reply. Nothing reaches the fact store or the graph |
| L-4 Replies after a refusal | A "no" or no answer is reported as `APPROVAL_DENIED`, as the registry reports its own denials. JARVIS says "Cancelled, sir. You did not approve it, so nothing was done." A stopped request says it was stopped, not "not confirmed". Policy reasons are short enough to be spoken |
| L-5 Repeat calls ask again | The owner's answer is kept per agent root task, or per owner request, and fact, for at most an hour (500 facts). A "no" is not asked again, and a "yes" stores the fact once ("Already kept…"). With no request in flight nothing is kept, as before |
| L-6 A store error after "yes" asks again | The kept "yes" lets the retry store without asking |
| L-7 The goal-step check | Recall forms ("remember what/which…", "note which…", "save time") are read-only. "Store", "record", "memorize", "make a note", "put … in memory" and "update the profile/preferences/memory" are store steps. English only, as stated in `.env.example` |
| L-8 `.env.example` overclaimed | Rewritten to match the code |
| L-9 "It can be undone" | Now `reversible: 'partial'`, as in the tool catalog |

**Tests:**

| Test | Unfixed tree | `c4ac909` | After |
|---|---|---|---|
| `saveRelationLowFixesTest` | 6 passed, 21 failed | 4 passed, 23 failed | 27/27 |
| `saveRelationRepliesTest` (real orchestrator, one process per case, reply read from the reflection's result) | 0 passed, 3 failed | 0 passed, 3 failed | 3/3 |

Evidence: `evidence/final-lows/`.

**Module state.** The answer record is module-level state in `memoryTool.ts`, bounded by time and size. It is the smallest place that sees both the owner's answer and the store.

## 14. Owner's final instructions (2026-11-17)

1. **L-4:** the reviewed change in ★`core/agents/behaviors/research.ts` is authorized and retained.
2. **LL-1 to LL-5:** stay documented in the final report; not dismissed.
3. **Windows and live-provider verification:** explicitly PENDING.
4. **Phase 1B:** not started.
5. **`main`:** no merge.
6. **Commit and push:** wait for the owner's final commit authorization.
