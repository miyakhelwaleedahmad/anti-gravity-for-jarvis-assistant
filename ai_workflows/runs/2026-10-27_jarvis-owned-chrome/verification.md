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

## Owner requirement after review: a named browser opens that browser (2026-10-27)

"Open Microsoft Edge" / "open Firefox" must open that browser; only generic "open browser" (and "open chrome", owner answer Q1) use JARVIS's Chrome. Checks added to `tests/jarvisChromeTest.ts` (now **108 passed, 0 failed**, `evidence/new_code_run.txt`):

| Request | Path | Result |
|---|---|---|
| "open edge", "launch edge" | route `open_app edge` → `msedge.exe` → platform opener | PASS: msedge.exe started, no JARVIS Chrome tab |
| "open firefox", "open firefox for me" | route `open_app firefox` → `firefox.exe` | PASS |
| `open_app "microsoft edge"` (how the planner may call it) | allow-list → `msedge.exe` | PASS |
| `control_app open` "firefox", "edge", "msedge" | platform opener with that name | PASS (no JARVIS Chrome) |
| "open browser", "open the browser", "open chrome" | route `open_app chrome` → JARVIS's Chrome | PASS |

Mutants M21 (open_app sends Edge/Firefox to JARVIS's Chrome) and M22 (control_app sends Firefox there): 2/2 caught (`evidence/mutation_run_named_browsers.txt`).

Gaps found then, **fixed on the owner's request** (same day, `change_log.md` last section):
- "open Microsoft Edge" / "open Mozilla Firefox" had no deterministic route, and `open_app "mozilla firefox"` was refused → now routes and allow-list entries.
- `control_app open "edge"` handed Windows the name `edge` → now `msedge.exe` (and `firefox.exe`).

Fix verification: before the fix 108 passed, 12 failed (`evidence/named_browsers_before_fix.txt`); after it, with the security-boundary checks of review R4-1, **129 passed, 0 failed** (`evidence/new_code_run.txt`). Mutants M21–M28: 8/8 caught. Typecheck 0 errors; full suite on the fix **202 passed, 0 failed**, 1 blocked (pygame), 9 skipped (`evidence/full_suite.txt`; the boundary checks were added to the test file after that run and the test was re-run: 129/129). Review round 4: PASS.

## Not verified here

- Windows: chrome.exe locations, `%USERPROFILE%` profile, detached start, `DevToolsActivePort` with Windows Chrome, whether `/json/activate` brings the window forward (review R11).
- Live voice on the owner's PC: the checks in `final_report.md`.
- Windows CI: after the owner approves the push.
