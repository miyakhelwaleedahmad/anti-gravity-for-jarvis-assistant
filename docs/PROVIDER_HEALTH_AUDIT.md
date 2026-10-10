# Provider routing and health audit

Branch `claude/jarvis-repair`, starting at `3d98c32`, clean working tree. This report was written before any change (sections 1–4). Sections 5–7 are filled in afterwards. No secret appears here; this environment has no LLM keys, so live Gemini/Groq calls were not made. Provider behaviour was tested against a local HTTP server that answers like the provider.

## 1. Components inspected

| Area | Files |
|---|---|
| Config | `config/llmconfig.ts`, `config/configValidator.ts`, `.env.example` |
| LLM client and router | `bridge/groqProvider.ts` (the primary client for either provider), `bridge/openaiProvider.ts` (optional fallback), `bridge/modelRouter.ts` |
| Self-healing state | `self_healing/pipelineRegistry.ts`, `healthChecker.ts`, `pipelineWatchdog.ts`, `selfHealingManager.ts`, `alertManager.ts`, `fsWatcher.ts` |
| Dashboard | `monitoring/healthManager.ts` |
| Vector memory | `memory/vectorMemory.py`, `memory/vectorMemorySupervisor.ts`, `memory/memoryManager.ts` |
| Voice | `voice/tts.py`, `bridge/nodeBridge.ts`, `core/agentStateMachine.ts` |
| Startup | `jarvis.ts`, `core/orchestrator.ts`, `core/goalManager.ts`, `core/tools/index.ts`, `core/skillLoader.ts`, `perception/windowsState.ts` |

## 2. Provider path, traced

`.env` → `resolveProviderSettings()` (`config/llmconfig.ts`) → `llmConfig` → `GroqProvider` (`bridge/groqProvider.ts`, despite its name a generic OpenAI-compatible client that uses `llmConfig.baseURL`, key and models) → `ModelRouter` (primary = `llmConfig.provider`; the optional `openai` fallback only when `JARVIS_FALLBACK_API_KEY`/`_BASE_URL` is set).

Selection rules in place:

- `JARVIS_LLM_PROVIDER=groq|gemini` (case-insensitive) wins.
- Otherwise the provider is chosen from the keys: only a Gemini key → Gemini; any other combination → Groq. When both keys are set, a note explains the choice.
- An explicit provider whose key is missing stays that provider. The validator reports a CRITICAL missing-key error; JARVIS does not switch silently.

**Verdict:** requests go to the configured provider. Your log (provider `gemini`, base URL `…/v1beta/openai`, Gemini probe OK) agrees with this path. **No request is sent to Groq when Gemini is configured.**

## 3. Root cause of the "Groq" confusion

The Groq names are labels left over from when Groq was the only provider:

| Where | What it says | What it actually is |
|---|---|---|
| `pipelineRegistry` default list, `healthChecker`, `pipelineWatchdog`, `fsWatcher` | `brain_to_groq` | The LLM call path for whichever provider is configured; the probe pings `llmConfig.baseURL` |
| same + `memoryManager.scheduledWrite` | `groq_to_memory` | The memory database write and the vector-memory probe; nothing to do with Groq |
| `alertManager` voice text | "a warning in my brain_to_groq system" | Spoken aloud, so a Gemini user can hear "Groq" |
| watchdog heal plan | `target: "groq"` | Pings the configured provider |

## 4. Findings

Legend: **D** = confirmed defect (to fix) · **N** = naming or log noise (to fix, harmless) · **E** = expected behaviour (no change) · **U** = could not be reproduced here (documented)

