# Final JARVIS implementation report

Branch `claude/jarvis-repair`, 2026-10-07. This report covers phases P0–P15
of the PC-aware upgrade ([JARVIS_PHASES.md](JARVIS_PHASES.md)).

Every number below comes from a run made for this report, from the
repository's own history, or from GitHub CI, and its source is named. What
could not be run is listed in section 7.

## 1. Summary

- 16 phases. P0–P13 are complete. P14 (Windows) is built and tested in this
  container but is **blocked**: it needs a run on the owner's Windows PC. P15
  ran every test group that can run here. Its one open item is the same
  Windows run.
- Tests: 110 test files. Normal mode: 104 passed, 0 failed, 6 environment
  (prerequisites missing here). CI mode: 102 passed, 0 failed, 8 skipped.
  Typecheck clean.
- The approval-bypass test (new in P15, 54 checks) found no way past the
  approval step. The P15 review found and fixed one command-injection defect
  in `run_command` (section 5.1).
- The owner's first run of `pnpm verify:windows` (2010 iMac, 2026-10-07): 5
  passed, 6 failed, 4 skipped. It found two problems, both fixed since:
  the approval gate took a line typed before the request as the answer
  (section 5.1), and the PowerShell time limits were too short for a slow
  PC (section 7). A second run is needed.
- No new dependencies.

## 2. Phases

