# Verification — safe tab targeting (phase A4)

Cloud machine: Linux, Node 22, a headless Chromium (used by `browserControlAgentTest`), no PowerShell 7, no pygame. The owner's PC and Windows not observed.

| Check | Result | Evidence |
|---|---|---|
| tabTargetingA4Test on the code before the change | 15 passed, **37 failed** | `evidence/old_code_checks.txt` |
| tabTargetingA4Test after (before review) | **55 passed, 0 failed**: 52 checks written first; 2 queue-retry checks added during implementation; 1 controller-level check added after the mutation check | `evidence/new_code_checks.txt` |
| Related tests (34, including the DO_NOT_BREAK set, `browserControlAgentTest` on a real headless Chromium, `jarvisChromeTest`, `routeGoldenTest`, `routingA3Test`, `riskEngineTest`) | 33 passed, 1 failed (`browserControlTest` check 4, an intended change; see change_log.md) → passes after the change | `evidence/related_tests.txt`, `evidence/related_tests_after.txt` |
| Typecheck | 0 errors | `evidence/typecheck.txt` |
| Full suite | **207 passed, 0 failed**, 1 blocked (realTtsHandoffTest: no pygame), 9 skipped | `evidence/full_suite.txt` |
| DO_NOT_BREAK set | all PASS | `evidence/full_suite.txt` |
| Mutation check (14 mutants: the audit's MB, MD, ME and 11 of this plan) | 13/14 on the first run; M14 (the controller's own level for an empty name) was missed because the risk engine refuses first; a direct controller check was added → **14/14 caught**; tree restored (checksums and diff stat unchanged) | `evidence/a4_mut.py`, `evidence/a4_mut_run.txt`, `evidence/a4_mut_run_m14.txt` |
| The 9222 case | ran (port 9222 was free on this machine) | `evidence/new_code_checks.txt` |
| Independent review, round 1 | CHANGES REQUIRED (R1 high, R2–R3 med, R4–R9 low, R10–R11 info) | `review.md` |
| New checks for R1–R10 on the code before those fixes | 58 passed, **11 failed** (R10 already passed: redacted later on the way to the reply) | `evidence/review_r1_old_code_checks.txt` |
| tabTargetingA4Test after the round-1 fixes | **71 passed, 0 failed** | `evidence/review_r1_new_code_checks.txt` |
| Related tests after the round-1 fixes (34) | **34 passed** | `evidence/review_related_tests.txt` |
| Mutation check after the round-1 fixes (23 mutants) | 22/23; M6 became a second layer; a direct test was added, then M6 was caught → **23/23**; tree restored | `evidence/a4_mut_run_review.txt`, `evidence/a4_mut_run_m6.txt` |
| Typecheck and full suite after the round-1 fixes | typecheck 0 errors; **207 passed, 0 failed**, 1 blocked (no pygame), 9 skipped; DO_NOT_BREAK all PASS | `evidence/typecheck_review.txt`, `evidence/full_suite_review.txt` |
| Independent review, round 2 | CHANGES REQUIRED (R12 med: pause chose the oldest video tab; R13–R14 records; R15–R17 info) | `review.md` |
| R12 check on the code before the fix | 71 passed, **1 failed** | `evidence/review_r2_old_code_checks.txt` |
| tabTargetingA4Test after the R12 fix | **72 passed, 0 failed** | `evidence/review_r2_new_code_checks.txt` |
| Related tests after the R12 fix (14, YouTube play and DO_NOT_BREAK included) | **14 passed**; typecheck 0 errors | `evidence/review_r2_related_tests.txt`, `evidence/typecheck_review2.txt` |
| Mutation M24 (R12) | caught | `evidence/a4_mut_run_m24.txt` |
| Full suite after the R12 fix | **207 passed, 0 failed**, 1 blocked (realTtsHandoffTest: no pygame), 9 skipped; DO_NOT_BREAK all PASS | `evidence/full_suite_review2.txt` |
| tabRouteReplyA4Test (spoken route replies) on the code before the orchestrator change | 6 passed, **7 failed** | `evidence/route_reply_old_code_checks.txt` |
| tabRouteReplyA4Test after | **13 passed, 0 failed** | `evidence/route_reply_new_code_checks.txt` |
| Mutation check, all 27 mutants (A4, review rounds 1–2, spoken replies) | **27/27 caught**; tree restored | `evidence/a4_mut_run_final.txt` |
| Typecheck and full suite after the orchestrator change | typecheck 0 errors; **208 passed, 0 failed**, 1 blocked (realTtsHandoffTest: no pygame), 9 skipped; DO_NOT_BREAK all PASS | `evidence/typecheck_review3.txt`, `evidence/full_suite_review3.txt` |
| Independent review, round 3 (R12 and the orchestrator change) | **PASS** (R18 low, fixed; R19–R20 info) | `review.md` |
| R18 checks on the code before the fix | `tabRouteReplyA4Test` 15 passed, **2 failed** | `evidence/review_r3_old_code_checks.txt` |
| tabRouteReplyA4Test after the R18 fix | **17 passed, 0 failed**; M27, M28 caught | `evidence/review_r3_new_code_checks.txt`, `evidence/a4_mut_run_m28.txt` |
| Final typecheck and full suite (after R18) | typecheck 0 errors; **208 passed, 0 failed**, 1 blocked (realTtsHandoffTest: no pygame), 9 skipped; DO_NOT_BREAK all PASS | `evidence/typecheck_final.txt`, `evidence/full_suite_final.txt` |

