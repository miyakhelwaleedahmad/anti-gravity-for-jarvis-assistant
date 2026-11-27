# Independent review: the `save_relation` path into long-term memory

**Reviewer:** an independent, read-only agent with no part in writing the code, the plan or the earlier reviews.
**Scope:** this round's change to the uncommitted Phase 1A work on `claude/jarvis-repair` (base `c4ac909`): `unverifiedRelation` in `core/tools/memoryTool.ts`, the L-B label order in `core/goalRuntime.ts`, the `.env.example` text, and `tests/saveRelationProvenanceTest.ts`. Plan: `LR2_L5_PLAN.md` §10.
**Method:** I read the changed code and every caller that can reach `save_relation`, wrote five probes, ran the typecheck and the 14 listed tests, and compared the author's full CI run with the baseline. The author's documents were read as context only.

---

## 1. Verdicts

**(a) Implementation correctness: correct as far as it goes.**
- The goal check works. A Memory agent in a goal is refused through the real executor, the real `toolRegistryV2` and the real goal runtime (probe 2 C and C2, the new test).
- The agent scope reaches the tool and does not leak. The foreground request and a background agent's request stay apart in both directions, also through the registry's medium-risk queue and the sandbox with concurrent agents (probe 2 A, B, D).
- L-B is fixed. In 1,008 context layouts cut as the tool loop cuts them, no unverified summary was visible without its label (probe 3).
- The word check is narrower than the guarantee it is documented to give (M-1, M-2).

**(b) Memory trust: closed inside goals; narrowed, not closed, elsewhere.**

Unverified information can still enter trusted long-term memory (source `relation`) through `save_relation` in these ways:
1. **Main planner (foreground).**
   - The claim is in the `relation` field, which is not checked.
   - The claim is a choice between entities the owner named ("which is better, A or B? remember it").
   - An entity has no word the check can read: non-Latin script, 1–2 letters, or only common words.
   - All three reproduced in probe 1 (M-1, M-2).
2. **A delegated Memory task.** It is checked against the task text the planner wrote, not the owner's words (plan §10.3 path 3). Probe 2 B-bg stored a fact because the task text contained it. Closing this needs a protected file (I-1).
3. **The A2A HTTP endpoint.** The caller's text is treated as the owner's words. This is by design: the endpoint is token-gated, off by default and localhost-only.

**(c) Readiness to commit: READY WITH CONDITIONS.**
- No regression. Typecheck: exit 0. The 14 listed tests: 14 passed. Full CI: same verdicts as the baseline for all 231 baseline tests; the 24 tests added by the programme all pass.
- The change is a strict improvement on `c4ac909` and the previous round.
- Conditions:
  1. Either fix M-1 and M-2 in `core/tools/memoryTool.ts` (unprotected), or reword `.env.example:143-145` and plan §10.2 so they do not claim that a fact from an agent's result, a page or a document is refused (L-1).
  2. The owner accepts, or decides on, the residual paths: the choice between named entities (M-1, which a word check cannot close) and path 3 (I-1, protected).
  3. The owner accepts the false refusals of L-2, or chooses the confirmation option below.

---

## 2. Checks

