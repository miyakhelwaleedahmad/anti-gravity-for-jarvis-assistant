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

---

# Change Log — sub-phase A5d (open_app: TRA-19)

Base commit: `1cab883`. Owner's Gate 1, 2026-11-03:
- "Approve A5d (Recommended)", with the protected files `skills/automation/skill.ts` and `core/orchestrator.ts` (the `open_app` route reply only);
- Q1: "Say it wasn't checked (Recommended)";
- Q2: "Refuse: needs Windows (Recommended)".

## The change

| File | Change |
|---|---|
| `skills/automation/skill.ts` (protected) | `openTarget` waits for the launcher's own outcome, for up to 3 s (P1). Exit 0 is a success, and so is a launcher ended by a signal (exit code null; Linux and macOS only), as before (review D2). A non-zero exit is a failure: "The launcher (cmd) exited with code N, so X may not have opened." A failure to start is a failure with its reason. A launcher still running after 3 s is "started" (`launcherStillRunning: true`). Before, the answer was success 50 ms after the spawn, whatever the launcher did next. On a real open off Windows, a Windows-only target is refused with "X needs Windows: … this computer is not running Windows.", and nothing is launched (P3, Q2). A dry run returns earlier, so it still shows the resolution. The launcher and the platform come through `openAppDeps`, so tests can stand in for them. Its `spawn` calls `child_process.spawn` when called, as the code did before, so a patch made after load still applies. It always passes the filtered environment, `childEnv()` (SEC-101), which the caller already passes too. |
| `security/openAppPolicy.ts` | `windowsOnlyTarget(resolvedTarget)`: a `.exe`, an `ms-settings:` page or a `shell:` folder. |
| `core/orchestrator.ts` (protected; the `open_app` route reply only) | On the voice/text route, a success whose check was "unverifiable" says "I started X, sir, but I can't check from here that it opened." (P2, Q1). Checked opens keep "Opening X, sir.", and failures keep their replies. |

## Tests

| File | Change |
|---|---|
| `tests/openAppHonestA5dTest.ts` (new) | 16 checks. The launcher (exit 0, exit 1 after 300 ms, a failure to start after 120 ms, still running) and the platform are stood in for, so the test is the same on Windows and Linux. Off Windows: `notepad` and `settings` refused with nothing launched; a dry run unchanged; `code` still launched; on Windows, `notepad` launched. The route: "open settings" says it could not check; a failed launch is not "Opening"; "open youtube" in JARVIS's Chrome (a fake DevTools server) still says "Opening youtube, sir.". The real launcher goes through a `child_process.spawn` patched after load (added when mutant M12 was missed). |
| `tests/boundary-doubles.json` | An entry for the new test (`installFakeTts`). |
| `tests/jarvisChromeTest.ts` | Its "browser named explicitly" checks are about Windows names (`msedge.exe`, `firefox.exe`), and Q2 refused them on Linux (12 checks failed, `evidence/a5d_related_tests.txt`). They now run with the platform stood in as Windows. One check was added: off Windows, "edge" is refused with "needs Windows" and nothing started. The real platform is restored afterwards. |

## Evidence

| Check | Result | File |
|---|---|---|
| New test on the base code | 5 passed, **10 failed** (of the first 15 checks) | `evidence/a5d_old_code_checks.txt` |
| New test after the change | **15/15**, then **16/16** with the M12 check | `evidence/a5d_new_code_checks.txt`, `evidence/a5d_new_code_checks_16.txt` |
| First related run | `jarvisChromeTest` failed 12 checks (Q2 on Linux); updated as above | `evidence/a5d_related_tests.txt` |
| `jarvisChromeTest`, `openAppHonestA5dTest`, `openAppSmokeTest` after the update | 3/3 pass | `evidence/a5d_updated_tests.txt` |
| Typecheck | 0 errors | `evidence/a5d_typecheck.txt` |
| Mutation check, 12 mutants | **11/12 caught** at first. M12 (spawn bound at load) was missed, because `voiceRouteMockTest` patches `child_process` before it loads the skill. After the added check: **12/12 caught**, tree restored (md5) | `evidence/a5d_mut.py`, `evidence/a5d_mut_run.txt`, `evidence/a5d_mut_run_m12.txt` |
| First full suite | 212 passed, **1 failed**: `childEnvCoverageTest` found the new wrapper's `spawn` call without `env` (`skill.ts:30`). The wrapper now always passes `childEnv()`; the 5 affected tests then passed | (overwritten by the run below) |
| Mutation check after that, 13 mutants (M13: the wrapper drops the filtered environment) | **13/13 caught**, tree restored (md5) | `evidence/a5d_mut_run_r1.txt` |
| Related tests (the 41 that touch `open_app`, the automation skill or its policy, and `boundaryDoublesTest`, `routeGoldenTest`, `docsHygieneTest`, `kernelOutcomeA5cTest`, `scenarioIntegrationTest`, `verifyAfterActTest`, `childEnvCoverageTest`) | **47 passed, 0 failed**, 1 skipped (`finalIntegrationSuiteTest`, live provider test). A first run stopped on a wrong test name (`verifierTest`) | `evidence/a5d_related_tests_final.txt` |
| Full suite | **213 passed, 0 failed**, 1 blocked (no pygame), 9 skipped | `evidence/a5d_full_suite.txt` |

