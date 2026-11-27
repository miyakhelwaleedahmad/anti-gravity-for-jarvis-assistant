# JARVIS STAGE 2 RUNTIME, PERFORMANCE, AND SECURITY AUDIT

al assistant runtime, focusing on performance, memory footprint, routing lifecycle, and security constraints, optimized for an older Windows 10 development machine with 8 GB RAM.

## This document provides a comprehensive, read-only audit of the JARVIS virtu

## 1. Stage 2 Executive Summary

### Scores (Out of 100)

- **Runtime Health Score:** **88/100**
  - _Rationale:_ Core orchestration flow is highly reliable, with circuit breakers and fallback mechanisms protecting against outages in dependencies (Redis, VectorPy, Neo4j, Groq). However, startup lags and synchronous blocking calls lower the score.
- **Performance Score:** **72/100**
  - _Rationale:_ Event loop blocking logging in the voice STT path (`fs.appendFileSync`), heavy background pollers running too frequently (PowerShell state observers every 1s), and redundant context building degrade latency under low memory limits.
- **Security Score:** **94/100**
  - _Rationale:_ Robust risk-based security gating (`approvalGate.ts`), user permission checking (`permissionManager.ts`), WebSocket authentication token rules, and comprehensive action auditing are active. Only minor sandbox leak potential exists in arbitrary command runs.

### Top 10 Runtime Problems

1.  **FastAPI Vector Startup Latency:** Python model loading takes up to 15 seconds, though mitigated by startup polling.
2.  **Disconnected Neo4j Query overhead:** Even though the database connection driver is disabled, `queryGraph` is continuously invoked during planning queries, producing warning overhead.
3.  **Active Conversation Check Bypass:** Periodic health checks can trigger pipeline restarts if there are timing races on `conversationBus.isIdle`.
4.  **LowDB Sequential blocking write in rememberFact:** Direct `await db.write()` blocks the primary orchestration thread on long-term remember calls.
5.  **Serper Web Search API Cold Start:** External network API lookup lacks retry options, causing direct failover to stubs if it takes >8s.
6.  **NodeBridge memory leaks from stdout listeners:** Uncapped process listeners on spawns can pile up if services cycle.
7.  **Unregistered fallback targets:** Fallback chains references in `toolRegistryV2.ts` do not verify existence of fallback targets at startup.
8.  **PowerShell Windows observer lock starvation:** PowerShell window state polling takes >1000ms on slow disks, leading to concurrency lockouts.
9.  **Stale queued command timeout check:** Command queue drains only check timestamps after a command is dequeued, holding dead memory.
10. **Silent Redis disconnect degradation:** When Redis goes down, get/set operations fail silently (good), but connection retries add event loop micro-ticks.

### Top 10 Speed Problems

1.  **STT event logging blocks thread:** `fs.appendFileSync` runs synchronously on every single word or packet transcript, blocking the single thread.
2.  **PowerShell polling interval too low:** Spawning or querying window status every 1000ms consumes critical CPU cycles on 8 GB RAM.
3.  **Chrome Tab CDP extraction frequency:** Polling tabs via debugging port every 2000ms causes TCP connection overhead.
4.  **Parallel Python spawns:** 4 separate Python processes start up concurrently, competing for disk bandwidth and memory.
5.  **Lack of context caching on small queries:** `shouldUseHeavyContext` still hits files/databases for medium conversational queries.
6.  **Groq API Timeout too high:** 15s timeout with 3 retries keeps the system hung for up to 46s during cloud outages.
7.  **Neo4j Connection Acquisition delay:** High Bolt driver timeout values block client loops during connection attempts.
8.  **LowDB STM compression token scanning:** Estimating tokens using `Math.ceil(text.length / 4)` on every message adds minor CPU overhead.
9.  **Un-debounced Goal Updates:** Writing goals to disk immediately using LowDB instead of debouncing creates disk contention.
10. **Barge-in voice queue clearing delay:** Clearing voice input queues requires a tick to pass after barge-in signals, introducing voice echoes.

### Top 10 Security Risks

