# Independent review: the nine Lows after `INDEPENDENT_REVIEW_FINAL_MEMORY.md`

**Reviewer:** an independent, read-only agent with no part in writing the code, the plan or the earlier reviews.

**Scope:** the uncommitted Phase 1A work on `claude/jarvis-repair` (base `c4ac909`), changes made after `INDEPENDENT_REVIEW_FINAL_MEMORY.md`:
- `core/tools/memoryTool.ts`, `core/goalExecutor.ts`, `.env.example`;
- the speech stand-in removal in `tests/saveRelationAskOnceTest.ts`;
- the new tests `saveRelationLowFixesTest` and `saveRelationRepliesTest`.

**Method:** I read the diff and the code it relies on (registry, sandbox, task graph, reflection, orchestrator, agent tool loop, goal executor, trace context, agent scope, spoken text, approval request). I re-ran the previous review's probes against the new code, wrote five probes of my own (p1 to p4b), ran the typecheck and the 27 listed tests, and compared the author's full CI run with the baseline. The author's documents were read as context only.

---

## 1. Verdicts

**(a) Implementation correctness: correct for all nine previous Lows; five new Low findings, none in a protected file except one optional fix.**
- L-1, L-2, L-3, L-4, L-6 and L-9 are resolved as described in `LR2_L5_PLAN.md` §13.
- L-5 is resolved for one agent's root task and for the planner within one request. Two calls for the same fact at the same moment, and the planner and a delegated agent in the same owner request, are still asked separately (LL-1).
- L-7 meets every phrasing the previous review listed, but the new recall rule stops flagging "Remember when/where/who/how …: <fact>", which the old classifier flagged, and new false positives appear (LL-2).
- L-8 is resolved for the three sentences named; some new sentences say a little more than the code does (LL-5).

