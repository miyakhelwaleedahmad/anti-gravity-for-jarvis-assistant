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

Level 4 is approved only with a code typed in the console (P3, below).

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
   - Browser actions (P9, `security/browserPolicy.ts`). Element actions name
     an element JARVIS has looked at (a reference from
     `browser_page_structure`); any other reference is refused. The level comes
     from what that element was when JARVIS looked:
     - `browser_click` 1; a button that submits a form, or anything in a form
       with a password field, 2; by its label — "send", "post", "save", "sign
       in", "subscribe" and similar 2, "delete", "remove", "unsubscribe",
       "cancel subscription" 3, "pay", "buy", "checkout", "place order",
       "transfer", "donate" 4. The label rule is a heuristic: it only raises.
       A link that downloads is refused (use `browser_download`).
     - `browser_type` into a search box 1, any other field 2; password, card
       number, card code and one-time-code fields are refused.
     - `browser_select` 1; in a form 2.
     - `browser_navigate` and `browser_tab new`: only http and https addresses,
       without a user name or password in them; `javascript:`, `file:`,
       `data:` and the rest are refused.
     - `browser_tab close` 2; `browser_download` 2; `browser_upload` 3, only
       from the approved folders, never keys or credential files (`.env`,
       `id_rsa`, `.pem`, `.key`, `.kdbx`, anything in `.ssh`, `.aws`…).
   - Files, git and development (P10, `security/fsPolicy.ts`,
     [FILES_AND_DEV.md](FILES_AND_DEV.md)):
     - `files`: list, search, compare and trash 0; create and modify 2 — a
       `.txt` in the temp folder 1 *(sets)*, source, configuration and key
       files 3; rename, move and restore 2; delete 3 (to the JARVIS trash);
       empty_trash 3. Paths outside the approved folders (by real path),
       files that run when opened, and a whole approved folder are refused.
     - `git`: status, diff, branches, log 0; commit and switch 2.
       `git_push` 3; to `main` or `master` 4; any `force` argument refused;
       repositories outside the project folders refused.
     - `dev`: scripts and servers 0; run (test, build, lint, typecheck,
       check) and start_server (dev, start, serve, preview) 1; other scripts
       refused; stop_server 2, only for servers JARVIS started.

## Repairs (P11)

A repair of a failed step ([ERROR_RECOVERY.md](ERROR_RECOVERY.md)) is an
ordinary tool call: same levels, same decisions, same approval. Its approval
request shows the failure as WHY ("To finish your request, JARVIS needs to
repair this: port 3000 is held by a server JARVIS started earlier").

## Approval request (P3, `security/approvalRequest.ts`, `security/approvalGate.ts`)

When a call needs approval JARVIS stops and shows (console) and says (voice):

```
=================================================================
JARVIS NEEDS YOUR APPROVAL  (request apr_muw8a4kv_dibk)
-----------------------------------------------------------------
  ACTION:           End process
  WHY:              You asked: "end the frozen notepad process"
  TARGET:           notepad
  EXPECTED EFFECT:  Ends a process; its unsaved work is lost.
  RISK:             Level 3 — high
  REVERSIBILITY:    No
-----------------------------------------------------------------
  Do you approve this action?
  Type APPROVE, YES or CONFIRM within 30 s.
  Anything else, or no answer, cancels it.
=================================================================
```

Spoken: "Sir, I need your approval to end process on notepad. Risk level 3. It
cannot be undone. Do you approve this action? Say approve or cancel." (Since
P12 it ends on "cancel": an echo of its last word can only deny; before, it
ended on "confirm".)

Where the fields come from: ACTION from a title per tool action; WHY from the
user's words for this request (or, with none, the reason approval is needed);
TARGET from the arguments; EXPECTED EFFECT and REVERSIBILITY from the tool's
metadata (P1); RISK from the risk engine, with the argument rule that set it
when there is one. Every field passes through the redactor first
(`security/redactor.ts`), so a key in a command is shown as
`[REDACTED:openai-key]`.

Answer rules:
- Typed: `APPROVE`, `YES` or `CONFIRM`, while this request is displayed and
  before it expires (30 s). Anything else, an empty line, or silence denies. A
  line typed when nothing is displayed is not an answer to anything.
- Spoken: "approve", "confirm" or "yes" (also "yes sir", "I approve"), counted
  only from the moment JARVIS has finished saying the request — and anything
  else it was saying before it — until 10 s later. Words heard while JARVIS is
  speaking are its own voice and are ignored, so its "say approve or cancel"
  cannot approve anything. Since P12 this holds for anything JARVIS says while
  the request waits (a reminder, "Voice cannot approve this one"), while it
  plays and for 0.3 s after; before, an "approve" heard during such a message
  approved, and the echo of "Voice cannot approve this one" denied a level-4
  request the user was about to approve with the code. "no", "cancel", "stop"
  deny. Any other sentence denies the request and is then handled as a new
  command.
- An answer is consumed: it is not also run as a command. (Before, the typed
  answer went to the command prompt as well, and the spoken one to the echo
  filter.)
- Level 4: only `APPROVE <code>` typed, with the 4-character code shown in the
  request (new for each request). `APPROVE` or `YES` alone denies; a spoken
  "approve" is refused with "Voice cannot approve this one".
- One request is displayed at a time; parallel steps wait their turn. One
  answer approves one call.
- A controller's own question (closing a protected app, a dangerous keyboard
  shortcut) is asked the same way, by voice when the request was spoken.

Each decision — request id, approved or not, by whom (`console`, `voice`,
`timeout`, `unavailable`, or `scope` for a controller check covered by the
call's approval), the answer, the time — is stored on the task step
(`node.approvals`), on the goal (`metadata.approvals`) and in the security
audit log (with the six fields); the last 50 are kept in memory
(`approvalGate.recentDecisions()`, for P4's action history).

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
