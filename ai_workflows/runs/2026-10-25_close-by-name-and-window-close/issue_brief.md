# Issue Brief — Close by name; tab requests close whole windows; process kill reports success unchecked

> Stage: 01_intake
> Status: [x] Complete
> Date: 2026-10-25 · Branch `claude/jarvis-repair` @ `e394a26` · Phase A1 of `docs/audit/TOOL_REPAIR_PHASES.md`

## One-Sentence Problem Description
"Close notepad" and "close Chrome" can't find the app, "close the YouTube tab" can close whole Chrome windows, and a process kill reports success without checking.

## Exact Symptoms
From the audit `docs/audit/JARVIS_TOOL_RELIABILITY_AUDIT_2026-10-25.md`:
- TRA-04 (P1): `control_app close/focus` for `chrome`, `notepad`, `calculator` never match. The deterministic "close notepad" route fails; `restart` opens a second copy.
- TRA-18 (P1): `control_app close "youtube"` / `"google chrome"` closes every Chrome window whose title matches; `control_window close "chrome"` closes one Chrome window. For "close the YouTube tab" the planner is offered `control_app` and `control_window` first.
- TRA-06 (P2): `control_process kill` takes the first substring match and returns "Successfully terminated" whatever Stop-Process did.

## Expected Behavior
- `close notepad` closes Notepad's window; `close calculator` closes Calculator's.
- A site or tab name never closes a browser window through app/window tools; JARVIS points to the tab command.
- Owner decision D3 (2026-10-25): JARVIS never closes the everyday Chrome; "close the browser" closes only JARVIS's own Chrome (phase A2).
- Several matching windows: JARVIS asks before closing them all.
- A kill reports success only when the process is gone.

## Actual Behavior
See symptoms. Code: `control/appController.ts:16-23, 92-128, 136-141, 186-195`; `control/windowController.ts:15-33, 56-75`; `control/processController.ts:57-84`; `core/planningToolSelection.ts:115-137`.

## Environment
- [ ] Live voice runtime (`pnpm run dev` + real microphone)
- [ ] CLI input (typed into terminal)
- [x] Test only (mock test) — cloud Linux; audit probes in a scratchpad export
- [ ] Unknown

Windows effect inferred from code and the .NET `Process.ProcessName` documentation (no `.exe`); not observed on the owner's PC.

## Runtime Issue Record
Not read: no runtime issue record exists for these findings; the source is the audit report.

## Files Likely Involved
`control/appController.ts`, `control/windowController.ts`, `control/processController.ts`, `core/verifiers.ts` (`appWindowMatcher`), `core/planningToolSelection.ts`.

## What Has Already Been Tried
Nothing; first repair run for these findings.

## Ready to Advance to Diagnosis?
- [x] All symptoms documented
- [x] Expected vs actual behavior clear
- [x] Issue record copied, or "not read" with the reason (never invented)
- [x] No secrets or unneeded personal data in this file
- [x] File list ready
- [x] No code edits made during this stage