**(b) Memory trust: no new path lets unverified information into trusted long-term memory.**
- The answer record re-uses an owner's "yes" only for the identical fact text, within the same agent root task (random UUID) or the same foreground trace (random id, cleared when the request ends). The owner saw that exact text when answering.
- A kept "no" never stores anything. With no request in flight nothing is asked or kept, as before (p1 F).
- The writers of `rememberFact` are the same as at the previous review (`memoryTool.ts:192`, `jarvisAgents.ts:311,318`, `goalLearning.ts:155`, `agentMemory.ts:223` with no caller); their files are unchanged (hashes).
- What remains is what the owner sees or hears: what the real TTS says for emoji and symbols, and the protected background-question grace (previous review's L-3, still open).

**(c) Readiness to commit: READY WITH CONDITIONS.**
1. Correct the `.env.example` sentences in LL-5 (docs only), or make the code match them.
2. Record the owner's decision on LL-1 to LL-5: fix now, or accept as documented limits. All fixes are in unprotected files, apart from the optional shared-key part of LL-1.

The previous review's condition 1 is met: the author's full CI run on the final files has 251 passed, 0 failed, 1 blocked, 9 skipped (§2, check 7).

---

## 2. Checks

| # | Check | Result |
|---|---|---|
| 1 | L-1 to L-9, previous probes re-run | See §4. f2, f4 and f6 show the fixes through the real gate; r1 and r7 changes are explained there |
| 2 | Answer record (L-5, L-6) | **Met, with LL-1** (p1). <br>**Key:** `rootTaskId ?? traceId ?? requestText` + NUL + fact (`memoryTool.ts:54-56`). The request-text fallback is unreachable: `beginTrace` sets the trace id and the request together, `endTrace` clears both, and an agent scope always has a `rootTaskId`. <br>**Lifetime and size:** an entry older than an hour is dropped on the next lookup (p1 G: asked again after 61 min); at most 500 entries, oldest write first (p1 H: after 501 facts the first is asked again, the last is not). Facts reach the record only after the policy checks, so each key is at most about 200 characters. <br>**Concurrency:** <br>• two calls for the same fact at once in one request: asked twice, stored twice for "yes" (p1 A); <br>• a foreground "no" and a background agent's "yes" for the same fact at once: independent, only the agent's fact stored (p1 J), as intended; <br>• two agents in one root task: the second is not asked and gets "Already kept" (p1 C). <br>**Kept answer across requests:** a "yes" whose store failed is not used by the owner's next request (p1 E: asked again, "no" honoured). No trace id or root id is reused. <br>**Same text, different split:** after a failed store, a different split of the same fact text is stored without asking and the graph gets the new split (p1 D). The owner is only ever shown the joined text, so this changes nothing the owner saw (Info). <br>**No request in flight:** asked 0, stored on every call, as before (p1 F) |
| 3 | `APPROVAL_DENIED` JSON refusal | **Met.** <br>• Registry: `reportedFailure` sets `error: 'APPROVAL_DENIED'`, the result is a failure, and metrics count it as one (as before; previous I-6). <br>• Orchestrator: the node error is `APPROVAL_DENIED: {…cancelled by user…}`; the task graph classes it `abort`, no retry (f2 no). <br>• Reflection: `refusalVoiceMessage` returns "Cancelled, sir. You did not approve it, so nothing was done." (f2, r4, f5). `classifyError` reaches `cancelled by user` (abort); no earlier pattern matches (the text has no "JSON", "parse", "policy" or "timeout"). <br>• `stepRecovery` `NEVER_RAN` and `voiceSummaries` match the code. <br>• Agent tool loop: the failure entry is `save_relation: {…} (APPROVAL_DENIED)`, the model sees `FAILED: {…}` (f6). <br>• Goal check: `memoryNotStored`'s prefix still matches the entry (p4), although inside a goal the call is refused before anyone is asked. <br>• Code that parses tool output as JSON (`verify.ts:127`, `data.ts:80`, `replyText.ts`, the verifiers) does so only for its own tools. |
| 4 | Character rules | **Met for hidden characters; false refusals widened (LL-3).** <br>p3, 31 ordinary texts: accepted are accents (precomposed and combining), Chinese, Japanese, Korean, Arabic, Urdu without ZWNJ, Hindi conjuncts, Hebrew with niqqud, Thai, emoji, ❤️ and ©️ with U+FE0F, skin tones and regional-indicator flags. Refused are Persian/Urdu with ZWNJ, Devanagari, Sinhala and old Malayalam forms with ZWJ, Mongolian with a free variation selector, ZWJ emoji (family, rainbow flag, technologist), keycaps (1️⃣, #️⃣), the England tag flag and ☎︎ with U+FE0E. <br>Refused as intended: ZWSP, word joiner, U+3164, U+FFA0, U+115F, U+2800, U+034F, U+17B4, a stray or doubled U+FE0F, U+E0100, tag letters, U+180E, U+061C, U+00AD. <br>Still accepted: private-use and unassigned code points, a lone surrogate, U+FFFC, U+1D159, and single exotic spaces (U+2000, U+3000, U+1680). These are kept exactly as stored. On screen they usually show as a box, a symbol or a space rather than nothing; this depends on the font (Info) |
| 5 | Goal-step classifier | **Partly met (LL-2).** f3: 20 of 22 as expected (only the Spanish and German cases are missed, as documented). p4, 32 further phrasings: 2 as expected. <br>**False negatives:** "First, remember …", "Then store …", "… just save …", "The Memory agent should remember …", "Make sure to remember …", "Keep track of …", "Log that …", "Write down that …", "Set/Change the user's preference …", "Learn that …", "Persist …", and "Remember when the exam is: Friday", "Remember who …: Sara", "Note where …: Lahore", "Remember how …: black". The old classifier flagged the last four (p4b); the new `RECALL_STEP` excludes `when|where|who|how|why`. <br>**False positives:** "Remember to check the remembered facts …", "Don't forget to search memory …", "Keep in mind the user's time zone …", "Add up the expenses …", "Add the exam date to the summary", "Record the answer in the final report", "Store hours: …", "Save some time …", "Note that the remembered facts may be stale …", "List what you store in memory …", "Check what we keep in memory …", "Summarise what the user asked to save in memory", "Update the user on what is in memory", "Update the summary using the user's preferences". <br>A false positive blocks the step for review, which fails safe. A false negative matters only when the model skips `save_relation` and says it saved; a call to `save_relation` inside a goal is caught whatever the wording |
| 6 | Memory trust re-audit | **Met** (see verdict b). <br>• `memoryTool.ts` stores only after the owner's "yes" for that exact text in that root or request, or with no request in flight (no production caller, unchanged). <br>• Credentials are refused on the joined fact before anything is asked or stored (f4, p2: graph writes 0). <br>• Inside a goal nothing is stored and nobody is asked (r1 C, P5; r5). <br>• `memory_brain` remember is still reached only by the owner's routed words |
| 7 | No regression | **Met.** <br>• `pnpm run typecheck`: exit 0. <br>• The 27 listed tests: 27 passed, 0 failed. <br>• Author's full CI (`evidence/final-lows/after-ci.txt`, written at 13:28, after the last source change at 13:09): 261 files, 251 passed, 0 failed, 1 blocked (`realTtsHandoffTest`, no pygame), 9 skipped. <br>• Against `evidence/baseline-ci.txt`, all 231 baseline verdicts are identical; the 30 files not in the baseline all pass |
| 8 | Files | **Met.** <br>• `git diff HEAD -- tests`, `package.json` and `pnpm-lock.yaml`: empty. `git diff --check HEAD`: clean. <br>• Against `evidence/final-lows/hashes-before.txt` (71 files, equal to the previous review's hashes for the three changed files), only `memoryTool.ts`, `goalExecutor.ts` and `.env.example` differ. <br>• The protected files not in that list (`jarvis.ts`, `core/deterministicRoutes.ts`, `core/agentStateMachine.ts`, `core/skillLoader.ts`, `core/conversationBus.ts`, `skills/automation/skill.ts`, `voice/*`, the protected tests and the others in `RUNTIME_PROTECTED_FILES.md`) are unchanged against HEAD. <br>• `source-hashes-at-review.txt`: all OK |

---

## 3. Findings

### High

None.

### Medium

None.

### Low

**LL-1. The answer record does not cover two calls at once, or the planner and a delegated agent in one request.**
- **Where:** `memoryTool.ts:174-186` looks up the record, then asks; the answer is written only after the question returns. The key is the agent's `rootTaskId` or the foreground trace id (`:54-56`), so a delegated agent's root task and the planner in the same owner request have different keys.
- **Scenario (p1):**
  - A: two `save_relation` calls for the same fact start together in one request (two parallel graph nodes, or two workers). The owner is asked twice; for "yes" the fact is stored twice; for "no" the owner says no twice.
  - B: the planner calls `save_relation`, then delegates to the Memory agent, which calls it for the same fact. The owner is asked twice, and a "no" to the planner does not stop the agent's question.
- **Fix:**
  - **Unprotected:** keep the pending question per key (a map of promises) so a second call waits for the first answer.
  - For B, either accept it and say "per request, and per delegated task" in `.env.example`, or carry the foreground trace id into the agent scope and key on it. The second option changes `core/agents/agentScope.ts` and `agentManager.ts`, which are protected.

**LL-2. The goal-step classifier: one regression, and new false positives.**
- **Where:** `goalExecutor.ts:232-243`.
- **Scenario (p4, p4b):**
  - "Remember when the exam is: Friday", "Remember who the user's manager is: Sara", "Note where the user lives: Lahore" and "Remember how the user takes coffee: black" were flagged before this round and are not now, because `RECALL_STEP` excludes `when|where|who|how|why`.
  - `KEEP_STEP` flags any step starting with "add", "record", "store", "save", "remember to" or "don't forget to": "Add up the expenses …", "Record the answer in the final report", "Store hours: …", "Remember to check …".
  - `PROFILE_STEP` flags "Update the user on what is in memory" and "Update the summary using the user's preferences".
  - Steps that do not start with the verb ("First, remember …", "Then store …") are not flagged.
- **Fix (unprotected):**
  - Limit `RECALL_STEP` to `what|which|whether|if`, and do not apply it when a colon follows with a value.
  - Treat "remember to / don't forget to <verb>" as an instruction, not a store step.
  - Require "add", "record", "store" and "save" to be followed by "that" or by a memory word.
  - Allow a leading "first,", "then" or "next,".
  - Or accept the heuristic and say in `.env.example` that only the step's first words are read.

**LL-3. The character rule refuses ordinary text in several scripts, and some emoji.**
- **Where:** `memoryTool.ts:35-39`. `\p{Cf}` and `\p{Default_Ignorable_Code_Point}` include U+200C and U+200D, the Mongolian free variation selectors, tag characters and U+FE0E. U+FE0F is allowed only after an `Extended_Pictographic` character, and keycap bases (`0-9#*`) are not that.
- **Scenario (p3):** a Persian or Urdu word typed with ZWNJ, Devanagari or Sinhala text with ZWJ, a Mongolian word with a free variation selector, 👨‍👩‍👧, 🏳️‍🌈, 👩‍💻, 1️⃣, #️⃣, 🏴󠁧󠁢󠁥󠁮󠁧󠁿 and ☎︎ are all refused with "the fact has a line break, a control or an invisible character". This fails safe; it extends the previous review's I-3. `.env.example:153` says "an emoji's own variation selector is allowed", which keycaps contradict.
- **Fix (unprotected):**
  - Allow U+200C and U+200D between two letters or marks of the same script.
  - Allow U+200D between two emoji.
  - Allow U+FE0F and U+FE0E after `\p{Emoji}` (this covers keycap bases), and a tag sequence after U+1F3F4.
  - Or state in `.env.example` that such text is refused.

**LL-4. The credential refusal is retried by the task graph and said as a tool failure.**
- **Where:** `memoryTool.ts:160` and `:168` return "Error: save_relation refused - I don't store passwords, keys or tokens, sir." `taskGraphEngine.ts:543-567` matches none of its fatal words and classes it `transient`. The reflection's `^Error:` pattern gives `tool_error`.
- **Scenario (p2):** for a credential split across the parts, or in one part, the node is run three times (about 3 s of retry delay). JARVIS says "One of my tools failed, sir. save relation refused I don't store passwords, keys or tokens, sir." Nothing is asked or stored, and the graph gets nothing. The per-part case predates this round; the new whole-fact check inherits its wording.
- **Fix (unprotected):** word it "refused by memory policy - I don't store passwords, keys or tokens". The graph then classes it `fatal` and the reply becomes "I couldn't do that, sir. …".

**LL-5. `.env.example:143-160` still says a little more than the code does.**
- "Within that request or task you are asked once per fact": not for two calls at once, or for the planner and a delegated agent (LL-1).
- "an emoji's own variation selector is allowed": not for keycaps (LL-3).
- "a goal step … asked to in English words (remember, store, save, …)": only when the step starts with them, and not for "remember when/where/who/how …" (LL-2).
- "forget_memory removes a kept fact, not a graph-memory edge": with a vault configured, a `relation` fact of importance 6 is also filed in the second brain (`memory/secondBrain.ts:684-703`), and `forgetFacts` (`memoryManager.ts:1117`) does not remove that note. "It can only partly be undone" stays correct.
- **Fix:** docs only, after the owner's decision on LL-1 to LL-3.

### Info

- **I-1. "Already kept" after a forget in the same request.** If the fact is removed during the same request and `save_relation` is called again, it returns "Already kept" without storing. The after-action check then reports VERIFICATION_FAILED, which is accurate (p1 I). This is narrow.
- **I-2. A different split of the same text** after a failed store is stored without asking, and the graph gets that split (p1 D). The owner sees only the joined text in either case.
- **I-3. Accepted characters that are not blank.** Private-use and unassigned code points, a lone surrogate, U+FFFC, U+1D159 and look-alike letters (Cyrillic "а" in "bank") are accepted and stored exactly. Single exotic spaces are shown as a plain space (the previous review's I-1).
- **I-4. The policy reply says "Error:"** aloud: "I couldn't do that, sir. Error: save relation refused by memory policy the fact is 224 characters; …" (f2). `refusalVoiceMessage` strips only "Refused by safety policy:".
- **I-5. A trace can outlive an ignored input.** `orchestrator.ts:318` returns after `beginTrace` when the state is INTERRUPTED, without `endTrace`. Until the next request, a call made with no request would be asked with that input as WHY and would share its answer record. There is no production caller of `save_relation` without a request; this predates this round.
- **I-6. Unchanged from the previous review:**
  - I-1: NBSP and U+3000 are shown as a space.
  - I-2: a whitespace-only entity is accepted (f4: asked, then VERIFICATION_FAILED).
  - I-4: the new `saveRelationLowFixesTest` stands in for `requestApproval`. The real gate is covered by `saveRelationRepliesTest`, `saveRelationAskOnceTest` and f1, f2, r3.
  - I-5: outcome unknown on a slow store.
  - I-6: each "no", and now each kept "no" returned without asking, counts as a tool failure in the registry metrics.
  - I-7: no change.

---

## 4. Status of the previous review's findings and conditions

| Item | Status | Evidence |
|---|---|---|
| **L-1** (markdown by voice) | **Resolved** | f4: the link and emphasis facts give risk 3, so voice cannot approve them; the console shows the exact text. `stripMarkdown` is applied to the fact alone, so a fact that starts like a list item is also raised; that fails safe |
| **L-2** (invisible characters) | **Resolved**; residuals LL-3, I-3 | f4: variation selectors, U+3164 and U+2800 are refused. p3: further default-ignorable characters are refused |
| **L-3** (credential split across parts) | **Resolved**; wording LL-4 | f4, both cases: refused, not asked, nothing stored, no graph write |
| **L-4** (replies) | **Resolved** | f2/r4/f5 "no" and timeout: "Cancelled, sir. You did not approve it, so nothing was done." The late answer (f2, f1 C, r3 T3) says "this request was stopped before your answer counted". The line-break and length refusals say why (f2) |
| **L-5** (agent re-asks) | **Resolved** for one root task; residual LL-1 | f6: "no" asked 1, stored 0; "yes" asked 1, stored 1 (was 3 and 3) |
| **L-6** (store error re-asks) | **Resolved** without the protected alternative | f2 throw: asked 1, three graph attempts without asking; `saveRelationRepliesTest` busy case: stored on the retry |
| **L-7** (goal classifier) | **Partly resolved**; LL-2 | f3: every listed English phrasing as expected. p4: regression and new false positives |
| **L-8** (`.env.example`) | **Resolved** for the three sentences named; LL-5 for new ones | Wrapping fixed (lines 143-160 are 65-78 characters) |
| **L-9** (undo wording) | **Resolved** | r2: "It can only partly be undone."; `reversible: 'partial'` (`memoryTool.ts:116`) |
| Condition 1 (full CI) | **Met** | 251 passed, 0 failed, 1 blocked; baseline verdicts identical |
| Condition 2 (`.env.example`) | **Met** for the previous sentences; LL-5 open | |
| Condition 3 (owner's decision) | **Met** | `LR2_L5_PLAN.md` §13: "Fix all nine" |
| Earlier L-3 (background question grace) | **Open**, protected (`security/approvalGate.ts`) | r6 unchanged: a second "yes" 80 ms later still approves the background agent's fact |
| Earlier I-1, I-3, I-5 | Unchanged | |

**Changes in the re-run probes that are not regressions:**
- **r1:** the agent rows "ag/yes" now show asked 0, stored 0. The probe uses the fixed root id `'r'` for every agent row, so the record keeps the earlier "ag/no" answer for that root. With real roots (UUIDs; rows A/no and A/yes) each root is asked once.
- **r7:** the direct `execute` call is not asked again, because the registry call before it in the same trace was answered "no".

**Test change.** `saveRelationAskOnceTest` (11:57) drops `installFakeTts`, which no assertion used, and keeps its three assertions. It passes here and in the author's CI, and `boundaryDoublesTest` passes.

**New tests.** `fail-before.txt` and `on-original-c4ac909.txt` match what the tests assert. On the unfixed tree, `saveRelationLowFixesTest` gave 6 passed and 21 failed, and `saveRelationRepliesTest` gave 0 passed and 3 failed.

---

## 5. What I ran

**Probes:** in `scratchpad/review-lows/`, run with `pnpm exec tsx` from the repository root. Outputs are in `*.full`.

Every probe:
- sets `JARVIS_WORKSPACE_ROOT` and `JARVIS_DATA_ROOT` to a new temporary folder before importing anything;
- replaces `memoryManager.rememberFact` with a stand-in before any call that could store;
- registers a stand-in provider under `anthropic` where models are loaded;
- makes no network or provider call;
- answers the gate with scripted prompt functions or `offerConsoleAnswer`, never a real console or voice.

My own probes (p1, p2, p4, f4) also replace `graphMemory.saveRelation`. The re-run probes keep their original stand-ins, and graph memory was disabled in every run ("Neo4j disabled").

| Probe | What it covers |
|---|---|
| Re-run: `r1`–`r7`, `f1`–`f6` | The previous review's probes, unchanged, against the new code (f2 in all eight modes, r4 in three) |
| `p1_answerRecord.mts` | Own: the answer record. Concurrent calls; planner then agent; two agents in one root; failed store then a different split; a new request after a failed store; no request in flight; lifetime (61 min); size (501 facts); forget then save again; foreground and background at once |
| `p2_refusalPaths.mts` | Own (from f2): real orchestrator with a credential split across parts, a credential in one part, and a whitespace-only entity, each with the reflection model answering `replan` and `fallback_tool`; tool calls and graph writes counted |
| `p3_characters.mts` | Own: `unshownFact` and the credential check on 31 ordinary texts and 27 blank or unusual characters |
| `p4_goalClassifier.mts` | Own (harness from f3): 32 further goal-step phrasings through `inspectPrevious` |
| `p4b_oldClassifier.mts` | Own: the previous classifier (`factToRemember` or "… in memory") on p4's phrasings, for comparison |

**Tests and typecheck:**
- `pnpm run typecheck`: exit 0.
- `pnpm test -- --only=<the 27 listed>`: 27 passed, 0 failed.

**Full CI:** not run by me. I read the author's `after-ci.txt` once it had finished; the comparison is in §2, check 7.

**State:** `git status --porcelain` was the same before and after. No file in the repository other than the author's `after-ci.txt` changed during the review. The only file I wrote in the repository is this report.

**Only the owner's Windows PC or live providers can verify:**
- How the Windows console shows private-use, unassigned and look-alike characters, RTL text and emoji in the TARGET line.
- What the real TTS says for emoji, symbols and underscores in a fact. `stripMarkdown` is the only check; a TTS that skips emoji would speak less than is stored.
- Whether real planner and Memory-agent models issue parallel or repeated `save_relation` calls (LL-1), and which phrasings the real goal planner uses for memory steps (LL-2).
- Whether owners write Persian or Urdu with ZWNJ, or use ZWJ emoji and keycaps in facts (LL-3).
- A vault-configured second brain and `forget_memory` (LL-5).
- The Windows-only and live-provider tests that CI skips or blocks (`realTtsHandoffTest` is blocked here).
