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
| 7 | TEST-101 | `windowControlTest` passes without PowerShell | **Fixed** (PASS on Windows CI, run 39032166186; owner's PC not yet run) | `windowControlTest` on Linux: 8/8 PASS → BLOCKED (exit 3) | `f2aac05` |
| 8 | SEC-102 + cleanup | Unused stdin "yes" helpers, dead bridge code, `ts-node` | **Fixed** | `approvalPathsTest` 0/7 → 7/7 | `dc99250` + docs `343c84a` |
| 9 | VOICE-008 | Echo filter drops short user phrases | **Fixed** | `echoShortReplyTest` 7/12 → 13/13 | `0e210d9` |
| 10 | REL-101 | Two tests near the 120 s limit on the owner's PC | **Fixed** (limits only; the owner's PC run is the check) | runner output shows the limit; no new test (runner change) | `5c0ae37` |
| 11 | VOICE-007 / TEST-102 | Voice tests never use the real hand-off; no real `tts.py` test | **Fixed** (new end-to-end test; found and fixed a VOICE-005 gap) | `realTtsHandoffTest` 13/13 (without the tts.py fix: 11/13) | `49de8d6` |
| 12 | VOICE-006 | Voice barge-in during speech impossible | **Deferred** (design change, not a bug fix) | — | — |
| 13 | VOICE-009 | STT energy gate averages over silence | **Fixed** (synthetic audio; real microphone not tested) | `test_stt_vad_gate.py` 3/5 → 5/5 | `6761c44` |
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
| **Windows CI** | PASS on run 39032166186 (`f2aac05`), 0 blocked: the real-window checks held on a hosted Windows runner. |
| **Not verified** | The owner's PC (CMD): `npx tsx tests\windowControlTest.ts`, expecting `8 passed, 0 failed`, with PowerShell's window count printed first. |

## 8. SEC-102 and cleanup

