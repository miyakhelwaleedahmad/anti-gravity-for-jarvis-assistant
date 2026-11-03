# Change Log — honest capability, sub-phase A5a (read tools, TRA-07)

Base commit: `62f0a99`. Owner's Gate 1 for A5a, 2026-11-03:
- "Approve A5a (Recommended)", with the protected file `core/orchestrator.ts`;
- Q1: "Say so, don't start it (Recommended)";
- Q2: "Read Chrome live (Recommended)".

## The change

| File | Change |
|---|---|
| `perception/windowsState.ts` | A window list that could not be read now carries `unavailable: <reason>` with its empty lists: a failed poll, an empty PowerShell answer, a failed fresh read for an action, or not read yet. Nothing else changes: an action still never gets a stale list (the `windowsStateFreshnessTest` rule). |
| `perception/systemStateObserver.ts` | The snapshot keeps that reason (`windowsUnavailable`). It starts as "not read yet". |
| `perception/readTools.ts` (new) | `readFailure(error, spoken)`: a read tool's failure as JSON `{ success:false, error, spoken }`, which the registry already reads as a failure. `windowsFailure(state)`. `liveTabList()`: every tab of JARVIS's Chrome by title and address, in one DevTools call with no limit (for `is_tab_open`). `liveTabs()`: the same with per-tab details (the tab on screen) for the first 20, then the rest by title and address, redacted alike (for `get_browser_tabs`). JARVIS's Chrome is found the A4 way: `jarvisChrome.running()`, meaning the owner's `JARVIS_CDP_PORT` or the Chrome that matches JARVIS's profile, never a stale file or a guessed 9222. Nothing is started (Q1). With `JARVIS_CDP_PORT` set and nothing answering, the reason names it (review R6). |
| `skills/get_open_apps`, `get_active_window`, `is_app_open` | When the window list was not read: a failure with the reason ("I can't read the open windows right now, sir."), not `[]`, an empty window or `"false"`. |
| `skills/is_tab_open`, `get_browser_tabs` | Read JARVIS's Chrome live (Q2), not the 12 s snapshot. Chrome not running: a failure, "My Chrome is not running, sir, so I can't see its tabs." Chrome running but its list fails: a failure, "I could not read my Chrome's tabs, sir." Really no tabs: `[]` and a success. |
| `core/worldState.ts` | The planner's world state says `apps: not readable (<reason>)` instead of `open: none` when the window list could not be read (review R4). |
| `core/orchestrator.ts` (protected) | Routes: `is_tab_open` says "No" only when Chrome was read; otherwise it says why. `get_browser_tabs` reads through the live tool, without the old fallback to stale snapshot tabs. `whats_running` says the windows could not be read, and still gives the servers' answer. 20 lines added, 15 removed. |

## Tests

| File | Change |
|---|---|
| `tests/honestReadToolsA5aTest.ts` (new) | 36 checks, with a fake DevTools server (HTTP only) and a stand-in PowerShell (session and fresh read), so it is the same on Windows and Linux (review R1). They cover:<br>- tab tools with Chrome down: failures with the reason;<br>- live tabs with Chrome up, against a stale snapshot that disagrees;<br>- really-empty stays a success;<br>- a failing tab list;<br>- the three routes' spoken replies, with no model call;<br>- window tools when the list cannot be read, with that read's reason;<br>- after review round 1: 22 tabs (the 22nd found and listed), a stale profile file and JARVIS's profile, `JARVIS_CDP_PORT` with nothing on it, the reasons of `is_app_open` / `get_active_window`, and the planner's world state;<br>- unchanged: an action never gets the stale list after a good reading; a read empty list is a success; an app in a read list is found; "whats running" lists it. |
| `tests/boundary-doubles.json` | An entry for the new test (`installFakeTts`). |
| `tests/scenarioIntegrationTest.ts` | One check, "from a real reading", looked for `browser_state`, which the route no longer calls. It now looks for the live `get_browser_tabs` (proved live in the new test §2; review R9). |

## Evidence

