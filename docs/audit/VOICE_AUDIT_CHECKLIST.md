# Voice and forensic audit checklist (audit of 17 October 2026, at `bdd2f86`)

One finding at a time: confirm in the code, a test that fails on the old code, the smallest fix, the test passing, neighbouring tests, commit. "Passed" means run on Linux here; nothing below has been run on the owner's PC unless it says so.

Graphify's index is of `main` (131 commits behind this branch), so code was located with `rg`/`git` on the branch; Graphify was used only where `main` still matches.

| # | ID | Finding | Status | Test (old → new) | Commit |
|---|---|---|---|---|---|
| 1 | VOICE-001 | Same reply twice: second never spoken, JARVIS deaf 12 s | **Fixed** | `ttsRepeatDeliveryTest` 2/4 → 4/4 | `4f496f6` |
| 2 | VOICE-002 | Answer slower than the planning watchdog dropped silently | **Fixed** (code); owner's `.env` line still to check | `planningTimeoutSpeechTest` 2/4 → 4/4; `llmTimingTest` 18/20 → 20/20 | `3b9d933` |
| 3 | VOICE-004 | Audio-device failure mutes TTS for the run, unreported | **Fixed** | `test_tts_audio_device.py` 1/6 → 6/6 | `55b915b` |
| 4 | VOICE-005 | Speech health = "text was sent" | **Fixed** | `speechOutcomeHealthTest` 2/7 → 7/7; `test_tts_audio_device.py` +3 outcome checks (fail before) | `f792aba` |
| 5 | VOICE-003 | No real TTS fallback; old edge-tts allowed | **Fixed** (Windows voice wrote a WAV on Windows CI, run 39030902139; not yet heard on the owner's PC) | `test_tts_fallback.py` 1/9 → 10/10; `test_tts_windows_voice.py` (Windows CI) | `ed9c37e` + follow-up `0e1d8b2` |
| 6 | SEC-101 | Launched apps and voice services inherit every secret | **Fixed** | `childEnvCoverageTest` 5/8 → 8/8 (22 call sites listed before) | `99ca62d` |
| 7 | TEST-101 | `windowControlTest` passes without PowerShell | **Fixed** (Windows side: needs Windows CI / owner's PC) | `windowControlTest` on Linux: 8/8 PASS → BLOCKED (exit 3) | `f2aac05` |
| 8 | SEC-102 + cleanup | Unused stdin "yes" helpers, dead bridge code, `ts-node` | **Fixed** | `approvalPathsTest` 0/7 → 7/7 | (this commit) |
| 9 | VOICE-008 | Echo filter drops short user phrases | Open | | |
| 10 | REL-101 | Two tests near the 120 s limit on the owner's PC | Open | | |
| 11 | VOICE-007 / TEST-102 | Voice tests never use the real hand-off; no real `tts.py` test | Open | | |
| 12 | VOICE-006 | Voice barge-in during speech impossible | Open | | |
| 13 | VOICE-009 | STT energy gate averages over silence | Open | | |
| — | APR-001 | Lowercase "yes" rejected | Not reproducible (audit) | `approvalTypeAheadTest` 9/9 | — |

## 1. VOICE-001

| | |
|---|---|
| **Confirmed** | `bridge/nodeBridge.ts` `speakToClients()`: `_lastQueuedTts` was set on every phrase and never cleared, so a phrase equal to the last one ever queued was dropped. `orchestrator.speak()` had already moved to SPEAKING and paused the wake word. |
| **Test first** | New `tests/ttsRepeatDeliveryTest.ts`, with the real `NodeBridge`, a real WebSocket client standing in for `tts.py` (new `tests/ttsBridgeClient.ts`: authenticates like `tts.py`, answers `speaking_start`/`speaking_end`) and the real `orchestrator.speak()`. Old code: 2 passed, 2 failed: second "Opening Chrome, sir." dropped (`TTS dedup … skipping`), state still SPEAKING after 5 s. |
| **Fix** | The phrase is forgotten on `speaking_end`, on a TTS stop, and after 2 s (`TTS_DEDUP_WINDOW_MS`). The same phrase queued twice at the same moment is still sent once. |
| **Proof** | 4/4: both replies reach the speech service; IDLE again after 163 ms. Neighbours pass (18 files: `speakingWatchdogQueueTest`, `ttsSpeakingLifecycleTest`, `voiceApprovalTest`, `stopClearsTtsQueueTest`, barge-in, echo, `bridgeSecurityTest`, `scenarioIntegrationTest` …). `tsc --noEmit` clean. |

## 2. VOICE-002

| | |
|---|---|
| **Confirmed** | `core/agentStateMachine.ts` PLANNING watchdog → `orchestrator.handleWatchdogReset()` → `safeReset()` aborts the request; `spokenForm()` refuses to speak for an aborted request, so nothing was said. `config/llmTiming.ts` kept a value below the retry budget (the owner's 30000 against 62000) with a warning only. |
| **Test first** | New `tests/planningTimeoutSpeechTest.ts`: a real request planning against a stand-in model that never answers, then the state machine's own watchdog reset; real bridge and the `tts.py` stand-in. Old code: 2/4: `SPOKEN=[]`. `tests/llmTimingTest.ts`: its checks that a low value is "kept" now expect "raised to the budget"; old code 18/20. |
| **Fix** | A watchdog set below the budget is raised to it, with a warning naming the value used. When the watchdog ends a request, JARVIS says "That took too long, sir. Please ask me again." (through `sendSpeech()`, past the aborted-request check, which is what silenced it). |
| **Proof** | 4/4 and 20/20; neighbours pass (`errorRecoveryTest`, `supersededRequestTest`, `llmCancellationTest`, `llmClientBehaviourTest`, `providerFailoverTest`, `requestScopeTest`, `scenarioIntegrationTest`, `speakingWatchdogQueueTest`, `watchdogUnitTest` …). `tsc --noEmit` clean. |
| **Owner** | With this fix a `JARVIS_PLANNING_WATCHDOG_MS=30000` line no longer cuts answers off (62000 is used), but removing the line is still cleaner. |

## 3. VOICE-004

| | |
|---|---|
| **Confirmed** | `voice/tts.py` `_ensure_mixer()` set `_mixer_initialized = True` before trying `pygame.mixer.init()`, so after one failure it never tried again; the only `hardware_error` was sent at connect time, before the lazy mixer had been tried. |
| **Test first** | New `tests/python/test_tts_audio_device.py` (stand-in `pygame` whose `mixer.init()` raises a WASAPI error, then recovers). Old code: 1/6: no `hardware_error`, one init attempt for two phrases, nothing played after the device came back. |
| **Fix** | A failed init is tried again on a later phrase after `JARVIS_TTS_MIXER_RETRY_S` (10 s); the first failure of a run is sent to JARVIS as `hardware_error` with the error text; the opened format is logged on success. The speaking turn still ends at once. |
| **Proof** | 6/6; `test_tts_retry_delay.py` 12/12; `py_compile` clean. Added to CI's `python-checks` job. Not run with a real audio device. |

## 4. VOICE-005

| | |
|---|---|
| **Confirmed** | `bridge/nodeBridge.ts` recorded `brain_to_tts` healthy on `ws.send`; nothing recorded a failure; `monitoring/healthManager.ts` showed TTS "online — connected via bridge" whenever `tts.py` was connected; `hardware_error` was only logged. |
| **Test first** | New `tests/speechOutcomeHealthTest.ts` (real bridge, `tts.py` stand-in that reports an outcome): old code 2/7: a reply that failed to synthesise left speech "healthy" and the dashboard "online"; a `hardware_error` changed nothing. `tests/python/test_tts_audio_device.py` gained 3 outcome checks that fail on `tts.py` without this change. |
| **Fix** | `tts.py` puts `outcome` (`played`, `synthesis_failed`, `no_audio_device`, `interrupted`) and a short `detail` on every `speaking_end`; a failure in a turn is kept over a later success. The bridge records success or failure from it and from `hardware_error`, keeps `lastSpeechOutcome`, and no longer counts a send as success. A (re)connecting `tts.py` starts clean. The dashboard shows TTS "degraded: connected, but the last reply was not played: synthesis failed (…)". Three failures in 10 minutes let the existing watchdog restart `tts.py`. |
| **Proof** | 7/7 and 9/9; `test_tts_retry_delay.py` 12/12; neighbours pass (`healthStatusTest`, `providerHealthTest`, `vectorSupervisorDashboardTest`, `parallelizationTimeoutAuditTest`, `ttsSpeakingLifecycleTest`, `speakingWatchdogQueueTest`, `voiceApprovalTest`, `bridgeSecurityTest`, `scenarioIntegrationTest`, `errorRecoveryTest`); `dashboardAccuracyTest`/`dashboardHealthSystemTest` environment-only here (no LLM key), as before. `tsc --noEmit` clean. |

## 5. VOICE-003

| | |
|---|---|
| **Confirmed** | `voice/tts.py` had one engine. When both edge-tts attempts failed the phrase was dropped. The self-healing `fallback_tts` action (`self_healing/repairExecutor.ts`) only moved a label in `fallbackRouter`, which nothing in `tts.py` reads. `requirements.txt` allowed `edge-tts>=6.1.9`; versions before 7.2.7 get HTTP 403 from Microsoft's service, per the audit. |
| **Test first** | New `tests/python/test_tts_fallback.py` (edge-tts stand-in that always fails with a 403, pygame stand-in): old code 1/9 — no fallback list, nothing played, no PowerShell command builder. |
| **Fix** | After edge-tts gives no audio (and no interrupt), `tts.py` tries offline voices in order: Windows' built-in voice (System.Speech via `powershell -NoProfile -NonInteractive`, text and path passed base64-encoded so they are data, not code), then `pyttsx3` if installed (not added as a dependency). The voice writes a WAV file that plays through the same pygame path. JARVIS is sent `speaking_delay` (+`JARVIS_TTS_FALLBACK_TIMEOUT`, default 20 s) so the speaking watchdog waits. The turn reports `played` with `detail: "fallback: windows-sapi"`, or `synthesis_failed` if every voice failed. `JARVIS_TTS_FALLBACK=off` turns it off. `requirements.txt`: `edge-tts>=7.2.7,<8` (7.3.1 is current on PyPI). |
| **Proof** | `test_tts_fallback.py` 10/10; `test_tts_audio_device.py` 9/9 and `test_tts_retry_delay.py` 12/12 (both now set `JARVIS_TTS_FALLBACK=off`, since they test edge-tts paths); `py_compile` clean. New `tests/python/test_tts_windows_voice.py` runs the real Windows voice on the Windows CI job and checks it writes a RIFF/WAVE file; on Linux it says SKIP. |
| **Not verified** | Hearing the fallback voice on the owner's PC. To check (CMD): `set JARVIS_TTS_FALLBACK=auto` and run `python tests\python\test_tts_windows_voice.py`, expecting `3 passed`. Upgrading edge-tts on the PC: `pip install -U "edge-tts>=7.2.7,<8"`. |

### 5a. Found by CI after the VOICE-003 push

| | |
|---|---|
| **VOICE-003 follow-up** | `0e1d8b2`: `selfHealInstallTest` hard-coded `edge-tts>=6.1.9` and failed after the pin moved (CI red on `ed9c37e`); it now reads the pin from `requirements.txt`. Found while there: the "install it yourself" command was unquoted, and in CMD/PowerShell the `>`/`<` of a version range are redirections; each package spec is now quoted. |
| **CI, Windows** | `08a1682`: `secretSinksTest` failed once on Windows CI ("the tool audit has the high-risk call", on the docs-only `bdd2f86`). `core/toolExecutionSandbox.ts` appended audit lines fire-and-forget and swallowed errors. Writes are now queued, retried once on EBUSY/EPERM, a failure is logged, and `flushAudit()` lets the test wait for the write instead of sleeping. Likely cause; not reproduced here — the next Windows CI run is the check. |

## 6. SEC-101

| | |
|---|---|
| **Confirmed** | `system/childEnv.ts` (SEC-06) was used at only some call sites. New `tests/childEnvCoverageTest.ts` listed 22 child-process calls with no `env`: the voice services (`self_healing/selfHealingManager.ts`), the app opener and `tasklist` (`control/appController.ts`), the settings opener and its PowerShell queries (`control/systemController.ts`), the process list/kill/restart (`control/processController.ts`), Explorer "reveal" and service/battery queries (`control/pcControlKernel.ts`), `win_automate.ps1` (`control/helper.ts`), the Windows observer's PowerShell session and one-shot fallback (`perception/windowsState.ts`), `perception/chromeState.ts`, `core/environmentContext.ts` (tasklist/ps), `taskkill` in `system/processRunner.ts` and `tools/devTools.ts`. execa merges `process.env` back in unless given `extendEnv: false`. |
| **Test first** | `childEnvCoverageTest` on the old code: 5/8. A real voice service started by `selfHealingManager` (stand-in `tests/fixtures/print_env.py`) saw every planted key; the app opener (stand-in `xdg-open` on PATH) saw them all plus the bridge token. |
| **Fix** | Every listed call passes `env: childEnv()` (execa also `extendEnv: false`). The voice services get `childEnv({ JARVIS_BRIDGE_TOKEN, ...voiceServiceEnv() })`: the bridge token they connect with, and only their own and their libraries' settings (`JARVIS_TTS_*`, `JARVIS_STT_*`, `JARVIS_WW_*`, `TTS_*`, `VISION_*`, `SDL_*`, `PYTHON*`, `HF_*`, `CT2_*`, `TORCH_*`, `CUDA_*`, `OMP_*`, `MKL_*`, `KMP_*`, proxy and CA-bundle names), never a name that looks like a credential. `scripts/` is left out on purpose: those are the owner's own command-line tools, and `superviseJarvis.ts` starts JARVIS itself. |
| **Proof** | `childEnvCoverageTest` 8/8; with it `childEnvTest`, `selfHealInstallTest`, `appControlTest`, `pcControlKernelTest`, `windowControlTest`, `windowsStateSessionTest`, `windowsStateFreshnessTest`, `adminControlTest`, `systemControlSafetyTest`, `filesAndDevToolsTest`, `chromeStateSmokeTest`, `desktopControlTest`, `voiceSettingsTest`, `securityBypassTest` pass (15 passed; `processControlSafetyTest` needs Windows). `tsc --noEmit` clean. |
| **Not verified** | On the owner's PC: that tts.py, stt.py and wakeWords.py still start and work with the narrower environment (faster-whisper, torch and pygame were not run here). If one fails to start after this change, its log names the missing variable; it can be added to `VOICE_ENV_PREFIXES`/`VOICE_ENV_NAMES` in `self_healing/selfHealingManager.ts`. |

## 7. TEST-101

| | |
|---|---|
| **Confirmed** | `tests/windowControlTest.ts` checked only that a string came back. When PowerShell could not read the windows, `getWindowsState()` returned its empty result (pid 0, no apps), which is still a string: run directly on Linux it reported 8 passed, 0 failed. `focusWindow` passed with any message. Its peer `processControlSafetyTest` already fails honestly off Windows ("returns at least 1 process"); the runner skips both off Windows. |
| **Fix** | Not Windows: BLOCKED (exit 3) with the reason. On Windows, PowerShell is asked directly how many windows have a title. If it lists any, JARVIS's list must be non-empty with a name, pid and title for each, and the active window must have pid > 0. If the desktop has none, or PowerShell cannot be asked, the result is BLOCKED with the reason, not a pass. Close below Level 2 must be refused; focusing a window that is not open must say "not found". |
| **Proof** | Linux: exit 3, `BLOCKED: needs Windows…` (was 8/8 PASS). `tsc --noEmit` clean. |
| **Not verified** | The Windows branch: Windows CI on the next push, and the owner's PC (CMD): `npx tsx tests\windowControlTest.ts`, expecting `8 passed, 0 failed`, with PowerShell's window count printed first. |

## 8. SEC-102 and cleanup

| | |
|---|---|
| **Confirmed** | `bridge/nodeBridge.ts` had `askForConfirmation()` (resolved true when "yes" was typed into the console, with no approval record and none of `approvalGate`'s rules) and `waitForTextConfirmation()` (the same for STT text). Nothing called either (checked with `rg` across code and tests); the phase-3/phase-12 docs that name the second one describe an earlier design. Also dead: `sendToClient()` (no caller), an `ack` branch reading a `pendingAcks` map that was never created, and a `pendingListen` flag that was never set to true. `ts-node` was a devDependency nothing uses (`tsx` runs everything). |
| **Test first** | New `tests/approvalPathsTest.ts`: only `security/approvalGate.ts` and `jarvis.ts` may read the console; the bridge has none of the removed members; no `ts-node`. Old code 0/7. |
| **Fix** | The two helpers, `sendToClient`, the `ack` branch and `pendingListen` removed (87 lines); `pnpm remove ts-node` (lockfile regenerated by pnpm, `pnpm install --frozen-lockfile` passes). Five dated reports moved from the root to `docs/history/` (`FINAL_REPORT.md`, `IMPLEMENTATION_PLAN.md`, `JARVIS_CURRENT_ARCHITECTURE_REPORT.md`, `JARVIS_MULTI_AGENT_ARCHITECTURE_AUDIT.md`, `JARVIS_MULTI_AGENT_IMPLEMENTATION_REPORT.md`), links fixed. Kept at the root: `README.md`, `ARCHITECTURE.md` (current), `RECURSIVE_AGENT_RESEARCH.md` (the design reference eight `core/agents/*.ts` files point to). |
| **Proof** | `approvalPathsTest` 7/7; `docsHygieneTest`, `bridgeSecurityTest`, `voiceApprovalTest`, `nodeBridgeSingletonTest`, `ttsRepeatDeliveryTest`, `speechOutcomeHealthTest`, `ttsSpeakingLifecycleTest`, `stopClearsTtsQueueTest` pass. `tsc --noEmit` clean. |