## Spoken replies on the fast routes (probe, fake Chrome)

`evidence/spoken_probe.mts` records what JARVIS says (captured, not played). Before the orchestrator change: `evidence/spoken_probe.txt`. After: `evidence/spoken_probe_after.txt`.

| Case | Typed | Said before | Said now | Tabs after |
|---|---|---|---|---|
| 1 one YouTube tab | close youtube tab | Closing the youtube tab, sir. | same | Gmail |
| 2 Chrome takes 0.6 s | close the youtube tab | Closing the youtube tab, sir. (no "still open") | same | Gmail |
| 3 two YouTube tabs, neither on screen | close youtube tab | I tried to close the tab "youtube" but encountered an issue, sir. Which tab, sir? … | **Which tab, sir? 2 match "youtube": "YouTube", "lofi beats YouTube".** | all three |
| 4 the last tab | close youtube tab | Closing the youtube tab, sir. | same | a blank tab (Chrome open) |
| 5 Chrome not running | close youtube tab | I tried to close the tab "youtube" but encountered an issue, sir. | **My Chrome is not running, sir, so I did not change any tab.** | — |
| 6 full control off | close this tab | That needs full control mode, sir. … | same | Gmail |
| 7 full control on | close this tab | Closing current tab, sir. | same | YouTube |
| 8 none on screen | close this tab | I tried to close the current tab but encountered an issue, sir. No tab is on screen … | **No tab is on screen (is Chrome minimised?). Which tab, sir: "Inbox Gmail", "YouTube".** | both |
| 9 "youtube" matches only a sign-in page | close youtube tab | That needs full control mode, sir. … | same | the sign-in page |

## Owner's PC test plan (after a push the owner approves)

Shell: CMD, in the JARVIS folder. Mute the microphone first (echo, Voice item). Type commands only when JARVIS is idle (N-PC2). Full control is off unless a step says otherwise.

| # | Do | Expected |
|---|---|---|
| 0 | `git pull origin claude/jarvis-repair`, then `pnpm test -- --only=tabTargetingA4Test,tabRouteReplyA4Test,browserControlTest,jarvisChromeTest,routingA3Test,routeGoldenTest` | all `PASS`; `6 passed · 0 failed` |
| 1 | `pnpm run dev`; type `open youtube` | YouTube opens in JARVIS's Chrome |
| 2 | type `open youtube` again | no second YouTube tab; the same tab comes to the front (Q3) |
| 3 | type `close youtube tab` | "Closing the youtube tab, sir."; the tab closes; **no** "the tab is still open" (N-PC4). It was the last tab, so JARVIS's Chrome stays open on a blank tab (Q4, N-PC8) |
| 4 | type `open youtube`, then click a video so that tab shows `youtube.com/watch…`; type `open youtube` | the video tab comes to the front, no new tab |
| 5 | in JARVIS's Chrome, open a second YouTube tab yourself (Ctrl+T, youtube.com) and stay on it; type `close youtube tab` | the YouTube tab **on screen** closes; the other stays |
| 6 | open a second YouTube tab again; switch to a non-YouTube tab in that Chrome (or open one: Ctrl+T, example.com); type `close youtube tab` | nothing closes; JARVIS says only "Which tab, sir? 2 match "youtube": …", naming both (Q1); no "encountered an issue" |
| 7 | minimise JARVIS's Chrome; type `close this tab` with full control **off** | "That needs full control mode, sir. …"; nothing closes |
| 8 | `enable full control mode`, `yes`; restore Chrome and stay on a non-YouTube tab; type `close this tab` | "Closing current tab, sir."; only that tab closes |
| 9 | full control still on; minimise JARVIS's Chrome; type `close this tab` | nothing closes; JARVIS says "No tab is on screen (is Chrome minimised?). Which tab, sir: …"; no "encountered an issue" |
| 10 | full control on; in JARVIS's Chrome open github.com; type `close the github tab` | an approval box ("Close sensitive tab"); type `no` → nothing closes |
| 11 | close JARVIS's Chrome window yourself (X); type `close youtube tab` | "My Chrome is not running, sir, so I did not change any tab."; nothing pressed in any other window (watch your everyday Chrome: no tab closes) |
| 12 | full control on; your everyday Chrome open and in front, JARVIS's Chrome closed: type `close current tab` | your everyday Chrome's tab does **not** close (no Ctrl+W) |

## Not verified

- On the owner's PC: all of the plan above.
- Real Chrome on Windows: how long `/json/close` takes on the owner's PC (the check waits up to 2 s), and whether Windows Chrome reports `visibilityState` "hidden" for a minimised window as the fake does.
- Windows CI: after the owner approves a push.
