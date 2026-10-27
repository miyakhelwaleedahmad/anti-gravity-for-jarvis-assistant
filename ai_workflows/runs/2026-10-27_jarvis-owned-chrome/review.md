# Review — JARVIS-owned Chrome and "close the browser" (phase A2)

Reviewer: a separate agent session (general-purpose), read-only, tests through the runner only. Not a human.

## Round 1 — CHANGES REQUIRED

The reviewer ran: `tsc --noEmit` (0 errors), `jarvisChromeTest` (pass, real-Chromium section included), 15 DO_NOT_BREAK and related tests (pass), and pure-regex checks for R6 and R7.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| R1 | high | `control_app open` (offered on every launch request) still opened `chrome` and URLs with the platform opener: the everyday Chrome or the default browser | **Fixed**: `appController.openApp` sends `chrome` and web addresses to `showInJarvisChrome`; test and mutant M15 |
| R2 | med | `cdpPort()` trusts the profile file without checking the browser path, and falls back to 9222 for the read and tab tools | **Deferred to A4** (safe targeting). Pre-existing 9222 default; an owner who still starts Chrome on 9222 by hand relies on it. Documented under "Limits" in BROWSER_CONTROL.md |
| R3 | med | The confirmation runs inside the tool's 15 s (+5 s) budget; a "yes" after the timeout still closed Chrome after JARVIS had said it did not | **Fixed**: the abort signal goes skill → kernel → `closeBrowser`; an answer after it is aborted closes nothing ("the request had already ended"); test and mutant M16. The double question under `JARVIS_LEVEL2_POLICY=ask` is the same as A1's and is not changed |
| R4 | med | Orchestrator wiring (`close_browser` route, Q2 reply) untested | **Fixed**: `taskFailureHonestyTest` §1b drives the real orchestrator: right tool and action, success text only on success, the Q2 reply with the fix |
| R5 | med | Protected files changed beyond the plan: the `open_app` spoken-failure change in `orchestrator.ts`; "close the google chrome" in `deterministicRoutes.ts` | Phrase **reverted**. The orchestrator change is kept: it is how Q2 ("say why") is spoken. Recorded as a deviation for the owner to approve |
| R6 | low | Only the first sentence of a failure was spoken; the fix was left out | **Fixed**: `ChromeNotAvailableError.spoken` (cause and fix, under 120 characters), carried in open_app's JSON and spoken by the orchestrator |
| R7 | low | The close check took the first "(port N no longer answers)", which a tab title can contain | **Fixed**: anchored to the end of the reply; test and mutant M17 |
| R8 | low | `close()` did not re-check which browser answers; its connect failures were retried (asking again) | **Fixed**: `running()` gives port and browser path; `close()` refuses a different browser and words its failures as final; test and mutant M18 |
| R9 | low | A cold start left a blank tab next to the page | **Fixed**: the lone `about:blank` of a just-started Chrome is closed after the page opens; test |
| R10 | low | Race between check and start; busy Chrome (>2 s) counted as not running | Race **fixed** (one pending check-and-start); the busy-Chrome case is not changed (recorded) |
| R11 | low | `/json/activate` may not raise the window on Windows; verifier wording | Wording **fixed** ("has the tab"); window raising is an owner PC check |
| R12 | low | Earlier docs named `W:\jarvis-chrome-profile`; migration | **Fixed** in `.env.example` and BROWSER_CONTROL.md (`JARVIS_CHROME_PROFILE`, `JARVIS_CDP_PORT=9222`) |
| R13 | low | "Never touched" claims too strong (Ctrl+W / Ctrl+R fallbacks) | **Fixed**: wording softened; the fallbacks are listed under "Limits" (A4/A5) |
| R14 | low | "close notepad and chrome" no longer offers `control_app` | **Deferred to A3** (mixed requests), as A1 deferred "close notepad and the youtube tab" |
| R15 | low | Test gaps; one label stronger than its assertion | **Fixed**: the assertion checks the fix text; tests for R1, R3, R7, R8, R9, R17 added |
| R16 | low | Records incomplete (full-suite file read while it was still being written; no verification.md; tracker path) | **Fixed** in the records written after this review |
| R17 | low | "A window is already open" also said when Chrome could not run or crashed; a spawn that throws was not a ChromeNotAvailableError | **Fixed**: separate messages for could-not-run (spawn throws or ENOENT), non-zero exit, and exit 0 (profile in use); tests |

Security note from the reviewer (no blocker): spawn uses an argument array with `shell: false` and the filtered environment. Accepted risk: JARVIS's Chrome keeps the owner's sign-ins behind a loopback DevTools port without a password. Now stated in `.env.example` and BROWSER_CONTROL.md.

## Round 2 — CHANGES REQUIRED

The reviewer ran `tsc --noEmit` (0 errors) and 18 related test files through the runner (all pass). Round 1: R1, R4, R6–R13, R15, R17 fixed; R2, R14 deferred acceptably; R3 still open (below); R5, R16 open in the records.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| R2-1 | high | The kernel passed `either(toolSignal, queueSignal)`: the action queue's default 10 s timeout aborted it, so a "yes" given more than 10 s after the tool started was refused | **Fixed**: only the tool's own signal (the sandbox budget) is passed; a test checks the kernel hands over exactly that signal; mutant M19 |
| R2-2 | med (records) | `control/pcControlKernel.ts` is a protected file (RUNTIME_PROTECTED_FILES.md, PC Control); the plan listed it under "Others" | **Recorded** in change_log.md as a deviation for the owner to approve |
| R2-3 | low (records) | change_log.md out of date (removed phrase listed; appController and round-2 changes missing; orchestrator deviation not under Deviations) | **Fixed** |
| R2-4 | low | `control_app open` with the full path to chrome.exe still used the platform opener | **Fixed**: the last path segment is matched; test; mutant M20 |
| R2-5 | low (docs) | BROWSER_CONTROL.md overclaimed for `cdpPort()` and omitted `control_app open` | **Fixed** |

## Round 3 — PASS

The reviewer ran `tsc --noEmit` (0 errors) and 8 targeted test files through the runner (all pass); no new defects. R2-1, R2-2, R2-3, R2-4, R2-5 fixed. Two record items:

- R3-1: the "question inside the tool's time budget" limit (an answer after about 15–20 s is refused, or comes after JARVIS reported a timeout; also A1's questions) gets its own line under B4 in the tracker; the owner's PC check says to answer "close the browser" within about 15 s. **Done at closure.**
- R3-2: verification, final report and closure records, and the complete full-suite output, are written after the suite finishes. **Done in stages 05–07.**

## Round 4 (named-browser fix, owner request) — PASS

The reviewer ran `tsc --noEmit` (0 errors) and 11 targeted test files (all pass), and traced every path (voice routes, open_app, control_app, isAppOpen, restartApp, closeApp, the planner): nothing named Edge or Firefox reaches JARVIS's Chrome; no security or DO_NOT_BREAK regression.

| ID | Sev. | Finding | Outcome |
|---|---|---|---|
| R4-1 | low | The new aliases had positive tests only; ai_workflows/CLAUDE.md asks for security-boundary tests when aliases are broadened | **Fixed**: "launch microsoft edge /c del *", "open google chrome & calc", "open mozilla firefox; del *" and similar give no browser route |
| R4-2 | low (records) | `evidence/typecheck.txt` read while being rewritten; change_log/review silent on this change | typecheck.txt says `TC=0` after the run; records **added** (change_log, this section) |
| R4-3 | info | A page asked for "in Edge" still opens in JARVIS's Chrome (D1) | **Documented** in BROWSER_CONTROL.md |

