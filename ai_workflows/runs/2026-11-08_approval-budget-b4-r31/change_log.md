# Change Log — approval wait outside the tool's budget (B4 R3-1)

Base commit: `7ea2d3a`. Owner's Gate 1, 2026-11-08: approved, with two safeguards (cancellation cleanup; remaining-budget accuracy). See `patch_plan.md`.

## The change

| File | Change |
|---|---|
| `core/toolExecutionSandbox.ts` (protected) | Each sandboxed call runs `tool.execute` inside a per-call scope (AsyncLocalStorage, `currentToolCall()`). Its budget is a clock (`budgetClock`) that `whileOwnerAnswers()` pauses while the owner answers a question the tool asks, and resumes with exactly the time that was left: time used before the question is deducted, the full budget is never given again. Pauses are counted (the clock restarts after the last open question). Nothing restarts after the call ended, ran out of time, or was stopped. The stop grace, concurrency cap, audit log and wordings are unchanged. A tool that asks nothing keeps its budget exactly as before |
| `security/approvalGate.ts` (protected) | `requestApproval`, inside a tool call, pauses the budget around its turn wait and the question. A call already stopped is not asked. A call stopped while waiting its turn stops waiting at once and is not asked (its box is never shown); the turn still passes on only after the question before it is done. A call stopped while its question is open has it withdrawn at once: the pending request removed, the voice wait ended, a typed or spoken answer afterwards taken by nothing. A yes that arrives as the call is stopped approves nothing. Each of these is recorded as `cancelled`, a denial. Covered nested questions are unchanged. Questions asked outside a tool (the registry's own, goals, the CLI) are not paused or cancelled, with one change from review F2: a question shown within 1.5 s of a withdrawal takes typed answers only from 1.5 s after it, and its deadline moves by as much. The accepted words and the deadlines (typed 30 s, spoken 20 s after JARVIS finishes asking, the 90 s speech wait) are unchanged; a deadline can only get longer, by at most the grace |
| `security/approvalRequest.ts` (protected) | `'cancelled'` added to the decision's `by` |
| `tests/boundary-doubles.json` (owner's approval, after the first full suite) | One entry: `tests/approvalBudgetR31Test.ts` replaces `speakToClients` (§7, a spoken question still being said when its call is cancelled), with its reason, as the repository's boundary-double rule requires |

Not changed: `core/toolRegistryV2.ts`, the controllers (`browserController`'s own check after the answer stays as a second guard), the risk engine, the permission session.

## Tests

| File | Change |
|---|---|
| `tests/approvalBudgetR31Test.ts` (new) | 40 checks with the real sandbox, gate and registry, a 1.5 s budget and 0.5 s grace, typed answers through the console hand-off, and fake tools that ask and then act without checking their signal. §1 a yes at 1.8 s and at 2.4 s (after the budget plus grace) acts once, as a success, and the budget did not run out during the question. §2 "close the browser" (`control_browser`, a fake Chrome found through the profile's port file) answered after 1.8 s: `Browser.close` sent once, "Closed JARVIS's Chrome". §3 no answer by the gate's deadline (10 s): denied, not acted, no TIMEOUT while asking; no way to answer: denied; yes twice: acted once. §4 cancelled with the question open: withdrawn at once, `cancelled`, a later yes approves nothing, the next question is shown at once; a yes and the cancellation in the same instant: `cancelled`, not acted; cancelled with budget left: the budget is not resumed; cancelled before asking and budget used up before asking: not asked. §5 0.6 s + a question + 0.6 s fits; 0.6 s + a question + 1.5 s: the budget ends 0.9 s after the answer (±0.15 s), never 1.5 s; a tool that asks nothing: 1.5 s as before; a parallel call keeps its budget. §5b a question waiting its turn has its budget paused; cancelled while waiting its turn: stops at once, never shown, a third question still waits for the one on display; two questions open at once in one call; two questions one after the other: 0.7 s left after the second (±0.15 s). §6 the registry's own approval and a covered nested question, unchanged. §7 a spoken question cancelled while JARVIS is saying it: the voice wait ends, a spoken approve afterwards approves nothing |

## Evidence

| Check | Result | File |
|---|---|---|
| Diagnosis probes (Gate 0) | the real sandbox with a fake tool: A refused, B acted after the budget, C acted after JARVIS reported TIMEOUT; the tools' risk tiers | `evidence/r31_probe_sandbox.*`, `r31_tool_tiers.txt` |
| New test on the base code (the final 40-check version, minus the 4 checks added last) | 11 passed, **25 failed** of 36; every failure is the bug; the 11 passes are behaviour that must stay (the registry's approval, nested questions, duplicates, no way to answer, tools that ask nothing, parallel calls, "the question on display is still the other call's") | `evidence/r31_old_code_checks.txt` |
| New test after the change | **40/40** | `evidence/r31_new_code_checks.txt` |
| Typecheck | Round 1: `TC=0` was recorded before the test's last edit and was wrong. On that tree it gave **TC=2** (`tests/approvalBudgetR31Test.ts(413,54): error TS2339`; review F1). After the review fixes: **TC=0** | `evidence/r31_typecheck.txt` |
| Mutation check, 14 mutants | **13/14 caught**, tree restored (md5). M8 (a call already stopped is asked anyway) is not caught, and it is **not strictly equivalent** (review F6). The check after the turn wait gives the same outcome: not asked, `cancelled`, not acted. But under M8, `pause()` clears the cancelled call's budget timer, which is still running, so the call's TIMEOUT message reads "was cancelled …" instead of "ran past its … budget". No test checks that wording. The first check is kept as defence in depth: it also avoids taking a turn slot | `evidence/r31_mut.py`, `r31_mut_run.txt` |
| Related tests (43: every test that imports the three changed files, and the tests named in Gate 0) | **42 passed, 0 failed**, 1 skipped (`finalIntegrationSuiteTest`, live provider) | `evidence/r31_related_list.txt`, `r31_related_tests.txt` |
| Full suite, first run | 217 passed, **1 failed**, 1 blocked (no pygame), 9 skipped: `boundaryDoublesTest`, "tests/approvalBudgetR31Test.ts (speakToClients) is listed with a reason — not in tests/boundary-doubles.json". Reported to the owner; the entry was added with approval. `boundaryDoublesTest` then passed (the evidence shows its PASS line in the full suite; the number of checks inside it is not recorded) | `evidence/r31_full_suite_first.txt` |
| Full suite, after the entry | **218 passed, 0 failed**, 0 timed out, 1 blocked (`realTtsHandoffTest`, no pygame), 9 skipped; exit 1 for the blocked test; `approvalBudgetR31Test` and `boundaryDoublesTest` pass | `evidence/r31_full_suite.txt` |
| **Review round 1 follow-ups (2026-11-09)** | | |
| New test after the review fixes | **55/55** (40 earlier + 15 in §8). The F8 "no budget left" check failed on the code before the `pause()` fix (54 passed, 1 failed: "1 shown, console: acted"); it passes after the fix | `evidence/r31_new_code_checks_round2.txt` |
| Typecheck | **TC=0** | `evidence/r31_typecheck.txt` |
| Mutation check, round 2, 10 mutants (N1–N10) | **9/10 caught**, tree restored (md5). N8 (no upper limit on the remaining time) survives as an equivalent mutant: with `performance.now()` the deadline is always set as now + at most the budget, and the clock never goes back, so `deadline − now` cannot exceed the budget. `Math.min` is kept as a second guard | `evidence/r31_mut_round2.py`, `r31_mut_round2_run.txt` |
| Related tests (the same 43) | **42 passed, 0 failed**, 1 skipped (`finalIntegrationSuiteTest`, live provider) | `evidence/r31_related_tests_round2.txt` |
| Full suite | **218 passed, 0 failed**, 0 timed out, 1 blocked (`realTtsHandoffTest`, no pygame), 9 skipped; exit 1 because of the blocked test; `approvalBudgetR31Test` and `boundaryDoublesTest` pass | `evidence/r31_full_suite_round2.txt` |
| **Review round 2 follow-ups (2026-11-09)** | | |
| New test after the round-2 fixes | **72/72** (55 earlier + 17 in §9); exit 0; `jarvis-r31-*` folders before 0, after 0 | `evidence/r31_new_code_checks_round3.txt` |
| Typecheck | **TC=0** | `evidence/r31_typecheck.txt` |
| Mutation check, round 3, 7 mutants (P1–P7: S1 ×4, S2 ×3) | **7/7 caught**, tree restored (md5), no folders left after 7 failing runs (the S6 cleanup also runs when checks fail). The first run hung on P6 before the bounded waits (see above) | `evidence/r31_mut_round3.py`, `r31_mut_round3_run.txt`, `r31_mut_round3_first_partial.txt` |
| Related tests (the same 43) | **42 passed, 0 failed**, 1 skipped (`finalIntegrationSuiteTest`); exit 0 | `evidence/r31_related_tests_round3.txt` |
| Full suite | **218 passed, 0 failed**, 0 timed out, 1 blocked (`realTtsHandoffTest`, no pygame), 9 skipped; exit 1 because of the blocked test; `approvalBudgetR31Test` and `boundaryDoublesTest` pass; no `jarvis-r31-*` folders left | `evidence/r31_full_suite_round3.txt` |
| **Review round 3 follow-ups (2026-11-09)** | | |
| New test after the round-3 fixes | **78/78**, exit 0, 71 s; `jarvis-r31-*` folders before 0, after 0. Also 78/78 with `JARVIS_APPROVAL_GRACE_MS=abc` set in the shell (T5) | `evidence/r31_new_code_checks_round4.txt` |
| T6 probe | A script with the same exit handler that ends on an unsettled top-level await: exit code 13, 0 folders left | (probe outside the repository) |
| Typecheck | **TC=0** | `evidence/r31_typecheck.txt` |
| Mutation check, round 4, 5 mutants (Q1 T1 test fault, Q2–Q4 T2, Q5 T5) | **5/5 caught**, files restored (md5: `approvalGate.ts`, the test), 0 folders left after 5 failing runs | `evidence/r31_mut_round4.py`, `r31_mut_round4_run.txt` |
| Related tests (the same 43) | **42 passed, 0 failed**, 1 skipped; exit 0 | `evidence/r31_related_tests_round4.txt` |
| Full suite | **218 passed, 0 failed**, 0 timed out, 1 blocked (`realTtsHandoffTest`, no pygame), 9 skipped; exit 1 because of the blocked test; `approvalBudgetR31Test` (70.5 s) and `boundaryDoublesTest` pass; 0 folders left | `evidence/r31_full_suite_round4.txt` |

## Deviations from the plan

- `tests/jarvisChromeTest.ts` did not need a change: its R3 case still passes.
- `tests/boundary-doubles.json` was not in the Gate 1 list. The first full suite failed on the repository rule that every test replacing `speakToClients` is listed there; the owner approved adding the one entry ("Add the entry").
- The test's first old-code run had test-harness faults (a leftover question making later cases fail, a level-3 case without full control, a hand-built approved call); they were fixed in the test before the code change, and the old-code run was repeated.
- The last four checks (a yes in the same instant as the cancellation; the cancelled waiter's box; a third question; two questions one after the other) were added after the old-code run, so that mutants M9, M11, M12 and M6 have a check; those mutants show they can fail.

## Review round 1 follow-ups (owner's approval, 2026-11-09)

The independent review (`review.md`) required changes. The owner approved fixing F1, F2, F3 and F5, adding tests, and correcting the records for F4, F6 and F9; F7 and F8 were left to the implementer's judgement. While writing the F8 test, a gap was found: a question asked with no budget left was still shown. The owner approved fixing it ("Fix in pause()").

| Finding | Change | File |
|---|---|---|
| F1 | `approvalGate.pendingRequest()?.request` replaced by `approvalGate.pendingRequest()` (line 413) | `tests/approvalBudgetR31Test.ts` |
| F2 | The gate keeps when a question on display was last withdrawn (`withdrawnAt`). A question shown within `ANSWER_GRACE_MS` (1.5 s) of a withdrawal takes typed answers only from 1.5 s after the withdrawal. A "yes" typed earlier is not taken; the owner is asked to answer again. Its deadline moves by the same amount, so the 30 s typed window is not shortened. Questions shown with no recent withdrawal are unchanged. Spoken answers were already safe: they count only after JARVIS has finished asking the new question | `security/approvalGate.ts` |
| F3 | `ToolCallBudget.ended`, set when the tool's run has finished. `currentToolCall()`, and so `whileOwnerAnswers` and the gate, ignore an ended call: a question that work left behind asks **after** the call ended is asked like any question outside a tool. Work still running inside an active call stays part of it. A question opened while the call was running and still open after it ended stays tied to the call's signal (review S4, a known limit) | `core/toolExecutionSandbox.ts` |
| F5 | The budget clock uses `performance.now()` (monotonic) instead of `Date.now()`; the remaining time is capped at the full budget | `core/toolExecutionSandbox.ts` |
| F7 | A spoken question that is already withdrawn when the bridge is reached is not said. A question cancelled while JARVIS is saying it is still played to the end. Stopping playback needs the TTS bridge (outside this phase), so it is recorded as a known limit | `security/approvalGate.ts` |
| F8 (gap) | `budgetClock.pause()`: when no time is left (the timer had not fired yet, for example a blocked event loop), the budget ends at once, so the gate records the question as `cancelled` and does not ask. Before, the question was shown, and a yes let the tool act with no budget left | `core/toolExecutionSandbox.ts` |
| F4, F6, F9 | Records only: `diagnosis.md` (the action queue's 10 s timer and the admin commands), the M8 and `boundaryDoublesTest` rows above, and `patch_plan.md` (real timers with about ±150 ms margins, not fake timers) | run folder |

New checks in `tests/approvalBudgetR31Test.ts` §8 (15). §4's "next question after a cancellation" now answers after the 1.5 s grace.
- **F2:**
  - the reviewer's P4 scenario: "Delete B" is not approved by a "yes" typed 30 ms after "Close A" was withdrawn;
  - the deadline moves with the grace (31.5 s);
  - a fresh yes after the grace approves "Delete B";
  - with no withdrawal, a yes 20 ms after the question appears approves as before.
- **F3:**
  - a question from work left behind by an ended call is shown (not withdrawn by that call's signal) and decided by the owner;
  - background work inside an active call pauses its budget and is withdrawn on cancellation.
- **F5:** the system clock moved back 10 s and forward 10 s before a question; the budget left after the answer is 1.2 s (±0.15 s) both times.
- **F8:**
  - a cancellation followed at once by a "yes" (not taken, `cancelled`, not acted);
  - no budget left when the question is asked (not shown, `cancelled`, not acted).
- **F7:** a spoken question withdrawn before the bridge is reached is not said.

## Review round 2 follow-ups (owner's approval, 2026-11-09)

The second independent review (`review.md`, round 2) required changes. The owner approved S1, S2 and S6 as fixes, S5 as corrections, and S3 and S4 as known limits.

| Finding | Change | File |
|---|---|---|
| S1 | `approvalGraceMs()` reads `JARVIS_APPROVAL_GRACE_MS`: a finite number of ms, 0 or more, is kept; missing, empty, non-numeric, negative, NaN or infinite gives 1500. The parser is what keeps NaN out of every deadline: it turns an invalid value into 1500 before any deadline is computed (`approvalGate.ts:86-99`, final tree). `afterWithdrawal` is also held to 0..`ANSWER_GRACE_MS` (`:388`), but that clamp does not stop NaN, because `Math.min` and `Math.max` return NaN when given NaN; it only bounds a finite value, for example from a clock that goes back (review T3; *corrected 2026-11-09*). Round 3 (T2) added an upper limit: values above 60 000 also give 1500. Behaviour change: an empty setting now gives 1500 instead of 0, as `voiceApprovalMaxRisk` already treats an empty value as missing | `security/approvalGate.ts` |
| S2 | The withdrawal time is taken with `performance.now()` (`:405` on the final tree), and the grace after it is computed on the same clock and held to 0..`ANSWER_GRACE_MS` (`:388`). With the default setting that is 0–1.5 s; a valid custom setting is kept (for example 2500 gives 0–2.5 s), as F2 already used `ANSWER_GRACE_MS` | `security/approvalGate.ts` |
| S5 | `docs/GOAL_RUNTIME.md:303` (the grace also applies after a withdrawal; the accepted values); the `boundary-doubles.json` reason (§7, §8, §9); `approvalRequest.ts` marked protected; the F3 and "outside a tool" wording; `review.md` line numbers | docs, records, `tests/boundary-doubles.json` |
| S6 | The test removes its temporary workspace in `finally`, as `tests/toolTimeoutTest.ts`, after returning to the repository folder. A 300 s watchdog fails the test and removes the workspace if a fault leaves a question open; the §9 waits are bounded (3 s) so a fault fails a check instead of hanging | `tests/approvalBudgetR31Test.ts` |

New checks in §9 (17).
- **S1:**
  - the parser for 10 values;
  - a gate started (child process) with `abc`, `-5`, `NaN`, `Infinity`, missing and `2500`: a question stays open with its 30 s deadline, a yes approves it, and a goal question's grace is 1500 ms (2500 ms for `2500`).
- **S2:**
  - the system clock moves back, and forward, an hour just after a withdrawal: the next question takes typed answers after at most 1.5 s, its deadline is 30 s plus at most 1.5 s, a "yes" typed at once is not taken, and a "yes" 1.6 s after the withdrawal approves it;
  - a controlled monotonic clock that goes back an hour cannot lengthen the grace;
  - a spoken question after a clock change: a typed "yes" at once is not taken, JARVIS listens once it has said the question, the spoken window is 20 s plus at most 1.5 s, and a spoken "approve" approves it.

The first round-3 mutation run hung on P6: a question was left open for an hour, and the test had no bound. The script's 600 s timeout stopped it; the tree was restored (md5 OK); the orphaned test processes were stopped by hand. This led to the bounded waits and the watchdog above, and the run was repeated in full (`r31_mut_round3_first_partial.txt`, `r31_mut_round3_run.txt`). 45 leftover `jarvis-r31-*` folders from earlier runs were removed from the temp folder before the S6 check.

## Review round 3 follow-ups (owner's approval, 2026-11-09)

| Finding | Change | File |
|---|---|---|
| T1 | The F5 clock tests wait until the grace after the gate's last withdrawal is over (`pastWithdrawalGrace()`) before their question appears. They assert `approved === true` and `by === 'console'`, and the budget check also requires the approval. The run is bounded (`within(call, 5 s)`). The R3-1 test now runs in about 71 s instead of 99 s | `tests/approvalBudgetR31Test.ts` |
| T2 | `approvalGraceMs()` accepts 0 to 60 000 ms (`MAX_ANSWER_GRACE_MS`). Above that, or invalid, it gives 1500, so no deadline can overflow Node's timer (limit about 24.8 days) | `security/approvalGate.ts` (protected), `docs/GOAL_RUNTIME.md:303` |
| T3, T4 | The NaN statement in the S1 row and the clock-change known limit corrected | this file |
| T5 | The test removes `JARVIS_APPROVAL_GRACE_MS` at its start; the header says "0..grace" | `tests/approvalBudgetR31Test.ts` |
| T6 | One removal function, run once, shared by `finally`, the watchdog and a `process.on('exit')` handler | `tests/approvalBudgetR31Test.ts` |

New and changed checks (78 in total, up from 72):
- **F5:** split into an approval check (`approved === true`, `by === 'console'`) and the budget check, for the clock moved back and forward.
- **Parser:** now covers 15 values (60000 kept; 60001, 1e7, 2147483647 and 1e308 give 1500).
- **Child processes:** 4 started with 60000, 60001, 1e7 and 2147483647. Each makes a real withdrawal; the next question has the expected grace (60 000 or 1500 ms), a deadline of 30 s plus that grace, stays open, and does not take a "yes" typed at once.

## Known limits (recorded, not changed)

- S3: goal code (`core/goalExecutor.ts:160-168`, `core/goalRecovery.ts:126-135`) reports any refused decision other than `timeout` and `unavailable`, `cancelled` included, as "the user declined". Today a `cancelled` decision with a `rootTaskId` arises only for a registry question asked inside another sandboxed call. Not fixed in R3-1.
- S4: a question opened while a tool call was running and still open after the tool returned stays tied to the call's signal. A later cancellation by the caller withdraws it as `cancelled` (it fails safe). F3 covers questions asked after the call ended.
- System clock changes: a known limit that was already there before R3-1. It is not fixed, and no clock-handling code was changed for it (review T4). The bridge's speech times (`ttsStartedMs`, `ttsEndedMs`, `bridge/nodeBridge.ts`) and the gate's answer windows (`consoleFrom`, `listeningFrom`, `expiresAt`) are system-clock times. Only the expiry timer and the tool budget run on monotonic clocks; since R3-1, the budget's pause and resume arithmetic uses `performance.now()`. The withdrawal grace has its **length** measured on the monotonic clock (`approvalGate.ts:388`), but it is **enforced** on the system clock, through `consoleFrom = Date.now() + grace` (`:396`) checked against `Date.now()` in `offerConsoleAnswer` (`:243-245`).
  - **Moved back:** the gate and the bridge are affected differently.
    - A question already open keeps its system-clock times, so typed and spoken answers count later than intended. The question still ends when its monotonic expiry timer fires.
    - The bridge's speech times recorded before the change lie in the "future". The next spoken question can then wait for JARVIS's speech to "end" until the clock catches up, and its listening window (`listeningFrom`, and the expiry derived from it) moves out by the same amount.
  - **Moved forward:** this has two effects; only the first fails closed.
    - A question already open has its answer window shortened, because `offerConsoleAnswer` and `offerVoiceAnswer` reject answers once `Date.now() > expiresAt` (`approvalGate.ts:244, 269`).
    - A forward jump during a grace also shortens or skips it. This covers the typed-answer grace (`consoleFrom`: both the goal grace and the grace after a withdrawal) and the echo tail after JARVIS speaks (`ttsEndedMs + ECHO_TAIL_MS`, `:273`). A "yes" typed inside the grace can then be taken as the answer to the question on display. For example, the confirming review moved the clock forward 10 s 50 ms after a withdrawal: the stale "yes" was taken and approved the next question (review U1).
    - Before R3-1, this already applied to the goal grace and the echo tail. Since F2, the 1.5 s grace after a withdrawal has the same exposure. It needs a system clock step forward within that 1.5 s window. Not fixed in R3-1 (owner's T4 decision: record only).

- F4: admin commands (`runShellCommand`, `runPowerShell`, service actions) run under the action queue's 10 s timer (`pcControlKernel.ts:444-468`). When the registry's approval does not already cover their question, a "yes" after 10 s is taken but the command is stopped. This is a separate issue for a later phase.
- F7: a spoken question cancelled while JARVIS is saying it is played to the end, and nothing says it was withdrawn. The console shows "Cancelled".
- F8: the readLine (TTY) cancel paths in `approvalGate.ts` (`_promptWithTimeout` without the CLI loop, the voice path's typed reading) are not tested here: the test environment has no TTY on stdin.
- F2: the grace is time-based. A "yes" typed more than 1.5 s after a withdrawal is taken as the answer to the question then on display.

- A call can stay open as long as its question: typed 30 s; spoken up to 90 s of speech plus 20 s. Meanwhile it keeps its sandbox slot and the registry's risky-call queue, as the gate's one-at-a-time turn already did.
- Only questions asked through `approvalGate.requestApproval` pause the budget. A tool that waits for the owner some other way would not.
- The approval words are unchanged (owner's decision): "approved" is still not an approval.
