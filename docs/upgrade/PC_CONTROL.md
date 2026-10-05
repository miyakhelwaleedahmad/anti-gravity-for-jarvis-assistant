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

Missing: UI Automation (reading a window's buttons and fields), screenshots on
request, clipboard, dialogs, checks after actions.

## Target

- **UI Automation first.** `control/uia.ps1` uses .NET `UIAutomationClient`
  to list the elements of the active window (name, type, automation id,
  enabled) and to invoke a button, set a field value or focus an element by
  reference. Coordinates only when an element exposes nothing.
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

## Verification

`pnpm verify:windows` (P14) runs each capability against harmless targets
(Notepad, Calculator, a temporary file), writes `data/logs/verify-windows.json`,
and prints PASS/FAIL per check. It never touches files outside the temp folder
and asks for approval before any level-2 step.