## Deviations from the plan

- P2 uses the registry's existing `verification.status` ("unverifiable") in the route, not a new `checked: false` field. The verifier already decides what can be checked, so a second flag could disagree with it.
- `jarvisChromeTest` was changed (above). It was not in the plan.
- `openAppDeps.spawn` calls the live `child_process.spawn` binding, not a copy taken at load, and always passes `childEnv()` (found by `childEnvCoverageTest` in the first full suite).

## Known limits (recorded, not changed)

- On Windows, "open downloads" (`shell:Downloads`) is checked as an app called "downloads". The matcher also tries window titles, so an Explorer window titled "Downloads" probably passes; if it does not, the registry marks a folder that did open as VERIFICATION_FAILED. Not checked on the PC yet. This was there before A5d (`core/verifiers.ts`, `verifyOpenApp`; review D5).
- A launcher that hangs adds up to 3 s before the answer. Within the 20 s sandbox budget (review D9).
- On Windows, `cmd /c start` for a program that is not installed probably waits on a "Windows cannot find" dialog. After 3 s that counts as "started"; for apps, the verifier's check afterwards (up to 15 s) should turn it into a failure. Not checked on the PC yet (review D3).
- Exit 0 from `cmd /c start` means the launch was handed to Windows, not that the app's window appeared. On Windows, apps are still checked afterwards by the verifier; Settings pages are not, and now say so.
- Off Windows, every open outside JARVIS's Chrome is unchecked, so on the voice/text route it says "I started X, sir, but I can't check from here that it opened."
- **Only the voice/text route says this.** An open that the planner (the LLM path) chooses still says "Opening X, sir." when it could not be checked (`core/orchestrator.ts`, the simple-reply tools; review D1). Gate 1 limited the orchestrator change to the route reply. A follow-up would apply Q1 there too.
- Off Windows, "open cmd" asks for approval first and only then refuses with "needs Windows"; the audit log records the request as allowed although nothing started. `fullControlLimitTest` expects the approval prompt on Linux (review D4).
- `control_app open` (`control/appController.ts`) has its own launcher. It still reports success at once and has no off-Windows refusal. It was outside A5d (review D9).
- A desktop check that times out or cannot run is also "unverifiable", so a real app open can get the "I started…" reply (review D6).
- "Full suite green" is on Linux. Windows CI runs after a push.

---

# Change Log — sub-phase A5b (self_check: TRA-08, B3)

Base commit: `2602948`. Owner's Gate 1, 2026-11-05:
- "Approve A5b (Recommended)" (no protected file);
- Q1: "Not verified + reason (Recommended)";
- Q2: "Not verified: starts when needed (Recommended)";
- Q3: "Full self-check only (Recommended)".

## The change

