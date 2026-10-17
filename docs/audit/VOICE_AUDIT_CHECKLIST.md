# Voice and forensic audit checklist (audit of 17 October 2026, at `bdd2f86`)

One finding at a time: confirm in the code, a test that fails on the old code, the smallest fix, the test passing, neighbouring tests, commit. "Passed" means run on Linux here; nothing below has been run on the owner's PC unless it says so.

Graphify's index is of `main` (131 commits behind this branch), so code was located with `rg`/`git` on the branch; Graphify was used only where `main` still matches.

| # | ID | Finding | Status | Test (old → new) | Commit |
|---|---|---|---|---|---|
| 1 | VOICE-001 | Same reply twice: second never spoken, JARVIS deaf 12 s | **Fixed** | `ttsRepeatDeliveryTest` 2/4 → 4/4 | see below |
| 2 | VOICE-002 | Answer slower than the planning watchdog dropped silently | Open | | |
| 3 | VOICE-004 | Audio-device failure mutes TTS for the run, unreported | Open | | |
| 4 | VOICE-005 | Speech health = "text was sent" | Open | | |
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
