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
  with "Say 'enable full control mode'" — today's behaviour.
- `ask`: approval for each call, full control mode or not.

Level 1 needs session level 1 ("safe control"). That level is defined today but
never granted (the session is 0 or 2), so focus and open-URL are refused unless
full control mode is on. P2 makes the default session level 1, as the
specification asks ("normally allowed automatically");
`JARVIS_DEFAULT_PERMISSION_LEVEL=0` restores the read-only default.

## How a call's level is found

1. Start from the tool's risk, or the risk of the requested `action`.
2. Raise it from the arguments:
   - commands (`run_command`, `control_system` shell/powershell): the existing
     command classes — SAFE_READ_ONLY 0, LOW 1, MEDIUM 2, HIGH 3, CRITICAL 4;
   - file deletes 3; a folder delete covering many files 4;
   - writes outside the temp folder at least 2;
   - process kill and service start/stop/restart 3; security services 4 (refused);
   - open_app targets that need approval (Command Prompt) 3;
   - git push 3, push to `main`/`master` 4, force push refused (P10);
   - browser form submission 2, upload 3, typing into a password field refused (P9).
3. Unknown action or argument → the tool's highest action risk, never lower.

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

An approved call runs in an "approved" scope, so the controller's own approval
prompt (process kill, service control, protected app) does not ask again.

## What never changes

- Level-4 session checks still refuse (passwords, credentials, security bypass).
- The command blocklist, file containment, open_app allow-list and the bridge
  token stay as they are.
- Full control mode still expires after its time limit.