| # | Check | Result |
|---|---|---|
| 1 | Audit complete | **Complete, with one difference from the plan:** path 3 has an unprotected (if costly) way to close it (I-1). See the table below |
| 2 | Guard in a goal's agent scope | **Met.** Refused through the real executor and registry (probe 2 C), also with an empty goal title (C2), and in the new test through `GoalRuntime` + `AgentGoalExecutor` |
| 2 | Guard with a request in flight | **Works as coded, bypassable** (M-1, M-2). Controls behave: "Globex" and "5000" not said → refused (probe 1 h1, h2) |
| 2 | Guard with no request in flight | Unchanged: stored (new test; probe 2 D2 shows `getRequestText()` is `undefined` after `endTrace`). No production caller reaches `save_relation` without a trace or an agent scope |
| 2 | Scope reaches the tool | **Met.** `TaskContext.callTool` (`agentManager.ts:1284-1301`) → `toolRegistryV2.execute` → `runUnderLock` (low risk, `toolRegistryV2.ts:875-877`) → `_executeRaw`. Probe 2 ran with the manager's default executor (`m.toolSource() === toolRegistryV2`: true). A medium-risk tool through `executionQueue.then` and `toolExecutionSandbox.run` saw each caller's own request and goal with four interleaved calls (probe 2 D). `save_relation` has no fallbacks, is not cacheable, and a refusal is returned, not thrown, so it is not retried |
| 2 | Foreground/background isolation | **Met.** A: foreground words contain the fact, agent request does not → refused. B: agent request contains it, a foreground call made while the agent was running → refused, and the agent's own call afterwards stored |
| 2 | Word-check attacks | See M-1, M-2 (probe 1). Very long request containing the words: stored (g1); expected, since the words are the request's. Owner quoting an agent result: stored (f2), which is the owner's choice. Owner-pasted document text: stored (f1), which contradicts the `.env.example` wording "a document is refused" (L-1) |
| 2 | False refusals | 15 of 23 plausible triples for the owner's own facts are refused (probe 4; L-2) |
| 3 | L-B: all labels survive the cut | **Met.** Probe 3: objective 0–1,450 characters, titles 4–120, 1–5 dependencies, summaries 20–900, three verified patterns. 0 cases with an unverified summary visible without its label; up to 4 labels visible. In 12 cases the label itself was cut, and then the summary was hidden too. New test: 3 of 3 labels in 1,557 characters |
| 4 | `.env.example` matches the code | **Partly.** True: verified-only promotion; with `JARVIS_AGENT_VERIFY=0` nothing is stored; the archive exists unless `JARVIS_AGENT_ARCHIVE=0` (`agentManager.ts:206,1112`); nothing stored by `save_relation` in a goal. Not accurate: lines 143-145 (L-1) and the QA parenthetical at line 139 (L-1) |
| 5 | No regression | **Met.** `pnpm run typecheck`: exit 0. `pnpm test -- --only=saveRelationProvenanceTest,…,fullSystemIntegrationTest`: 14 passed, 0 failed. `evidence/save-relation/after-ci.txt` (finished during this review): 255 files, 245 passed, 0 failed, 1 blocked (`realTtsHandoffTest`), 9 skipped. Per-test verdicts against `evidence/baseline-ci.txt`: 231 of 231 identical, and the 24 tests not in the baseline all pass. Ends "ELIFECYCLE Test failed", as the baseline does, because of the blocked test |
| 6 | Only planned files changed | **Met.** `sha256sum -c hashes-before.txt`: only `core/tools/memoryTool.ts`, `core/goalRuntime.ts` (listed twice) and `.env.example` differ. `core/agents/*`, `core/traceContext.ts`, `memory/memoryManager.ts` and the bridge files are unchanged. `sha256sum -c source-hashes-at-review.txt`: all OK after my runs. `scratchpad/sr-before/*` match `hashes-before.txt`; my diff of `memoryTool.ts` is identical to `source.diff`, and the `goalRuntime.ts` hunk matches. Files newer than `INDEPENDENT_REVIEW_LR2_L5.md` (outside `evidence/save-relation/`): those three, `tests/saveRelationProvenanceTest.ts`, `LR2_L5_PLAN.md`, `change_log.md`, `docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md`. `git diff HEAD -- tests`: empty. `git diff HEAD -- package.json pnpm-lock.yaml`: empty. `git diff --check HEAD`: clean |

**Every way to reach `save_relation` (audited in the current source):**

| Caller | Whose words the check uses | Unverified agent result can get in now? |
|---|---|---|
| Main planner (`planningToolSelection.ts:263-265`, when the words mention memory/remember/recall/forget/relation/preference) | Owner's request (`traceContext` `currentRequest`, set at `orchestrator.ts:299`) | **Yes, by M-1 and M-2**, e.g. after reading `agent_status` or `goal_status` |
| Deterministic routes | — | **No route calls `save_relation`.** "remember … preference" goes to `memory_brain` with the owner's words (`deterministicRoutes.ts:191`, `orchestrator.ts:831-835`). "ask the memory agent to …" delegates with the owner's words (`jarvisAgents.ts:560-563`) |
| Skills (`skills/`) | — | No skill references `save_relation` or `rememberFact` |
| Memory agent in a goal (`goalExecutor.ts:110-122` → A2A in-process with goal metadata) | — | **No.** Refused |
| Memory agent from `delegate_task` (`jarvisAgents.ts:427-441`) | The planner's `task` text (`run.request`) | **Yes, if the planner puts an agent's result in the task text** (probe 2 B-bg; I-1) |
| Memory agent via A2A HTTP (`a2a.ts:301-335`) | The caller's text; goal metadata accepted only in-process (`a2a.ts:316-319`) | As the caller decides (token holder acts as owner) |
| Other agents | — | No. Only `memory_agent` holds the tool (`specialists.ts:185`); no role lists it as a child role. The verification root (`jarvisAgents.ts:273`) is `qa_agent` |
| Code with no request in flight | — | Unchecked, but no production caller found |