| # | Finding | Kind |
|---|---|---|
| 1 | Pipeline names `brain_to_groq`/`groq_to_memory` and the spoken alert name Groq while Gemini is active | N |
| 2 | `healthChecker`: the vector-memory probe and the MemoryManager probe write to the same pipeline (`groq_to_memory`) in the same round. A vector failure is wiped by the MemoryManager success, depending on which finishes last | D |
| 3 | LLM probe: "rate-limited means reachable" is decided by the text `(429)`. The `/models` error reads "returned 429", so a rate-limited provider is reported as failed. Auth, timeout and server errors are not told apart | D |
| 4 | Dashboard `probeLLM` says *online* when a key exists. A rejected key, an unknown model or an exhausted quota still shows online; the probe results never reach it | D |
| 5 | Real LLM requests never update the LLM pipeline; only the probe (every 2 min) does, so a past failure stays shown after the provider recovered | D |
| 6 | `ping()` checks `JARVIS_BRAIN_MODEL` only. A wrong `JARVIS_FAST_MODEL` surfaces only when a 429 forces a switch to it | D |
| 7 | An unsupported `JARVIS_LLM_PROVIDER` value (e.g. `openai`) is reported at INFO level although JARVIS ignores it | D (minor) |
| 8 | Router failover to the optional fallback provider is logged only; the dashboard cannot show that answers came from another provider | D (visibility) |
| 9 | Vector memory: `/health` answers 503 while the model loads. This is by design (`vectorMemory.py` loads in a background thread) | E |
| 10 | The supervisor polls `/health` every 300 ms for 20 s at startup and logs "503 — model still loading" on every poll (up to ~66 lines) | N |
| 11 | Dashboard vector probe uses `/stats`, which answers 200 ("0 vectors") while the model is still loading, so it shows *online* before search works. The `ServiceStatus` model has no "loading" state | D |
| 12 | Dashboard vector probe has a 2 s timeout. While the model loads in the same Python process, responses can be slower, so it shows "probe timed out" and later recovers | D (follows from 11) |
| 13 | The `vector_memory` pipeline (reported by the supervisor) has no heal plan; three failures would log "No heal plan mapped" every minute | D (minor) |
| 14 | The `tool_execution` heal plan targets `toolRegistryV2`, but the heal code checks `toolExecutor`, so they never match | D (minor) |
| 15 | TTS: Node arms the speaking watchdog when it sends text; `speaking_start` comes only after synthesis succeeds. A first edge-tts attempt that times out (5 s) plus a successful retry plus playback outlasts the watchdog's estimate, which allows only 1 s for synthesis. The watchdog fires during a normal retry, then `speaking_end` arrives "late" | D |
| 16 | The first edge-tts attempt timing out is cold-start network latency (a new TLS/WebSocket connection to Microsoft); the retry succeeds | E / U |
| 17 | `goalManager.init()` runs twice: `jarvis.ts` and the `Orchestrator` constructor both call it, and it has no single-run guard. This makes two database objects on one file and two writes, and a goal created between the two runs can be lost | D |
| 18 | 40 then 66 tools: 40 built-in tools register first, then 26 skill tools load later (66 unique names, checked by running both stages). Different stages, no duplication | E (log clarity only) |
| 19 | PowerShell observer 15 s timeout: the first query of a session compiles a C# helper and gets 15 s (later ones 4 s). At startup it competes with the models loading. A late answer is discarded safely. Whether it repeats could not be checked without Windows | U |
| 20 | NodeBridge probe in `healthChecker` reports healthy whenever the object exists, even with no TTS/STT client connected | D |

## 5. Changes (after implementation)

Five commits on `claude/jarvis-repair` (`e872e48`, `dbe3c0d`, `c1eecd7`, `cf75e46`, and this report). No dependency was added; no data store was changed or reset.

