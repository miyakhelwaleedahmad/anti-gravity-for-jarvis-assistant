# Review — Close by name; tab requests close whole windows; process kill reports success unchecked

> Stage: 05b_review
> Date: 2026-10-25/26

## Reviewer
A separate agent session (Claude), started with only the task and the repository. **Not a human review.** Read-only on the checkout; experiments in its own copy (`<scratchpad>/review_a1/`).

## What Was Inspected
`git diff` against `e394a26`, the new files, the run records and evidence; probes and one mutation in its copy; related tests through the runner.

## Checks
Typecheck 0 errors; closeByNameTest and 15 related tests PASS in its copy; the kill approval text still matches `approvalScope.coversNested`; PID is an integer in the script; the Stop-Process exit-code check is right for Windows PowerShell 5.1 `-Command` ($? false → exit 1); golden route phrases unchanged; no Windows-only assumption in the new test.

## Findings

### Round 1 — CHANGES REQUIRED

| ID | Sev | Finding | Change made |
|---|---|---|---|
| R1 | high | `control_window close "youtube"` could still close the Chrome window when a non-browser window also matched: the handle came from `findHwnd`, not from the plan | handle taken from the plan (no browser windows); test with Chrome listed first, for both tools |
| R2 | medium | The several-windows question was answered automatically inside a registry-approved call (`coversNested` matched "notepad" in its text) | asked through `withoutApproval`; test inside `runApproved` |
| R3 | medium | `restartProcess` killed the exact match but restarted `matches[0]` (notepad++), with an uncaught `spawn ENOENT` | one `chooseProcess` for both; start waits for `spawn`/`error` (injectable `start`); test |
| R4 | medium | "maximize the window with the youtube tab" lost `control_window` | the window branch no longer excludes tab requests, so `control_window` is offered whenever "window", minimize or maximize is said; three phrases added. (A verb restriction tried first was removed: its mutant changed nothing a test or the requirement could see.) |
| R5 | medium | The gone-check took an empty output (PowerShell failed) as "gone" | the check prints `running`/`gone`; anything else fails the kill; test |
| R6 | medium | "empty name closes nothing" passed vacuously (the browser rule stopped it) | case uses a desktop with no browser and asserts the message |
| R7 | low-med | The close check still used the title regex over all windows (Notepad++ or a Chrome tab "…notepad…" → "still open") | `closeApp` names the closed handles; the check looks at exactly those (fallback: the controller's rule, no browsers); tests through `windowChecks` |
| R8 | low | Arc, Chromium, Thorium, Waterfox, LibreWolf, Yandex and others not known as browsers | list extended; Arc test |
| R9 | low | A browser window's handle (from a window list) skipped the browser rule | refused unless it is "close current window"; test both ways |
| R10 | low | Substring fallback closed Notepad++ for "notepad" without asking; "e" matched anything | substring only ≥3 characters and only when it leaves one program; a non-exact match always asks; tests. **Found while testing this:** the title stage also matched the word inside program names (default matcher), so "host" still reached every `*host` program; program names are now tested there only for the apps listed in `APP_WINDOWS` (VS Code's "Code"); test |
| R11 | low | Protection checked on the name, not the matched window ("close terminal" closed WindowsTerminal) | matched windows checked too; test |
| R12 | low | All matches without a handle → "Closed 0 window(s)" (success) | throws; test |
| R13 | low | `findProcess` kept ".exe" ("kill notepad.exe" found nothing) | `programKey`; test |
| R14 | low | The queue retried the new refusals and "still running" (a retried kill asks again) | added to `FINAL_FAILURE`; test through `actionQueue.enqueue` |
| R15 | low | Reproduction record covered 36 checks, not the later ones | re-run on the hooks-only export with the final test; recorded |
| R16 | info | Kernel checks (§6) pass on old code: B1 item 2 has no detecting evidence | kept; B1 item 2 left open and moved to phase A5 (TRA-10, the kernel's text-as-success) |
| R17 | info | Windows 11 may list `CalculatorApp` with its own window | owner-PC check: "close calculator" on Windows 11 |

## Decision
- [x] PASS (rounds 5–8), by a separate agent session — **not a human review**
- [ ] CHANGES REQUIRED (rounds 1–4; each returned to 04_implementation and is answered above)
- [ ] BLOCKED — what is missing: [ ]

### Round 2 — CHANGES REQUIRED

| ID | Sev | Finding | Change made |
|---|---|---|---|
| R2-1 | medium | R9 incomplete: a browser handle not in the app list (a second Chrome window; the list has one main window per program, first 20) was still closed | the owner of a handle not in the app list is read from every visible window (`allWindows` = `freshWindowList.read()`); unknown or unreadable → refused; tests |
| R2-2 | low | A failed restart reported "No process found …" after the kill had happened | "Ended X, but could not start it again: …", final (no retry); test |
| R2-3 | low | The check took the first "(windows …)" in the reply, which can be inside the quoted target | anchored to the end of the reply; test |
| R2-4 | low | The protected-window question (R11) was answered by the approved call | asked through `withoutApproval`; test |
| R2-5 | low | Every non-exact match asked, under "Close Several Windows"; Calculator always asked | retitled "Close Matching Windows"; listed apps in their own window count as the app (see R3-1/R3-2 for the corrected rule); "close word" (WINWORD) still asks — in the patch plan |
| R2-6 | low | "close notepad and the youtube tab" gets no `control_app` | accepted; a mixed app-and-tab request is routing work: phase A3 |
| R2-7 | low | Records out of date (Change 3 text, "every other path", check counts) | updated after round 3 |
| R2-8 | info | `restartProcess` looked the process up twice | chooses once and calls a private `terminate`; restart checks permission itself |

### Round 3 — CHANGES REQUIRED

| ID | Sev | Finding | Change made |
|---|---|---|---|
| R3-1 | medium | The R2-5 rule made "close calculator" refuse when a Chrome tab mentioned calculators (the browser rule saw a "program" match) | a listed app counts as the app only in its own program's windows (`APP_HOSTS`: Calculator in ApplicationFrameHost/CalculatorApp, VS Code in Code, cmd in cmd/WindowsTerminal/conhost, Settings in ApplicationFrameHost/SystemSettings); test with both tools |
| R3-2 | medium | The same rule closed "calculator.py - Notepad" for "close calculator" without asking | that window is now a title match: asked first; test |
| R3-3 | low | Protection for a window closed by handle read only the app list | uses the owner found (app list or every window); test |
| R3-4 | low | Every close by handle read every window (a fresh PowerShell, up to 15 s), and failed if that read failed | a handle in the app list is used directly; the full read only when it is not; test counts reads |

Mutations after each round: `evidence/mutation_run_round2.txt` (26 + 4), `mutation_run_round3.txt` (6), `mutation_run_round4.txt` (3): all caught (one equivalent mutant removed with its code, see R4).

### Round 4 — CHANGES REQUIRED

| ID | Sev | Finding | Change made |
|---|---|---|---|
| R4-1 | medium | "close cmd" / "close command prompt" closed every Windows Terminal window, JARVIS's own included (the cmd pattern matched the program name "WindowsTerminal"); inside an approved call nothing was shown. Present since round 1; found in round 4 | cmd matches `cmd`, or Windows Terminal / conhost windows titled Command Prompt or cmd.exe; the protected question is planned first, asked once outside the approved call, and names the windows; tests with JARVIS's terminal open, both tools, approved call, yes and no |
| R4-2 | low-med | ApplicationFrameHost hosts every Store app: "calculator.png - Photos" closed for "close calculator" without a question | ApplicationFrameHost counts as Calculator only titled exactly "Calculator" (Settings: "Settings"); test |
| R4-3 | low | The partial-name stage ran before the listed-app stage: "close settings" (SystemSettings), "close calculator" (CalculatorApp) asked | listed-app stage right after the exact program; tests |
| R4-4 | low | "close current window" on a protected window missing from the app list (JARVIS's terminal) asked nothing | its active-window reading is used for the protection check; test |
| R4-5 | info | The protected question came before a refusal ("close vs code" with only a Chrome tab) | the close is planned first; test |

### Round 5 — **PASS** (four low/info findings)

Confirmed: R4-1…R4-5 correct; "close code" with nothing open fails without asking (right); appControlTest, adminControlTest, approvalGateStructuredTest, worldStateTest, windowsToolsTest PASS; "close powershell" asks outside the approved call; "close cmd" with only JARVIS's terminal closes nothing.

| ID | Sev | Finding | Change made |
|---|---|---|---|
| R5-1 | low | `control_window`'s protected question was still answered inside an approved call ("close window jarvis" closed JARVIS's terminal unasked) | asked through `withoutApproval`, naming the program; test (after the PASS) |
| R5-2 | low | "close windows terminal" found nothing | `'windows terminal'` → windowsterminal, `'windows powershell'` → powershell; test (after the PASS) |
| R5-3 | low | A conhost window titled "cmd.exe - npm run dev" counts as Command Prompt, and may be JARVIS started from cmd | recorded; the protected question names the window, so the owner can say no |
| R5-4 | info | On Windows 11, Calculator may be listed twice (CalculatorApp and ApplicationFrameHost): "close calculator" then asks about 2 windows | owner-PC check (R17) |

### Round 6 — **PASS** (confirmation of R5-1, R5-2)

Both changes work; no regression found. The protected-window question is asked outside an approved call and names the program ("Close: jarvis - pnpm dev (WindowsTerminal)"); "close windows terminal" finds Windows Terminal; "close powershell" unchanged; opening apps unchanged (launch aliases untouched). The reviewer's own typecheck output was unreadable; confirmed here: `npx tsc --noEmit` exit 0, 0 errors.

### Round 7 — **PASS** (owner's decision D3a, 2026-10-26: "close current window" with Chrome in front asks first)

Confirmed: the browser question is asked outside the approved call for the front window (also a second Chrome window, from the active-window reading); "no" closes nothing and is final in the queue; a protected non-browser window gets only the protected question; a browser window whose title is protected gets both questions (redundant, safe).

| ID | Sev | Finding | Change made |
|---|---|---|---|
| R7-1 | low | The front window with no program name (process lookup failed) and not in the app list closed unasked, even a Chrome window | its program is read from every visible window; still unknown → "Close Unknown Window" question; tests |
| R7-2 | low | The refusal was over 120 characters, so the route said "encountered an issue" instead of the reason | "Not closed: the Chrome window "<title>" was not approved.", title cut to 40 characters; test |

### Round 8 — **PASS** (confirmation of R7-1, R7-2)

Unknown front window: asked, nothing closed on no; the full list naming Chrome gives the browser question; yes closes after the question; Notepad in front closes with no question and no full-list read. A 74-character title gives an 89–96 character refusal, spoken by the route; still final in the queue. Note (info): a listed handle whose program name is empty and that is missing from the full list now gets the "Close Unknown Window" question instead of a refusal (safer side; recorded in the patch plan). After a "no" the route says "I tried to close the active window but encountered an issue, sir." followed by the reason.

> A PASS by a reviewer who is not independent must be reported as
> "reviewed, not independently". Never mark a check done that was not done.