Other writers of `memoryManager.rememberFact`:
- `promoteToMemory` (`jarvisAgents.ts:296-323`) stores only verified results.
- Goal lessons (`goalLearning.ts:129,155`) are stored with source `lesson`. A failed-goal lesson includes up to 160 characters of `goal.outcome`, which can quote an agent's failure message. This is not a claim about the world and is outside this change.
- `agentMemory.rememberFact` has no caller outside `_legacy/`.

---

## 3. Findings

### High

None.

### Medium

**M-1. The `relation` field, and a choice between entities the owner named, are not checked. An unverified claim passes.**
- **Where:**
  - `core/tools/memoryTool.ts:39` checks only `entity1` and `entity2`.
  - `core/verifiers.ts:131-132` (`relationFact`) stores the relation, uppercased, as part of the fact.
  - Entities made only of generic words (`memoryTool.ts:16`) have nothing to check.
- **Scenarios (probe 1, foreground and delegated scope give the same result):**
  - a1, request "what is the weather today?": `(User)-[FAST_TOOL_IS_THE_BEST_LIBRARY]->(JARVIS)` stored.
  - h3: `(fast-tool)-[HAS_5000]->(stars)` stored, while `(fast-tool)-[HAS_STARS]->(5000)` is refused (h2).
  - b1/b2, request "Which is better, fast-tool or slow-tool? Remember the answer": both `fast-tool IS_BETTER_THAN slow-tool` and the opposite are stored.
  - b3 ("Does Alice work at Acme or Globex? remember it" → `Alice WORKS_AT Globex`) and b4 (`fast-tool IS_NOT safe`) are stored.
  - Realistic path: an earlier delegated research task compared two libraries. The owner later asks "what did the agents find about fast-tool or slow-tool? remember the answer". The planner reads `agent_status` and stores the agent's verdict.
- **Effect:** an agent's unverified answer to the owner's question becomes a trusted fact. This is the L-C case in another form.
- **Fix:**
  - Check the relation's words as well as the entities', apart from a short list of structural words (is, has, of, a…; `not` must count).
  - Require at least one entity with a checkable, non-generic word.
  - Unprotected (`memoryTool.ts`).
- **What a word check cannot close:** a choice or yes/no answer between words the owner used. Two options:
  1. Ask the owner to confirm the exact triple before storing, for example with an approval request from `memoryTool.ts` (unprotected; raising the risk in `core/toolCatalog.ts` instead would touch a protected file).
  2. Refuse `save_relation` in a request that has already read agent or goal results. This needs a record in `core/traceContext.ts` (unprotected), fed by `goal_status` (`core/goalTools.ts`, unprotected) and `agent_status` (`core/agents/jarvisAgents.ts`, protected), or by the registry (`core/toolRegistryV2.ts`, protected).
- Otherwise, document it as residual.

**M-2. The tokenizer reads only a–z and 0–9 and drops 1–2 letter words, so some entities have nothing to check and always pass.**
- **Where:** `core/tools/memoryTool.ts:18-20`. `split(/[^a-z0-9]+/)`, then words shorter than 3 letters (without a digit) and `COMMON` words are dropped. An entity with no remaining word passes `significant(e).some(...)` vacuously (`:39`).
- **Scenarios (probe 1):**
  - c1 `Alice WORKS_AT 東京電力` and c2 `sister LIVES_IN لاہور`: stored.
  - c4: request "what is the weather today?" → `Москва IS_CAPITAL_OF Россия` stored. Nothing in the request is related.
  - c3 `Ünïcödé`: only "nc", "d" survive, and both are dropped.
  - d1 `UK`, d2 `Go`, d3 `(AI)-[WILL_REPLACE]->(me)`, e1 `(the)-[IS]->(about)`: all stored.
  - An Urdu or other non-Latin transcript as the request gives the reverse: every Latin-script entity is refused.
- **Effect:** a whole class of facts, including place and person names in the owner's own languages, skips the provenance check.
- **Fix (unprotected, `memoryTool.ts`):**
  - Split on `/[^\p{L}\p{N}]+/u` and compare in Unicode lower case.
  - Keep 2-letter words.
  - Refuse an entity with no checkable word unless it is wholly generic (User, me, JARVIS) or appears verbatim, case-insensitive, in the request.

