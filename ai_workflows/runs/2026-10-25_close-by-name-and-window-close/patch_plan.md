# Patch Plan — Close by name; tab requests close whole windows; process kill reports success unchecked

> Stage: 03_patch_plan
> Status: [ ] Awaiting Approval / [x] Approved (scope, in advance; see Approval) / [ ] Rejected
> Date: 2026-10-25 · Base commit: `e394a26`

## Summary
One matching rule for app and window tools (Windows names have no `.exe`; Calculator by its title; the exact program first); browser windows are never closed or killed through app, window or process tools (owner decision D3); several matching windows need a yes; a kill succeeds only when the process is gone; tab requests aren't offered the app and window tools.

## Proposed Changes
### Change 1 — `control/appMatch.ts` (new)
`programKey` (lower case, no `.exe`), `programFor` ("google chrome" → `chrome`, "edge" → `msedge`), `browserName`, `appWindowMatcher` (moved unchanged from `core/verifiers.ts`), `matchAppWindows` (program name first, exact before substring; else window title), `planAppClose` (`none | browser | browser-page | close`), the two refusal texts, `hasHandle`.

### Change 2 — `control/appController.ts`
Constructor takes `{ windows, automate, approve }` (defaults: `getWindowsState`, `runAutomateScript`, `approvalGate.requestApproval`). `closeApp` uses `planAppClose`: no match → the same "No open application matches" error (`restartApp` depends on it); browser → refusal; browser page → refusal pointing to the tab; more than one window (not protected) → one approval question naming them. `focusApp`, `isAppOpen` use `matchAppWindows`. `openApp` and its launch aliases are unchanged.

### Change 3 — `control/windowController.ts`
Same constructor arguments plus `allWindows` (every visible window). `closeWindow` by name takes the window from `planAppClose` (never a browser window). By handle: the owner comes from the app list, or from every visible window when it is not there; a browser owner, an unknown handle or an unreadable list is refused. "Close current window" closes the window in front; a browser window only after the owner confirms it (owner's decision, see Risk). Protection is checked on the window being closed.

### Change 4 — `control/processController.ts`
Constructor takes `{ powershell, approve }`. `killProcess` prefers the exact name, refuses browser processes (D3) before asking, checks Stop-Process's exit code, then checks `Get-Process -Id` and fails if the process still runs. The approval text is unchanged (`approvalScope` matches on it).

### Change 5 — `core/planningToolSelection.ts`, `core/verifiers.ts`
A close request that names a tab gets `control_browser`, `browser_tab` instead of `control_app`, `control_window`. `verifiers.ts` imports and re-exports `appWindowMatcher`.

### Change 6 — tests and docs
`tests/closeByNameTest.ts` (new); `package.json` `test:pc-control` gains `closeByNameTest`; `TEST_MATRIX.md` count 17 → 18; `ARCH_PC_CONTROL.md` lists `appMatch.ts`; `docs/audit/TOOL_REPAIR_PHASES.md` checklist.

## Files That Will Change
`control/appMatch.ts` (new), `control/appController.ts`, `control/windowController.ts`, `control/processController.ts`, `control/actionQueue.ts` (added after review round 1, R14), `core/planningToolSelection.ts`, `core/verifiers.ts`, `tests/closeByNameTest.ts` (new), `package.json` (one script line), `ai_workflows/_config/TEST_MATRIX.md`, `ai_workflows/_config/ARCH_PC_CONTROL.md`, `docs/audit/TOOL_REPAIR_PHASES.md`, `docs/audit/JARVIS_TOOL_RELIABILITY_AUDIT_2026-10-25.md` (the audit itself, first commit).

None is in `RUNTIME_PROTECTED_FILES.md`. `core/deterministicRoutes.ts`, `skills/automation/skill.ts` and `security/*` are not touched.

## Reproduction (from Stage 02b)
REPRODUCED: `closeByNameTest` 10 passed / 26 failed on `e394a26` + hooks only.

## Tests to Run After Implementation
closeByNameTest, appControlTest, processControlSafetyTest, windowsToolsTest, windowControlTest, taskFailureHonestyTest, closeAppRouteTest, routeGoldenTest, toolDiscoverabilityAuditTest, plannerDecisionAuditTest, plannerDesktopToolSelectionTest, registryRepairHonestyTest, riskEngineTest, adminControlTest, verifyAfterActTest, windowsStateFreshnessTest, childEnvCoverageTest, browserControlAgentTest, deterministicCommandRouteTest, systemStateRouteTest, dispatchAuthzTest, executionDispatchAuditTest, errorRecoveryTest, scenarioIntegrationTest, boundaryDoublesTest, docsHygieneTest; then `pnpm test -- --ci` and `pnpm run typecheck`.

## Live Voice Verification Required?
- [ ] Yes — this change affects the voice pipeline
- [x] No — this is a non-voice change (the "close notepad" voice route reaches it, but the route itself is unchanged). A Windows desktop check by the owner is owed.

## Risk Assessment
- "close chrome" through app/window/process tools now refuses, where it used to close windows (by title) or nothing. This is the owner's D3; phase A2 adds "close the browser" for JARVIS's Chrome.
- A title-only match that mixes browser and other windows closes only the others.
- Exact-name preference: "close notepad" no longer also closes `notepad++`.
- Two or more matching windows now ask first: one extra question where it used to close them all.
- Windows behaviour is inferred from `Process.ProcessName`; owed on the PC.
- **Owner's decision (2026-10-26, R9):** "close current window" with Chrome in front does not close it on that command alone: JARVIS asks the owner to confirm that specific Chrome window ("Close the Chrome window "<title>" and all its tabs"), outside any approval already given; no → nothing closed. Closing by name, by a handle from a window list, by app or by process refuses browser windows. Existing safety and confirmation rules unchanged.
- A name that is only part of a program's name asks first: "notepad" with only Notepad++ open, "close word" (WINWORD). A listed app found in another program's window asks too ("calculator.py - Notepad" for "close calculator").
- "close calculator", "close vs code", "close command prompt" match their own program's window (`APP_HOSTS`) and ask nothing extra.
- Closing by a handle that is not a main window, or whose program is unknown, reads every visible window once (a fresh PowerShell, up to 15 s). A handle not in any list is refused; one listed with no program name gets a confirmation question.
- After a refused close, the spoken reply starts "I tried to close the active window but encountered an issue, sir." and then gives the reason.
- A mixed request ("close notepad and the youtube tab") is offered the tab tools only; phase A3 (routing).
- Protected apps (cmd, PowerShell, Windows Terminal, VS Code, Antigravity) are asked about once, outside any approval already given, naming the windows; a console titled "cmd.exe …" counts as Command Prompt even if it runs JARVIS (review R5-3): the question shows its title.

## Approval
The owner approved this scope in advance on 2026-10-25: "make phases of each report … when you don't fix a report phase one so don't move to a second phase … go on the two phases", after the phase plan made A1 = TRA-04, TRA-18, TRA-06. The owner also answered D1 (JARVIS-owned Chrome) and D3 (close JARVIS's Chrome only). Pushing still needs approval (Gate 2).

**Deviation:** this detailed plan was written after the implementation and was not shown to the owner before Stage 04. It stays inside the approved scope (phase A1 of `docs/audit/TOOL_REPAIR_PHASES.md`) and changes no protected file. The extra question for several windows, and the refusal of browser processes, follow from D3 and are listed here for the owner to confirm.
