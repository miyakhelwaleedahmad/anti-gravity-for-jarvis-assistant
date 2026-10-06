# Security model

## Protections that exist today (kept, never loosened)

| Protection | Where |
|---|---|
| Bridge listens on 127.0.0.1 only and requires `JARVIS_BRIDGE_TOKEN` | `bridge/nodeBridge.ts` |
| Session permission levels, full control mode with expiry, persisted | `control/permissionSession.ts` |
| Dispatch-level floor per tool (`requiredLevel`), checked before arguments | `core/toolRegistryV2.ts` |
| Command classes and blocklist (format, disk wipes, Defender, firewall, shutdown) | `security/permissionManager.ts`, `control/adminController.ts`, `tools/terminalTool.ts` |
| Developer allowlist for run_command | `tools/terminalTool.ts` |
| File containment: project folder for read/write_file; project, temp, Desktop, Documents, Downloads for control_file; Windows system folders refused on any host | `core/workspaceRoot.ts`, `security/workspacePathPolicy.ts`, `control/fileController.ts` |
| open_app allow-list; Command Prompt needs approval | `skills/automation/skill.ts` |
| Deterministic router accepts only fixed aliases (no injection) | `core/orchestrator.ts` |
| Service names checked before PowerShell; security services refused | `control/adminController.ts` |
| Text read from the screen or pages enters the prompt as untrusted data | `core/orchestrator.ts`, system prompt |
| Human approval for dangerous actions, deny on timeout | `security/approvalGate.ts` |
| Audit logs: security, tool (high risk), actions, permission session | `data/logs/`, `logs/` |
| Sandbox time and concurrency limits per execution risk | `core/toolExecutionSandbox.ts` |
| Tests use a temporary data folder, never real memory | `tests/runAll.ts` (`JARVIS_DATA_ROOT`) |

## Added by the upgrade

| Addition | Phase |
|---|---|
| Risk 0–4 per call from metadata and arguments | P2 |
| Structured approval bound to one displayed request; level 4 typed code; decisions recorded | P3 |
| Secret redaction before the LLM, memory and logs | P4 |
| Observations kept out of long-term memory; `save_relation` refuses secrets | P4 |
| Rate limits per tool; tools that change outside systems are at least level 2 | P4 |
| Action history tool (redacted) | P4 |
| Verification after actions | P5 |
| Fixed in-page scripts for the browser — the model never writes JavaScript that runs in a page | P8 |
| Page text, titles and form labels wrapped as untrusted data | P8 |
| Password fields never read or typed into | P8, P9 |
| Repairs pass the risk engine | P11 |
| JARVIS's own speech cannot approve | P12 |

## Secret redaction (P4, `security/redactor.ts`)

Replaced with a marker that keeps the kind (`[REDACTED:github-token]`): API
keys of known shapes (Google `AIza…`/`AQ.…`, OpenAI-style `sk-…`, Groq `gsk_…`,
GitHub, AWS, Slack), JWTs, `Authorization: Bearer …`, `Cookie` / `Set-Cookie`
values, private-key blocks, `password` / `token` / `secret` / `api_key` pairs
(`:` or `=`, quoted or not; quoted values keep their quotes so JSON stays
valid), "my password is …", URLs with a password, `.env` lines whose name
contains KEY, TOKEN, SECRET or PASSWORD, and what is left of a known key
prefix when text was cut short before it got here.

Where it is applied:

| Sink | Where |
|---|---|
| Every tool result (output and error), before the graph, synthesis, memory and the cache | `toolRegistryV2` dispatch |
| Every message sent to the LLM — tool output, memory, context, the user's own words | `modelRouter.chat` / `streamChat` |
| Registry call history (arguments, errors), shown by `action_history` | `toolRegistryV2._pushHistory` |
| Conversation memory and long-term facts | `memoryManager.addMessage`, `rememberFact` |
| Episodes (`data/episodes.jsonl`) | `agentMemory.pushEpisode` |
| Goals on disk (`data/runtime/goals.json`; the copy in memory is unchanged) | `goalManager` file adapter |
| Security audit, structured, tool audit and action logs; JARVIS's own speech-to-text log | the four loggers, `jarvis.ts` |
| Approval requests and their audit entries | `security/approvalRequest.ts` (P3) |

If redaction itself fails, the text is replaced by `[REDACTED]` (fail closed).
The original stays only where the tool itself needs it (a file JARVIS was asked
to edit is edited as it is); only what is shown to the model or stored is masked.

`save_relation` refuses a credential ("I don't store passwords, keys or
tokens"); other facts are stored with it replaced.

Not covered: a password with no label ("login with hunter2") cannot be told
from an ordinary word; the Python speech service writes its own transcript
log (`data/logs/stt_debug.log`, from `voice/stt.py`); documents the user
ingests for search are stored as they are, and only what reaches the LLM from
them is redacted.

## Rate limits and outside effects (P4)

Each tool may run at most 120 / 60 / 20 / 10 / 10 times a minute at risk level
0 / 1 / 2 / 3 / 4 (the level of the call, so a dry run counts as level 0).
Calls are counted per level (since P9): before, every call of a tool counted
against the limit of the current call's level, so ten ordinary clicks in a
minute made the next "Pay now" click hit the level-4 limit.
`JARVIS_TOOL_RATE_LIMITS="120,60,20,10,10"` overrides; 0 means no limit. Over
the limit the call is refused before any approval is asked, is not retried,
and JARVIS says so. A tool whose metadata says it changes something outside
the PC (`external: change`) is at least risk 2.

## Browser (P8, P9)

- JARVIS reaches only the Chrome started with a debugging port and a profile of
  its own, on 127.0.0.1; the everyday profile's logins and cookies are never
  exposed to it.
- The model never writes JavaScript: fixed functions in
  `perception/cdpScripts.ts`, run in an isolated world; a reference or typed
  text is passed to them as data.
- Actions only on elements JARVIS has looked at, checked again before acting
  (same element, same page, visible, enabled, not covered), and checked after.
- No password, card or one-time-code typing; no password, hidden, email or
  textarea values read; page dialogs reported, never answered.
- Downloads go only to the JARVIS download folder and are never opened;
  uploads only from the approved folders, never keys, approved each time.
- Screenshots stay on the PC (`data/screenshots`); they are not sent to the
  model.

## Files and development (P10)

- File tools only inside the approved folders, compared by real path. The
  older `control_file` compared paths as text and read `/etc/hostname`
  through a link placed in the temp folder; it now compares real paths too.
- Deleting is recoverable (the JARVIS trash); emptying the trash is level 3.
- No shell: git and package managers run with fixed arguments; script names
  must be in `package.json` and on the allowlist.
- A commit never takes key files or changes holding a credential; there is
  no force push; pushes are approved each time, to `main`/`master` with a
  typed code.
- Only servers JARVIS started can be stopped by it.
- `data/screenshots/` and `data/trash/` are git-ignored (user data).

## Data minimisation

- Nothing is observed in the background for the new features; each tool reads
  what the current request needs.
- Tool results stay in the request's working context; they become long-term
  facts only through `rememberFact` (a failed task's one-line summary) or
  `save_relation`, both without credentials (P4).
- World state (P7) lives in memory for the session and is never written to
  long-term memory.
- Not captured unless a user-approved operation needs it: passwords, cookies,
  tokens, API keys, private keys, banking details, private messages, sensitive
  files.

## Never automatic

Formatting drives, deleting critical folders, disabling security software,
changing security policy, exposing credentials, sending private data out,
irreversible financial actions, destructive commands. These are level 4
(approval with a typed code) or refused outright where today's blocklist
refuses them.