### Low

**L-1. `.env.example` and the plan describe a stronger check than the code has.**
- **Where:**
  - `.env.example:143-145`: "otherwise only a fact in the words of the request it serves (a fact read from an agent's result, a page or a document is refused)".
  - Plan §10.2 (`LR2_L5_PLAN.md:238`) says an entity must "share a word" with the request. The code requires every checkable word (`memoryTool.ts:39`): stricter, and what `.env.example` describes.
  - `.env.example:138-139`: "a browser, PC, memory or QA result is stored only when it was verified (one with conflicts is)". `shouldVerify` returns false for `qa_agent` whatever its conflicts (`jarvisAgents.ts:247-249`), so a QA result is never verified and never stored.
- **Scenario:** probe 1 a1–d3, h3 (agent or page facts stored) and f1 (owner-pasted document text stored).
- **Fix:** say what is checked: the two entities' words against the request; the relation is not checked; a delegated Memory task is checked against the planner's task text; with no request in flight there is no check. Drop "QA" from the conflicts parenthetical. Docs only; no protected file.

**L-2. False refusals of the owner's own facts.**
- **Where:** `memoryTool.ts:39` with the tokenizer at `:18-20`.
- **Scenario (probe 4, foreground):** 15 of 23 plausible model triples for the owner's own "remember …" requests are refused:
  - "Lahore, Pakistan", "Acme Corporation", "New York City" (from "NYC").
  - "March 5" (from "5th of March"), "9:00" (from "nine"), "2 children", "dark theme" (from "dark mode").
  - "Visual Studio Code" (from "VS Code"), "running" (from "jogging"), "eshop" (from "e-shop").
  - "glass" vs "glasses" (the plural rule strips only a final "s"), "User's buses" vs "bus".
  - Every "remember that" or "remember what I just told you" that refers to an earlier turn: only the current turn's words count.
- **Effect:** the refusal tells the model to have the owner say the fact. A model can retry with the owner's exact words. How often real models do this is unverified. "Remember that" after an earlier statement cannot succeed without the owner repeating it.
- **Fix:** owner's choice. The confirmation option in M-1 removes most of these. Loosening the stem rules ("es", "ies") helps a little without reopening M-1. Unprotected.

**L-3. A goal step that should store a fact completes, and the goal's record does not show the refusal.**
- **Where:**
  - `core/agents/behaviors/toolLoop.ts:337` puts "Tool refused or failed: save_relation: …" in the outcome's limitations.
  - `core/goalExecutor.ts:62-76` (`taskResultFrom`) does not copy limitations into the goal task result.
  - The refusal text says "(the result stays in the goal's record)", which refers to earlier results.
- **Scenario (probe 5):**
  - Setup: a goal "Remember that my exam is on Friday" with one Memory-agent step, run through the real executor and registry. The stand-in model, after the refusal, answers "Saved: your exam is on Friday."
  - Result: nothing is stored, and the goal status is `completed`.
  - The task's record holds the summary "Saved: your exam is on Friday." and no limitation, so nothing in it shows that the store was refused.
- **Effect:** with a model that misreports, the goal history claims a fact was saved. The goal planner can still plan "remember" steps, which now always fail silently.
- **Fix:**
  - Carry limitations into `TaskResult`, or mark the task as failed (`evidence`) when a store tool was refused.
  - Or tell the goal planner not to plan memory-store steps.
  - Both unprotected (`core/goalExecutor.ts`, `core/goalPlanner.ts`).

### Info

- **I-1. Path 3 has an unprotected (costly) option.**
  - The plan says closing path 3 needs `core/agents/jarvisAgents.ts` or the agent scope, both protected.
  - Unprotected alternative: refuse `save_relation` in every agent scope (`getAgentIds()` defined), not only in goals, so only the foreground planner, checked against the owner's words, can store.
  - Cost: "ask the memory agent to remember …" (`memory.ts:103-127` remember flow) could no longer store.
  - Owner's choice.
