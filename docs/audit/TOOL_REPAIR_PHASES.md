# Tool repair phases (from the 2026-10-25 tool audit)

Sources:
- **Report A**: `docs/audit/JARVIS_TOOL_RELIABILITY_AUDIT_2026-10-25.md` (findings TRA-01…19, roadmap section I).
- **Report B**: the audit's working checklist (Stage 8 test gaps, the seven proposed browser contracts, weak-test patterns, NOT RUN items). Its open items are copied into track B below, so this file is enough on its own.

Rules:
- Each track is worked in order. Phase N+1 of a track starts only when every item of phase N is `[x]`, or is an owner item marked `[owner]`. An owner item needs the owner's PC, so it can't be done in the cloud; it stays open and is listed in the phase's closing line.
- Each phase is one ICM run (`ai_workflows/runs/`): diagnosis, failing test first, smallest fix, runner tests, agent review (a separate agent session, not a human), records, commit by name. Pushing needs the owner's approval.
- A phase is not "fixed" on the owner's PC until the owner runs its PC check.

Legend: `[ ]` open · `[~]` in progress · `[x]` done with evidence · `[owner]` needs the owner's PC · `[-]` dropped (reason given)

## Owner decisions

| ID | Question | Answer (2026-10-25) |
|---|---|---|
| D1 | Which Chrome does JARVIS control? | **JARVIS-owned Chrome**: JARVIS starts its own Chrome with a separate profile and debug port, and opens pages in it. The everyday Chrome is never touched. |
| D2 | One permission level for every tab close? | Open: asked before track A phase 5 |
| D3 | What does "close the browser" do? | **Close JARVIS's Chrome only**, after confirmation. Never the everyday Chrome. |
| D3a | "Close current window" with Chrome in front? | **Not on that command alone** (2026-10-26): JARVIS asks the owner to confirm that specific Chrome window; existing safety and confirmation rules stay. |
| D4 | Start the repair phases? | Yes: "go on the two phases", one phase at a time |

Consequence of D3 for phase A1: once `chrome` matches again (TRA-04), app, window and process tools must not close or kill a browser. Phase A2 adds "close the browser" for JARVIS's own Chrome.

## Track A — phases from Report A (roadmap section I)

### A1. Close by name; no whole-window close for tab requests; honest kill — TRA-04, TRA-18, TRA-06

Run: `ai_workflows/runs/2026-10-25_close-by-name-and-window-close/`

- [x] TRA-04: `control_app close/focus` match `chrome`, `notepad` and `calculator` against real Windows names (`ProcessName` has no `.exe`; Calculator's window belongs to `ApplicationFrameHost` or `CalculatorApp`)
- [x] TRA-04: `restart` doesn't open a second copy when the app is running
- [x] TRA-18: a site or tab name ("youtube") never closes a browser window through `control_app` or `control_window`; the reply points to the tab command
- [x] TRA-18 + D3: `control_app`, `control_window` and `control_process` don't close or kill a browser by name or by a window handle from a list; "close current window" with Chrome in front asks the owner to confirm that Chrome window first (owner's decision, 2026-10-26)
- [x] TRA-18: when several windows match, or the name is only part of a program's name, `control_app close` asks first (outside any approval already given)
- [x] TRA-18: for "close … tab" requests the planner offers the tab tools and not `control_app`/`control_window` (a mixed "close notepad and the youtube tab" is phase A3)
- [x] TRA-06: `control_process kill` prefers an exact name, checks Stop-Process's exit code, checks that the PID is gone (and fails if that check gives no answer), and fails when it isn't
- [x] Found in review: protected apps (cmd, PowerShell, Windows Terminal) are asked about once, naming the windows; "close command prompt" never reaches JARVIS's own terminal
- [x] Tests fail on the old code and pass on the new (shown): `closeByNameTest` 17 passed / 64 failed + a crash on `e394a26` (hooks only, before the D3a checks); 88 / 88 fixed
- [x] Typecheck 0 errors; related tests; full runner suite (`pnpm test -- --ci`) — see the run's `verification.md`
- [x] Agent review PASS (a separate agent session, not a human): eight rounds, PASS in rounds 5–8
- [x] Records, tracker row, commits by name
- [owner] Windows CI green after push; on the PC: open Notepad → "close notepad" closes it; "close calculator" on Windows 11; "close the YouTube tab" leaves the Chrome window open; "close command prompt" with JARVIS's terminal open closes nothing

