# Permission model

Risk engine: phase P2 ([prompt](phases/phase-02-risk-engine.md)).
Approval gate: phase P3 ([prompt](phases/phase-03-approval-gate.md)).

## Two separate questions

1. **How risky is this call?** — a risk level 0–4 for one concrete call, from
   the tool's metadata and its arguments (new, P2).
2. **What has the user unlocked right now?** — the session level, which already
   exists: 0 read-only, 2 full control mode (10 minutes after "enable full
   control mode" and approval).

The decision uses both. Every check that exists today keeps running; the risk
engine adds a decision on top and can only make a call harder to run.

## Risk levels

| Level | Name | Examples | Decision |
|---|---|---|---|
| 0 | Safe observation | system info, process list, windows, browser tabs, page text, read a file, git status | run |
| 1 | Low-risk action | open an app or a web page, focus a window, navigate, web search, safe diagnostic command | run |
| 2 | Moderate action | modify project files, type or click, close an app, commit, install a package, change configuration, upload | by policy (below) |
| 3 | High-risk action | delete files, kill a process, start/stop services, run a shell command, push code, change system settings | approval every time, also in full control mode |
| 4 | Critical action | delete large folders, format, disable security software, change boot or security settings, expose credentials, send private data out | never automatic: approval with a typed code; what the blocklist refuses today stays refused |

Level 2 policy, `JARVIS_LEVEL2_POLICY`:
- `session` (default): allowed while full control mode is on, refused otherwise
  with "Say 'enable full control mode'" — the behaviour before P2.
- `ask`: approval for each call, full control mode or not. Without full
  control mode the approval stands in for it during that one call, so a
  level-3 call is also asked once instead of refused.

The default session level is 1 ("safe control"), as the specification asks
for level 1 ("normally allowed automatically"). Before P2 the level was 0 or 2,
so focus and the other level-1 actions of control_app and control_window were
refused unless full control mode was on. `JARVIS_DEFAULT_PERMISSION_LEVEL=0`
restores that previous default.

## Decisions (P2, `security/riskEngine.ts`)

`assessRisk` gives one call a level, reasons and, where a rule forbids it, a
refusal; `decide` turns that into run, ask or refuse. The registry calls both
after its own checks (tool floor, argument validation), and the controllers
keep theirs, so nothing they refuse is let through.

| Call | Session below what it needs | Session has it |
|---|---|---|
| refused by a rule | refused, no prompt ("Refused by safety policy: …") | refused, no prompt |
| level 0–1 | — | runs |
| level 2 | `session`: refused with the full-control hint · `ask`: asked | runs |
| level 3–4 | `session`: refused with the full-control hint · `ask`: asked | asked every time |

What a call needs: level 2 and above need full control mode (session 2);
levels 0–1 need nothing, beyond the tool's own floor (control_app and
control_window need session 1, control_file, control_keyboard and control_mouse
need 2). Two calls need no session level, only approval: open_app targets
that always needed approval (Command Prompt; targets outside open_app's
allow-list stay refused) and turning full control mode on.

P2 asks for level 4 with the same approval as level 3; the typed code arrives
with the approval gate (P3).

If the risk check itself fails, the call is refused (fail closed).

## How a call's level is found

1. Start from the tool's risk, or the risk of the requested `action` (P1
   catalogue). An unknown action gets the tool's highest action risk.
2. Apply the argument rules. Most only raise the level; three set it from the
   arguments because the controller already treats those calls that way:
   - `run_command`: commands the developer allow-list refuses are refused
     (shell metacharacters, `rm -r`, `git push`, `git branch -D`,
     `git diff --output=…`); read-only git 0; other allow-listed commands
     (`npm run test`, `pnpm build`) 1. *(sets)*
   - `control_system` shell/powershell: the blocklist refuses (`format c:`,
     `diskpart`, firewall off); otherwise the command class can raise it
     (risk 3 in the catalogue); commands that cannot be undone are level 4:
     deleting a folder tree, system-wide registry changes, `bcdedit`, deleting
     shadow copies or backups, erasing a disk, `cipher /w`, ownership or
     permission changes, `Set-ExecutionPolicy`, scheduled tasks, user accounts.
     Deleting a drive, a user profile or a Windows system folder is refused.
   - `control_system` services: security services (Defender, firewall) are
     refused; others are 3.
   - `control_file` write: a `.txt` file in the temp folder 1 *(sets; the same
     exemption FileController makes)*; source or configuration files (`.ts`,
     `.js`, `.json`, `.py`, `.env`, `tsconfig`) 3, because FileController asks
     to approve them; other writes 2.
   - `control_file` delete and delete_folder 3; deleting a whole approved folder
     (the JARVIS folder, Desktop, Documents, Downloads, temp) 4.
   - `write_file` to a `.env` file 3.
   - `open_app`: targets that need approval (Command Prompt) 3; a dry run 0,
     because it opens nothing.
   - `control_browser` close: a YouTube or blank tab 1 *(sets; the browser
     controller's existing exemption)*; other tabs 2.
3. Planned for later phases: git push 3, push to `main`/`master` 4, force push
   refused (P10); browser form submission 2, upload 3, typing into a password
   field refused (P9).

## Approval request (P3)

When a call needs approval JARVIS stops and shows:

```
ACTION:           Kill process
WHY:              You asked to stop the frozen Notepad.
TARGET:           notepad.exe (PID 4120)
EXPECTED EFFECT:  The process ends; unsaved text in it is lost.
RISK:             Level 3 — high
REVERSIBILITY:    No
Do you approve this action?
```

Answer rules:
- Console: `APPROVE`, `YES` or `CONFIRM`, typed while this request is the one
  displayed and before it expires (30 s). Anything else, or silence, denies.
- Voice: "approve" or "confirm" within 10 s of JARVIS speaking the request;
  "yes" only in that window. Words matching JARVIS's own last speech are ignored.
- Level 4: typed `APPROVE <code>`, where the code is shown in the request.
  Voice cannot approve level 4.
- One answer approves one call. A second call needs a second request.
- The decision, with the request id, is stored on the task step, the goal and
  the security audit log.

An approved call runs in an "approved" scope (P2, `security/approvalScope.ts`),
so the controller's own approval prompt (process kill, service control,
protected app, sensitive file write) does not ask again. The scope belongs to
that one call: a call running at the same time, or waiting behind it in the
action queue, is not approved by it (both tested). A refused or cancelled
action is not retried by the action queue, so the user is not asked twice.

## What never changes

- Level-4 session checks still refuse (passwords, credentials, security bypass).
- The command blocklist, file containment, open_app allow-list and the bridge
  token stay as they are.
- Full control mode still expires after its time limit.
