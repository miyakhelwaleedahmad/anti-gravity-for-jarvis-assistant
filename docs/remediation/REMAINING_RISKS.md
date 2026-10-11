# Remaining risks

What this repair did not close, why, and what to do about it. Each item names its finding ID in `REMEDIATION_TRACKER.md`.

## 1. Not verified on Windows (REL-09, TEST-01)

All work was done and tested on Linux (Node 22, Python 3.11). Nothing here ran on Windows. The last Windows run, on the owner's PC before `30605cf`, had 103 passing and 24 failing tests.

Code paths that behave differently on Windows and were checked only by reading:

| Change | Windows-specific part | How it was checked |
|---|---|---|
| REL-01 process stop | `taskkill /pid N /T /F` | Linux process-group path tested; the Windows-only `ping -n 30` case in `toolTimeoutTest` runs only on Windows |
| SEC-20 cmd.exe characters | `^`, `!`, `%NAME%` reach cmd.exe | allow-list refusal tested; cmd.exe itself not run |
| SEC-15 self-heal | `.venv\Scripts\python.exe` | path code read; the run test uses a POSIX stand-in |
| SEC-16 skill trust | CRLF checkouts | CRLF fingerprint tested on Linux |
| SEC-18 vector token file | file mode 0600 has no effect on NTFS | the file sits in the user's own profile folder; ACLs not set |

The new CI Windows job (TEST-01) runs the suite on `windows-latest` after the branch is pushed. Pushing was not authorised, so it has not run.

## 2. Findings answered in writing only

| ID | Risk that stays | Suggested next step |
|---|---|---|
| ARCH-01 | `core/orchestrator.ts` (~2,900 lines) holds routing, planning, execution, reflection and replies; changes there are hard to review | Split in this order, each step behind the existing tests: (1) deterministic routes → `core/routes/`, (2) planning → `core/planner.ts`, (3) synthesis and spoken replies → `core/replies.ts`. The request-level tests added here (`requestScopeTest`, `skillLoadOrderTest`, `promptInjectionFlowTest`, converted TEST-02 tests) cover the seams |
| ARCH-02 | Two health systems (`monitoring/healthManager`, `self_healing/healthChecker`), three buses, two memory front ends | Health: keep `healthChecker` for repair, make `healthManager` read from it. Buses: `conversationBus` for speech, `agents/events` for agents, retire `messageBus`. Memory: `memoryManager` as the only writer |
| ARCH-03 | Mutable singletons serve the foreground request, goals and agents at once | The concrete bugs were fixed per request (REL-04/05, SEC-08). A general request context (ALS carrying request id, signal, source, approval scope) should replace the remaining fields |
| ARCH-04 | `security/riskEngine.ts` imports tool and controller modules | Move `validateDeveloperCommand`, `packageScripts`, `isSecurityService` predicates into `security/` |
| ARCH-07 | Many other empty `catch {}` blocks and ~700 `console.*` calls | Review each empty catch; add a small structured logger with levels |
| ARCH-09 / PERF-04 | Synchronous archive writes (~29 ms per 2 MB here) | Switch `agentManager` archive writes to `fs.promises` if stutter is heard |
| PERF-02 | Foreground and background share one provider quota | Measure 429s during a goal; pause background agents while a spoken request runs |
| PERF-05 | CPU and RAM contention on an old PC | Profile on the PC (see REMEDIATION_REPORT.md) before changing defaults |
| PERF-07 | Lexical memory fallback is a linear scan | Index it if facts grow past tens of thousands |

## 3. Limits of the fixes

- **SEC-02** Voice can still approve level 1–2 actions (the default `JARVIS_VOICE_APPROVAL_MAX_RISK=2`). Set it to 1 to require typing for every level-2 action as well.
- **SEC-03** The untrusted wrapper tells the model that tool output is data; a model can still be fooled. The protection that holds regardless is the registry: permission, risk and approval checks run in code (`promptInjectionFlowTest` §4).
- **SEC-08** A controller question is answered from the approval when it names an approved value; a value that is a substring of an unrelated target (approved `dir`, question about `C:\dir\x`) would still match. The one-per-call limit narrows this.
- **SEC-10** The obfuscation list covers the common cmd.exe and PowerShell techniques, not every one. Commands still need the owner's approval at level 3.
- **SEC-14** Secret files are recognised by name. A key pasted into `notes.txt` is not. The owner's own `ai_workflows/_config/github my persnal tokens.txt` (listed in `.gitignore`) should be deleted and the token moved into `.env` as `GITHUB_TOKEN`; JARVIS now refuses to read that file, but the file still exists on the PC.
- **SEC-16** Trust is by description fingerprint. A changed `skill.ts` in a trusted folder still loads; changing it needs write access to the repository, which the file tools treat as level 3.
- **SEC-18** The token stops other programs and web pages that do not have it. A program running as the same Windows user can read `data/security/vector_token`.
- **SEC-19** No signature on the session file (its key would sit in the same folder). An edited file can still claim up to 30 minutes of full control.
- **REL-02** JARVIS now exits after an uncaught exception. Without the supervisor (`pnpm dev:supervised`) it stays stopped until restarted.
- **REL-05** Marked NOT_REPRODUCED: hardened, but no failing case was found.
- **PERF-03** An `.env` that still sets `JARVIS_PLANNING_WATCHDOG_MS=20000` keeps the old behaviour, with a warning at start.

## 4. Designs not built

### Control Center (OPS-01)

Documented only, as instructed.

- **Purpose:** see and manage agents, goals, memory facts and pending approvals without the CLI or voice.
- **Shape:** a local web page served by JARVIS on `127.0.0.1` only, on its own port.
- **Access:** the same rules as the bridge and vector service after this repair:
  - a token required on every request (SEC-18 pattern);
  - any `Origin` other than the page's own refused (SEC-01);
  - JSON bodies only;
  - no CORS.
- **Approvals from the page:** typed only, never by a single click. Level-4 approvals still need the console code.
- **Audit:** every action from the page goes through the tool registry, so the existing risk checks, approvals and audit logs apply unchanged. The page gets no direct access to controllers.
- **Views:**
  - running and scheduled goals (pause, resume, cancel);
  - agent tasks (cancel);
  - memory facts with origin (forget, via `forget_memory`);
  - pending approvals;
  - recent audit entries.

### Remote access (OPS-02)

Nothing in this repair exposes a port beyond `127.0.0.1`. Before JARVIS runs on a rented server or is reached from another device, it needs:

1. Per-device identity (one key per device, revocable), not one shared token.
2. TLS on every listener.
3. A remote approval model in which high-risk approvals need a second factor. A remote voice "yes" never counts.
4. A clear split between the server (thinking, memory) and the PC (desktop control), and a PC-side agent that refuses desktop actions unless the owner is present.
5. Rate limits and audit at the network edge.
6. Secrets kept out of the server's environment where the PC is the one that needs them.
