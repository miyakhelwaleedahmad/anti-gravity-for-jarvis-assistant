# Voice and forensic audit checklist (audit of 17 October 2026, at `bdd2f86`)

One finding at a time: confirm in the code, a test that fails on the old code, the smallest fix, the test passing, neighbouring tests, commit. "Passed" means run on Linux here; nothing below has been run on the owner's PC unless it says so.

Graphify's index is of `main` (131 commits behind this branch), so code was located with `rg`/`git` on the branch; Graphify was used only where `main` still matches.

| # | ID | Finding | Status | Test (old → new) | Commit |
|---|---|---|---|---|---|
| 1 | VOICE-001 | Same reply twice: second never spoken, JARVIS deaf 12 s | **Fixed** | `ttsRepeatDeliveryTest` 2/4 → 4/4 | `4f496f6` |
| 2 | VOICE-002 | Answer slower than the planning watchdog dropped silently | **Fixed** (code); owner's `.env` line still to check | `planningTimeoutSpeechTest` 2/4 → 4/4; `llmTimingTest` 18/20 → 20/20 | `3b9d933` |
| 3 | VOICE-004 | Audio-device failure mutes TTS for the run, unreported | **Fixed** | `test_tts_audio_device.py` 1/6 → 6/6 | `55b915b` |
| 4 | VOICE-005 | Speech health = "text was sent" | **Fixed** | `speechOutcomeHealthTest` 2/7 → 7/7; `test_tts_audio_device.py` +3 outcome checks (fail before) | see below |
| 5 | VOICE-003 | No real TTS fallback; old edge-tts allowed | Open | | |
| 6 | SEC-101 | Launched apps and voice services inherit every secret | Open | | |
| 7 | TEST-101 | `windowControlTest` passes without PowerShell | Open | | |
| 8 | SEC-102 + cleanup | Unused stdin "yes" helpers, dead bridge code, `ts-node` | Open | | |
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