| Phase | Status | Commit |
|---|---|---|
| P0 Discovery and architecture | complete | `6189dd4` |
| P1 Tool registry | complete | `2394cf7` |
| P2 Risk engine | complete | `6727771` |
| P3 Approval gate | complete | `1ebf838` |
| P4 Redaction | complete | `74cf026` |
| P5 Observe → act → verify | complete | `ebac5ec` |
| P6 System and development observation | complete | `6ff7349` |
| P7 World state | complete | `ee8880a` |
| P8 Browser observation | complete | `f421d21` |
| P9 Browser control | complete | `d95446e` |
| P10 Files and development actions | complete | `aae96af` |
| P11 Error recovery | complete | `d40535a` |
| P12 Voice | complete | `3130ac1` |
| P13 Integration and scenarios | complete | `aa419ea` |
| P14 Windows observation and control | **blocked** (owner's Windows run) | `ec3e044` |
| P15 Final verification | **blocked** on the same Windows run; everything else done | this commit |

Details and the evidence for each phase: [PHASE_STATUS.md](PHASE_STATUS.md).

## 3. Tasks

[MASTER_TASKS.md](MASTER_TASKS.md) has 78 tasks. After P15: 71 done, 7 in
progress, 0 not started. The 7 in progress are T14.1–T14.6 and T15.1, and
all of them wait for the Windows run.

## 4. Tests run

All runs below were made in this Linux container (Node v22.22.2) on the P15
working tree, with PowerShell 7.4.6 supplied for `windowsScriptsTest`.

| Run | Result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0, no errors |
| `npm test` | 110 files: 104 passed · 0 failed · 6 environment |
| `npm test -- --ci` | 110 files: 102 passed · 0 failed · 8 skipped |
| GitHub CI on `ec3e044` (P14) | green: 101 passed · 0 failed · 8 skipped |
| GitHub CI on `781086e` (P15, the code in this report) | green: 102 passed · 0 failed · 8 skipped |
| After the fixes from the first Windows run: typecheck | exit 0, no errors |
| …`npm test` | 111 files: 105 passed · 0 failed · 6 environment |
| …`npm test -- --ci` | 111 files: 103 passed · 0 failed · 8 skipped |

The 6 environment results in normal mode are tests whose prerequisite this
container lacks: `dashboardAccuracyTest` (Redis), `dashboardHealthSystemTest`
(Windows PowerShell), `processControlSafetyTest` (Windows process table),
`startupPerformanceTest` (`JARVIS_BRIDGE_TOKEN`), `sttReliabilityTest`
(Python `.venv`), `windowControlTest` (Windows window manager). CI mode skips
these six. It also skips `finalIntegrationSuiteTest` and
`successfulExecutionLifecycleAuditTest`, which are on its fixed "needs a
reachable LLM API" list. In normal mode, with no `.env` and no key, both of
those ran and passed.

### Test groups (results from the `npm test` run)

| Group | Files | Result |
|---|---|---|
| Permission (P2–P3) | riskEngineTest, approvalGateStructuredTest, permissionSessionTest, dispatchAuthzTest, securityGateUnitTest, voiceApprovalTest | all pass |
| Security: redaction leaks | redactionTest, secretSinksTest | all pass |
| Security: approval bypass | securityBypassTest (new, 54 checks) | pass |
| Security: page and OCR injection | promptInjectionHardeningTest, browserObservationTest | all pass |
| Security: path and command injection | fileToolWorkspaceSafetyTest, fileControlSafetyTest, runCommandSafetyTest, dangerousCommandMatchTest, openAppSecurityTest, systemControlSafetyTest | all pass; processControlSafetyTest needs Windows |
| Browser (P8–P9, real headless Chromium) | browserObservationTest, browserControlTest, browserControlAgentTest, chromeStateSmokeTest | all pass |
| Recovery (P11) | errorRecoveryTest, diagnosisRulesTest, faultInjectionTest, registryRepairHonestyTest | all pass |
| End to end (P13) | scenarioIntegrationTest (35 checks), finalIntegrationSuiteTest, fullSystemIntegrationTest | all pass |
| Windows (P14) | windowsToolsTest, windowsScriptsTest | pass here; windowControlTest and the `pnpm verify:windows` pack need Windows |
| Performance | toolPerformanceBenchmarkTest, latencySmokeTest, endToEndLatencyTest, memoryPerformanceTest, planningPerformanceTest | all pass; startupPerformanceTest needs the bridge token |
| Regression | the 92 test files that existed before P1 | 86 pass; the other 6 are the 6 environment results above |

The upgrade added 18 test files: 17 in P1–P14 and `securityBypassTest` in
P15.

## 5. Security findings

### 5.1 Found and fixed in P15

**A line break let a second command run without approval.** `run_command`
checks a command against its developer allow-list after collapsing its
whitespace, but the shell runs the command as written. `git status`, then a
line break, then any other command passed every check at level 0, so it ran
with no approval and without full control mode, and the shell ran both lines.
A carriage return alone did the same.

- Fix: `validateDeveloperCommand` (`tools/terminalTool.ts`) refuses line
  breaks and other control characters before it reads the command. The risk
  engine and the tool itself both call it, so the call is refused before
  any prompt appears and before dispatch.
- Test: `securityBypassTest` section 10. On the code before the fix, 6
  checks failed: for each of LF, CR LF and CR, the call was not refused and
  the tool body ran. After the fix, all 54 checks pass. A one-line
  `git status` still runs.

**A line typed before an approval request was shown was taken as the
answer** (found by the owner's first Windows run). Where the gate reads the
console itself, with no CLI loop as in `pnpm verify:windows`, a line typed
while JARVIS was busy waited in the console and was read the moment the
request appeared. On the owner's PC an Enter pressed while JARVIS loaded
denied the request before it could be answered. An early "yes" would have
approved a request nobody had seen.

- Fix: `security/approvalGate.ts` drops the lines that were already waiting
  when the request appears, says so, and only then shows the prompt. The
  CLI loop of `jarvis.ts` was not affected: it takes a typed line as an
  answer only while a request is on display.
- Test: `tests/approvalTypeAheadTest.ts`, 9 checks, with a stand-in console.
  On the code before the fix, 6 fail: an early Enter denies, and an early
  "yes" approves, typed and during a spoken request. After the fix, all 9
  pass.

### 5.2 Approval-bypass attempts (no bypass found)

`tests/securityBypassTest.ts` uses the real registry, risk engine and
approval gate. No tool body runs: each is replaced by a counter, and the
decisions it checks are made before dispatch.

1. Approval arguments added to a high-risk call (`approved`, `confirm`,
   `force`, `_approved`, `skipApproval`) are ignored. The call is still
   asked, and "no" runs nothing.
2. Names that only look like a tool (`Files`, a trailing space, a
   zero-width space, upper case, a trailing line break) are not registered,
   and nothing runs.
3. A level-4 action stays strong (it needs a typed code) even when the
   request text claims approval. A typed "yes", a bare "APPROVE" and the
   words from the request all deny it.
4. A repair (`asRepair`) of a level-4 action still needs the code.
5. Approving one call does not approve the next identical call. The second
   call is asked again.
6. The approval scope belongs to the approved call and ends with it. A
   level-3 approval made in full control mode grants session level 0. A
   scope that grants 0 does not satisfy a level-2 floor. A scope that grants
   2 satisfies it only inside that call.
7. Full control mode does not skip level 3. Without full control mode the
   call is refused.
8. Two parallel calls are shown one at a time, and each needs its own
   answer.
9. A blocklisted shell command is refused before any prompt, even in full
   control mode and with forged approval arguments.
10. Line breaks in `run_command` (section 5.1).

### 5.3 Found and fixed in earlier phases

Each was fixed in its phase with a test, and most were shown failing on the
code before the fix. Details are in [PHASE_STATUS.md](PHASE_STATUS.md).

- P2: `explain_code` could read any file on the PC and send it to the LLM.
  Command Prompt injection through `control_app open` targets and URLs
  containing `&`. A refused action was retried, which asked the question
  twice. The "read-only git" allow-list accepted `git branch -D`,
  `git branch -m` and `git diff --output=…`.
- P3: a typed approval answer was also run as a command. JARVIS's own spoken
  "say confirm" could approve its own request. "proceed" and "do it"
  approved by voice.
- P4: the goal file stored a request's words, including any token in them.
  Text cut short before logging could leave half a key that the redactor no
  longer matched.
- P10: `control_file` compared paths as text, so it read a file outside the
  approved folders through a link. It now also compares real paths. `data/`
  (screenshots, trash) was not git-ignored.
- P12: an "approve" heard while JARVIS was saying something else counted as
  an answer.
- P13: the redactor missed credential names with other words joined to them
  (`DB_PASSWORD=…` in a log line, `AWS_SECRET_ACCESS_KEY=…`,
  `"dbPassword": …`).

### 5.4 Open points (found by reading the code; not changed)

None of these is a bypass with today's tools. They are listed so that a
later change does not turn one into a bypass.

- **The approval scope answers yes to every request made inside the approved
  call** (`security/approvalGate.ts`, `currentApproval()`). The scope exists
  so that a controller's own second question (process kill, services, shell)
  is not asked twice. A tool body that called the registry for another risky
  tool would be approved by it as well. Today the only tool body that calls
  the registry is `search`, and it calls `web_search`, which needs no
  approval.
- **Fallback tools run without their own risk check**
  (`executeWithFallbacks` in `core/toolRegistryV2.ts`). The fallback inherits
  the first tool's decision. Today's fallbacks are all read-only:
  `search_documents` → `search_memory`, and `search` and `weather` →
  `web_search`.
- **The approval block shows a command on one line**: TARGET collapses line
  breaks. `control_system` shell commands are always asked (level 3 or 4),
  so the text is shown in full, but its line breaks are not.
- `bridge/nodeBridge.ts` still holds two old confirmation helpers
  (`askForConfirmation`, `waitForTextConfirmation`). Nothing calls them. They
  were left in place because the upgrade rules say not to remove existing
  code.

## 6. Performance

All numbers come from two runs of a measurement script in this container
(Linux, Node v22.22.2), not on the owner's PC. For the end-to-end timings
the model is stubbed to count requests, so they measure JARVIS's own path
only, with no network.

| Measure | Run 1 | Run 2 |
|---|---|---|
| Deterministic pre-router (`matchDeterministicCommand`), mean over 20 000 calls | 4.8 µs | 4.4 µs |
| …per phrase, median (10 phrases) | 2.9–8.2 µs | 2.7–6.6 µs |
| "what is open", end to end, median of 3 | 0.5 ms, 0 LLM requests | 0.9 ms, 0 LLM requests |
| "what can you do", end to end, median of 3 | 0.5 ms, 0 LLM requests | 0.9 ms, 0 LLM requests |
| Node process memory at startup (RSS / heap) | 84 / 7 MB | 83 / 7 MB |
| …after importing JARVIS | 140 / 33 MB | 143 / 38 MB |
| …after registering tools and skills | 141 / 34 MB | 144 / 39 MB |

Two other phrases tried, "what is my permission status" and "what is my
system state", are not deterministic routes: each made 1 planner (LLM)
request per run.

**LLM requests per scenario.** These come from a fresh run of
`scenarioIntegrationTest` in P15 (35 passed, 0 failed). They match the P13
run.

| Scenario | LLM requests |
|---|---|
| 1 What is in my browser | 0 |
| 2 Is my backend running | 0 |
| 3 Why isn't my application working | 0 |
| 4 Continue what I was doing | 3 |
| 5 Check why my website isn't working | 0 |
| 6 A dangerous request (delete Downloads) | 2 |

## 7. Blocked or not verified

- **The Windows pack** (`pnpm verify:windows`) has run once on the owner's
  PC (2010 iMac, Windows 10 19045, 2026-10-07): 5 passed (installed apps,
  ports with their program, windows with their program, disks by drive
  letter, a screenshot), 6 failed, 4 skipped. The console approval was
  denied before it could be answered (section 5.1). Gpu, displays, audio,
  cameras and services did not answer within their 10–15 s limits, because a
  fresh Windows PowerShell is slow on that PC. The four steps that need full
  control mode were skipped: clipboard, Notepad, Calculator, test server.
  Both causes are fixed: the gate change, and longer PowerShell limits with
  at least two looks in the desktop checks (PC_CONTROL.md, Known limits). A
  second run is the one item P14 and P15 wait for. It covers the P14
  readings, UI Automation in real apps, the clipboard, the checks after
  window and app actions, P3's console approval in a real CMD window, and
  P10's `cmd.exe` and `taskkill` paths.
- **Microphone and speakers** (P12) need a check by hand on the PC. The pack
  lists this as not checked.
- **The six environment tests** in section 4 did not run here. They need
  Windows, Redis, the Python virtualenv or the bridge token.
- **No live LLM run** was made in P15. All LLM traffic in the tests went to
  a scripted model that records every request.

## 8. Known limitations

- `win_automate.ps1` and the window poll still list at most 20 programs, one
  window each. The new P14 tools and checks list every visible window instead.
- A dialog that blocks its caller stops a UI Automation invoke after 30 s.
- WMI reports at most 4 GB of graphics memory.
- `appController.isAppOpen` looks for `calc.exe`, which exits once
  Calculator is open. The P14 checks look for the window first.
- Redaction works by pattern, so it finds the credential formats it has
  rules for.
- The risk levels of browser clicks depend partly on button labels ("pay",
  "delete"). That rule can only raise a level.

## 9. Architecture changes

The existing architecture was kept: the orchestrator, the task graph, the
tool registry, the controllers, the bridge, voice, memory and the folder
layout. The upgrade adds layers around the registry and new tools behind it.
From the P0 commit to the P14 commit: 122 files changed, 15 745 lines added,
598 removed (`git diff --shortstat 6189dd4 ec3e044`). In P15 the only code
change is the line-break check in `tools/terminalTool.ts` (6 lines added). P15
also adds `securityBypassTest` and this report, and updates four documents.

| Area | New modules |
|---|---|
| Tool metadata (P1) | `core/toolCatalog.ts`, `core/tools/capabilityTool.ts` |
| Risk and approval (P2–P3) | `security/riskEngine.ts`, `security/approvalRequest.ts`, `security/approvalScope.ts` |
| Redaction and history (P4) | `security/redactor.ts`, `core/tools/historyTool.ts` |
| Verification (P5) | `core/verifiers.ts` |
| Observation (P6–P7) | `perception/systemProbe.ts`, `perception/devProbe.ts`, `perception/gitProbe.ts`, `core/worldState.ts`, `core/taskContext.ts`, `core/tools/observationTools.ts` |
| Browser (P8–P9) | `perception/cdpClient.ts`, `perception/cdpScripts.ts`, `perception/browserState.ts`, `perception/browserRefs.ts`, `security/browserPolicy.ts`, `control/browserAgent.ts`, `core/tools/browserTools.ts`, `core/tools/browserActionTools.ts` |
| Files and development (P10) | `tools/fsTools.ts`, `tools/gitTools.ts`, `tools/devTools.ts`, `security/fsPolicy.ts` |
| Recovery (P11, P13) | `core/recoveryPlanner.ts`, `core/diagnosis.ts`, `core/tools/diagnosisTools.ts` |
| Voice (P12) | `core/voiceSummaries.ts` |
| Windows (P14) | `perception/windowsProbe.ts`, `perception/windows_probe.ps1`, `control/uiAutomation.ts`, `control/uiRefs.ts`, `control/uia.ps1`, `control/desktopControl.ts`, `control/desktop.ps1`, `core/tools/windowsTools.ts`, `scripts/verifyWindows.ts` |

Every tool call now passes through one pipeline in the registry: the tool's
permission floor, argument validation, the risk engine (run, ask or refuse),
a per-minute rate limit, the approval gate, execution, redaction of the
result, and a check of the result.

## 10. New dependencies

None. `package.json` gains one script, `verify:windows`. PowerShell 7 is used
only by `windowsScriptsTest`, to parse JARVIS's PowerShell files. On Windows,
JARVIS itself uses the built-in Windows PowerShell 5.1.

## 11. Recommended next steps

1. The owner runs `pnpm verify:windows` again on the Windows PC and sends
   back `data\logs\verify-windows.json`. P14 and P15 close on that report.
   If the readings are still slow, run the P14 PowerShell files in one
   long-lived PowerShell instead of starting one per reading.
2. Limit the approval scope to the approved call's own controller questions,
   so that a later tool which calls the registry cannot reuse an approval
   (5.4).
3. Run the risk check for each fallback tool before it runs (5.4).
4. Show line breaks in the approval block's TARGET (5.4).
5. Move `win_automate.ps1` and the window poll to the full window list that
   P14 uses.
6. Check the microphone and speakers by hand.