| Finding | Change | Files |
|---|---|---|
| 1 | Pipelines renamed `brain_to_llm`, `brain_to_memory`, `vector_memory`. The old names are still accepted everywhere through `canonicalPipeline()`, so older callers and alerts keep working. Spoken alerts use `pipelineLabel()` ("Gemini language model") | `self_healing/pipelineRegistry.ts`, `healthChecker.ts`, `pipelineWatchdog.ts`, `fsWatcher.ts`, `alertManager.ts`, `memory/memoryManager.ts` |
| 2 | Vector memory and the memory manager report to separate pipelines | `self_healing/healthChecker.ts` |
| 3 | LLM errors classified by HTTP status (auth, rate_limit, timeout, network, server, model, bad_request, bad_response). The probe counts a 429 as reachable; a failed probe is counted once | `bridge/llmStatus.ts` (new), `healthChecker.ts`, `groqProvider.ts` |
| 4, 5 | One LLM status record, written by every request, the probe and the router; the dashboard reads it. A failure shows only while it is newer than the last success and belongs to the configured provider. When nothing is known from the last 3 min, the dashboard starts a background model-list check and never waits on the network | `bridge/llmStatus.ts`, `groqProvider.ts`, `monitoring/healthManager.ts` |
| 6 | `ping()` checks the fast model too | `bridge/groqProvider.ts` |
| — | Found while testing: the error after the last retry dropped the HTTP status, so a 503 was "request failed". It now keeps the status | `bridge/groqProvider.ts` |
| 7 | An unsupported `JARVIS_LLM_PROVIDER` or reasoning effort is a WARNING | `config/configValidator.ts` |
| 8 | Fallback answers recorded and shown: "Gemini failed (server 500); answered by fallback provider" | `bridge/modelRouter.ts`, `llmStatus.ts` |
| 10 | "Model loading" logged once per loading phase, not on every 300 ms poll | `memory/vectorMemorySupervisor.ts` |
| 11, 12 | `ServiceStatus` and `PipelineStatus` gained `loading`. The dashboard shows *loading* (with seconds) instead of *online, 0 vectors* or *probe timed out* | `monitoring/healthManager.ts`, `runtimeDashboard.ts`, `pipelineRegistry.ts`, `vectorMemorySupervisor.ts` |
| — | **Found with the real service**: when the model fails to load, it answered 503 "not ready" forever, so it looked like loading. It now reports `model_state: failed` with the reason; the supervisor, health checker and dashboard say "failed to load (…)" | `memory/vectorMemory.py`, `vectorMemorySupervisor.ts`, `healthChecker.ts`, `healthManager.ts` |
| 13, 14 | Heal plan for vector memory (its supervisor restarts it); the tool-registry heal plan now matches | `pipelineWatchdog.ts`, `selfHealingManager.ts` |
| 15 | tts.py sends `speaking_delay` (extra time = the retry's timeout) before a synthesis retry. The bridge passes it to `agentStateMachine.noteSpeechDelayed()`, which restarts the deadline with the extra time (capped at 30 s) and re-arms the mic guard. The watchdog is neither removed nor lengthened by default | `voice/tts.py`, `bridge/nodeBridge.ts`, `core/agentStateMachine.ts` |
| 17 | `goalManager.init()` runs once; later callers wait for it | `core/goalManager.ts` |
| 18 | The log says "40 built-in tools registered; skills load next" and "26 skill(s) loaded: 66 tools in total" | `core/tools/index.ts`, `core/orchestrator.ts` |
| 20 | The bridge probe needs a listening WebSocket server | `bridge/nodeBridge.ts` (`isListening()`), `healthChecker.ts` |

## 6. Tests executed

| Test | Result |
|---|---|
| `tests/providerHealthTest.ts` (new; real local HTTP server answering like Gemini) | 55 passed, 0 failed |
| `tests/vectorReadinessTest.ts` (new; real HTTP server on :8000) | 20 passed, 0 failed |
| `tests/ttsRetryWatchdogTest.ts` (new) | 14 passed, 0 failed |
| `tests/goalManagerInitTest.ts` (new) | 2 passed, 0 failed. **Both failed on the old code**: 2 initialisations, goal lost |
| `tests/startupRegistrationTest.ts` (new) | 5 passed, 0 failed (40 + 26 = 66, unique) |
| `tests/python/test_tts_retry_delay.py` (new, added to CI) | 12 passed, 0 failed |
| `tests/python/test_vector_service_startup.py` (+ blocked-download case) | 23 passed, 0 failed |
| `tests/python/test_vector_persistence.py` | 23 passed, 0 failed |
| Related existing: llmProviderConfig 37, llmClientBehaviour 41, providerFailover 13, faultInjection 13, speakingWatchdogQueue 16, ttsLifecycleState 6, ttsSpeakingLifecycle 8, stopClearsTtsQueue 4, voiceApproval 27, bargeInProcessing 4, vectorSupervisorDashboard 8, vectorStartupGate 12, goalRuntimeMigration 16, dataRootIsolation 18, redaction 51, secretSinks 23, parallelizationTimeoutAudit | all passed |
| Full suite `npx tsx tests/runAll.ts --ci` | **114 passed, 0 failed, 9 skipped**; the skipped tests need Windows, PowerShell 7, Redis, a live LLM API, the bridge token or the Python venv |
| `npx tsc --noEmit` | clean |
| `python -m compileall memory voice vision bridge` | clean |

Real vector service, run here with sentence-transformers. The model download is blocked in this sandbox (HTTP 403). Over 240 s, `/liveness` and `/stats` answered in 1–9 ms and `/health` returned 503. The service stayed "not ready" after the load had failed, which led to the fix above. Embedding and search were checked with the stand-in encoder in the Python tests, not with the real model.

## 7. Remaining risks and what could not be verified

- **Live Gemini/Groq**: no key in this environment; provider behaviour was tested against a local server that answers like Gemini. Run JARVIS on your PC to see the live dashboard row.
- **Real embedding model**: not loaded here (download blocked). Check on your PC with the `/liveness` and search commands below.
- **First edge-tts timeout** (finding 16): the cold first connection to Microsoft's speech service. The fix makes the retry safe; it does not make the first attempt faster. Not reproduced here (no Windows audio, no edge-tts network).
- **PowerShell 15 s first-query timeout** (finding 19): not reproduced without Windows. If it repeats after startup (not only once), send the log lines around `PS query timed out`.
- The dashboard's LLM row is "not checked yet" for the first seconds after start, until the first request or background check finishes.

## 8. Commands to verify on Windows (CMD)

Stop JARVIS first (the vector test needs port 8000 free), then in the project folder:

```
git pull origin claude/jarvis-repair
npx tsx tests\providerHealthTest.ts
npx tsx tests\vectorReadinessTest.ts
npx tsx tests\ttsRetryWatchdogTest.ts
npx tsx tests\goalManagerInitTest.ts
.venv\Scripts\python tests\python\test_tts_retry_delay.py
npm test -- --ci
```

Each test file ends with `=== Results: N passed, 0 failed ===` (55, 20, 14, 2, 12). The last command ends with `0 failed`.

Then start JARVIS with `npm run dev` and check the log:

- `[ToolRegistry] 40 built-in tools registered; skills load next.` and later `26 skill(s) loaded into ToolRegistry: 66 tools in total.`
- `[GoalManager] ✅ Initialized` appears **once**
- `[VectorSupervisor] Embedding model loading (/health 503)…` appears **once**, then `✅ Vector memory is online.`
- no `brain_to_groq` anywhere; the dashboard's LLM row reads `Gemini · model: gemini-3.5-flash · OK …s ago`

While JARVIS runs, in a second CMD window (read-only, adds nothing to memory):

```
curl http://127.0.0.1:8000/liveness
curl -X POST http://127.0.0.1:8000/search -H "Content-Type: application/json" -d "{\"query\":\"what do I like\",\"top_k\":3}"
```

The first should show `"model_state":"ready"`; the second returns your closest stored facts.
