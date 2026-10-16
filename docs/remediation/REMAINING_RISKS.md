# Remaining risks

What this repair did not close, why, and what to do about it. Each item names its finding ID in `REMEDIATION_TRACKER.md`.

## 0. The owner's PC runs

First run at `28b0d2b`: three real failures, fixed as PC-01 to PC-03. Second run at `ee1c8c8`: `pnpm test` 162 passed, 4 failed, 1 environment; `pnpm verify:windows` 16 passed, 1 failed. Those are fixed or changed as PC-06 to PC-11, and none is rerun on the PC yet. See TEST_RESULTS.md.

Still unverified on the PC:
- **PowerShell session (PC-08):** the one-line framing passed with PowerShell 7.4.6 here and with Windows PowerShell 5.1 on Windows CI (`12c6925`, `windowsStateSessionTest`'s real-PowerShell section). Not yet on the owner's PC, where `dashboardHealthSystemTest` measures the 4 s poll limit.
- **Calculator (PC-09):** what minimised Calculator is not known. The check now restores it and reads its buttons again, and says so in its result. If Calculator keeps leaving the screen, the check fails after 3 restores. `data/logs/verify-windows.json` from the next run should show the window state before each press.
- **`dashboardAccuracyTest` (PC-07):** needs Redis and a working LLM key; here it ran without a key only.
- **`windowsScriptsTest` (PC-10):** needs PowerShell 7 installed on the PC.

Third run (`b81aeac`): `docsHygieneTest` timeout, `parallelizationTimeoutAuditTest` 855 ms, `finalIntegrationSuiteTest` timeout, no PowerShell 7. Fixed or reclassified as PC-13 to PC-16; none rerun on the PC yet. The live tests now run only with `pnpm test:live`, which needs the key in `.env` and opens apps on the PC; it has not been run against the real provider (no key here).

**Intermittent on Windows CI (`448dbcb`, first attempt): `windowsStateSessionTest`, real Windows PowerShell 5.1 section.** `throw 'deliberate'` got no end marker within the 4 s query limit; the session then refused the next two queries as busy (3 checks failed). The re-run of the same commit passed (7.2 s), as did `b81aeac` and `12c6925`; neither the test nor `perception/windowsState.ts` changed in between. That runner was about twice as slow as usual (`windowsScriptsTest` 66 s against 31–38 s). With PowerShell 7 here a throw answers in 17–163 ms, so the delay is specific to 5.1 under load and was not reproduced. Root cause not established. JARVIS's own scripts catch their errors, so a throwing query is rare in use; if the owner's PC shows "PS session still finishing a slow query" after an error, this is the place to look.

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
| ARCH-01 | named seams split | `core/orchestrator.ts` is 2,243 lines: request lifecycle, planning prompt assembly, synthesis and streaming, speech, barge-in, watchdog, recovery | Accepted for this repair: these share request state and run through the LLM. Next, only with a scripted-model golden test per path |
| ARCH-02 | health agrees; naming fixed | Two health loops (dashboard snapshot, self-healing records) read the same source per service. A Redis failure is recorded on `memory_to_context`, whose repair (`memoryManager.init()`) does not touch Redis | If Redis failures show up on the PC, give Redis its own pipeline and repair |
| ARCH-03 | narrowed | Shared fields on the orchestrator: `currentAbortController`, `currentProcessCallId`, `continueOffer`, conversation-end flags | Move them into the request scope one at a time, each with a two-request test like `requestScopeTest` §3 |
| ARCH-04 | done | The risk engine still reads live state kept next to tools (element refs, dev servers, project scripts, push target); these are lookups, not rules | — |
| ARCH-07 | one request in one file | Many `console.*` calls remain for the owner's console; the trace file has state changes, security events, tool calls and task-graph events | Convert remaining modules to the levelled logger as they are touched |
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
