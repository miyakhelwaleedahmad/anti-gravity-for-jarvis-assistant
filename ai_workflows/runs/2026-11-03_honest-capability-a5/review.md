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
