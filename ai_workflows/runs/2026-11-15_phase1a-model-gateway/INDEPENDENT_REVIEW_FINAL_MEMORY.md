# Independent review: final memory-trust changes after `INDEPENDENT_REVIEW_SAVE_RELATION_CONFIRM.md`

**Reviewer:** an independent, read-only agent with no part in writing the code, the plan or the earlier reviews.

**Scope:** the uncommitted Phase 1A work on `claude/jarvis-repair` (base `c4ac909`), changes made after the previous review:
- `core/tools/memoryTool.ts`, `core/goalExecutor.ts` and `.env.example`;
- `core/toolRegistryV2.ts`, the protected file approved at Gate 1 (`LR2_L5_PLAN.md` §12.1, §12.2);
- the new tests `saveRelationConfirmReviewTest`, `saveRelationAskOnceTest` and `saveRelationTimeBudgetTest`, and the test changes listed in the brief.

**Method:**
- I read the changed code and the code it relies on: approval gate, approval request, sandbox, registry dispatch, task graph, reflection, goal runtime and agent archive.
- I re-ran the previous review's probes r1 to r7 against the new code and wrote six probes of my own (f1 to f6).
- I ran the typecheck and the 27 listed tests, and compared the author's full CI run with the baseline.
- The author's documents were read as context only.

---

## 1. Verdicts

**(a) Implementation correctness: correct for every previous Medium finding. Nine Low findings, none in a protected file except where noted.**
- **M-1:**
  - A fact over 150 characters is refused without asking. So is a fact with a line break, a control or format character, or a run of spaces.
  - By voice, a fact over 56 characters needs a typed answer.
- **M-2:** the budget pauses while the question is queued or on display, and a stopped call withdraws its question. The registry patch is exactly the diff in §12.2, and no other low-risk tool changes path.
- **M-3:** through the real orchestrator, the owner is asked once. This holds for "no", no answer, a policy refusal and a late answer, and nothing re-asks.

The Low findings are edge cases of what is shown or said, reply wording, retries outside the planner path, and the goal-step classifier.

**(b) Memory trust: closed, apart from three narrow gaps in what the owner sees or hears.**
- No path stores a `relation` fact without the owner's "yes". The exception is a call with no request in flight, which is unchanged and has no production caller.
- The other writers are unchanged (hashes match):
  - `promoteToMemory` stores verified results only;
  - goal lessons are stored with source `lesson`;
  - `memory_brain` stores the owner's own routed words.
- What remains depends on what the owner sees or hears:
  - a voice question drops markdown from the fact (L-1);
  - some invisible characters are not refused (L-2);
  - a background agent's question still has no answer grace, which is protected (L-3 of the previous review, still open).

**(c) Readiness to commit: READY WITH CONDITIONS.**
1. The author's full CI run (`evidence/final-review/after-ci.txt`) has one real failure, `boundaryDoublesTest`. The author has since changed `tests/saveRelationAskOnceTest.ts` so that it no longer needs to be listed. My targeted run of both tests passes. **Re-run `--ci` on the final files and confirm 249 passed, 0 failed, 1 blocked**, before committing.
2. Correct the two `.env.example` sentences that say more than the code does (L-8).
3. Record the owner's decision on L-1 to L-9: fix now, or accept as documented limits. All fixes except L-3's alternative and the previous review's L-3 grace are in unprotected files.

---

## 2. Checks

