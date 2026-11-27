# Change Log — diagnostics (phase A6: TRA-13, TRA-15)

Base commit: `82a1df5`. Owner's Gate 1, 2026-11-06:
- "Approve A6 (Recommended)", with the protected files `control/pcControlKernel.ts` and `core/toolRegistryV2.ts` (one listener call in `verifyResult`);
- Q1: "Every check that ran (Recommended)";
- Q2: "Drop them (Recommended)".

## The change

| File | Change |
|---|---|
| `control/pcControlKernel.ts` (protected) | Each action log line carries the request it belongs to (P1): `traceId` (the request trace's id) and `userCommand`, the owner's words cut to 160 characters. The log redacts keys, as before. Outside a request, `userCommand` is the action name and there is no `traceId`. Inside a background agent, `userCommand` is the agent's words and `agentPath` names the agent; there is no `traceId`, because the foreground request's id is not the agent's (review F1). `riskLevel` is the level the kernel computes ("safe" for a read, "high" below full control, "medium" in full control), not the fixed "medium" on a success and "high" on a failure. A successful change says `verified: "pending"`: the controller returned, and the effect may be checked afterwards. A later `verification` line gives the result, and no such line means it was not checked. A read never says it (review F2). A failure is `blocked` and not `allowed` when JARVIS refused it: a permission-level refusal (`isPermissionDenial()`, already in `control/permissionDenial.ts`, e.g. "Permission Level 2 required …"), "cancelled by user", "not approved", "was denied" (a dangerous shortcut), a safety rule ("Blocked by" or "Refused by safety policy", "Execution Blocked:" for a critical process), or a path outside the approved folders. Any other failure is `allowed` and `failure`, an OS refusal such as "EACCES: permission denied" or "Access is denied." included: JARVIS allowed the action and the OS refused it (review F6, F11, F15). A bare "cancelled" is not enough: "Chrome cancelled the download" is not a refusal (review F17). Before, every failure was "not allowed", and "Permission denied." was a "failure", because the check for "Denied" was case-sensitive. The fixed `rollbackAvailable` and `confirmationRequired` are gone (Q2). |
| `control/actionAuditLog.ts` | The entry type follows (`traceId`, `agentPath`, `verified`; without the two fixed fields). `logVerification()` writes a `verification` line: `traceId` (or `agentPath`), tool, status, evidence. |
| `core/toolRegistryV2.ts` (protected) | `onVerification(fn)`: every check of a call's effect that ran, verified or failed, is handed on with its evidence, redacted (Q1). A check that could not be done ("unverifiable") or a call without a check is not handed on. Nothing else changed. |
| `monitoring/traceWiring.ts` | Each check that ran goes to the request trace as `verification` (with the request's correlation id), and to the action log as a `verification` line with the same `traceId`. After a VERIFICATION_FAILED, the trace and the action log now agree. A check inside a background agent follows the action line's rule in the action log: `agentPath`, no foreground `traceId` (review F10). In the trace, its entry keeps the foreground correlation id, as an agent's `tool_call` entries already do; its data names the agent (review F16). |
| `tests/chromeHelper.ts`, `tests/jarvisChromeTest.ts` | The test helper ends Chrome's whole process tree on Windows: `taskkill /PID <pid> /T /F` (`treeKillCommand`, `endChrome`), with `proc.kill()` as the fallback if that fails. taskkill runs only while that Chrome is still running (`exitCode` and `signalCode` both unset): once it has exited, Windows may have given its process id to another program (review F12). The comment says the Windows cause is likely, not certain (review F13). `jarvisChromeTest` ends its real Chrome with `endChrome` too (review F4). Elsewhere `proc.kill()` is used as before. On Linux, Chrome's child processes already end with the parent: a probe found 9 processes while running and 0 after `stop()` (`evidence/a6_linux_chrome_probe.txt`, review F7). `monitoring/traceWiring.ts`'s header says what the `verification` entries hold (review F8). |

## Tests

| File | Change |
|---|---|
| `tests/diagnosticsA6Test.ts` (new) | 19 checks, then 29 after review round 1: inside an agent (F1); a read without `pending` (F2); the failure line, `allowed`, a permission refusal as `blocked` (F3, F6); a kernel action and its failed check end to end through `control_app` (F3); `endChrome` on Windows, with a failed taskkill, and elsewhere (F3). 37 after review round 2: an agent's check line through the registry (F10); six failure wordings, two OS refusals as `failure` and four JARVIS refusals as `blocked` (F11); an exited Chrome, by exit code and by signal, gets no taskkill (F12). 43 after review round 3: five more JARVIS refusal wordings as `blocked` (F15) and "Chrome cancelled the download" as `failure` (F17). The desktop controller and permission are stood in for, so the test is the same on Windows and Linux. Covered:<br>• the action log line: trace id, the request, `verified: "pending"`, the computed risk level, no fixed fields, outside a request, a key redacted, a long request cut short;<br>• checks: a passed and a failed check in the trace and the action log with the same trace id, and the evidence; a call without a check and an "unverifiable" check write nothing (the latter added when mutant M12 was missed);<br>• the helper's stop command: Windows ends the tree, elsewhere the process. |

## Evidence

| Check | Result | File |
|---|---|---|
| Windows CI before A6 (run 42212811009) | "Terminate orphan process … (chrome)" ×2 | `evidence/a6_ci_orphans_82a1df5.txt` |
| New test on the base code | 6 passed, **10 failed** (2 more checks need `treeKillCommand` and were skipped) | `evidence/a6_old_code_checks.txt` |
| New test after the change | **18/18**, then **19/19** with the "unverifiable" check | `evidence/a6_new_code_checks.txt` |
| Typecheck | `TC=0` | `evidence/a6_typecheck.txt` |
| Mutation check, 14 mutants | **13/14 caught** at first; M12 (an unverifiable check written as if it ran) was missed: the test had no such case. After the added check: caught, so **14/14**, tree restored (md5) | `evidence/a6_mut.py`, `a6_mut_run.txt`, `a6_mut_run_m12.txt` |
| Independent review, round 1 | CHANGES REQUIRED (F1 med; F2 low–med; F3–F6 low; F7–F9 info) | `review.md` |
| Round-1 checks on the round-1 code | 21 passed, **5 failed** (the end-to-end check passed: a gap in the test, not in the code) | `evidence/a6_review_r1_old_code_checks.txt` |
| Test after the round-1 fixes | **29/29** | `evidence/a6_review_r1_new_code_checks.txt` |
| Mutation check after round 1, 20 mutants (new M15–M20; M1, M3, M5 retargeted) | **20/20 caught**, tree restored (md5); the three retargeted because their lines changed | `evidence/a6_mut_run_r1.txt`, `a6_mut_run_r1b.txt`, `a6_mut_run_r2.txt` |
| Independent review, round 2 | CHANGES REQUIRED (F10–F12 med; F13 low; F14 info) | `review.md` |
| Round-2 checks on the round-1 code | 30 passed, **5 failed** | `evidence/a6_review_r2_old_code_checks.txt` |
| Test after the round-2 fixes | **37/37** (the two F11 wordings for "not approved" and "Access Denied: Path" were added with the fix, so that M26 and M27 have a check) | `evidence/a6_review_r2_new_code_checks.txt` |
| Typecheck after round 2 | `TC=0` | `evidence/a6_typecheck.txt` |
| Mutation check after round 2, 29 mutants (new M21–M29; M11 and M18 retargeted because their lines changed) | **29/29 caught**, tree restored (md5) | `evidence/a6_mut.py`, `a6_mut_run_r2.txt` |
| Related tests after round 2 | **27 passed, 0 failed**, 2 skipped (the same two) | `evidence/a6_related_tests_r2.txt` |
| Full suite after round 2 | **216 passed, 0 failed**, 1 blocked (no pygame), 9 skipped; exit 1 for the blocked test | `evidence/a6_full_suite_r2.txt` |
| Independent review, round 3 | CHANGES REQUIRED (F15 low–med; F16 low; F17, F18 info) | `review.md` |
| Round-3 checks on the round-2 code | 38 passed, **5 failed** | `evidence/a6_review_r3_old_code_checks.txt` |
| Test after the round-3 fixes | **43/43** | `evidence/a6_review_r3_new_code_checks.txt` |
| Typecheck after round 3 | `TC=0` | `evidence/a6_typecheck.txt` |
| Mutation check after round 3, 33 mutants (new M30–M33; M18, M23, M24, M25 retargeted because the rule's line changed) | **33/33 caught**, tree restored (md5). A `^Close cancelled:` branch was tried and dropped: its only wording also says "not approved", so no test could tell it was there | `evidence/a6_mut.py`, `a6_mut_run_r3.txt` |
| Related tests after round 3 | **27 passed, 0 failed**, 2 skipped (the same two) | `evidence/a6_related_tests_r3.txt` |
| Full suite after round 3 | **216 passed, 0 failed**, 1 blocked (no pygame), 9 skipped; exit 1 for the blocked test | `evidence/a6_full_suite_r3.txt` |
| Independent review, round 4 | **APPROVED** (F19 low, optional: recorded) | `review.md` |
| Related tests and full suite after round 1 | typecheck `TC=0`; related **27 passed, 0 failed**, 2 skipped; full suite **216 passed, 0 failed**, 1 blocked (no pygame), 9 skipped, exit 1 for the blocked test | `evidence/a6_related_tests_r1.txt`, `a6_full_suite_r1.txt` |
| Related tests (29: every test of the kernel, the action log, the trace, the registry's checks or the Chrome helper, and 7 more) | **27 passed, 0 failed**, 2 skipped (`finalIntegrationSuiteTest`: live provider test; `windowsScriptsTest`: needs PowerShell 7). Two earlier runs stopped on names that are not tests (`harness`, `runAll`) | `evidence/a6_related_tests.txt` |
| Full suite | **216 passed, 0 failed**, 1 blocked (no pygame), 9 skipped; exit 1 for the blocked test | `evidence/a6_full_suite.txt` |

## Deviations from the plan

- The failure line's risk level changed too: it was the fixed "high", and it is now the computed level ("medium" in full control).
- The plan said "a test of the helper's stop command on each OS". The test checks the command (`treeKillCommand`) for Windows and Linux. Whether the tree really ends on Windows is checked by Windows CI's orphan lines.

## Known limits (recorded, not changed)

- Only actions that go through the kernel are in the action log. A `verification` line is written for every tool with a check that ran, so the action log can have a check line without a matching action line (for example `open_app`, which does not go through the kernel).
- Two calls of the same tool in one request get two `verification` lines with the same `traceId`; they are told apart by time only.
- `riskLevel` follows the permission level, not the action's own risk from the catalog.
- That no Chrome is left running on Windows can only be confirmed by Windows CI after a push.
- A check that ends after the next request has begun (up to 60 s on Windows) is written with that request's trace id (review F1).
- When test Chrome has already exited, `taskkill` cannot reach its children through the root process (review F5).
- The test runner kills a test that runs past its limit without its Chrome (review F4).
- A `stop()` changed back to `proc.kill()` would not be caught by a test: only `endChrome` is tested (review F3 a).
- `normalizedIntent` is still the action name (review F6).
- `tests/secretSinksTest.ts` still passes `confirmationRequired: false` (behind `as any`); harmless (review F9).
- Agent scope comes from AsyncLocalStorage, so a callback fired from agent code carries it. A foreground listener that called the kernel from an agent event would be logged as the agent. The reviewer found no such path for kernel actions (review F14).
- A refusal worded in a way none of the blocked rules know is logged as an allowed `failure` (review F11, F15). The rule matches wordings, so a new refusal needs its wording added.
- "Execution queue is PAUSED …" is logged as an allowed `failure`: it is a hold, not a refusal (review F18).
- `Service name "…" rejected by policy: …` (`adminController.ts:27`) is logged as an allowed `failure`. It is closer to bad input than to a refusal, so it was left as it is (review F19).

## After the push: CI and the owner's PC (2026-11-06)

Commit `d2805dc`, pushed with the owner's approval. CI run 42229757312 passed in every job that ran:

| Job | Result |
|---|---|
| python-checks | passed |
| build-and-test (Linux) | passed. The suite ran twice (test step and coverage step), both times **218 passed, 0 failed**, 0 blocked, 8 skipped; `diagnosticsA6Test` and `jarvisChromeTest` passed |
| windows | passed. **220 passed, 0 failed**, 0 blocked, 6 skipped; `diagnosticsA6Test` and `jarvisChromeTest` passed |
| live-providers | skipped (needs API keys) |

TRA-15 on Windows CI: the cleanup step printed `Cleaning up orphan processes` and **no** `Terminate orphan process … (chrome)` line. Run 42212811009, before A6, had two (`evidence/a6_ci_orphans_82a1df5.txt`). This is one run, so a rare leak is not ruled out.

`scenarioIntegrationTest` (46.2 s) and `browserControlAgentTest` (14.3 s) passed on Windows in this run. Both stay recorded as unresolved Windows CI timing issues.

On the owner's PC (Windows), at `d2805dc`:

| Check | Result |
|---|---|
| `diagnosticsA6Test`, `jarvisChromeTest` | **2 passed, 0 failed** |
| A failed action, typed "focus notepad" with Notepad closed | **Pass.** One action line: `"userCommand":"focus notepad"`, a `traceId`, `riskLevel` "high", `"allowed":true`, `"result":"failure"`, the error, and no `verified`, `rollbackAvailable` or `confirmationRequired`. Lines written before A6 (10:25 UTC) show the old form: the action name as the command, no trace id, a fixed "medium" and `rollbackAvailable: true` |
| A checked action, "focus notepad" spoken with Notepad open | **Pass.** An action line with `"result":"success"`, `"verified":"pending"`, then a `verification` line with the same `traceId` (`trace_mw51u9bb_fjh5xi`), `"tool":"control_app"`, `"status":"verified"`, `"evidence":"notepad is in front"`. Notepad came to the front |
| Test Chrome left running | **0**. After `jarvisChromeTest` passed again, no `chrome.exe` had `jarvis-test-tmp` in its command line. The owner's own Chrome stayed open: the first count by `tasklist` (24 processes before, 23 after) could not tell the two apart. This count was not shown to find a leftover, so Windows CI's cleanup step is the main evidence |

Seen in the same PC logs, not caused by A6 (recorded as open, not changed):
- With Notepad closed, JARVIS said "I encountered an unexpected error and have been unable to complete the task, sir. No running window found for app "notepad"." The cause is right; "unexpected error" is not.
- Gemini timed out twice on one request (20 s each; 54.6 s in all).
- The open follow-up microphone turned speech into requests ("ok thanks", "close jar", "thank you jar"). "close jar" waited too long and was dropped.
- `Speaking timeout (12000ms) … TTS speaking_end was never received` at startup, after the wake word interrupted the greeting.

Status: A6 is complete in the cloud, passed Windows and Linux CI, and is verified on the owner's PC.
