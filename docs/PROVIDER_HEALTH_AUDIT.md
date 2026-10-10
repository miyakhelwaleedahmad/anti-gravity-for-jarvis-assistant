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

## 5. Changes

See the end of this report (filled in after implementation).
