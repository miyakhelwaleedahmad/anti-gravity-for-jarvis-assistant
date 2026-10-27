# Issue Brief — JARVIS-owned Chrome and "close the browser" (phase A2)

## One-Sentence Problem Description

JARVIS opens web pages in the default browser (the everyday Chrome) but can only see and control a separately started debug Chrome, and it cannot start that Chrome, close it, or tell the owner how to start it on anything but Windows.

## Exact Symptoms

- "Open YouTube", then "close the YouTube tab": the page opened in the everyday Chrome, which JARVIS's tab tools cannot see (TRA-03, audit A section D; needs the PC to confirm).
- With no debug Chrome running, YouTube and site searches, and `control_browser open_url`, open the page in the default browser and say it could not be checked.
- "Close the browser", "close chrome": no route and no action; the planner has nothing that closes a browser as such (TRA-17). Since phase A1, app, window and process tools refuse browsers by design (D3).
- Off Windows, every "Chrome is not reachable" message tells the owner to run `chrome.exe` (TRA-16).

## Expected Behavior

Owner decisions D1 and D3 (`docs/audit/TOOL_REPAIR_PHASES.md`):
- JARVIS starts its own Chrome (its own profile and debugging port) when it needs one, and opens pages in it. The everyday Chrome is never touched.
- "Close the browser" / "close Chrome" closes JARVIS's Chrome only, after the owner confirms.
- When JARVIS's Chrome cannot start, the reply says so and names the fix, for this platform.

## Actual Behavior

See `reproduction.md`: probe output for each point above, run on the current code (`84b9c03`).

## Environment

- Branch `claude/jarvis-repair`, commit `84b9c03`.
- Cloud: Linux, Node 22, Chromium 141 (`/opt/pw-browsers/chromium`); no Windows, no display.
- Owner's PC: Windows 10 (19045), Chrome (version not recorded).

## Runtime Issue Record

None; the audit report is the source (TRA-03, TRA-16, TRA-17).

## Files Likely Involved

`perception/cdpClient.ts`, `control/browserController.ts`, `control/browserAgent.ts`, `skills/automation/skill.ts` (protected), `core/tools/youtubeTools.ts`, `perception/chromeState.ts`, `skills/control_browser/skill.ts`, `control/pcControlKernel.ts`, `core/deterministicRoutes.ts` and `core/orchestrator.ts` (protected), `security/riskEngine.ts` (protected), `core/verifiers.ts`, `core/toolCatalog.ts`, `core/planningToolSelection.ts`, `control/appMatch.ts`.

## What Has Already Been Tried

Phase A1 stopped app, window and process tools from closing browsers. Nothing has started or closed a browser JARVIS owns.

## Ready to Advance to Diagnosis?

Yes.
