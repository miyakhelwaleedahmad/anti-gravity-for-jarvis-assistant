# Verification — JARVIS-owned Chrome and "close the browser" (phase A2)

Cloud machine: Linux, Node 22, Chromium 141 (`/opt/pw-browsers/chromium`), no PowerShell 7, no pygame. Windows and the owner's PC not observed.

## Results

| Check | Result | Evidence |
|---|---|---|
| New test on the old code (before any runtime change) | 14 passed, **44 failed**; no real opener ran (guard recorded `xdg-open https://www.youtube.com`, `xdg-open chrome.exe`) | `evidence/old_code_run.txt` |
| New test on the final code | **96 passed, 0 failed**, real-Chromium section included (start with port 0, profile file, reuse, open, close, exit 0) | `evidence/new_code_run.txt` |
| Typecheck `tsc --noEmit` | 0 errors | `evidence/typecheck.txt` |
| Full suite `pnpm test -- --ci` (final code) | **202 passed, 0 failed**, 0 timed out, 1 blocked (realTtsHandoffTest: no pygame), 9 skipped (Windows, Redis/LLM, live, venv, pwsh). Runner exit 1 is for the blocked test, as on every cloud run | `evidence/full_suite.txt` |
| DO_NOT_BREAK set (nodeBridgeSingleton, voiceRouteMock, interruptGating, openAppSmoke, latencySmoke, deterministicCommandRoute) | all PASS in the full suite | `evidence/full_suite.txt` |
| Mutation check, first harness (14 mutants) | 14/14 caught | evidence of round 1 superseded by the run below |
| Mutation check after review round 1 (18 mutants) | 17/18; M4 equivalent after fix R1 (its fallback now goes through `appController.openApp`, which also uses JARVIS's Chrome); M4b (direct platform-opener fallback) caught | `evidence/mutation_run.txt`, `evidence/mutation_run_m4b.txt` |
| Mutation check after review round 2 (M15, M16, M19, M20) | 4/4 caught | `evidence/mutation_run_round2.txt` |
| Tree restored after every mutation run | yes (`git diff` identical before and after) | — |
| Independent review | round 1 CHANGES REQUIRED (17 findings), round 2 CHANGES REQUIRED (5), **round 3 PASS** | `review.md` |

Earlier full-suite runs during the work: 200 passed / 2 failed (plannerDecisionAuditTest and taskFailureHonestyTest expected "close chrome" to reach the app/process tools; updated to D3), then 202 passed / 0 failed before review; a run started on the round-1 code was stopped when round-2 fixes began, and its output was replaced.

## Not verified here

- Windows: chrome.exe locations, `%USERPROFILE%` profile, detached start, `DevToolsActivePort` with Windows Chrome, whether `/json/activate` brings the window forward (review R11).
- Live voice on the owner's PC: the checks in `final_report.md`.
- Windows CI: after the owner approves the push.