Phase A1: **complete in the cloud, partially verified**: the owner items above (Windows PC, voice) stay open, and the status stays partially verified until they pass.

### A2. Browser session (D1 + D3) — TRA-03, TRA-16, TRA-17

Starts after A1. Run: `ai_workflows/runs/2026-10-25_jarvis-owned-chrome/`

- [ ] JARVIS can start its own Chrome: separate profile folder, loopback debug port, found or started on demand
- [ ] `open_app` web targets (YouTube, URLs) open in JARVIS's Chrome through CDP; if it can't start, the reply says so and names the fix
- [ ] "Close the browser" / "close Chrome": closes JARVIS's Chrome only, after confirmation; never the everyday Chrome
- [ ] Chrome start instructions per platform (TRA-16)
- [ ] Tests (fake CDP + fake Chrome launcher) fail first, then pass; the existing open_app/YouTube route tests stay green (`DO_NOT_BREAK`)
- [ ] Typecheck, related tests, full suite, agent review PASS, records, commits by name
- [owner] On the PC: "open YouTube" → "close the YouTube tab" → "close the browser"

### A3. Routing — TRA-05, TRA-14
- [ ] Deterministic patterns for common close/tab phrasings, with security boundary tests (`"launch cmd /c del *"` still doesn't match)
- [ ] Domain-like words keep their dot ("open github.com")
- [owner] Live voice phrases on the PC

### A4. Safe targeting — TRA-01, TRA-02, TRA-11
- [ ] One tab resolver for both tab tools; no target → the visible tab or a question; several matches → a question
- [ ] The tab-close check compares with the intended tab
- [ ] Mutations MB, MD, ME are detected

### A5. Honest capability — TRA-07, 08, 09, 10, 12, 19
- [ ] D2 answered
- [ ] Read tools say "unavailable" with a reason instead of `[]`/`false`
- [ ] Capability record per tool; the planner offers only available tools
- [ ] `self_check` reports CDP, PowerShell and permission level
- [ ] The kernel never turns free text into success
- [ ] (from B1) a controller failure returned without throwing (app, process, window) is reported as a failure through the kernel, with a test
- [ ] `open_app` checks the opener's exit and doesn't report "unverifiable" as checked

### A6. Diagnostics — TRA-13, TRA-15
- [ ] Action log carries the request id and the verified outcome
- [ ] Test Chromium's process tree is ended (no orphan Chrome in Windows CI)

## Track B — phases from Report B (audit checklist)

### B1. App, window and process test gaps (Stage 8)

Done in the same run as A1, because it tests the same code.

- [x] `closeApp` matching runs with real-shaped window data in a test (`closeByNameTest`)
- [ ] A controller that reports a failure *without throwing*, through the kernel for app/process/window: moved to phase A5 (TRA-10, the kernel's text-as-success); the thrown-error path is covered (`closeByNameTest` §6)
- [x] Process kill: a failed Stop-Process isn't "Successfully terminated" (`closeByNameTest` §4)

Phase B1: done with A1, except the item moved to A5.

### B2. Browser contracts 1–7 and mutations MB/MD/ME (Stage 8)
- [ ] 1 close one tab ≠ close browser · 2 close tab ≠ disconnect · 3 close managed browser ≠ kill user browser (with A2) · 4 dispatch success ≠ verified · 5 recoverable ≠ irrecoverable · 6 unavailable ≠ false success (with A5) · 7 target intent (with A4)

### B3. Health honesty (Stages 5, 7)
- [ ] `self_check` "tools" item and Redis-on-fallback (with A5)
- [ ] Unavailable-vs-empty contract tests for read tools (with A5)

### B4. Diagnostics (Stage 9)
- [ ] Action log fields (with A6)
- [ ] An action that ends after the registry timeout is reported as "may have happened", not "failed"

### B5. NOT RUN in the audit (needs real hardware)
- [owner] Real browser crash mid-call, several windows/profiles, pinned tabs
- [owner] Windows-only faults on the PC