| # | Check | Result |
|---|---|---|
| 1 | Previous probes re-run | See §4. All Medium findings resolved. L-3 is partly resolved: its protected part, background-question grace, is unchanged (r6) |
| 2 | M-1: shown = stored (console and voice, Unicode) | **Met, with three Low gaps** (f4, r2). <br>Asked with the exact fact: <br>• combining accents and stacked combining marks; <br>• emoji, including ❤️ with U+FE0F; <br>• Urdu text, and Hebrew with a Latin relation; <br>• a 150-character single word. <br>Refused without asking: 151 characters, a line break, U+200F, a ZWJ emoji, a Persian word with ZWNJ. <br>By voice: 56 characters gives risk 1, spoken whole; 57 characters gives risk 3, so a typed answer is needed. <br>The gaps: <br>• markdown is stripped from the spoken question (L-1); <br>• variation selectors and blank-glyph letters pass (L-2); <br>• a credential split across parts shows `[REDACTED:secret]` without the closing quote, and the graph gets the raw value (L-3). <br>Visible differences only: <br>• NBSP and U+3000 are shown as a plain space and stored as typed (I-1); <br>• a whitespace-only entity is accepted (I-2) |
| 3 | M-3: "no", no answer, policy refusal and late answer are final through the real orchestrator | **Met** (f2, r4). <br>Each mode: asked 0 or 1 times, node `[abort]` or `[fatal]`, "no retry", reflection `abort`, no repair cycle. With the reflection model scripted to answer `replan`, and a planner model that repeats the call, it is still asked once. <br>The late answer is recorded `false/cancelled`, never "approved". <br>Replies: "no" and no answer give "I'm missing something I need to do that, sir. save relation cancelled by user …" (L-4); the newline policy refusal gives only "I'm missing something I need to do that, sir." (L-4) |
| 4 | M-2 and the registry patch | **Met** (f1, r3, new test). <br>• Budget 500 ms, "yes" typed after 1.5 s: stored. <br>• Queued 1.5 s behind another question, budget 500 ms: stored. <br>• Caller stops the call while asked: the question leaves the display at once, a later "yes" is not taken, the record says `cancelled`, stored 0. <br>• Stopped while still queued: `cancelled`, never shown. <br>• r3 T4, the original 26 s case: stored. <br>• `search_memory` still runs outside the sandbox. <br>Sandbox effects on `save_relation`: <br>• the limit is now 30 s, or `JARVIS_TOOL_BUDGET_LOW_MS`, and excludes answer time; <br>• no concurrency cap (low = Infinity); <br>• no `tool_audit.log` line (high only); <br>• a thrown store error becomes an `Error:` result instead of a throw, which removes the registry-level retry path (`maxRetries` was already 0); <br>• **outcome unknown is now possible**: a store slower than the remaining budget plus the stop grace returns "may still finish". In f1 E it wrote `outcome_unknown` and `late_result` lines to `logs/jarvis-actions.jsonl` and an issue occurrence under `data/repairs`; the fact was stored later. That report is accurate (I-5). <br>Other `riskLevel === 'low'` branches: <br>• `isCacheable`: `save_relation` is not cacheable, so no change; <br>• `dispatch` (`toolRegistryV2.ts:882`): still unqueued, so its question does not hold the medium/high queue; <br>• `limitRetriesToReadOnlyTools` (`orchestrator.ts:2383`): keeps two graph retries for `save_relation` (L-6); <br>• metrics count a "no" as a tool failure (I-6); <br>• `plannerIntelligence` and `toolCatalog:537` use their own risk values. <br>The approval path is unchanged: risk 1, so the registry does not ask, only the tool does. Asked once in every r1 row |
| 5 | L-1 to L-3 in `goalExecutor` | **Mostly met; see L-7.** <br>• L-1: only `save_relation`'s own failure entry matches; another tool quoting it does not (r5 G3, f3). <br>• L-2: G2 is now `needs_review` / `MEMORY_NOT_STORED`. An archived run whose `save_relation` failed, or a memory step asked to keep a fact, is not taken back; it runs again (`goalRuntime.ts:1060`, then `interruptTask`). <br>• The archive has `request` = the task description and `agents[].role` (`agentManager.ts:1117-1128`), so both paths classify the same text. <br>• f3: 7 of 7 plain phrasings flagged, 5 of 8 read-only phrasings not flagged. False positives: "Remember what the user said … and summarise it", "Note which remembered facts …", "Save time: …". False negatives: "Store the user's exam date", "Record that …", "Memorize …", "Make a note that …", "Update the user profile: …", Spanish, German. <br>• "Save the file to the memory card" is flagged only when a Memory agent took part. <br>• The request object carries `tool`, `agent`, `agentId`, `taskId` and `rootTaskId`. The console shows ASKED BY AGENT, the voice names the agent, and decisions carry `rootTaskId` (r2, r6) |
| 6 | Memory trust re-audit | **Met, with L-1 to L-3.** Every `rememberFact` caller: <br>• `memoryTool.ts:139`: owner's "yes"; <br>• `jarvisAgents.ts:311,318`: `promoteToMemory`, verified only, unchanged; <br>• `goalLearning.ts:155`: lessons, unchanged; <br>• `agentMemory.ts:223`: no caller found. <br>`memory_brain remember` is reached only by the deterministic route with the owner's words (`orchestrator.ts:835`) and is not offered to the planner or to agents. The second brain mirrors every `rememberFact` after redaction (`memoryManager.ts:697`). Inside a goal nothing is stored and nobody is asked (r1 C, P5; r5) |
| 7 | No regression | **Met for the listed tests; full CI needs a re-run** (condition 1). <br>• `pnpm run typecheck`: exit 0. <br>• The 27 listed tests: 27 passed, 0 failed. <br>• `boundaryDoublesTest` and the changed `saveRelationAskOnceTest`: both pass. <br>• Author's CI: 259 files, 248 passed, 1 failed (`boundaryDoublesTest`), 1 blocked (`realTtsHandoffTest`), 9 skipped. <br>• Against `baseline-ci.txt`, 230 of 231 verdicts are identical; `boundaryDoublesTest` went PASS → FAIL because the ask-once test used `installFakeTts` without a `tests/boundary-doubles.json` entry. <br>• The 28 tests not in the baseline all pass |
| 8 | Files | **Met.** <br>• `git diff HEAD -- tests`, `package.json` and `pnpm-lock.yaml`: empty. `git diff --check HEAD`: clean. <br>• Against `confirm-review-fixes/hashes-before.txt` and `m2-registry/hashes-before.txt`, only `memoryTool.ts`, `goalExecutor.ts`, `toolRegistryV2.ts` and `.env.example` differ. <br>• `toolExecutionSandbox.ts`, `security/*`, `orchestrator.ts`, `taskGraphEngine.ts`, `core/agents/*` and `toolCatalog.ts` are unchanged; `reflectionEngine.ts` and `stepRecovery.ts` are unchanged against HEAD. <br>• `git diff HEAD -- core/toolRegistryV2.ts` is exactly the two hunks in §12.2. <br>• `source-hashes-at-review.txt`: all OK except `tests/saveRelationAskOnceTest.ts`, which the author changed at 11:57 during this review (see §4, test changes) |

