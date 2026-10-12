# Remaining risks

What this repair did not close, why, and what to do about it. Each item names its finding ID in `REMEDIATION_TRACKER.md`.

## 0. The owner's PC run

`pnpm test` and `pnpm verify:windows` ran on the PC at `28b0d2b`; see TEST_RESULTS.md. Its three real failures are fixed here (PC-01 to PC-03) but not yet rerun on the PC.

Still unverified on the PC:
- Notepad, window actions, Calculator, clipboard and the dev server: the approval was not answered;
- `windowsScriptsTest`: needs PowerShell 7;
- `dashboardHealthSystemTest`: its output was not captured.

## 1. Not verified on the owner's Windows PC (REL-09)

The branch is pushed and the CI Windows job (TEST-01) runs the suite on `windows-latest`. Results are in TEST_RESULTS.md. Windows CI found three real problems, now fixed:
- the PowerShell session's pipes kept Node alive;
- Chrome refused remote debugging under a fake `USERPROFILE`;
- upload checks ran in the wrong order.

It also showed that JARVIS caught no output from a dev server it started on Windows: 0 lines while the server ran. So a crash's error line could not be reported. Dev servers are no longer started detached on Windows. Side effect: a Ctrl+C in JARVIS's console window also stops the dev servers JARVIS started. With that change Windows CI passes: 160 passed, 0 failed, 6 skipped on `86ca10d`.

Windows CI is a clean Windows Server VM. It has no desktop session the owner uses, no microphone or speakers, no Python `.venv`, no Redis and no live model key. It does not replace a run on the owner's PC.

Not exercised on any Windows machine:

| Change | Windows-specific part | Where it was checked |
|---|---|---|
| REL-01 process stop | `taskkill /pid N /T /F` | Windows CI runs `toolTimeoutTest`; not on the owner's PC |
| SEC-20 cmd.exe characters | `^`, `!`, `%NAME%` reach cmd.exe | allow-list refusal tested; cmd.exe's own handling not exercised |
| SEC-15 self-heal | `.venv\Scripts\python.exe` | path code read; no `.venv` on CI |
| SEC-18 / OPS-01 token files | mode 0600 has no effect on NTFS | the files sit in the user's own profile folder; ACLs not set |
| Voice, wake word, TTS | microphone, speakers, Python `.venv` | not on CI; `sttReliabilityTest` skipped |
| Window and process control | the owner's desktop and apps | `windowControlTest` and `processControlSafetyTest` pass in the CI VM's session; not on the owner's desktop |

## 2. Partly done or still open

| ID | Status | What stays | Next step |
|---|---|---|---|
| ARCH-01 | first steps | `core/orchestrator.ts` is still 2,834 lines | Continue behind `routeGoldenTest`: (1) the rest of the deterministic router → `core/routes/`, (2) planning → `core/planner.ts`, (3) synthesis and spoken replies → `core/replies.ts` |
| ARCH-02 | owners chosen | Two health systems, three buses, two memory front ends | Health: `healthManager` reads from `healthChecker`. Buses: move `core/agents/events.ts` and `brainLoop` off `messageBus`, then retire it. Memory: `memoryManager` the only writer |
| ARCH-03 | narrowed | Shared fields on the orchestrator: `currentAbortController`, `currentProcessCallId`, `continueOffer`, conversation-end flags | Move them into the request scope one at a time, each with a two-request test like `requestScopeTest` §3 |
| ARCH-04 | policy lists moved | The risk engine imports validators that sit next to their tools (`validateDeveloperCommand`, `packageScripts`, `resolveTargetUrl`, git checks) | Move each into `security/` with its tool re-exporting it, as done for `protectedTargets` |
| ARCH-07 | shutdown and barge-in done | ~700 `console.*` calls; no levelled logger | Add a small logger with levels and redaction; convert module by module |
| ARCH-09 / PERF-04 | measured, unchanged | Synchronous archive writes (2–20 ms here) | Change to `fs.promises` if stutter is heard after large agent runs |
| PERF-02 | simulated | Not measured against a live provider | On the PC: count 429 replies in `logs` during a goal while talking to JARVIS; tune `JARVIS_BACKGROUND_YIELD_MS` |
| PERF-05 | needs readings | No budgets set | Run JARVIS with `JARVIS_CONTROL_CENTER=1` during a goal and read the resource figures; set agent concurrency from them |
| PERF-07 | measured, unchanged | Linear scan when the vector service is down (33 ms p95 at 50,000 facts) | Re-run `scripts/benchMemoryLookup.ts` if memory grows past that |

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
- **REL-05** Fixed at the provider (shared in-flight call). The orchestrator path was already correct.
- **PERF-02** A background call waits at most `JARVIS_BACKGROUND_YIELD_MS` (20 s) per call; a very long conversation still lets background work through after that.
- **OPS-01** The Control Center token in `data/security/control_center_token` can be read by any program running as the same Windows user, like the vector token. The Control Center is off unless `JARVIS_CONTROL_CENTER=1`.
- **PERF-03** An `.env` that still sets `JARVIS_PLANNING_WATCHDOG_MS=20000` keeps the old behaviour, with a warning at start.

## 4. Control Center and remote access

### Control Center (OPS-01): built, local only

`system/controlCenter.ts`, off unless `JARVIS_CONTROL_CENTER=1`, at `http://127.0.0.1:7790`. What it does and refuses is listed in the tracker row and tested in `controlCenterTest` (34 checks).

Not built yet from the earlier design:
- memory facts view with forget;
- pending approvals list (approvals stay in the console by design);
- recent audit entries.

It has not been used on the owner's PC.

### Remote access (OPS-02): groundwork only

Remote access is not available. `docs/remediation/REMOTE_ACCESS.md` has the threat model and the requirements. `security/remoteAccess.ts` has:
- the bind rule all listeners use;
- a deny-by-default request policy, tested in `remoteAccessTest`.

Nothing listens beyond loopback and nothing was deployed.