- **I-2. A dependency summary that contains its own `- <title>: …` line is shown as an unlabelled result line** (probe 3, last case). This is agent text shaping the goal context. It is advisory only, and `save_relation` is refused in goals anyway.
- **I-3. Message grammar.** Two unsaid entities give `"fast-tool" and "the best library" is not in the words…` (`memoryTool.ts:41`).
- **I-4. From reading the code, not reproduced:** `currentRequest` is one module-level value (`traceContext.ts:25`). A foreground planner loop that is still running after a newer `process()` replaced the trace would be checked against the newer request's words.
- **I-5. Tests.**
  - `saveRelationProvenanceTest` fails on the pre-change source (`fail-before.txt`: 6 of 11 fail) and on `c4ac909` (`on-original-c4ac909.txt`), and passes after.
  - It does not cover the relation field, a choice between named entities, non-Latin or short entities, or the goal record (M-1, M-2, L-3).

---

## 4. Status of the previous review's findings

| Item | Status |
|---|---|
| **L-A** (archive named when `JARVIS_AGENT_ARCHIVE=0`) | **Partly resolved.** `.env.example:140-141` now states the condition and matches `agentManager.ts:206,1112`. The console line `jarvisAgents.ts:304` still names the archive. It is protected and outside the approved diff (plan §10.3) |
| **L-B** (label cut off) | **Resolved** (`goalRuntime.ts:648-649`; probe 3: 0 of 1,008 layouts show an unverified summary without its label; new test 3/3) |
| **L-C** (`save_relation` stores unverified results) | **Resolved inside goals** (probe 2 C, new test). **Narrowed but open for the main planner** (M-1, M-2). **Open for delegated Memory tasks** (path 3, I-1; protected file or the costly unprotected option) |

---

## 5. What I ran

All probes are in `scratchpad/review-save-relation/`, outputs in `*.out`. Each ran from the repository root with `pnpm exec tsx`. Every probe:
- sets `JARVIS_WORKSPACE_ROOT` and `JARVIS_DATA_ROOT` to a new temporary folder before any import;
- replaces `memoryManager.rememberFact` with a stand-in before anything can store;
- registers a stand-in provider under `anthropic`;
- makes no network or provider call.

`git status --porcelain` was the same before and after, and no file under `data/` or `logs/` changed.

| Probe | What it covers |
|---|---|
| `p1_wordCheck.mts` | 20 request/triple rows through `toolRegistryV2.execute('save_relation')`, foreground (`beginTrace`) and in a delegated agent scope (`runAsAgent`, no goal): relation-borne claims, choices between named entities, non-Latin, accented, 2-letter and common-word entities, owner-pasted text, quoted agent results, a very long request, and refusal controls |
| `p2_scopeIsolation.mts` | Real `AgentManager` with its default executor (`toolRegistryV2`) and the real Memory agent (stand-in model): foreground words versus agent words in both directions, with a foreground call made while the agent waits; a goal root task (and an empty goal title); a medium-risk probe tool through the execution queue and sandbox with four interleaved callers |
| `p3_labelCut.mts` | The real `GoalRuntime.contextFor`, cut as `toolLoop.ts:183` cuts it, over 1,008 layouts; plus a summary that contains its own list line |
| `p4_falseRefusals.mts` | 23 owner "remember …" requests with plausible model triples, foreground |
| `p5_goalRecord.mts` | A one-step "remember" goal through `GoalRuntime` + `AgentGoalExecutor` + the real registry: goal status and task record after the refusal |

**Tests and typecheck:**
- `pnpm run typecheck`: exit 0.
- `pnpm test -- --only=saveRelationProvenanceTest,unverifiedMemoryTest,memoryTrustTest,mixedFailureCausesTest,secretSinksTest,verifyAfterActTest,executionDispatchAuditTest,sevenAgentTest,jarvisAgentIntegrationTest,goalRuntimeTest,goalAgentIntegrationTest,toolDiscoverabilityAuditTest,plannerDecisionAuditTest,fullSystemIntegrationTest`: 14 passed, 0 failed.

**Full CI (not run by me):** the author's `pnpm test -- --ci` was running when I started (started 10:45 UTC). I waited for it to finish before reading it. The per-test comparison with `evidence/baseline-ci.txt` is in §2, check 5.

**Only the owner's Windows PC or live providers can verify:**
- How real planner and Memory-agent models fill the triple: how often they put the claim in `relation`, pick between named entities (M-1), or normalize the owner's words and are then refused (L-2), and whether they retry with the owner's words.
- What the real models say to the owner after a refusal, in a request and in a goal (L-3).
- Voice transcripts, including non-Latin (Urdu) speech-to-text output, as the request text (M-2).
- The console and speech output when nothing is stored, and the archive on the PC's data folder (L-A).
- The Windows-only and live-provider tests that CI skips or blocks.