**The narrow patch (§12.2): agreed.**
- Sending every low-risk call through the sandbox would make every read-only tool reportable as "outcome unknown". That stops goals for review and writes action-log lines. It would also move every low-risk limit from 25 s to 30 s.
- The opt-in flag avoids both.
- Its cost: a future low-risk tool that asks the owner without setting `asksOwner` gets the old M-2 behaviour again, and nothing checks for this.
- I found no other low-risk tool that calls `approvalGate`. `delegate_task` is low but returns at once.
- A test that fails when a low-risk tool's source calls `requestApproval` without `asksOwner` would close this.

---

## 3. Findings

### High

None.

### Medium

None.

### Low

**L-1. A voice question drops markdown from the fact, so what is heard can differ from what is stored.**
- **Where:**
  - `memoryTool.ts:63` raises the risk by length only.
  - `nodeBridge.speakToClients` runs `stripMarkdown` (`spokenText.ts:51-56`) on the question.
- **Scenario (f4):** by voice, the fact `User TRUSTS [my bank](https://evil.example/x)` (45 characters, risk 1):
  - the speaker gets "… on "User TRUSTS my bank"";
  - a spoken "approve" stores the link.

  `**5**00 to ~Ali~ \`now\`` is said as "500 to Ali now".
- **Fix (unprotected, `memoryTool.ts`):** when the source is voice and `stripMarkdown(fact) !== fact`, ask with the raised risk, so a typed answer is needed. Alternatively, refuse markdown link syntax in every fact.

