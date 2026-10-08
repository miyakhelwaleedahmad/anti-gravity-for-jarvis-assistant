# Windows computer control

Phase P14 ([prompt](phases/phase-14-windows.md)); verification needs the owner's
Windows PC (`pnpm verify:windows`).

## Today

All control goes through `control/pcControlKernel.ts`, which queues state
changes, keeps an audit log and registers rollbacks.

| Capability | How | Session level |
|---|---|---|
| Open app | `cmd /c start "" <allow-listed target>` | 0 (open_app) / 1 (control_app) |
| Close / focus app, window actions | window handle → `control/win_automate.ps1` (Win32) | close 2, others 1 |
| Keyboard | typing through `SendKeys`, key presses through `keybd_event` | 2 |
| Mouse | screen coordinates through `SetCursorPos` / `mouse_event`: move, click, scroll, drag | 2 |
| Files | copy, move, rename, delete in approved folders | 2 (+ approval for some) |
| Processes | list, find, kill (approval, protected list) | kill 2 + approval |
| Services, shell | PowerShell with approval and blocklist | 2 + approval |
| Screen capture | `vision/screen_capture.py` (mss + OCR) — started, never activated | — |

Missing before P14: UI Automation (reading a window's buttons and fields),
screenshots on request, clipboard, dialogs, checks after actions. Built since:
see "Built in P14" below.

## Target

- **UI Automation first.** `control/uia.ps1` uses .NET `UIAutomationClient`
  to list the elements of the active window (name, type, automation id,
  enabled) and to invoke a button, set a field value or focus an element by
  reference. Coordinates only when an element exposes nothing. It registers
  the library's helpers for classic Win32 controls itself before reading
  (without them every classic control is a plain pane, as on the owner's
  PC), and a list says whether that worked (`classicControlHelpers`) and
  which elements or children could not be read (`problems`).
- **Observe before acting.** JARVIS reads the active window and its elements
  first, then acts on an element it has seen.
- **Verify after.** Closing a window: it is gone from the window list. Opening
  an app: its process and a window appear. Typing: the field holds the text.
- **Screenshots on request** (level 1): saved under the data folder; sent to
  the model only when the request needs it and the user's settings allow it.
- **Clipboard:** read level 1 (redacted before the model sees it), write level 2.
- **Dialogs:** a dialog's buttons are UI Automation elements; pressing one
  that confirms a deletion or an install is level 3.

## Risk levels

| Action | Risk |
|---|---|
| read window list, elements, active window | 0 |
| focus, minimise, maximise, move, resize a window; open an allow-listed app | 1 |
| close a window or app; type; click an element; clipboard write | 2 |
| dialog buttons that confirm deletion, installation or system changes | 3 |
| anything touching security software, credentials or system-critical settings | 4 |

## Built in P14

| Tool | Does | Level | Checks after |
|---|---|---|---|
| `windows_overview` | GPU, displays, audio (speakers and microphones told apart), cameras, installed apps, services, listening ports with their program, visible windows with their program and its ports; at most 80 entries for the model, or those matching `filter` | 0 | — |
| `ui_elements` | the buttons, fields, menus and texts of a window (default: the one in front), breadth first to depth 6, at most 200, each with a reference such as `u12`; never a password field's contents | 0 | — |
| `ui_action` | invoke (button, box, list item, menu), set_value, focus — of an element listed in the last 10 minutes that still has the name and type JARVIS saw. set_value uses the Value pattern; a classic multi-line text box (Notepad's), which has none, is set through its own window handle (WM_SETTEXT) | 1–4 | the field holds the text; the element has the focus; the press happened |
| `screenshot` | the screen or the window in front, as a PNG in `data/screenshots/` (not in git); nothing is sent anywhere | 1 | a PNG of the size is on disk |
| `clipboard` | read (at most 2 000 characters, secrets hidden) or write | 1 / 2 | the clipboard holds the text |

Window and app actions are checked on the desktop (`core/verifiers.ts`):
closing a window — Windows is asked whether that window handle still exists
(up to 3 s; one asking whether to save is reported as still open); focus —
it is in front; minimise or maximise — it is; opening an app — a visible
window of it, by title or program (Calculator's window belongs to
ApplicationFrameHost, VS Code's program is "Code"), or its process. Off
Windows these say "checked on Windows only".

How PowerShell is run (`perception/windowsProbe.ts`):

- Three fixed files — `perception/windows_probe.ps1`, `control/uia.ps1`,
  `control/desktop.ps1` — each started on its own with `powershell.exe
  -NoProfile -NonInteractive -File`, no shell. Nothing is ever pasted into
  a command or a script.
- Values go in through `JARVIS_*` environment variables, refused in
  TypeScript if they hold a line break or other control character, and
  checked again in the script (a section from a fixed list, a handle that is
  digits, a runtime id that is digits and dots). Text for a field or the
  clipboard goes in a temporary file (deleted afterwards) whose path is the
  variable.
- Not the persistent session of `perception/windowsState.ts`: these can take
  seconds, and that session serves the window poll every 4 s.
- Plain ASCII files, so Windows PowerShell 5.1 reads them the same with or
  without a byte-order mark; output is UTF-8.

## Verification

`pnpm verify:windows` (`scripts/verifyWindows.ts`) runs on the owner's PC, in
CMD. It asks once, in that window, to turn on full control mode for 15
minutes — the typed console approval of P3 — and the level-2 steps then run
under it (with `JARVIS_LEVEL2_POLICY=ask` each also asks). Then: every
`windows_overview` section; the disks by drive letter (P6); a screenshot,
deleted again; the clipboard written, read back and the old text put back;
Notepad opened, its text field filled and read back, closed ("Don't save" if
it asks, looked for in that Notepad window, never in another program's);
a second, empty Notepad minimised, focused, maximised, moved, resized and
closed through `control_window`; Calculator, 1 + 2 = pressed and 3 read,
with its window state, the program in front and its elements recorded after
each press, closed; a test server in
the temp folder started and stopped (P10's taskkill). Only windows the pack
opened are touched, found by comparing the window list before and after.
The report, redacted, goes to `data\logs\verify-windows.json` (not in git).

The old clipboard text is kept in memory only, to be put back; a picture or
files on the clipboard are not, so the pack says to copy them again.

## Known limits

- Until Step C (2026-10-08) no window action of `control_window` or of the
  app close and focus did anything: `win_automate.ps1` read the action from
  `-Action` (always `control-window` there) and had no `-ActionType`, so it
  matched nothing and printed nothing, and the close check, finding no window
  named, passed it as not checked. Now each action reaches its own Win32
  call, one that cannot be done is an error, and a close is checked strictly:
  no result naming the window, another window than the handle asked for, or
  a check that could not decide is a failed close.
- Each window action first finds the window through the older persistent
  PowerShell session; on the owner's PC that session timed out (15 s), and a
  close took 10–21 s. Not changed yet.

- `win_automate.ps1` and the window poll still list one window per program
  and at most 20 programs; `ui_elements` and the checks above read every
  visible window.
- Win32 dialogs that block their caller can make an invoke wait: it is
  stopped after 30 s, and JARVIS says a dialog may have opened.
- `Win32_VideoController` reports at most 4 GB of graphics memory.
- Every reading, UI Automation call and desktop check starts a fresh Windows
  PowerShell. In the first run of `pnpm verify:windows` on the owner's 2010
  iMac (2026-10-07), gpu, displays, audio, cameras and services went past
  the first limits of 10–15 s; in the second run the same day PowerShell
  started in 0.4 s and every reading took 0.8–2.8 s. What slowed the first
  run is not known. The limits are now 45–60 s for readings, 60 s for
  listing a window's elements, 30 s for an action, a window's state or the
  clipboard, and 45 s for a screenshot; the checks after window and app
  actions may take 60 s and look at least twice. When PowerShell is fast,
  none of this changes anything.