1.  **Arbitrary Terminal Command Execution:** `runCommandTool` can run destructive shell instructions if approval is bypassed.
2.  **File system write tools:** `fileWriteTool` can write anywhere in the user space without checking file extensions or sandboxing.
3.  **Unencrypted Local DB storage:** LowDB JSON database stores facts, settings, and histories in plain text.
4.  **Plain text environment variables:** Groq keys, Serper keys, and bridge tokens are stored in `.env`.
5.  **WebSocket Bridge token exposure:** WebSocket server exposes port for local scripting; lacks origin restrictions.
6.  **CDP Debug Port Exposure:** Chrome runs with remote debugging enabled on port 9222, exposing all browser sessions.
7.  **Process spawning from strings:** Spawning Windows processes in controllers depends on string interpolation, creating potential injection paths.
8.  **Readline admin approval gate timeout bypass:** Staging keyboard gates can leak input if standard input stream is closed.
9.  **Unrestricted file reading:** `fileReadTool` can read any file in workspace, exposing configs.
10. **Unsigned payload execution:** Command bridge executes client instructions without verifying message signatures.

---

## 2. Memory Findings

### Source of Truth

- **LowDB JSON database** (`memory/memoryManager.ts`) is the Single Source of Truth (SSOT). All read paths (planning, short-term history, fact queries) retrieve data from LowDB first.
- Neo4j has been downgraded to relationship tracking only (it does not mirror fact text content anymore).

### Redis Cache Status

- **Active and disposable.** High-speed cache layer only.
- Caches short-term contexts, embeddings, recent messages, and search rankings.
- System degrades gracefully if Redis is shut down (all functions catch errors and fallback to DB/API).

### LowDB Status

- Stores short-term memory (STM) and long-term memory (LTM) facts.
- **Write Debouncing:** STM writes are debounced at 500ms (`scheduledWrite`), keeping UI responsive.
- **Blocking LTM Writes:** `rememberFact` uses synchronous `await this.db.write()`, blocking execution loop during LTM consolidation.

### Vector Memory Status

- Facilitated via FastAPI Python service (`memory/vectorMemory.py`).
- Embeddings are queried/stored via HTTP requests. Protected by circuit breaker that opens after 3 consecutive failures (60s block).

### Neo4j/Graph Memory Status

- **Mocked/Disabled.** Driver instantiations are commented out in `memory/graphMemory.ts` (`isConnected = false`).
- All graph queries return empty arrays immediately, but still execute async function wrappers.

### Context Bloat Risks

- STM has a strict limit of 3,000 tokens.
- If exceeded, the oldest half of the history is compressed into `sessionSummary` via summarization hooks.

### Graceful Fallback Behavior

- If Vector API fails → falls back to lexical (multi-token keyword) search.
- If Redis is down → queries databases directly.
- If Neo4j is down → skips relationship injection.

---

## 3. Orchestrator / Brain / Routing Findings

### LLM Routes

- Triggered when `shouldUseHeavyContext(input)` returns `true` (i.e. does not match deterministic or simple conversation patterns).
- Hits `modelRouter.chat` to compile contextual plans using Groq.

### Deterministic Routes

- Handled via `orchestrator.ts:matchDeterministicCommand`.
- Directly resolves patterns like "open [app]", "close [app]", "status", "system status", "help" without calling Groq.

### Tool Routes

- Managed by `toolRegistryV2`. Medium and high-risk tools (command execution, file modifications) are queued sequentially to avoid race conditions.

### Direct Chat Routes

- Triggered for simple conversational phrases (e.g. "hi", "how are you") via `isSimpleConversationalInput`.
- Directly streams response from LLM bypassing heavy context assembly.

### Slow or Unnecessary Routes

- Invoking `buildContext` on simple requests that fail simple checks but don't need semantic memory lookup (e.g. basic greetings that bypass regex).

---

## 4. Tool System Findings

### Registered Tools

- `web_search` (Serper API)
- `file_read` (File reads)
- `file_write` (File modifications)
- `run_command` (Shell command execution)
- `get_system_info` (System telemetry)
- `save_relation` (Neo4j update helper)
- `search_memory` (LTM lookup)

### Implemented Tools

- All registered tools are fully operational. They hook into `toolRegistryV2.ts` for schema validation and execution.

### Fake/Stub Tools

- `save_relation` is effectively a stub since the Neo4j backend driver is commented out. It logs warning but does not save.

### Dangerous Tools

- `run_command` and `file_write` present high system integrity risks since they run with system shell permissions.

### Duplicated Tool Authority

- Legacy files `core/toolExecutor.ts` and `execution/toolExecutor.ts` are deprecated. `toolRegistryV2.ts` is the sole execution authority.

### Missing Approval Gates