| | |
|---|---|
| **Confirmed** | `bridge/nodeBridge.ts` had `askForConfirmation()` (resolved true when "yes" was typed into the console, with no approval record and none of `approvalGate`'s rules) and `waitForTextConfirmation()` (the same for STT text). Nothing called either (checked with `rg` across code and tests); the phase-3/phase-12 docs that name the second one describe an earlier design. Also dead: `sendToClient()` (no caller), an `ack` branch reading a `pendingAcks` map that was never created, and a `pendingListen` flag that was never set to true. `ts-node` was a devDependency nothing uses (`tsx` runs everything). |
| **Test first** | New `tests/approvalPathsTest.ts`: only `security/approvalGate.ts` and `jarvis.ts` may read the console; the bridge has none of the removed members; no `ts-node`. Old code 0/7. |
| **Fix** | The two helpers, `sendToClient`, the `ack` branch and `pendingListen` removed (87 lines); `pnpm remove ts-node` (lockfile regenerated by pnpm, `pnpm install --frozen-lockfile` passes). Five dated reports moved from the root to `docs/history/` (`FINAL_REPORT.md`, `IMPLEMENTATION_PLAN.md`, `JARVIS_CURRENT_ARCHITECTURE_REPORT.md`, `JARVIS_MULTI_AGENT_ARCHITECTURE_AUDIT.md`, `JARVIS_MULTI_AGENT_IMPLEMENTATION_REPORT.md`), links fixed. Kept at the root: `README.md`, `ARCHITECTURE.md` (current), `RECURSIVE_AGENT_RESEARCH.md` (the design reference eight `core/agents/*.ts` files point to). |
| **Proof** | `approvalPathsTest` 7/7; `docsHygieneTest`, `bridgeSecurityTest`, `voiceApprovalTest`, `nodeBridgeSingletonTest`, `ttsRepeatDeliveryTest`, `speechOutcomeHealthTest`, `ttsSpeakingLifecycleTest`, `stopClearsTtsQueueTest` pass. `tsc --noEmit` clean. |

## 9. VOICE-008

| | |
|---|---|
| **Confirmed** | `core/voiceEchoFilter.ts` (common phrases and last-reply containment) compared characters, not words: `phrase.includes(stt)` and `lastTts.includes(stt)`. New `tests/echoShortReplyTest.ts` on the old code: "no" was dropped as an echo of "let me know" (inside "know"), "here" as "here are", "yes" after "…Say yes or no.", "the second one" after "The first one or the second one, sir?". |
| **Fix** | `isEchoOf()`: whole words of the phrase, in order, and either the whole phrase, most of it (60%), at least four words, or — only for JARVIS's last reply when it was a statement, not a question — two or more words ("opening google" of "I am opening google for you" stays echo, as `bargeInEchoTest` expects). After a question, a short fragment is taken as the user's answer. The fixed common-phrase list uses the strict rule, since JARVIS may not have just said that phrase. |
| **Proof** | `echoShortReplyTest` 13/13 (old code failed the 5 user-reply cases); `bargeInEchoTest`, `echoWindowFromPlaybackEndTest`, `echoFilterCommandAcceptanceTest`, `echoFilterVerificationTest`, `voiceApprovalTest`, `voiceRouteMockTest`, `voiceContinuationFallbackTest`, `interruptGatingTest` pass. `tsc --noEmit` clean. |
| **Not verified** | Real microphone and speakers on the owner's PC: how often a real echo is a 1-word or after-a-question fragment that now gets through. If JARVIS starts answering itself, the `[EchoFilter] accepted reason="…"` log line shows which rule let it through. |

## 10. REL-101

| | |
|---|---|
| **Confirmed** | `tests/runAll.ts` stopped every test at one limit, 120 s (`JARVIS_TEST_TIMEOUT_MS`). On the owner's PC `finalIntegrationSuiteTest` took 104 s and `windowsScriptsTest` 88.6 s: a slower day would have turned them into timeouts with nothing wrong. |
| **Fix** | Those two get their own limit, about 2.5× their measured time (270 s and 240 s); every other test keeps 120 s, and a higher `JARVIS_TEST_TIMEOUT_MS` still applies to all. A timeout now says which limit stopped it ("stopped at its time limit, 270 s"). No assertion, check or expected result changed. |
| **Proof** | `JARVIS_TEST_TIMEOUT_MS=300` on a quick test: `TIMEOUT … stopped at its time limit, 300 ms`. `tsc --noEmit` clean. |

## 11. VOICE-007 / TEST-102

| | |
|---|---|
| **Confirmed** | Every voice test spoke to a stand-in for `tts.py` (`tests/fakeTts.ts`, `tests/ttsBridgeClient.ts`); nothing ran the real `voice/tts.py` behind the real bridge. A change on the Python side (handshake, message format, lifecycle, outcome) could break speech with all tests green. |
| **Test** | New `tests/realTtsHandoffTest.ts`: the real bridge and orchestrator; the real `tts.py` as a child process, pygame on SDL's silent `dummy` driver. Only edge-tts is a stand-in module (silent MP3 frames, and a record of each text), so no network or speaker is needed. Checks: tts.py authenticates; `orchestrator.speak()` reaches it with the exact text; `speaking_start` then `speaking_end` with outcome `played`; JARVIS back to IDLE; the same reply a second time is spoken again; speech recorded healthy; audio that cannot be played is reported. Python: `JARVIS_TEST_PYTHON`, else JARVIS's `.venv`; without pygame/websockets it says BLOCKED. |
| **Found by it** | A gap in VOICE-005: when playback threw (`TTS error: …`), `tts.py` ended the turn with no outcome, so the bridge recorded nothing and speech still looked healthy. Now that path records `playback_failed` with the error, and a failure in a turn is kept over a later success, like the other failures. Without this change the test fails 2 of 13 (a broken reply was recorded as "played"). |
| **CI** | Both `build-and-test` (Linux) and `windows` install Python 3.12 + pygame + websockets and set `JARVIS_TEST_PYTHON`, so the test runs there, not BLOCKED. |
| **Proof** | Here: 13/13; `test_tts_fallback.py` 10/10, `test_tts_audio_device.py` 9/9, `test_tts_retry_delay.py` 12/12. |
| **Not done** | The older tests that use `fakeTts.ts` were not converted; they still test JARVIS's side against a stand-in, and this test now covers the real hand-off. Real speakers and Microsoft's service are not part of it; on the owner's PC, `pnpm verify:windows` and hearing JARVIS are the check. |

## 12. VOICE-009

| | |
|---|---|
| **Confirmed** | `voice/stt.py` `_vad_gate()` took one RMS over the whole recording, which includes the pause the recogniser waits for after speech. New `tests/python/test_stt_vad_gate.py` (synthetic 16 kHz audio) on the old code: 3/5 — a short, soft "yes" with the pause after it was rejected (whole-clip RMS ~250 against a 450 threshold, the word itself ~707), and a single 20 ms click in silence passed (whole-clip RMS ~570). |
| **Fix** | The gate measures 20 ms frames and passes when at least 100 ms of them reach `noise_floor × JARVIS_STT_MIN_ENERGY_RATIO`. The threshold and the ratio setting are unchanged; audio shorter than one frame is rejected; numpy missing still lets audio through, as before. The log line now says how many ms were above the threshold and the loudest frame. |
| **Proof** | 5/5; `py_compile` clean; added to CI `python-checks`. |
| **Not verified** | A real microphone on the owner's PC. If short words are still dropped, the log shows `VAD gate rejected audio: N ms above threshold=…`; lowering `JARVIS_STT_MIN_ENERGY_RATIO` in `.env` (default 1.5) is the setting to try. |

## 13. VOICE-006 (deferred)

| | |
|---|---|
| **Confirmed** | While JARVIS speaks, `jarvis.ts` (`speaking:start`) pauses the wake-word listener and takes the microphone; it resumes on `speaking:end`. So the owner cannot interrupt by voice mid-reply. This is deliberate: without it JARVIS hears its own voice (the echo problems VOICE-008 and the echo filter deal with). |
| **Why not fixed here** | Listening during playback needs acoustic echo cancellation, or a wake-word detector that reliably ignores JARVIS's own voice, plus a stop path from the wake-word service to `tts.py`. That changes the voice architecture and needs testing with the owner's real microphone and speakers; it is not a contained bug fix, and the repair rules say not to replace the architecture. |
| **Next step (proposal)** | A separate phase: (1) measure on the owner's PC whether the wake-word model fires on JARVIS's own speech at normal volume; (2) if it does not, keep the wake-word listener running during playback with a raised threshold, and on detection send the existing TTS stop command; (3) test with real speakers before enabling by default. |

## 14. Second pass (owner's detailed repair brief, 18 October 2026)

The brief's requirements were checked one by one against the fixes above; these gaps were found and closed.

| Finding | Gap found | Fix | Test (old code → now) | Commit |
|---|---|---|---|---|
| VOICE-001 | No `tts.py` connected, or its connection dropping mid-reply: the reply was queued and nothing ended the speaking turn; JARVIS stayed in SPEAKING, wake word paused, until the watchdog. | The bridge ends that turn at once (outcome `not_connected`, reply kept and spoken when `tts.py` connects); the orchestrator ends a request in SPEAKING normally when no reply is in flight. | `ttsDeliveryLifecycleTest` 8/13 → 13/13 | `919c8c3` |
| VOICE-005 | Outcomes were not tied to a request: a stale or repeated `speaking_end` was recorded as the current reply's result and closed its turn; watchdog and stop left no outcome; the engine was not reported. | Request ids on `tts` messages, `ids` and `engine` on `speaking_end`; stale ends ignored; partial ends keep the turn open; `timed_out` (failure), `cancelled` and `not_connected` (not failures); dashboard degraded only for failures and names the voice. | `speechRequestCorrelationTest` 6/16 → 16/16; `realTtsHandoffTest` checks ids/engine from the real `tts.py` | `919c8c3` |
| VOICE-002 | The startup config report said nothing about an unsafe `JARVIS_PLANNING_WATCHDOG_MS`. Fast answers and late answers after a timeout were not tested. | `configValidator` WARNING with the value used and the `.env` line. Tests: a fast answer completes; a tool call arriving after the reset does not run (shown to run without the reset), only the timeout message is said, no second goal. | `llmTimingTest` 21/24 → 24/24; `planningTimeoutSpeechTest` 12/12 | `e315eda` |
| VOICE-003 | An empty file from edge-tts or from a fallback voice counted as speech; the fallback WAV was left behind; self-healing still ran `fallback_tts` and reported "TTS switched to fallback: pyttsx3". | Empty audio is no audio (edge-tts retry, then fallbacks); WAV removed after playing; the crash plan no longer adds `fallback_tts`, and the action no longer claims a switch. | `test_tts_fallback.py` 16/19 → 19/19; `ttsFallbackHonestyTest` 1/4 → 4/4 | `40d8e92` |
| VOICE-004 | "No retry storm" for a device that stays broken was not tested. | (Behaviour already correct.) | `test_tts_audio_device.py` +2 → 11/11 | `cf956e3` |
| E2E | The slow-response timeout was not tested through the real `tts.py`. | `realTtsHandoffTest`: the watchdog ends a stuck request and the real `tts.py` plays "That took too long". | 18/18 | `cf956e3` |

Three older tests (`ttsLifecycleStateTest`, `speakingWatchdogQueueTest`, `supersededRequestTest`) drive `speaking_end` by hand with no `tts.py` connected; they now register a connected stand-in (`attachSilentTtsClient`), which is what they assumed. No assertion was changed.
