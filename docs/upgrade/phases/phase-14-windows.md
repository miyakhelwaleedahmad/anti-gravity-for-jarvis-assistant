# Phase 14 — Windows observation and control

## Goal
Windows-only observation (GPU, displays, audio devices, cameras and
microphones, installed apps, services, ports with owning process, process ↔
window, clipboard) and control (UI Automation, screenshots, clipboard write,
dialogs, checks for window and app actions), plus `pnpm verify:windows`.

## Current system context
- Persistent PowerShell session (`perception/windowsState.ts`) for windows and apps.
- `control/win_automate.ps1`: Win32 window control by handle, `SendKeys`
  typing, `keybd_event`, `SetCursorPos`/`mouse_event`.
- `vision/screen_capture.py`: mss + OCR, idle (nothing sends `vision_start`).

## Required changes
1. `perception/windowsProbe.ts` (+ PowerShell snippets) for the observation list.
2. `control/uia.ps1` + `control/uiAutomation.ts`: list elements of the active
   window, invoke, set value, focus — by reference.
3. Screenshots on request (PowerShell `System.Drawing`), optional OCR through
   the vision service.
4. Clipboard read (1, redacted) / write (2); dialogs through UI Automation.
5. Verifiers for window and app actions (P5 hook).
6. `scripts/verifyWindows.ts`, `pnpm verify:windows` → `data/logs/verify-windows.json`.
   It also checks what earlier phases could only check on Linux: P6's drive
   letters and free space (`systemProbe.driveRoots` / `statfs` on C:\ and the
   other drives), and P3's console approval in a real CMD window.

## Implementation steps
1. Observation commands (read-only, fixed text, no user input in the script):
   `Get-CimInstance Win32_VideoController`, `Win32_DesktopMonitor` /
   `[System.Windows.Forms.Screen]::AllScreens`, `Win32_SoundDevice`,
   `Get-PnpDevice -Class Camera,Image,AudioEndpoint -PresentOnly`, uninstall
   registry keys (name, version, publisher), `Get-Service` (name, status,
   start type), `Get-NetTCPConnection -State Listen` joined with `Get-Process`;
   all through the existing persistent session where possible.
2. UI Automation: `Add-Type -AssemblyName UIAutomationClient`; walk the
   active window's tree to depth 4, max 200 elements; reference = runtime id;
   actions via `InvokePattern`, `ValuePattern`, `SetFocus`.
3. Screenshot: `CopyFromScreen` → PNG under the data folder; not sent to the
   model unless the request needs it.
4. Clipboard: `Get-Clipboard` / `Set-Clipboard` with the text passed through a
   temp file, never interpolated.
5. Verifiers: window gone after close; process present after open; focused
   window is the target after focus; field value after set-value.
6. Verification pack: each capability against Notepad, Calculator and a temp
   file; level-2 steps ask first; report PASS/FAIL with evidence.

## Files to inspect
`perception/windowsState.ts`, `perception/get_windows_state.ps1`,
`control/win_automate.ps1`, `control/windowController.ts`, `control/appController.ts`,
`vision/screen_capture.py`.

## Files that may be modified
New files above, `control/windowController.ts`, `control/appController.ts`,
`core/toolCatalog.ts`, `security/riskEngine.ts`, `package.json` (script), tests, docs.

## Dependencies
P1–P13.

## Tests
Here: parsers tested with recorded PowerShell output; scripts checked for
fixed text (no interpolation of arguments). Windows: `pnpm verify:windows`.

## Acceptance criteria (Windows)
The owner runs `pnpm verify:windows` in CMD and every check passes. Until the
report is back, the phase is `[!] BLOCKED`.

## Security requirements
No argument interpolated into PowerShell; clipboard redacted before the model;
screenshots local by default; dialog confirmations of deletion/installation level 3.

## Failure conditions
Any check failing on Windows; any PowerShell built from user or model text.

## Completion requirements
Gate (including the Windows report); checklist; PHASE_STATUS; PC_CONTROL;
commit `phase-14-windows`; CI green.

## As built (alignment note)
- Observation, UI Automation, screenshots, clipboard and the window and app
  checks are built ([PC_CONTROL.md](../PC_CONTROL.md)); `pnpm verify:windows`
  is `scripts/verifyWindows.ts`.
- The readings run in their own short PowerShell processes, not the
  persistent session: they can take seconds, and that session serves the
  window poll every 4 s.
- Windows are read with EnumWindows (every visible top-level window), not
  `Process.MainWindowTitle` (one per program): Store apps such as Calculator
  share one ApplicationFrameHost process, so a new Calculator window could be
  missed and a window could look closed when it was only not listed.
- The window checks ask Windows about one handle (`IsWindow`,
  `GetForegroundWindow`, `IsIconic`, `IsZoomed`) instead of reading a list.
- The pack asks once, to turn on full control mode, instead of before each
  level-2 step: the same permission model, one prompt instead of ten.
- OCR through the vision service is not used: screenshots are saved locally
  and their path is returned.
- Status: `[!] BLOCKED` until the owner sends `data\logs\verify-windows.json`.
