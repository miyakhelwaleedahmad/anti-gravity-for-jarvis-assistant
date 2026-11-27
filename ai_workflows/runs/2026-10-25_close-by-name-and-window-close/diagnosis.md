# Diagnosis — Close by name; tab requests close whole windows; process kill reports success unchecked

> Stage: 02_diagnosis
> Status: [x] Complete
> Date: 2026-10-25 · `e394a26`

## Root Cause (Primary Hypothesis)
1. **TRA-04 — name normalisation.** `APP_ALIASES` (`appController.ts:16-23`) rewrites `notepad`→`notepad.exe`, `chrome`→`chrome.exe`, `calculator`→`calc.exe`. That table is meant for `cmd /c start`. `closeApp`, `focusApp` and `isAppOpen` reuse it to *match* windows, comparing with `openApps[].name`. Every source of that list (`perception/windowsState.ts:95-96` inline script, `get_windows_state.ps1`, `windows_probe.ps1:124-129`, `freshWindowList`) fills `name` from `Process.ProcessName`, which has no `.exe`. Window titles don't contain "notepad.exe" either. Calculator's window belongs to `ApplicationFrameHost`; its title is "Calculator". The verifier's own `appWindowMatcher` (`core/verifiers.ts:290-293`) strips `.exe`, but the controller doesn't use it.
2. **TRA-18 — title matching without a browser rule.** `closeApp` matches `name.includes(t) || windowTitle.includes(t)` and closes **every** match (`appController.ts:109-126`). "youtube" matches "YouTube - Google Chrome" and closes that whole Chrome window; "google chrome" matches every Chrome window. `windowController.findHwnd` (`:15-33`) does the same for one window. The planner offers `control_app`, `control_window` for any close request, before the tab tools (`planningToolSelection.ts:115-137`).
3. **TRA-06 — success not checked.** `killProcess` takes `matches[0]` of a substring filter, runs `Stop-Process -Force` with `reject:false`, ignores the exit code, and returns "Successfully terminated" (`processController.ts:57-84`). `control_process` has no verifier (`verifiers.ts:401`).

## Supporting Evidence
- Audit probe `close_app.json` (scratchpad export, stubbed window list with `name: "notepad"`): `closeApp('notepad')` → "No open application matches"; `closeApp('youtube')` reached the close script for the Chrome window.
- Audit probe `planner_tools.json`: "Close the YouTube tab" → `control_app, control_window, browser_tab, …, control_browser`.
- [.NET `Process.ProcessName`](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.processname?view=net-8.0): "does not include the .exe extension".
- Tests: `appControlTest` checks protection only; `taskFailureHonestyTest` stubs `closeApp`. No test runs the matching with real-shaped data.

## Control Flow Trace
"close notepad" → `deterministicRoutes.ts:206` `close_app` → `orchestrator.ts:678` `runRoutedTool('control_app', {action:'close', target:'notepad'})` → `toolRegistryV2.execute` → `skills/control_app` → `pcControlKernel.closeApp` → `appController.closeApp('notepad')` → `resolveTarget` → `notepad.exe` → filter over `getWindowsState().openApps` → 0 matches → throws → "I tried to close the application…".

## Alternative Hypotheses
- The window list is empty because the PowerShell session is busy: fixed earlier (`freshWindowList`, `windowsStateFreshnessTest`). It can still happen, but it doesn't explain the `.exe` mismatch.

## Files That Would Need to Change
- `control/appMatch.ts` (new): one matching rule for app and window tools (no `.exe`, browser rule).
- `control/appController.ts`, `control/windowController.ts`, `control/processController.ts`: use it; injectable dependencies for tests.
- `core/verifiers.ts`: `appWindowMatcher` moves to `control/appMatch.ts` and is re-exported.
- `core/planningToolSelection.ts`: tab requests aren't offered `control_app`/`control_window`.

## Evidence Labels
- TRA-04: CONFIRMED logic (probe) + vendor docs; Windows effect INFERRED.
- TRA-18: CONFIRMED path (probe); the planner's choice INFERRED.
- TRA-06: CONFIRMED code.

## Proposed Reproduction (for Stage 02b)
A new test `tests/closeByNameTest.ts` with real-shaped window and process lists (names as `ProcessName` gives them) and stand-ins for the window list, `win_automate.ps1`, PowerShell and the approval question. Run it in a scratchpad export of `e394a26` where only the stand-in hooks are added (no logic change): it must fail. Then on the fixed code: it must pass.

## Ready to Advance to Reproduction?
- [x] Root cause identified (or hypotheses ranked)
- [x] Evidence documented and labelled
- [x] Files to change listed
- [x] Reproduction method proposed
- [x] No code edits made during this stage
