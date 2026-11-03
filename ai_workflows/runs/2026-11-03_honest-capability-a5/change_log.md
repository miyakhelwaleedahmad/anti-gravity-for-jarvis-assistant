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

---

# Change Log — sub-phase A5c (kernel: TRA-10 and the B1 item)

Base commit: `735c0a2`. Owner's Gate 1, 2026-11-03:
- "Approve A5c (Recommended)", with the protected file `control/pcControlKernel.ts`;
- Q1: "A failure: nothing closed";
- Q2 and Q3: "A failure with the reason".

## The change

The kernel counted any returned value as done. Controllers now **throw** a failure, with its reason, instead of returning it as text. The kernel already turned a thrown error into `success:false` and a "failure" line in the audit log.

| File | Change |
|---|---|
| `control/appController.ts` | `focusApp`: "Permission denied." and "No running window found for app …" are thrown. `focusApp`, close-app and the app list: an unread list is a failure with the reason (review C5). |
| `perception/windowsState.ts` | `openAppsOrWhy(state)`: the open windows, or a failure with the reason when they were not read. It is shared by the app and window controllers (review C5). |
| `control/actionQueue.ts` | The final (not retried) failures add "could not be read", "is not open, so nothing was closed" and "No running window found". A retry cost another long read, could run into the queue's 10 s limit and lost the reason (review C4). |
| `skills/get_pc_state/skill.ts` | On failure it returns the kernel's result (with the reason), not its empty message (review C2). |
| `control/windowController.ts` | `focusWindow`: "Permission denied." is thrown, and errors are no longer caught and returned as text. A list that was not read (A5a's `unavailable`) is a failure with the reason, not "none" or "not found" (Q3). That covers `listOpenWindows`, `getActiveWindow`, the window search `findHwnd` (used by focus, minimize, maximize, move, resize) and close by name (review C5). |
| `control/browserController.ts` | `listTabs`: "Permission denied." is thrown, and errors are no longer returned as text. `closeTab`: a tab that is not open is a failure, "… is not open, so nothing was closed." (Q1). |
| `control/systemController.ts` | PowerShell comes through an injectable dependency (as in `processController`). Disk and startup lists: PowerShell's non-zero exit, or PowerShell not starting, is a failure with the reason (Q2). They used to be an empty answer or `{"error"}`, both counted as success. Exit 0 with nothing printed is `[]` (really empty). |
| `control/processController.ts` | `listProcesses`: a failed or empty PowerShell answer is a failure with the reason, not `[]` (Q2). Its PowerShell runner says why PowerShell could not start (review C6). |
| `control/fileController.ts` | `readFile`: the secret-file refusal and a failed read are thrown, not returned as the file's "contents". |
| `control/pcControlKernel.ts` (protected) | `reportedFailureOf`: a returned JSON object with `success:false` or a top-level `error` is a failure with that reason. Plain text and lists are not judged, so nothing is guessed from words. Someone else's data is passed through unjudged (`passThrough`): a file's contents, command and PowerShell output, the service, battery, disk and startup reads (review C3). `getPcState`: an unread window list is a failure (Q3). |

## Tests

| File | Change |
|---|---|
| `tests/kernelOutcomeA5cTest.ts` (new) | 40 checks, with every dependency stood in (windows, PowerShell, Chrome, permission), so it is the same on Windows and Linux. Each failure path above is checked through the kernel. The kernel's own JSON rule: `{error}`, `{success:false}`, a list, plain text. The planner's tool (`control_app`) and the audit log. Unchanged: actions that did happen, and read lists, stay successes. |
| `tests/appControlTest.ts`, `browserControlTest.ts`, `fileControlSafetyTest.ts`, `systemControlSafetyTest.ts` | After review rounds 1–2: `appControlTest`'s `focusApp` must succeed on Windows unless a full window read has no Notepad (C8, C12), and its `listApps` lists the apps or, off Windows, fails with "could not be read" (the C5 change made it throw here). The tab-list failure must name Chrome (C8). Each asserted the old contract, "resolves without throwing" or "a missing file does not throw", which is the TRA-10 behaviour. Each now asserts "does it, or fails with its reason". On the base code these pass; with A5c they failed until changed (`evidence/a5c_related_base.txt`). |
| `tests/filesAndDevToolsTest.ts`, `tests/secretFileTest.ts`, `tests/windowControlTest.ts` | Called a controller directly and read a refusal or "not found" from the returned text. They now read the thrown message. The meaning is the same. `windowControlTest` runs only on Windows, so this was found by the review (C1). |

## Evidence

| Check | Result | File |
|---|---|---|
| New test on the base code | 10 passed, **20 failed** | `evidence/a5c_old_code_checks.txt` |
| New test after the change | **31/31** (30, then 1 check added when M16 was missed: a list returned as itself, not as text) | `evidence/a5c_new_code_checks.txt` |
| The 5 old-contract tests on the base code / with A5c / after their update | pass / **5 fail** / **6 pass** (with `secretFileTest`) | `evidence/a5c_related_base.txt`, `evidence/a5c_related_tests.txt` (first run), `evidence/a5c_updated_tests.txt` |
| Typecheck | 0 errors. The first run had 4 errors in the updated old tests (their `ok()` takes 2 arguments); fixed | `evidence/a5c_typecheck.txt` |
| Mutation check, 16 mutants | **16/16 caught** (M16 missed at first: lists in text are never parsed; caught after the real-list check); tree restored | `evidence/a5c_mut.py`, `evidence/a5c_mut_run.txt` |
| Related tests (all 50 that touch the kernel, the controllers or the control skills, and 4 more) | **49 passed**, 0 failed; `windowControlTest` blocked (needs Windows), `processControlSafetyTest` environment (needs a Windows process table), both as on the base code | `evidence/a5c_related_tests.txt` |
| Full suite (before review) | **212 passed, 0 failed**, 1 blocked (no pygame), 9 skipped | `evidence/a5c_full_suite.txt` |
| Independent review, round 1 | CHANGES REQUIRED (C1, C2 high; C3, C4 med; C5–C9 low; C10 info) | `review.md` |
| Review round 1 checks on that code (C2–C5) | 31 passed, **9 failed** | `evidence/a5c_review_r1_old_code_checks.txt` |
| Test after the round-1 fixes | **40/40** | `evidence/a5c_review_r1_new_code_checks.txt` |
| After round 1: typecheck; mutation check, 24 mutants (M10 retargeted, new M17–M24); related tests; full suite | typecheck 0 errors; **24/24 caught**, tree restored; related tests 51 passed, 1 failed (`appControlTest`'s `listApps` check, which the C5 change made throw on Linux; updated, then 7/7); the full suite after that update: **212 passed, 0 failed**, 1 blocked (no pygame), 9 skipped | `evidence/a5c_typecheck.txt`, `a5c_mut_run_r1.txt`, `a5c_related_tests_r1.txt`, `a5c_updated_tests.txt`, `a5c_full_suite_r1.txt` |
| Independent review, round 2 | **PASS** (C11–C14 low, C15 info) | `review.md` |
| `appControlTest` after the C12 change | passes | `evidence/a5c_appcontrol_final.txt` |

## Known limits (recorded, not changed)

- TRA-10's second part: keyboard, mouse, process and system actions are still not checked after the fact (`core/verifiers.ts`). That is for A5d/A5e.
- The audit log's `rollbackAvailable: true` is still a fixed value.
- Other new failures of a mutating action are retried once by the action queue, as any thrown failure already was: a WinAutomate error, or "Window matching … not found". "Permission denied." is final (it matches "denied"), and so are the unread list, the tab that is not open and the missing app window (review C4, C9).
- A non-zero PowerShell exit discards a list that was partly read, for example with one unreadable volume (review C7).
- `processController`'s runner message when PowerShell cannot start has no check in the test suite. The reviewer saw it on this Linux machine, which has no PowerShell: "PowerShell could not start: Command failed with ENOENT…" (C6, C11).
- `processControlSafetyTest` needs a Windows process table and is "environment" here, before and after.
- "Close the current window" with the window list unread says "No active window to close.", a false "none" (nothing is closed). This was there before A5c (review C13).
- `checkService` and the battery read ignore PowerShell's exit code: without PowerShell, or for a service that does not exist, the service check is an empty success and the battery says "not available". This was there before A5c, outside the owner's Q2 lists (review C14).
- A passing PowerShell failure while kill or restart looks up the process is now final, not retried once (it matches "could not be read"). The reason is kept (review round 2, b).
- Restarting an app with the window list unread now fails with the reason instead of opening a second copy (review C15).