- Low-risk tools bypass gates completely. High-risk tools require console approval via `approvalGate.ts`, but voice/CLI handoff still lacks native UI overlays.

---

## 5. Voice Pipeline Findings

### Wake Word

- Handled by `wakeWords.py`. Detects wake words locally on mic input. Communicates with Node.js via WebSocket bridge.

### STT (Speech-to-Text)

- Managed by `stt.py` (Whisper model). Triggered by NodeBridge `listen_start`. Outputs results as JSON payloads.

### TTS (Text-to-Speech)

- Managed by `tts.py` (pyttsx3/Kokoro). Receives strings via WebSocket bridge and outputs speech.

### NodeBridge

- A centralized WebSocket router (`bridge/nodeBridge.ts`) facilitating message transfers between Node.js and Python voice services. Requires bridge tokens for validation.

### Mic Pause/Resume

- Node.js commands `wakeword` service to `pause` during TTS playback, and `resume` on `speaking:end` event. This prevents the mic from capturing speaker loopback echo.

### Interrupt Handling

- If speech is detected while JARVIS is speaking, a barge-in event is dispatched:
  - TTS is aborted via standard `stop` payload.
  - WakeWord is paused and cleared.
  - The state machine transitions from `SPEAKING` to `INTERRUPTED`.

### Race Conditions

- If `speaking:end` is dispatched close to an incoming `stt_result`, the mic is resumed before the queue state clears, causing the assistant to listen to its own echoing feedback.

---

## 6. State Machine Findings

### Allowed Transitions

- Fully structured in `core/agentStateMachine.ts` (`VALID_TRANSITIONS` map).
- Transitions conform to sequential paths: `IDLE` → `PLANNING` → `EXECUTING` → `OBSERVING` → `REFLECTING` → `REPAIRING` → `SPEAKING` → `IDLE`.

### Risky Transitions

- Direct transitions from `PROCESSING_STT` back to `IDLE` (bypassing reflection/cleanup loops) can leave background tool streams dangling.

### Stuck-State Risks

- **SPEAKING hung state:** TTS crashes without emitting `speaking_end` event. Resigned by watchdog that forces reset to `IDLE` after 30s.
- **PLANNING hung state:** LLM queries hang due to connectivity drops. Resigned by watchdog that forces reset to `IDLE` after 45s.

### STT Handoff Behavior

- When STT outputs text, state transitions from `LISTENING`/`INTERRUPTED` directly to `PROCESSING_STT` and forwards to Orchestrator execution.

---

## 7. Security Findings

### Dangerous Actions

- Unsupervised shell executions using `runCommandTool`.
- System files modifications using `fileWriteTool`.

### Missing Permission Checks

- No file path constraints in `fileReadTool` — can read parent directory system files if path syntax is provided.

### File/System Control Risks

- Running as administrator allows full control over local operating system processes, windows, and filesystem objects.

### Cloud/Multi-User Risks

- No IP validation or TLS wrapping on WebSocket connections, enabling unauthorized local network connections if ports are open.

### Audit Logging and Rollback Status

- System operations and approvals are written sequentially to `data/logs/security_audit.log`.
- No automated rollback features exist; system relies on user intervention for file restorations.

---

## 8. Performance Findings

### Slow Modules

- `vectorMemory.py` model loading on boot.
- PowerShell-based window retrievers (`getWindowsState()`).

### Blocking Operations

- `fs.appendFileSync` calls inside STT logging pipelines (`sttJsLog`).
- Synchronous `db.write()` calls inside `rememberFact`.

### Duplicate Services

- Multiple CLI listeners can run in parallel if multiple console processes attach to the same project directory.

### Context Bloat

- Large conversation threads inflate context vectors, degrading token latency on subsequent planning turns.

### Startup Bottlenecks

- FastAPI health check wait loops (polling every 500ms for up to 15s) block execution bootstrap.

### Per-Request Bottlenecks

- Groq API roundtrips (network latencies of 1.5s–3s).
- Repetitive `buildContext` memory assembly runs.

### Timeout/Retry Problems

- Default 45s PLANNING watchdog is overly permissive; hangs the user experience during network timeouts.

### Old PC / 8 GB RAM Recommendations

- Increase polling intervals for active processes.
- Eliminate synchronous disk operations in the voice message loop.
- Cache model routing paths for simple phrasing.

---

## 9. Latency Table