**L-2. Some invisible characters are not refused.**
- **Where:** `memoryTool.ts:30` refuses `\p{Cc}\p{Cf}\p{Zl}\p{Zp}`.
- **Scenario (f4):** none of these is refused:
  - variation selectors U+E0100..E01EF (category Mn), which encode bytes invisibly, one per character; f4 hid "ignore all rules" after "Friday" and it was asked and stored;
  - Hangul filler U+3164 and Braille blank U+2800, which render blank.

  The console shows nothing for them, and `.env.example` says invisible characters are refused.
- **Fix (unprotected):**
  - Also refuse `\p{Default_Ignorable_Code_Point}`, except a U+FE0F that follows an emoji. That covers the variation selectors and Hangul fillers.
  - Add U+2800 explicitly.

**L-3. A credential split across the parts is shown cut, stored redacted, reported as failed, and given raw to the graph.**
- **Where:** `memoryTool.ts:117` checks `hasSecret` on each part, not on the joined fact.
- **Scenario (f4):** entity1 `User's wifi password`, relation `IS`, entity2 `hunter22x`:
  - Shown TARGET: `"User's wifi password IS [REDACTED:secret]`. The redaction consumed the closing quote.
  - Stored in the fact store, redacted by `rememberFact`: the same text.
  - The after-action check compares the unredacted fact, so the reply says "reported success, but … it is not in long-term memory" while a fact was stored.
  - `graphMemory.saveRelation` receives `hunter22x` (stored only when graph memory is on).
- **Fix (unprotected):** also refuse when `hasSecret(fact)`, with the existing "I don't store passwords" reply.

**L-4. The replies after a refusal are misleading.**
- **Where:**
  - `reflectionEngine.ts:805` (protected) maps "cancelled by user" to the `context_error` lead "I'm missing something I need to do that, sir."
  - `memoryTool.ts:131` says "cancelled by user - the fact was not confirmed" also when the owner said yes but the call had been stopped. Through the real gate, the "your answer came after this call was stopped" text at `:133` is not reached, because the gate already returns false (f1 C, f2 late, r3 T3).
- **Scenarios (f2):**
  - "no" or no answer: "I'm missing something I need to do that, sir. save relation cancelled by user the fact was not confirmed, so nothing was stored."
  - The line-break refusal: only "I'm missing something I need to do that, sir."
  - Late "yes": the same "not confirmed" text, although the owner confirmed.
- **Fix (unprotected):**
  - Return the refusal as JSON with `error: 'APPROVAL_DENIED'` and keep "cancelled by user" in the text. The registry then sets `error` (`reportedFailure`), the orchestrator keeps the code, and `refusalVoiceMessage` says `APPROVAL_DENIED_REPLY` ("Cancelled, sir. You did not approve it, so nothing was done."). The task graph still sees "cancelled" (abort).
  - Check `signal?.aborted` before choosing the "not confirmed" text.

**L-5. Inside a delegated agent, a model that calls `save_relation` again re-asks the owner.**
- **Where:** `memoryTool.ts:131` keeps no record of answers. The tool loop only tells the model not to retry (`toolLoop.ts:180`).
- **Scenario (f6):** a Memory agent whose model calls the same `save_relation` three times:
  - "no": asked 3 times, stored 0;
  - "yes": asked 3 times, stored 3 times.

  `.env.example:145-146` says "a 'no' or no answer is final"; that holds for the planner path only.
- **Fix (unprotected, `memoryTool.ts`):** keep the owner's answer per root task (or request) and fact for the life of that task. Return it without asking again, and do not store a fact twice.

