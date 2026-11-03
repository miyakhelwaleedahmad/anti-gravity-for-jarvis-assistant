# Review — honest capability, sub-phase A5a (read tools)

Reviewer: a separate agent session (general-purpose), read-only; tests run through the runner only. Not a human.

## Round 1 — CHANGES REQUIRED

The reviewer confirmed the core change does what TRA-07, Q1 and Q2 ask:
- with JARVIS's Chrome down, the tab tools say so and start nothing;
- an unread window list is said as such;
- the routes keep their old replies when Chrome or the window list was read;
- a stale profile file is rejected.

Every caller was checked (planner, subagents, task graph, `continueWork`, controllers, `system_state.json`); the change only adds to them, and nothing breaks. Typecheck 0; 3 tests through the runner.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| R1 | high | The test assumed no PowerShell: with a stand-in PowerShell on PATH (as on Windows CI and the owner's PC), 7 checks failed | **Fixed**: PowerShell is a stand-in inside the test (session and fresh read), so the read fails, or answers, on purpose on any machine. Passes with a fake `powershell` on PATH (`evidence/a5a_with_fake_powershell.txt`) |
| R2 | high | `is_tab_open` read at most 20 tabs (`readBrowserState`'s cap), so the 21st tab and beyond got a false "No" | **Fixed**: `is_tab_open` matches on `listPages` (one DevTools call, no cap). `get_browser_tabs` adds the tabs beyond 20 by title and address, redacted like the first 20. Test first; M12, M13 |
| R3 | med | `liveTabs` costs 50–120 ms for 20 tabs and up to about 2 s with one busy tab; it can wait behind another operation on that tab | **Fixed for `is_tab_open`** (`listPages` only: about 3 ms measured). `get_browser_tabs` keeps the per-tab details for the on-screen tab, as the old `browser_state` route did; recorded |
| R4 | med | The planner's world state still said `apps: … open: none` when the windows could not be read | **Fixed**: `core/worldState.ts` says `apps: not readable (<reason>)`. Test first; M15 |
| R5 | low | On Windows, right after start, "what's running" can say it can't read the windows for a few seconds (the "not read yet" state; longer if the first query times out) | Recorded (honest; a retry on demand is a possible follow-up) |
| R6 | low | With `JARVIS_CDP_PORT` set and nothing answering, the error said "JARVIS's own Chrome … starts when JARVIS opens a page", which is wrong in that case | **Fixed**: the existing `CdpUnavailableError` wording for that port. Test first; M14 |
| R7 | low | "Chrome not running" and "not read yet" count as tool faults in the health ledger and issue store; after 5 asks the tool shows as degraded | Recorded for A5b (self_check / health honesty) |
| R8 | low | Two checks passed on any failure; missing cases: the profile path, a stale profile, more than 20 tabs, `JARVIS_CDP_PORT` with nothing on it; one check could not fail on Linux | **Fixed**: reason checks added; all four cases added; the stale-list check now uses a real good reading first |
| R9 | low | The scenario check accepted `browser_state`, which the route no longer calls | **Fixed**: accepts only the live `get_browser_tabs` |
| R10 | low | `toolCatalog` and the skill's description still describe `get_browser_tabs` output as "title, url, active" | Recorded for A5e (the catalog is protected; a description change re-trusts the skill) |
| R11 | low | Records: the plan's `chromeState.ts` change and `windowsStateFreshnessTest` change were not made and not recorded; other unread-to-empty paths not listed; "suite green" only on Linux; latency not recorded | **Fixed** in `change_log.md` |
| R12 | info | "What is open" (`get_system_state`) ignores `windowsUnavailable` and reads tabs from the snapshot; off Windows "right now" suggests a passing fault | Recorded for A5e |

## Round 2 — PASS

The reviewer ran the tests and probes again, without relying on the evidence files:
- the test passes with a stand-in `powershell` on PATH, which gave 7 failures in round 1;
- real headless Chrome with 26 tabs: `liveTabs` lists all 26 in 59–110 ms;
- 22 tabs: `is_tab_open` finds the oldest;
- no tab socket is opened by `is_tab_open`;
- the race, zero-tab and redaction cases behave as expected;
- the world-state reason is safe (`clean()` redacts it, cuts it to 80 characters, inside the untrusted block);
- typecheck 0; 4 tests pass.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| R13 | low | Change log: "34 checks" (36), and a duplicated "Known limits" block | **Fixed** |
| R14 | low | A test comment still said "No PowerShell on this machine" | **Fixed** |
| R15 | info | Between the two list calls the count can be off by one; no tab present at both reads is lost | Recorded |
| R16 | info | A duplicate id beyond 20 would be listed twice; Chrome's ids are unique | Recorded |
| R17 | info | `readablePort` reads `JARVIS_CDP_PORT` from `process.env`, `running()` from the injected env; only differs for an injected instance (tests) | Recorded |
| R18 | info | The stand-in skips PowerShell's end-token framing (covered by `windowsStateSessionTest`) and the one-shot fallback (not covered, as before) | Recorded |

---

# Review — sub-phase A5c (kernel)

Reviewer: a separate agent session (general-purpose), read-only. Not a human.

## Round 1 — CHANGES REQUIRED

Confirmed:
- only the kernel calls the changed controller methods, and every kernel caller is a `control_*` skill that stringifies the result, so failures reach the registry as `success:false`;
- no uncaught exception or unhandled rejection outside tests;
- no legitimate kernel output from a JARVIS controller has a top-level `error` or `success:false`;
- B1 is covered for app, window and process.

Typecheck 0; 15 tests through the runner.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| C1 | high | `windowControlTest` (Windows only; blocked here) awaited `focusWindow` on a missing window with no catch: it would crash on Windows CI and the owner's PC | **Fixed**: it reads the thrown message and keeps its "not found" check |
| C2 | high | `get_pc_state` (the planner's tool) returned the kernel's empty `message` on failure: an empty success, the reason lost | **Fixed**: on failure the skill returns the kernel's result as JSON, read as a failure by the registry. Test first (through `toolRegistryV2`); M17 |
| C3 | med | The kernel's JSON rule also judged pass-through data: a JSON file with its own `error` field was reported as a failure, its contents dropped; the same for command and PowerShell output | **Fixed**: `executeAction(..., { passThrough: true })` for `readFile`, `runShellCommand`, `runPowerShell`, `checkService`, battery, disk and startup lists. Test first; M18 |
| C4 | med | The action queue retried the new failures; an unread window list (up to about 20 s a read) could hit the queue's 10 s limit, and its reason was lost to "Timeout or Aborted" | **Fixed**: "could not be read", "is not open, so nothing was closed" and "No running window found" are final failures in `control/actionQueue.ts`. Test first (one read, not two); M19, M20 |
| C5 | low | `focusApp`, close-app, the app list and window close by name still took an unread list for "no such window" | **Fixed**: one helper, `openAppsOrWhy` (`perception/windowsState.ts`), used by all of them and by the window list. Test first; M21–M24 |
| C6 | low | `processController`'s PowerShell runner did not say why PowerShell could not start | **Fixed**, as in `systemController` (not tested here: it needs a missing PowerShell; recorded) |
| C7 | low | A non-zero PowerShell exit discards a list that was partly read (one unreadable volume, say) | Recorded (known limit) |
| C8 | low | Two updated old tests passed vacuously on Windows | **Fixed**: `focusApp` must succeed on Windows (Notepad is open there); the tab-list failure must name Chrome |
| C9 | low | Records: "a refused focus is asked twice" was wrong; `windowControlTest` not listed; the `findHwnd` "close" claim was wrong | **Fixed** in `change_log.md` |
| C10 | info | B1 covered; the kernel's JSON rule was tested only with a stand-in | The `get_pc_state` tool case added (C2) |

## Round 2 — PASS

The reviewer re-ran the round-1 probes against the current tree:
- C2: `get_pc_state` fails with the reason in both `error` and `output`;
- C3: a JSON-RPC error file and a `{"success":false}` file are read as successes, with their full contents;
- C4: a slow unread list is read once and keeps its reason, where an 11 s read used to become "Timeout or Aborted";
- C5: close by handle with the list unread still asks for a protected program, refuses when its owner can't be read, and refuses a browser;
- C6: seen on this host, which has no PowerShell.

`win_automate.ps1`'s focus never throws a refused focus, so the stricter Windows check can't fail on that. `passThrough` is complete. Typecheck 0; 15 tests through the runner.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| C11 | low | Change log: the A5c tables were not updated for round 1; C6 "not tested here" was wrong | **Fixed** |
| C12 | low | On Windows with more than 20 titled windows, Notepad can be left out of the list and the stricter `focusApp` check fails for a reason unrelated to A5c | **Fixed**: on Windows a "No running window found" is accepted only when a full window read has no Notepad either |
| C13 | low | "Close the current window" with the list unread says "No active window" (before A5c; nothing is closed) | Recorded |
| C14 | low | `checkService` and the battery read ignore PowerShell's exit code (before A5c) | Recorded |
| C15 | info | Restart with the list unread now fails with the reason instead of opening a second copy | Recorded (better behaviour) |