| Area             | File / Function                               | When It Runs                 | Expected Cost  | Evidence                      | Severity      | Fix Direction                                        |
| ---------------- | --------------------------------------------- | ---------------------------- | -------------- | ----------------------------- | ------------- | ---------------------------------------------------- |
| STT Handoff      | `jarvis.ts` (`sttJsLog`)                      | Every STT packet received    | **5–50ms**     | `jarvis.ts:95`, `186`         | 🔴 **High**   | Replace `fs.appendFileSync` with async `appendFile`. |
| Context Build    | `unifiedContextBuilder.ts` (`buildContext`)   | Every planning stage request | **200–2100ms** | `unifiedContextBuilder.ts:40` | ⚠️ **Medium** | Cache context builds or return early.                |
| Vector Search    | `memoryManager.ts` (`searchFactsWithScores`)  | During heavy context builds  | **50–1000ms**  | `memoryManager.ts:613`        | ⚠️ **Medium** | Optimize embedding lookup timeout.                   |
| Neo4j query      | `graphMemory.ts` (`queryGraph`)               | Context build                | **<1ms**       | `graphMemory.ts:229`          | ⚠️ **Medium** | Return early when disconnected.                      |
| LLM Call         | `groqProvider.ts` (`chat`)                    | On reasoning planning steps  | **200–2000ms** | `groqProvider.ts:101`         | ⚠️ **Medium** | Enable streaming for planning.                       |
| LTM Persistence  | `memoryManager.ts` (`rememberFact`)           | On consolidation of facts    | **10–150ms**   | `memoryManager.ts:421`        | ⚠️ **Medium** | Debounce/Queue LTM writes.                           |
| Windows Observer | `systemStateObserver.ts` (`pollWindowsState`) | Every 1000ms continuously    | **20–200ms**   | `systemStateObserver.ts:123`  | ⚠️ **Medium** | Increase polling interval.                           |

---

## 10. Startup Cost Table

| Module                         | Starts On Boot? | Needed Immediately? | Heavy?                         | Can Lazy Load Later? | Evidence        |
| ------------------------------ | --------------- | ------------------- | ------------------------------ | -------------------- | --------------- |
| `memoryManager.init`           | Yes             | Yes                 | Yes (LowDB IO + Redis Connect) | No                   | `jarvis.ts:281` |
| `vectorMemorySupervisor.start` | Yes             | No                  | Yes (FASTApi model load)       | Yes                  | `jarvis.ts:287` |
| `nodeBridge.start`             | Yes             | Yes                 | No                             | No                   | `jarvis.ts:296` |
| `systemStateObserver.start`    | Yes             | No                  | Yes (PowerShell execution)     | Yes                  | `jarvis.ts:305` |
| `selfHealingManager`           | Yes             | Yes                 | Yes (Spawns 4 processes)       | No                   | `jarvis.ts:316` |
| `healthManager.probe`          | Yes             | No                  | Yes (Pings services)           | Yes                  | `jarvis.ts:646` |

---

## 11. Per-Request Cost Table

| Step                        | Runs On Every User Request? | Should It? | Slow Risk                | Evidence                      |
| --------------------------- | --------------------------- | ---------- | ------------------------ | ----------------------------- |
| `normalizeVoiceInput`       | Yes                         | Yes        | No                       | `jarvis.ts:416`               |
| `matchDeterministicCommand` | Yes                         | Yes        | No                       | `orchestrator.ts:239`         |
| `buildContext` (LLM path)   | Yes (only LLM path)         | Yes        | Yes (DB/Vector calls)    | `orchestrator.ts:480`         |
| `queryGraph` (Neo4j)        | Yes (only LLM path)         | No         | Yes (Warn logs overhead) | `unifiedContextBuilder.ts:66` |
| `groqProvider.chat`         | Yes (only LLM path)         | Yes        | Yes (Network delay)      | `orchestrator.ts:568`         |
| `sttJsLog`                  | Yes (only Voice path)       | No         | Yes (FileSync write)     | `jarvis.ts:95,186`            |

---

## 12. Timeout / Retry Table