**L-6. A store error after "yes" is retried by the task graph, so the owner is asked three times.**
- **Where:**
  - `memoryTool.ts:143-144` throws `save_relation failed: …`; the sandbox turns it into an `Error:` result.
  - `taskGraphEngine.ts:543-567` classifies it `transient`.
  - `orchestrator.ts:2383` keeps `maxRetries` 2 for low-risk tools.
- **Scenario (f2 `throw`):** the owner says yes and the stand-in store throws EBUSY: asked 3 times, each recorded `true/console`. The reply is "I couldn't work out how to do that, sir. save relation failed: Error: EBUSY …".

  The real `rememberFact` rarely throws: mainly `ensureInit` before memory is ready. The graph write catches its own errors. This behaviour predates this round.
- **Fix:**
  - **Unprotected:** return the failure with wording the graph treats as final. Better, do not ask again for a fact already approved in this request (L-5's record).
  - **Protected alternative:** `limitRetriesToReadOnlyTools` sets `maxRetries` 0 for `asksOwner` tools.

**L-7. The goal-step classifier has false positives and negatives.**
- **Where:** `goalExecutor.ts:233-235` (`isRememberStep`) and `factToRemember` (`behaviors/memory.ts:63`).
- **Scenarios (f3, Memory-agent steps):**
  - **False positives:** "Remember what the user said about the exam and summarise it", "Note which remembered facts about the exam are out of date" and "Save time: read the remembered facts first, then answer" are flagged `MEMORY_NOT_STORED`. The goal is `blocked` with "inside a goal nothing is stored there", although the step only reads.
  - **False negatives:** "Store the user's exam date (Friday)", "Record that …", "Memorize …", "Make a note that …", "Update the user profile: …", and Spanish or German phrasing are not flagged. A model that skips the tool and says "Saved" then completes the step (the L-2 residual).
  - When the model does call `save_relation`, the limitation check catches the step whatever its wording.
- **Fix (unprotected):**
  - Exclude recall forms: "remember what/which/whether/how/if", and "note which/what".
  - Add "record", "memori[sz]e", "make a note" and "store … <noun>".
  - Stating this residual in `.env.example` is enough if the owner prefers.

**L-8. `.env.example:143-151` still says more than the code does.**
- "a 'no' or no answer is final": not when a delegated agent's model re-calls (L-5), or after a store error (L-6).
- "an invisible character … is refused": not for variation selectors or blank-glyph letters (L-2).
- The line "limit, and a request that is stopped withdraws it. A fact longer than 150 characters, or with a line" is longer than the surrounding wrapped lines.
- **Fix:** docs only, after the owner's decision on L-2 and L-5.

**L-9. The question says "It can be undone"; the catalog says it can only partly be undone.**
- **Where:**
  - `memoryTool.ts:74` sets `reversible: 'yes'`;
  - `toolCatalog.ts:300` has `reversible: 'partial'` for `save_relation`;
  - `forget_memory` removes the fact store and the index entry, not a graph edge.
- **Fix (unprotected):** `reversible: 'partial'`. The spoken text becomes "It can only partly be undone."

### Info

- **I-1. Whitespace kinds.** NBSP and U+3000 inside an entity are shown as a plain space (`approvalRequest.ts:157` folds `\s+`) and stored as typed (f4). There is no visible difference on screen; noted for completeness.
- **I-2. A whitespace-only entity is accepted.** `entity2: '   '` passes `memoryTool.ts:114`. "User LIKES" is stored, and the after-action check then reports it missing (f4).
- **I-3. False refusals.** A ZWJ emoji sequence and Persian text with ZWNJ are refused (f4). This fails safe; it matters only for owners who write in Persian or Urdu orthography that uses ZWNJ.
- **I-4. The "stopped" branch and its test.** `memoryTool.ts:133` is reached only when the gate is bypassed. `saveRelationConfirmReviewTest` reaches it with a stand-in `requestApproval`, so it tests a message the owner will rarely see (see L-4). `saveRelationTimeBudgetTest`'s withdrawal case uses a prompt stand-in that ignores the signal: it proves the `cancelled` record, not that the question leaves the display. f1 C shows the real withdrawal in CLI-loop mode.
- **I-5. Outcome unknown for `save_relation`** (f1 E):
  - It is now possible when the store, for example a slow Neo4j write with graph memory on, outlasts the remaining budget plus the stop grace. The fact store write happens first.
  - The reply ("may still finish") and the action-log lines are accurate.
  - An issue occurrence is also recorded under `data/repairs`.
- **I-6. A "no" counts as a tool failure.** Registry metrics count each "no" as a failure. After 5 in a row (`DEGRADE_THRESHOLD`), `save_relation` is marked degraded, and `plannerIntelligence` lowers its confidence. This predates this round.
- **I-7. Previous I-1, I-3 and I-5 unchanged.**
  - The provenance test's two assertions still test the stand-in owner's policy.
  - A resumed `needs_review` memory step is refused again.
  - The foreground request is module-level.

---

## 4. Status of the previous review's findings

| Item | Status | Evidence |
|---|---|---|
| **M-1** (long fact shown cut; line breaks) | **Resolved**; residual gaps L-1, L-2, L-3 | r2: the long fact (225 characters) is refused without asking; the line-break fact is refused; the 129-character voice fact gives risk 3 and a spoken "yes" is not taken; short facts are shown and spoken whole. f4: Unicode cases |
| **M-2** (budget not paused; question not withdrawn) | **Resolved** by the registry patch | r3: T2 (limit 300 ms) stored; T3 `cancelled`, stored 0; T4 (26 s) stored. f1 A–D: queued and displayed questions, withdrawal. The new test: 7 of 7 |
| **M-3** (asked three times) | **Resolved** for the planner; residuals L-4, L-5, L-6 | r4 and f2: asked once for "no", timeout, late and repeat-no, and 0 times for policy refusals; one in-process sequence (f5): 4 of 4 |
| **L-1** (pattern matched any mention) | **Resolved** | r5 G3: completed; f3: another tool's entry is not matched |
| **L-2** (step done without storing; archive) | **Resolved** for the common phrasing; residual L-7 | r5 G2: `needs_review`; I1: no result taken from the archive |
| **L-3** (no agent or ids; no grace) | **Partly resolved.** Request, console line, spoken asker and `rootTaskId` are done. Grace for a background question is open (protected `approvalGate.ts:389`) | r2, r6: a second "yes" 80 ms later still approves the background agent's fact |
| **L-4** (`.env.example`) | **Partly resolved**; see L-8 | |
| I-1 (provenance test labels) | Open (I-7) | |
| I-2 (direct call inside an approved scope) | **Resolved**: the request now names `save_relation` | r7: direct call asked, decision `console`, stored 0 |
| I-3 (resume) | Unchanged | |
| I-4 (test stands in for `requestApproval`) | **Partly resolved**: the ask-once and time-budget tests use the real gate | See I-4 above |
| I-5 (module-level request) | Unchanged | |

**Test changes (brief, item 16): none weakens a test.**
- **`provenance-test-setup.diff`:** the stand-in reads `target` from the request object. No assertion changed.
- **`ask-once-test-restructure.diff`:** one process per answer, with the same three assertions.
  - The author's debug output shows why the one-process version failed before the fix: an interim refusal wording led the reflection step to a `fallback_tool` repair that asked again.
  - On the final code, my one-process run of the same sequence (f5), with a fourth identical "yes" request added, passes 4 of 4.
- **`ask-once-speech-stand-in-removed.diff`** (11:57, during this review): drops `installFakeTts`, which no assertion used, to satisfy `boundaryDoublesTest`.
  - On the pre-fix code it still fails (asked 3 times).
  - On the final code it passes.
- **`saveRelationTimeBudgetTest` header note:** accurate. The 26 s case shows that the call limit no longer ends the question, and it says that in use the window is 20 s. Its withdrawal case is weaker than its label (I-4).

---

## 5. What I ran

**Probes:** in `scratchpad/review-final/`, run with `pnpm exec tsx` from the repository root. Outputs are in `*.full`.

Every probe:
- sets `JARVIS_WORKSPACE_ROOT` and `JARVIS_DATA_ROOT` to a new temporary folder before importing anything;
- replaces `memoryManager.rememberFact` with a stand-in before any call that could store (f3's stand-in throws);
- registers a stand-in provider under `anthropic`;
- makes no network or provider call;
- either replaces the gate's prompt functions with a scripted answer, or runs the gate in CLI-loop mode answered with `offerConsoleAnswer` (f1, r6), or replaces `requestApproval` (f3, r5).

The older files in that folder dated 2026-11-15 (`probe*.mts`, `*-verdicts.txt`, `tests-run.txt`) belong to an earlier review and were not used.

| Probe | What it covers |
|---|---|
| `r1_rerun.mts` | Previous: 16 rows, foreground and delegated, "no" and "yes"; real Memory agent; goal root; one-step goal |
| `r2_display.mts` | Previous: console block, spoken text and record for short, long, voice and multi-line facts |
| `r3_timeBudget.mts --real` | Previous: control, lowered limit, stopped call, a "yes" after 26 s |
| `r4_plannerRepeat.mts` | Previous: real orchestrator with "no", timeout and "yes" |
| `r5_goalL3.mts` | Previous: `GoalRuntime` + `AgentGoalExecutor` (G1–G3) and `inspectPrevious` (I1) |
| `r6_queue.mts` | Previous: a foreground and a background question at once; a repeated "yes" |
| `r7_scope.mts` | Previous: another approved call's scope, through the registry and by a direct call |
| `f1_budgetSandbox.mts` | Own: budget paused while displayed and while queued; withdrawal while displayed and while queued; outcome unknown on a slow store; ordinary low-risk tool as control |
| `f2_orchestratorFinal.mts` | Own: real orchestrator with no, timeout, yes, policy-long, policy-nl, late, repeat-no and throw; spoken reply and graph classification |
| `f3_rememberStep.mts` | Own: `memoryNotStored` / `isRememberStep` on 22 Memory-agent phrasings, other specialists and limitation formats, through `inspectPrevious` |
| `f4_unicodeShown.mts` | Own: 24 display cases (Unicode, length limits, cross-part credential, voice markdown); shown, spoken, stored, graph |
| `f5_sequenceOneProcess.mts` | Own: the ask-once sequence in one process, plus a repeated "yes" request |
| `f6_agentRepeat.mts` | Own: a delegated Memory agent whose model repeats `save_relation` |

**Tests and typecheck:**
- `pnpm run typecheck`: exit 0.
- `pnpm test -- --only=<the 27 listed>`: 27 passed.
- `pnpm test -- --only=saveRelationAskOnceTest,boundaryDoublesTest`, after the author's 11:57 change: 2 passed.

**Full CI:** not run by me. I read the author's `after-ci.txt` once it had finished; the comparison is in §2, check 7.

**State:** `git status --porcelain` was the same before and after, and no tracked file under `data/` or `memory/` changed. The only file I wrote in the repository is this report.

**Only the owner's Windows PC or live providers can verify:**
- How the Windows console renders combining marks, RTL text, emoji, variation selectors and blank-glyph characters in the TARGET line.
- What the real TTS says for markdown, emoji and symbols (L-1).
- How long real spoken confirmations take now that the budget pauses, including speech queued behind other replies.
- Whether real planner and Memory-agent models put markdown, invisible characters or credentials into entities.
- Whether they call `save_relation` again after "cancelled by user" (L-5).
- Which phrasings the real goal planner uses for memory steps (L-7).
- A slow Neo4j graph write against the 30 s budget (I-5).
- The full `--ci` run on the final test file, and the Windows-only and live-provider tests that CI skips or blocks (`realTtsHandoffTest` is blocked here).
