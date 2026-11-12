# Change Log — an action that ends after JARVIS stopped waiting (B4)

Base commit: `dbaa5b1`. Owner's Gate 0 and Gate 1: 2026-11-09. Stage 2 and Stage 3 decisions, and the second review's corrections: 2026-11-09 to 2026-11-11. See `patch_plan.md`.

## The change

An action that ends after JARVIS stopped waiting for it is reported as "may have happened", never as a plain failure, and is never repeated automatically. The internal marker is `TIMEOUT (outcome unknown)`. It keeps the word TIMEOUT, so the action queue's existing no-retry rule still applies.

| File | Change |
|---|---|
| `core/outcomeUnknown.ts` (new) | `OUTCOME_UNKNOWN_MARK`, `isOutcomeUnknown()`, `secondsText()` (whole seconds, "1 second", "20 seconds") and `captureCallOrigin()`. The last one builds a frozen call identity: a call id, the request's trace id or the background agent's path, and the owner's words |
| `core/toolExecutionSandbox.ts` (protected) | **A1:** the call identity is taken on entry to `run()`. **A2:** the gave-up text `Error: TIMEOUT (outcome unknown): Tool "X" … JARVIS stopped waiting for it after N seconds. It may still finish.` **A3:** an `outcome_unknown` line is written and awaited before the result is returned, for at most 2 s (`OUTCOME_LOG_WAIT_MS`); a write that fails or is overdue is reported separately, the outcome stays unknown, and nothing is run again. **A4:** when the tool ends later, a `late_result` line with the same identity is written after the real `outcome_unknown` write, and the earlier line is never rewritten. Once JARVIS has stopped waiting, the unknown outcome is the call's only result, also when the tool ends during the audit wait. Budgets, the concurrency cap, the R3-1 approval clock, the stop grace and `tool_audit.log` are unchanged |
| `control/pcControlKernel.ts` (protected) | **B1:** the request identity is taken when an action starts and used for its log line. **B2:** a failure carrying the marker is logged as `result: "unknown"` |
| `core/toolRegistryV2.ts` (protected) | **C:** an output or thrown error carrying the marker is returned at once, with no retry and no fallback tool |
| `core/taskGraphEngine.ts` (protected) | **D:** the marker is a fatal error, so the step is never re-run |
| `core/reflectionEngine.ts` | The class `outcome_unknown` is checked before the network `TIMEOUT` pattern. Any failed step carrying the marker makes the outcome `outcome_unknown` with strategy abort, so it is never retried or re-planned. What the owner hears: a one-step request, `I stopped waiting for "<request>" after N seconds, sir. It may still finish, so check before asking me to try again.`; a step of several, `…for the <tool> <action> step…`; a stopped command, `The command was stopped after N seconds, sir. Part of it may already have run, so please check before trying again.` A network read timeout keeps `network_error` and "retry with delay" |
| `control/adminController.ts` | `stoppedCommandError()`: a started command that was stopped gives the marker text with the measured seconds. A command that never started is a definite failure: `… was not started: the request was stopped before it began.` |
| `system/processRunner.ts` | `RunResult.started`: false only when the signal was already aborted, so no process was started |
| `control/actionAuditLog.ts` | The result value `unknown`; `logOutcomeUnknown()` (returns whether the line was written) and `logLateResult()`; `append()` returns whether it wrote |
| `core/goalRecovery.ts` | `classifyFailure` returns `outcome_unknown` before the budget and transient patterns. The decision is needs-review/block and never a retry |
| `core/goalLifecycle.ts` | `outcome_unknown` added to `FailureClass`, so it is counted apart from `interrupted` |

## Corrections after the second independent review (owner's approval, 2026-11-11)

| ID | Problem | Correction | Regression check |
|---|---|---|---|
| V1 | The never-started text did not match the action queue's no-retry rule. The command was tried again after 500 ms, so approval was asked twice (`evidence/b4late_new_code_checks_round2.txt:83`) | New wording "… the request was stopped before it began." (`was stopped` is final for `control/actionQueue.ts`) | 5.1: one attempt through the real queue. 5.2: end to end through the kernel with an already-aborted signal; asked once, the definite wording, logged `failure` |
| V2 | When the `outcome_unknown` write took longer than 2 s, the `late_result` line could be written first | `late_result` waits for the real write; the result keeps its 2 s limit | 5.3: write delayed 2.6 s; result in 3.7 s; `outcome_unknown` before `late_result` |
| V3 | After a replan, the quoted request would include the planner's internal `[SYSTEM NOTE …]` | The note is removed before quoting, as at `core/orchestrator.ts:1501` | 5.4 |
| V4 | Records: agents were said to be told to check first; the agent-run goal limit was missing; `goalLifecycle.ts` was not listed | `patch_plan.md` corrected | (records) |
| V5 | A new method separated `buildFailureVoiceMessage` from its comment | The comment is back above its method | 5.5 |
| K25 timing | The Windows checks expected exact whole seconds; a slow process exit could add one | 4.6 accepts 2 or 3 seconds and still rejects a fixed 10; 2.5 accepts 10 or 11 and checks the sentence with the measured number | (Windows only) |

