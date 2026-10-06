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

## Secret redaction (P4; the redactor itself from P3)

`security/redactor.ts` exists from P3, where approval requests and their audit
entries pass through it. P4 applies it to tool output.

Masked wherever text leaves a tool for the LLM, memory or a log:
API keys of known shapes (Google, OpenAI-style, Groq, GitHub, AWS, Slack),
JWTs, `Authorization: Bearer …`, cookies and `Set-Cookie`, private-key blocks,
`password=` / `token=` / `secret=` pairs, connection strings with a password,
`.env` lines whose name contains KEY, TOKEN, SECRET or PASSWORD.

The original stays only where the tool itself needs it (a file JARVIS was asked
to edit is edited as it is); only what is shown to the model or stored is masked.

## Data minimisation

- Nothing is observed in the background for the new features; each tool reads
  what the current request needs.
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