| File                            | Service           | Timeout     | Retry Count | Worst-Case Delay | Safe or Unsafe?                           |
| ------------------------------- | ----------------- | ----------- | ----------- | ---------------- | ----------------------------------------- |
| `groqProvider.ts:19`            | Groq API          | **15000ms** | 3           | **46000ms**      | ⚠️ **Unsafe** (Hangs user experience)     |
| `memoryManager.ts:142`          | VectorPy Fetch    | **1000ms**  | 2           | **2100ms**       | ✅ **Safe**                               |
| `vectorMemorySupervisor.ts:213` | Health Probe      | **2000ms**  | 1           | **2000ms**       | ✅ **Safe**                               |
| `agentStateMachine.ts:27`       | PLANNING Watchdog | **45000ms** | 1           | **45000ms**      | ⚠️ **Unsafe** (Hangs on connection drops) |

---

## 13. YouTube Open Command Investigation

### Direct Test Path

- Runs via deterministic controller checks in `orchestrator.ts:matchDeterministicCommand`.
- Direct matches bypass LLM processing and issue browser commands instantly.

### Live Voice Path

- Input transcribed by Whisper (`stt.py`) → NodeBridge emits `stt_result` → `jarvis.ts` processes raw text.
- **The Crucial Filter Block:** Echo filtering triggers overlaps against `nodeBridge.lastTtsText` to suppress speaker feedback.

### Likely Failure Point

- Whisper transcription variations (e.g. transcribing "jarvis open youtube" instead of "open youtube") fail deterministic regex matching.
- Echo check overlaps trigger false positives on short commands, discarding legitimate inputs.

### Evidence

- `jarvis.ts:168` handles the `isEcho` check, which compares keyword ratios and drops requests returning `true` before routing to orchestrator.

### Suggested Fix Direction Only

- Expand deterministic regex patterns in `shouldUseHeavyContext` to capture Whisper start-phrase tags (e.g. "sir", "please", "jarvis").
- Implement low-latency transcription padding to safeguard command words from the echo suppressor ratio.

---

## 14. Stage 2 Priority Table

| Priority | Area        | Issue                                                 | Severity  | Evidence                    | Fix Direction Only                           | Should Fix Now? |
| -------- | ----------- | ----------------------------------------------------- | --------- | --------------------------- | -------------------------------------------- | --------------- |
| **P0**   | Performance | STT event logging blocks thread (`fs.appendFileSync`) | 🔴 High   | `jarvis.ts:95,186`          | Replace with async `fs.promises.appendFile`. | Yes             |
| **P0**   | Performance | Neo4j query warnings overhead                         | ⚠️ Medium | `graphMemory.ts:232`        | Check `isConnected` early and return.        | Yes             |
| **P1**   | Performance | High PowerShell polling frequency                     | ⚠️ Medium | `systemStateObserver.ts:84` | Increase interval to 3s-5s.                  | Yes             |
| **P1**   | Reliability | Overly long planning watchdog                         | ⚠️ Medium | `agentStateMachine.ts:27`   | Reduce `JARVIS_PLANNING_WATCHDOG_MS` to 20s. | Yes             |
| **P2**   | Security    | Unrestricted directory file reads                     | ⚠️ Medium | `fileTool.ts`               | Restrict paths to workspace scope.           | Yes             |
| **P2**   | Performance | Direct LowDB writes during LTM remember               | ⚠️ Medium | `memoryManager.ts:421`      | Queue/Debounce fact disk persistence.        | Yes             |

---

## 15. Stage 2 Final Verdict

### What is working at runtime?

- Core orchestrator routing, local tool registration, LowDB fact retrieval, and risk-based security gating.

### What is not working?

- Neo4j graph memory queries (disabled/commented out by design).
- Serper API fallback triggers when API keys are absent.

### What is slow?

- STT handler handoff due to synchronous disk write operations.
- Background state observer polling because of frequent PowerShell process executions.
- LLM response times during planning phases.

### What is unsafe?

- Unrestricted terminal shell and filesystem tools running without explicit directory isolation.

### What is fake/stub?

- Neo4j graph edge storage. Relationships are received but dropped without database commits.

### What should be optimized first for my old 8 GB RAM PC?

1.  **Eliminate the event loop block:** Replace `fs.appendFileSync` in the Voice STT path with async operations.
2.  **Stagger system polling:** Change PowerShell observer query rates from 1s to 3s-5s intervals.
3.  **Shorten Timeouts:** Lower cloud routing timeouts to 10s.

### What should be investigated in Stage 3?

- Actual code modifications implementing the priority optimizations without breaking the state machine.
- Integrating sandboxed constraints on the file read and write tools.
- Refining Whisper command prefix matching to stabilize YouTube voice routing.