| Check | Result | File |
|---|---|---|
| New test on the base code (24 checks then) | 7 passed, **17 failed** | `evidence/a5a_old_code_checks.txt` |
| New test after the change | **26/26** (2 checks added after the change: the read's own reason; a failing tab list) | `evidence/a5a_new_code_checks.txt` |
| Related tests (28) | 27 passed, 1 failed (`scenarioIntegrationTest`, the "from a real reading" check; see Tests) → passes after the test change; final run **28/28** | `evidence/a5a_related_tests.txt`, `evidence/a5a_scenario_after.txt`, `evidence/a5a_related_tests_final.txt` |
| Typecheck | 0 errors | `evidence/a5a_typecheck.txt` |
| Mutation check, 11 mutants | **11/11 caught**; tree restored (md5 of the 9 changed source files) | `evidence/a5a_mut.py`, `evidence/a5a_mut_run.txt` |
| Full suite | **211 passed, 0 failed**, 1 blocked (realTtsHandoffTest: no pygame), 9 skipped | `evidence/a5a_full_suite.txt` |
| Independent review, round 1 | CHANGES REQUIRED (R1, R2 high; R3, R4 med; R5–R11 low; R12 info) | `review.md` |
| Review round 1 checks on that code (R2, R4, R6; the R1 rewrite already passes) | 30 passed, **4 failed** | `evidence/a5a_review_r1_old_code_checks.txt` |
| Test after the round-1 fixes | **36/36** (34, then 2 checks added when M12 was missed: `is_tab_open` touches no page; the page counter itself works) | `evidence/a5a_review_r1_new_code_checks.txt` |
| The same test with a stand-in `powershell` on PATH (the R1 failure scenario) | **passes** | `evidence/a5a_with_fake_powershell.txt` |
| After round 1: typecheck; mutation check, 15 mutants (M6–M8 retargeted, new M12–M15); related tests (29); full suite | typecheck 0 errors; **15/15 caught** (M12 missed at first, caught after the page-touch check), tree restored; **29 passed**; **211 passed, 0 failed**, 1 blocked (no pygame), 9 skipped | `evidence/a5a_typecheck.txt`, `a5a_mut_run_r1.txt`, `a5a_related_tests_r1.txt`, `a5a_full_suite_r1.txt` |

## Deviations from the plan

- P3 named `perception/chromeState.ts`. It was not changed: the tab tools no longer read the snapshot that `chromeState` fills, so it did not need to change.
- The plan said `windowsStateFreshnessTest` would change. It did not need to: an action still gets an empty list when the read fails. The new `unavailable` field only adds to that.
- Added during review: `core/worldState.ts` (R4).

## Known limits (recorded, not changed)

- Measured on headless Chrome by the reviewer: `is_tab_open` now takes about 3 ms (`listPages`). `get_browser_tabs` takes 50–120 ms for 20 tabs, and up to about 2 s when a tab is busy, as the old `browser_state` route did (R3).
- Right after JARVIS starts on Windows, "what's running" can say it can't read the windows until the first poll returns (R5).
- "Chrome not running" and "not read yet" still count as tool faults in the health ledger and issue store; that is for A5b (R7).
- Other places still turn an unread window list into an empty one: `get_pc_state` (`control/pcControlKernel.ts:128-131`), `windowController.listOpenWindows` / `getActiveWindow`, and closing apps and windows (they read only `openApps`). That is for A5c. "What is open" (`get_system_state`) ignores `windowsUnavailable` and reads tabs from the snapshot; that is for A5e (R11, R12).
- `browser_state`, `browser_read_page` and the other browser read tools still use `cdpPort()`, not JARVIS's checked port. They already fail honestly when Chrome is down. Moving them is for A5e.
- The tool descriptions still say `get_browser_tabs` returns "title, url, active" (R10, A5e).
- The window tools still read the snapshot (up to 8–10 s old) when it was read. Only an unread list changes.
- Between `get_browser_tabs`' two list calls, the count can be off by one: a tab closed in that gap still appears, and a newly opened tab is listed last. No tab that exists at both reads is lost (R15). A duplicate tab id would be listed twice; Chrome's ids are unique (R16).
- "Full suite green" is on Linux. Windows CI runs after a push.