| File | Change |
|---|---|
| `core/selfCheck.ts` | The ledger's "tools" item is now "last tool call" (P1): when it worked, "X ran N s ago; not a check of what the tools can do", without "working"; otherwise the ledger's detail. Its state is unchanged, and "why stuck" says the same name (review B2, B6). Redis on its in-memory fallback is NOT_VERIFIED, "Redis is not connected; JARVIS uses its in-memory cache instead" (P2, Q1). The full self-check adds "Chrome for web pages" (P3): running and answering is VERIFIED with the port; installed but not running is NOT_VERIFIED, "it starts when JARVIS opens a page" (Q2); installed but not running with `JARVIS_CHROME_AUTOSTART` off is BLOCKED, "JARVIS will not start it" (review B1); not installed, `JARVIS_CDP_PORT` not answering, or the check failing is FAILING with the reason. It reads `jarvisChrome.running()` and `findChrome()` and starts nothing. The full self-check also adds "PowerShell for desktop control" (P4): on Windows, a version query that answers within 5 s is VERIFIED; no answer within 5 s is NOT_VERIFIED, "it may only be slow to start" (review B3); a failure to start or a non-zero exit is FAILING with the reason. The two checks run at the same time. Off Windows it is BLOCKED, "desktop control needs Windows", and PowerShell is not asked. The query runs with the filtered environment (`childEnv()`). Every self-check says the permission level as a line, not a check (P5): "level 0, read only", "level 1, safe control", "full control, N min left" ("less than 1 min left" under a minute), or "not read" with the reason. The full report's last line says Chrome and PowerShell are checked only for whether they answer. All of these come through `SelfCheckDeps`, so tests can stand in for them. |
| `monitoring/healthManager.ts` | The Redis probe marks the in-memory fallback (`fallback: true`); its status stays `online`, so the dashboard and the self-healer read it as before (`redisHealthAgreementTest`). A probe that throws is `degraded` with the reason instead of `online`, "in-memory cache fallback". Redis's own check comes through `redisProbeDeps`, so tests can stand in for it. |

## Tests

| File | Change |
|---|---|
| `tests/selfCheckA5bTest.ts` (new) | 30 checks, then 38 after review round 1 (39 on Windows, where the real PowerShell query is also checked). Chrome, PowerShell, the platform, Redis and the permission level are stood in for, so the test is the same on Windows and Linux. Covered: the "tools" item; Redis on the fallback, connected, the probe's flag, a probe that throws, and the flag through the real service list; Chrome running, installed only, missing, `JARVIS_CDP_PORT` silent, the check failing, not in the quick check, and the real check with `JARVIS_CHROME_PATH` (missing / present, nothing started); PowerShell answering, not answering, off Windows (not asked), not in the quick check; the permission level at 0, 1 and 2 (minutes left), unreadable, said as a line; no overclaim; the "checked only for whether they answer" line. Added in review round 1: the tools detail without "working" and "why stuck" naming it the same; Chrome with autostart off (stand-in and the real check, on and off); PowerShell slow versus unable to start, and on Windows the real query; "less than 1 min left"; no nested brackets in what is said. |
| `tests/selfCheckTest.ts` | One check compared the quick reply with an exact string. With P5 the reply ends with the permission sentence, so the check now matches the count and then "Permission: …". It fails on the base code, as it should. After review B4 it points `JARVIS_CHROME_PROFILE` at its temporary folder, so it never reads the host's real Chrome profile. |

## Evidence

| Check | Result | File |
|---|---|---|
| Diagnosis probe (`self_check full` on this Linux host, base code) | `[VERIFIED] tools: working (list_capabilities ran)`, `[VERIFIED] service redis: in-memory cache fallback`, no Chrome, PowerShell or permission item | `evidence/a5b_diagnosis_probe.txt` |
| New test on the base code | 6 passed, **21 failed** (3 more checks need `redisProbeDeps` and were skipped) | `evidence/a5b_old_code_checks.txt` |
| New test after the change | **30/30** | `evidence/a5b_new_code_checks.txt` |
| The same probe on the final code (run with `JARVIS_CHROME_AUTOSTART=off`, as the tests are) | `[VERIFIED] last tool call: list_capabilities ran 0 s ago; not a check of what the tools can do`, `[NOT_VERIFIED] service redis: Redis is not connected; JARVIS uses its in-memory cache instead`, `[BLOCKED] Chrome for web pages: not running, and JARVIS_CHROME_AUTOSTART is off, so JARVIS will not start it`, `[BLOCKED] PowerShell for desktop control: desktop control needs Windows …`, "Permission: level 1, safe control" | `evidence/a5b_after_probe.txt` (re-run after review B5) |
| Typecheck | 0 errors | `evidence/a5b_typecheck.txt` |
| Mutation check, 19 mutants | **19/19 caught**, tree restored (md5) | `evidence/a5b_mut.py`, `evidence/a5b_mut_run.txt` |
| First related run (32 tests) | 29 passed, **1 failed**: `selfCheckTest`'s exact-string check (updated as above, then 77/77); 2 environment (`dashboardAccuracyTest`, `dashboardHealthSystemTest`; the runner marks them as expected here: they need Redis, an LLM API and Windows PowerShell) | `evidence/a5b_related_tests.txt` |
| Related tests after the update | **30 passed, 0 failed**, the same 2 environment | `evidence/a5b_related_tests_r1.txt` |
| Full suite (the restarted run) | **214 passed, 0 failed**, 1 blocked (no pygame), 9 skipped; the runner exits 1 because of the blocked test | `evidence/a5b_full_suite.txt` |
| Independent review, round 1 | CHANGES REQUIRED (B1 med; B2–B6 low; B7, B8 info) | `review.md` |
| Round-1 checks on the round-1 code | 30 passed, **8 failed** | `evidence/a5b_review_r1_old_code_checks.txt` |
| Test after the round-1 fixes | **38/38** | `evidence/a5b_review_r1_new_code_checks.txt` |
| After round 1: typecheck; mutation check, 26 mutants (M2, M11 retargeted, new M20–M26); the after-probe; related tests; full suite | typecheck 0 errors; **25/26** at first: M13's line had changed and it was not applied; retargeted and run alone: caught, so **26/26**, tree restored; related **30 passed, 0 failed**, the same 2 environment; full suite **214 passed, 0 failed**, 1 blocked (no pygame), 9 skipped, exit 1 for the blocked test | `evidence/a5b_typecheck.txt`, `a5b_mut_run_r1.txt`, `a5b_mut_run_r1_m13.txt`, `a5b_after_probe.txt`, `a5b_related_tests_r2.txt`, `a5b_full_suite_r1.txt` |