## Tests

`tests/lateOutcomeB4Test.ts` (new): 51 checks run on Linux, plus 3 that run only on Windows.
- **§1, the sandbox gave up:**
  - the unknown outcome and the time waited;
  - what the owner hears;
  - one run with no retry or fallback;
  - the audit lines, their identity and order;
  - another request; two calls; a background agent; a cancellation;
  - an audit write that fails or hangs.
- **§2, an admin command:**
  - the stop text and its spoken sentence;
  - `runProcess` reports `started`;
  - the kernel's line;
  - the action queue;
  - Windows: real `cmd.exe` (2.5).
- **§3, unchanged:** network-read retries; goal recovery; refusals; a tool that finishes before JARVIS gives up.
- **§4, checks added after the mutation check:** K3, K8, K11, K16, K19, and K25 (4.6, Windows).
- **§5, checks added after the second review:** V1, V2, V3, V5.

## Evidence

| Check | Result | File |
|---|---|---|
| Gate 0 probe | the tool acted 1.2 s after JARVIS reported the failure; "I couldn't reach a service I needed, sir." | `evidence/b4late_probe.mts`, `b4late_probe.txt` |
| New test on the original code | **8 passed, 26 failed** of 34. Every failure is the bug; the 8 passes are behaviour that must stay | `evidence/b4late_old_code_checks.txt` |
| New test after implementation, first run | 32 passed, 2 failed (the timeout line written after the result; fixed with the owner's approval) | `evidence/b4late_new_code_checks_first.txt` |
| New test, final | **51 passed, 0 failed**, exit 0. 2.5 and 4.6 skipped on Linux | `evidence/b4late_new_code_checks_round3.txt` |
| Mutation check, round 1 (K1–K29) | 22/29 caught. K18 equivalent (accepted); K3, K8, K11, K16, K19 and K25 were test gaps | `evidence/b4late_mut.py`, `b4late_mut_run.txt` |
| Mutation check, round 2 (after six checks were added) | K3, K8, K11, K16, K19: **5/5 caught**. K25 needs Windows | `evidence/b4late_mut_round2_run.txt` |
| Mutation check, round 3 (after the second review's corrections) | K1, K6, K8, K21, K22, K23, K24, V1m, V2m, V3m, V5m: **11/11 caught** | `evidence/b4late_mut_round3_run.txt` |
| Mutation check, V1 against the queue's retry rule | V1q ("was stopped" removed from `control/actionQueue.ts`'s no-retry list): **1/1 caught**, by 5.1 ("2 attempt(s)") | `evidence/b4late_mut_round3b_run.txt` |
| Files restored after every mutation run | md5 OK; no test processes or temporary folders left; `control/actionQueue.ts` unchanged | the run files above |
| Typecheck | TC=0 | — |
| `git diff --check` | clean | — |
| Related tests (100 files: every test importing a changed file, plus the named ones) | **99 passed, 0 failed**, 1 skipped (`finalIntegrationSuiteTest`, live provider) | `evidence/b4late_related_list.txt`, `b4late_related_tests_round2.txt` |
| Full suite | **219 passed, 0 failed**, 0 timed out, **1 blocked**, **9 skipped**; exit 1 only because of the blocked test | `evidence/b4late_full_suite_round2.txt` |

Full suite, the blocked test:
- `realTtsHandoffTest`: needs a Python with pygame and websockets (JARVIS's `.venv`, or `JARVIS_TEST_PYTHON`). Neither is available here.

Full suite, the nine skipped tests:

| Test | Reason |
|---|---|
| `dashboardAccuracyTest` | needs a running Redis and a reachable LLM API |
| `dashboardHealthSystemTest` | needs Windows PowerShell, a reachable LLM API and Redis |
| `finalIntegrationSuiteTest` | live provider test (`pnpm test:live`) |
| `processControlSafetyTest` | needs the Windows process table |
| `startupPerformanceTest` | needs `JARVIS_BRIDGE_TOKEN` |
| `sttReliabilityTest` | needs the Python virtualenv (`.venv`) |
| `successfulExecutionLifecycleAuditTest` | live provider test (`pnpm test:live`) |
| `windowControlTest` | needs the Windows window manager |
| `windowsScriptsTest` | needs PowerShell 7 (`pwsh`) |

## Windows-only checks: VERIFIED on the owner's PC (2026-11-12)

Pushed as `2170458` with the owner's approval. On the owner's Windows 10 PC (build 19045), at `2170458`:
- TEMP and TMP were set to `%USERPROFILE%\.jarvis-test-tmp`;
- the test was run directly: `node node_modules\tsx\dist\cli.mjs tests\lateOutcomeB4Test.ts … < nul`.

| Check | Status | Result on the owner's PC |
|---|---|---|
| 2.5: a real `cmd.exe` command stopped by the action queue's 10 s timer gives "after 10 seconds" or "after 11 seconds", and the spoken sentence | **VERIFIED** | `PASS` (2 checks): "The command was stopped after 10 seconds; part of it may already have run."; said as "The command was stopped after 10 seconds, sir. Part of it may already have run, so please check before trying again." |
| 4.6: a real `cmd.exe` command cancelled after about 2 s gives "after 2 seconds" or "after 3 seconds" | **VERIFIED** | `PASS`: 2172 ms, "The command was stopped after 2 seconds; …" |
| Whole test on the real code | **VERIFIED** | **54 passed, 0 failed** (51 plus the 3 Windows-only checks) |
| K25: the fixed-10-seconds mutant is caught by 4.6 | **VERIFIED** | The fault was applied to `control/adminController.ts` (`git diff --stat`: 1 file, 1+/1−). Result: `FAIL: 4.6 … (2308 ms: … stopped after 10 seconds; …)`, **53 passed, 1 failed**. Then restored with `git checkout -- control\adminController.ts`; `git status` showed no tracked change |

## Windows CI on `2170458`: one test-only failure, fixed

| Job | Result |
|---|---|
| Linux (run 43174861848, two test runs) | **221 passed, 0 failed**, 8 skipped, both times; `lateOutcomeB4Test` PASS |
| Windows (job 131036536425) | **222 passed, 1 failed**, 6 skipped. `lateOutcomeB4Test`: 53 passed, 1 failed: `FAIL: 5.5 (V5) the comment "Spoken when the task is abandoned" sits directly above buildFailureVoiceMessage`. Every other B4 check passed there, 2.5 and 4.6 included |

**Cause:** check 5.5 reads `core/reflectionEngine.ts` as text and its patterns expected Unix line endings (`\n`). GitHub's Windows runner checks files out with Windows line endings (`\r\n`), so the pattern found no match. On the owner's PC the check passed, because that checkout uses Unix line endings. The second, "must not match" pattern of 5.5 had the same `\n`, so on Windows line endings it could never match. The production code was correct; only the test's text check was wrong.

**Fix (test only, owner's approval):** in `tests/lateOutcomeB4Test.ts`, check 5.5, the three `\n` in its two patterns became `\r?\n`. Nothing else changed.

**Verification.** Check 5.5's expressions were taken from the old test (`2170458`) and the new one, and run on `core/reflectionEngine.ts` with Unix (LF) and Windows (CRLF) line endings:

| Source | Old 5.5 | New 5.5 |
|---|---|---|
| LF, correct | PASS | PASS |
| CRLF, correct | **FAIL** (the CI failure, reproduced) | **PASS** |
| LF / CRLF, V5m (an extra comment inserted) | FAIL / FAIL | FAIL / FAIL (caught) |
| LF / CRLF, the original V5 defect (two stacked comments) | FAIL / FAIL | FAIL / FAIL (caught) |

The full B4 test then gave **51 passed, 0 failed**. Typecheck TC=0; `git diff --check` clean. The fix needs a push and a new Windows CI run to show green on Windows CI.

## Deviations from the plan

- **The timeout line before the result.** The first implementation returned the result before the `outcome_unknown` line was written, which made checks 1.4 fail. Reported, then fixed with the owner's approval: the line is written and awaited, for at most 2 s.
- **Goal class.** At first the goal runtime mapped the marker to the existing `interrupted` class, to stay inside the approved files. The owner then approved a dedicated `outcome_unknown` class in `core/goalLifecycle.ts`.
- **Audit-write failure checks (1.9) added.** They cover the owner's added requirement that an audit write never holds the call and never makes the result look recorded.
- **Windows check 2.5 setup.** It used `runShellCommand`, which asks for approval; nobody can answer in a test. It now uses the same approval stand-in as `tests/toolTimeoutTest.ts`, restored afterwards. Found before it ever ran.
- **Check 5.5 tightened.** Its first pattern could match across a second comment, so V5m survived. It now cannot cross a comment boundary.

## Known limits (recorded, not changed)

- **Background agents.** An agent's model decides for itself whether to call a tool again. The text it receives says only "It may still finish."; nothing in code stops a second call (`core/agents/behaviors/toolLoop.ts:84-94`).
- **Goal tasks run by an agent do not reach needs-review.** The agent's tool loop turns the failed call into a limitation (`core/agents/behaviors/toolLoop.ts:159`), and `core/goalExecutor.ts:194` returns `ok: true`. The needs-review routing applies when the attempt itself fails with the unknown-outcome text.
- **Process trees.** `taskkill /T` does not reach a process that detached from its tree.
- **The confirming review's informational notes (I1–I3)** are in `review.md`; none needed a change.

## Open from R3-1

R3-1 (`ai_workflows/runs/2026-11-08_approval-budget-b4-r31/`) remains open:
- On the owner's PC, `approvalBudgetR31Test` first stopped at the runner's 120 s limit, with no check failing.
- With a 600 s limit it took about 150 s and failed 2 checks in §2 ("close the browser" end to end: no question was asked within the test's 1.5 s budget).
- Run directly (2026-11-12), it passed **78/78**.
- Its §2 timing on a slow PC, its runtime against the 120 s limit, and its live checks are still open.