## Deviations from the plan

- `tests/selfCheckTest.ts` was changed (one check, above). It was not in the plan.
- `redisProbeDeps` (`monitoring/healthManager.ts`) was added so the probe's catch path can be tested. It was not in the plan.
- A full suite run was stopped and started again: while it ran, the two source files were briefly put back to the base code to check the updated old test. That run's result is not used.
- After review round 1 (review B9), three changes to the agreed behaviour:
  1. Chrome installed, not running, with `JARVIS_CHROME_AUTOSTART` off is BLOCKED, "JARVIS will not start it". This refines the owner's Q2 answer ("Not verified: starts when needed") for a case the owner was not asked about, because "starts when needed" would be false there (B1). Confirmed by the owner on 2026-11-05: "Keep \"blocked\" for the autostart-off case, as recommended."
  2. PowerShell with no answer within 5 s is NOT_VERIFIED, not FAILING as planned (B3).
  3. The items are named "Chrome for web pages" and "PowerShell for desktop control", not as in the plan (B8).
- The mutation re-run of M13 finished after the last full suite; it restored the tree (md5), and the reviewer's tests on the final tree pass.

## Known limits (recorded, not changed)

- The "last tool call" item can still be `self_check` itself, which counts as verified. The registry records every tool call; changing that is in the protected `core/toolRegistryV2.ts`.
- The "service tool_registry" item is still a count of loaded tools.
- On Windows, the full self-check starts one `powershell.exe` for the version query, which takes up to 5 s. (`selfCheckTest`'s full-mode calls did this on Windows CI too, review B4, and it did make a check fail there. Fixed after the push with a stand-in: see "After the push" below.) It does not use the persistent PowerShell session that reads windows, so a stuck session there is not seen by this check.
- `JARVIS_CDP_PORT` set and answering is VERIFIED even when that Chrome is the owner's own, not JARVIS's.
- A non-zero PowerShell exit puts the whole error message, with the command and line breaks, into the details, and says "did not answer" although PowerShell did answer, with an error (review B8, B10).
- "Full suite green" is on Linux. Windows CI runs after a push. The PowerShell VERIFIED path has run only with a stand-in here; the real query is checked on Windows only.

## After the push: Windows CI on `d9d7820` (test-only fix)

CI run 42033994044 (`d9d7820`) failed on the Windows job, and the owner's rule stopped further changes until they were reported. The owner then approved, on 2026-11-05:
- a test-only fix in `tests/selfCheckTest.ts`: a fast PowerShell stand-in, and comparing the ledger's outcomes instead of its time text;
- one re-run of the failed Windows job.

| Attempt | `selfCheckTest` | `scenarioIntegrationTest` | `browserControlAgentTest` | `selfCheckA5bTest` | Total |
|---|---|---|---|---|---|
| 1 (job 127267265678) | **FAIL**: "no issue, file or ledger entry changed" | **FAIL**, 4 checks: the dev server's restart reported `start_server: false`, and 3 checks after it | pass | pass (39 checks, the real PowerShell query included) | 216 passed, 2 failed |
| 2, the one re-run (job 127296040980), same commit | pass (4.8 s; the clock did not tick over) | pass | **FAIL**: "click: the page changed, and the check says so (undefined)" | pass | 217 passed, 1 failed |

### `selfCheckTest`: caused by A5b, fixed (test only)

- **Cause.** The read-only check compared `JSON.stringify(healthLedger.all())` before and after four self-checks. The ledger's text includes "worked, N s ago", rounded to the second. On Windows, A5b's full self-check started the real `powershell.exe`. Its time was not measured; the whole test took 2.8 s. That start moved the rounded "N s ago", although nothing was recorded. The CI log does not show which of the check's three comparisons failed. The reproduction shows that the ledger text alone is enough to fail it. Off Windows the PowerShell item is BLOCKED and nothing starts, so Linux passed. Review B4 had flagged this real start, and it was recorded as harmless. That was wrong.
- **Reproduced on Linux** with the committed test plus one edit, in the read-only section's self-check call only: `platform: () => 'win32', powershell: () => new Promise((r) => setTimeout(() => r({ ok: true, version: '5.1' }), 1500))`. The same check fails, 76 passed, 1 failed (`evidence/a5b_ci_fix_reproduce.txt`, which holds the output only). The test file was restored afterwards.
- **Fix** (`tests/selfCheckTest.ts`; no production code):
  - a `fastHost` stand-in (platform `win32`, a PowerShell that answers at once, no Chrome) in the four full-mode calls, so the test never starts PowerShell or reads the host;
  - the read-only check compares `healthLedger.history(p)` for every pipeline, that is what was recorded, not the clock-dependent text.
- **Results:**
  - `selfCheckTest` 77/77 (`evidence/a5b_ci_fix_selfchecktest.txt`).
  - A check of the fix (`evidence/a5b_ci_fix_mut.py`, `a5b_ci_fix_mut_run.txt`), 4/4 as expected, tree restored (md5):
    - C1: PowerShell answering after 1.5 s still passes;
    - M1 (the repair report records a ledger outcome) and M2 (it records an issue) fail exactly the read-only check;
    - M3 (the stand-in removed) passes. Its label in the script, "fail-on-windows-only", is wrong (review W1): with the `history()` comparison it would pass on Windows too. `fastHost` only keeps the test from starting PowerShell or reading the host, and no check enforces that.
  - Typecheck 0 errors.
  - Related tests 30 passed, 0 failed, the same 2 environment (`evidence/a5b_ci_fix_related_tests.txt`).
  - Full suite 214 passed, 0 failed, 1 blocked (no pygame), 9 skipped, exit 1 for the blocked test (`evidence/a5b_ci_fix_full_suite.txt`).
  - All of this is on Linux, with Windows simulated by a slow PowerShell stand-in. The one approved re-run (attempt 2) ran on `d9d7820`, without the fix. The fix runs on Windows only with the next push's CI (review W4).
  - Known limit (review W6): with stand-ins in every full-mode call, no test checks that the real Chrome and PowerShell readers write nothing. Reading the code, they do not (`jarvisChrome.running()`, `execFile`).

### `scenarioIntegrationTest` and `browserControlAgentTest`: not caused by A5b (recorded, not fixed)

- On the same commit, each failed in one attempt and passed in the other (`evidence/a5b_ci_windows_attempt1.txt`, `a5b_ci_windows_attempt2.txt`). A5b does not touch the dev-server, diagnosis, restart or browser-click code. Both tests passed on Windows CI for A5d (run 42010191425).
- `scenarioIntegrationTest` (attempt 1): after "Why isn't my application working?", the restart of the crashed api server returned `start_server: false`, while the reply said "I started it again; it answers now". The 3 later checks (stop asked, cancelled, approved) depend on that step. The CI log shows only the last lines, so the reason for `false` is not known. It did not fail again in the re-run.
- `browserControlAgentTest` (attempt 2): the click on "Show details" returned no verification at all (`undefined`). The log does not show why.
- Both depend on timing on the Windows runner: real Chrome, and a server restart. They are recorded as open Windows-CI issues for a later phase. Neither is fixed or skipped here.
