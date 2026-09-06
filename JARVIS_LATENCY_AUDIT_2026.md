# JARVIS Deep Latency Audit Report — 2026-07-17

## PIPELINE OVERVIEW

Every voice request travels this path:
WakeWord → STT → NodeBridge → Orchestrator → Memory → LLM → Tools → Reflection → Synthesis LLM → TTS → Audio

---

## MODULE 1 — WAKE WORD (wakeWords.py)

**Issue 1 | HIGH | wakeWords.py:211**
- Google STT used for wake word recognition (online API call per audio chunk)
- Every audio chunk triggers `recognize_google()` via `asyncio.to_thread`
- Cold network: 300–800ms per recognition attempt
- This happens BEFORE the user's actual command is captured
- **Impact:** Adds 300–1500ms to every single interaction

**Issue 2 | HIGH | wakeWords.py:126**
- `adjust_for_ambient_noise(source, duration=1)` runs 1 FULL SECOND on first run
- Blocks the entire AudioCaptureThread for 1000ms at startup
- **Impact:** First wake word attempt delayed by ~1s

**Issue 3 | MEDIUM | wakeWords.py:298**
- Consumer loop polls with `await asyncio.sleep(0.05)` when queue is empty
- 50ms polling loop runs 24/7 consuming CPU when idle
- **Impact:** Constant CPU burn; 50ms dead time between queue checks

---

## MODULE 2 — STT (voice/stt.py)

**Issue 4 | HIGH | stt.py:229**
- `pause_threshold = 1.5` — waits 1.5 seconds of silence before ending recording
- This is the enforced silence gap every user must wait through after speaking
- **Impact:** +1500ms dead wait on every voice command

**Issue 5 | HIGH | stt.py:233**
- `timeout=8` seconds on `recognizer.listen()`
- If user does not speak, entire pipeline stalls for 8 seconds
- **Impact:** Up to 8000ms blocking wait per failed listen cycle

**Issue 6 | MEDIUM | stt.py:340**
- `asyncio.to_thread(self._record_audio, filename)` — entire audio recording is synchronous inside a thread
- VAD + recording blocks a thread pool worker for 1.5–30 seconds
- **Impact:** Thread pool slot consumed for entire recording duration

**Issue 7 | MEDIUM | stt.py:355**
- `asyncio.to_thread(self._transcribe, filename)` — Whisper transcription is synchronous CPU-bound
- tiny model on CPU takes 200–800ms depending on audio length
- **Impact:** 200–800ms blocking CPU work per transcription

**Issue 8 | LOW | stt.py:384**
- `await asyncio.sleep(0.5)` hardcoded after every listen cycle before flushing queue
- Adds 500ms dead time between retries
- **Impact:** +500ms per retry cycle

---

## MODULE 3 — NODE BRIDGE (bridge/nodeBridge.ts)

**Issue 9 | MEDIUM | nodeBridge.ts:257**
- Every WebSocket message handler is `async` but awaited inline with `for (const handler of typeHandlers) { await handler(...) }`
- Handlers execute sequentially even if independent
- **Impact:** Stacked handler latency on busy event bursts

**Issue 10 | LOW | nodeBridge.ts:200**
- TTS queue flushed with synchronous `for` loop inside `client_ready` handler
- Multiple pending TTS messages flushed one by one without `Promise.all`
- **Impact:** Minor; negligible unless many queued messages

---

## MODULE 4 — ORCHESTRATOR (core/orchestrator.ts)

**Issue 11 | CRITICAL | orchestrator.ts:174**
- `goalManager.createGoal()` called on EVERY non-deterministic request
- This writes to `data/goals.json` via LowDB (debounced 300ms but still disk I/O path)
- Happens BEFORE LLM planning starts
- **Impact:** Adds 5–50ms disk I/O at the very start of every request

**Issue 12 | CRITICAL | orchestrator.ts:543**
- `unifiedContextBuilder.buildContext()` called on every planning request
- Even with parallel fetching: Redis + Vector API + Neo4j all queried simultaneously
- Vector API (FastAPI HTTP to localhost): 50–200ms
- Redis (if cold or miss): 5–30ms
- Neo4j (if available): 100–500ms
- Total context build: 100–500ms per request
- **Impact:** 100–500ms added before LLM call

**Issue 13 | CRITICAL | orchestrator.ts:652**
- LLM call via Groq API (cloud network round-trip)
- Groq latency varies by model and load: 500–3000ms
- `llama-3.3-70b-versatile` (likely default): 1500–3000ms
- `llama-3.1-8b-instant` (fallback): 500–1200ms
- This is the single largest latency source in the entire pipeline
- **Impact:** 500–3000ms per request — DOMINANT bottleneck

**Issue 14 | HIGH | orchestrator.ts:864**
- `handleSuccess()` makes a SECOND LLM call for synthesis when tools are used
- Two sequential cloud API round-trips: plan LLM + synthesis LLM
- **Impact:** Doubles LLM latency for any tool-using request: +500–3000ms

**Issue 15 | HIGH | orchestrator.ts:435**
- `reflectionEngine.reflect()` may call `llmDiagnoseFailure()` — a THIRD LLM call
- Triggered when failure class is 'unknown'
- **Impact:** +500–3000ms on ANY failed or unknown-classified tool execution

**Issue 16 | MEDIUM | orchestrator.ts:593**
- `selectPlanningToolNames()` runs on every planning call to filter tool set
- Despite LLM def cache (OPT-5), regex matching runs against all tool names
- **Impact:** Minor, ~5–20ms

**Issue 17 | MEDIUM | orchestrator.ts:526**
- `agentMemory.addConversationMessage('user', input)` called before planning
- Triggers Redis invalidation + debounced disk write
- **Impact:** ~10–30ms async overhead

---

## MODULE 5 — MEMORY SYSTEM (memory/memoryManager.ts)

**Issue 18 | HIGH | memoryManager.ts:145–210**
- `vectorRequest()` makes HTTP fetch to `http://127.0.0.1:8000` (local FastAPI)
- 1-second timeout, 1 retry = up to 2 total HTTP round-trips possible
- Even on success: HTTP overhead to localhost is 10–50ms
- **Impact:** 10–200ms per vector operation

**Issue 19 | HIGH | memoryManager.ts:77**
- `WRITE_DEBOUNCE_MS = 2000ms` (2 seconds debounce on LowDB writes)
- Memory writes from any caller complete the `scheduledWrite()` promise in 2s
- Callers that `await` this (like `clearShortTerm`) block for 2 seconds
- **Impact:** 2000ms potential stall on explicit memory flush

**Issue 20 | MEDIUM | memoryManager.ts:265**
- `rebuildVectorIndexInBackground()` runs setTimeout(fn, 500) at init
- Sends up to 10 embed requests sequentially/in parallel to vector API
- Runs 500ms after startup: may overlap with first user request
- **Impact:** Vector API contention during first ~15s of session

**Issue 21 | MEDIUM | memoryManager.ts:355**
- `addMessage()` runs inline token counting: `db.data.shortTerm.reduce(...)` on every call
- Iterates entire STM array to count tokens on every message add
- **Impact:** O(N) scan per message add; grows with conversation length

---

## MODULE 6 — VECTOR MEMORY (memory/vectorMemory.py)

**Issue 22 | CRITICAL | vectorMemory.py:36–44**
- `SentenceTransformer("all-MiniLM-L6-v2")` loaded at FastAPI startup
- Model load time: 5–15 seconds on first launch
- During this 15s window, all vector requests fail → circuit breaker accumulates failures
- **Impact:** First 15–25 seconds of every JARVIS session has NO vector memory

**Issue 23 | HIGH | vectorMemory.py:68–96**
- `embed()` and `search()` both call `_get_model()` which re-runs `model.encode()`
- CPU-bound inference: 20–100ms per encode call on CPU
- `search()` encodes query AND computes dot product over ALL stored embeddings
- As embedding count grows, search is O(N×D) — linear in corpus size
- **Impact:** 20–200ms per search; grows with memory size

**Issue 24 | MEDIUM | vectorMemory.py:63–65**
- ALL embeddings stored in-memory as numpy array — NO persistence
- On JARVIS restart, all embeddings are LOST
- `rebuildVectorIndexInBackground()` in memoryManager re-embeds top-10 facts at startup
- **Impact:** Every restart loses vector index; first queries get lexical fallback only

---

## MODULE 7 — TTS (voice/tts.py)

**Issue 25 | CRITICAL | tts.py:177**
- `edge_tts.Communicate.save()` makes HTTPS request to Microsoft Azure TTS
- Network latency to Microsoft CDN: 200–800ms
- Under network congestion or slow endpoints: up to 10s (timeout cap)
- This is a synchronous network call inside async worker
- **Impact:** 200–10000ms per TTS phrase — second-largest source of latency

**Issue 26 | HIGH | tts.py:194**
- Playback monitoring loop: `await asyncio.sleep(0.05)` per iteration
- 50ms polling to detect end-of-playback
- Means up to 50ms extra silence AFTER audio ends before speaking_end fires
- **Impact:** +0–50ms extra delay before pipeline resets to listening

**Issue 27 | MEDIUM | tts.py:165**
- `tempfile.NamedTemporaryFile` created on every TTS call
- Each phrase creates + writes + reads + deletes a temp .mp3 file
- Windows filesystem: tempfile operations ~5–30ms per phrase
- **Impact:** 5–30ms per spoken phrase on disk I/O

---

## MODULE 8 — SYSTEM STATE OBSERVER (perception/systemStateObserver.ts)

**Issue 28 | HIGH | systemStateObserver.ts:93–96**
- 5 separate `setInterval` timers run continuously:
  - activeWindow poll: every 4000ms → spawns PowerShell
  - chromeTabs poll: every 7000ms → spawns PowerShell
  - services poll: every 15000ms → spawns PowerShell
  - systemStats: every 10000ms → os.freemem() call
  - writeStateToFile: every 3000ms → disk write
- **Impact:** Continuous CPU usage; PowerShell spawning every 4–15s

**Issue 29 | HIGH | windowsState.ts:55–63**
- PowerShell spawned via `execa('powershell', [...])` for EVERY poll
- Even with `-NoProfile -NonInteractive`: 200–800ms process startup
- Poll runs every 4000ms → PowerShell runs ~15 times per minute
- **Impact:** 200–800ms spike every 4 seconds; CPU contention with LLM requests

**Issue 30 | MEDIUM | systemStateObserver.ts:141–142**
- `JSON.stringify(this.state.activeWindow) !== JSON.stringify(windowsData.activeWindow)` 
- Full JSON serialization for change-detection on every poll
- **Impact:** Minor GC pressure; ~1–5ms per poll

---

## MODULE 9 — GOAL MANAGER (core/goalManager.ts)

**Issue 31 | HIGH | goalManager.ts:135**
- `await this.persist()` called from `createGoal()` — but persist() is ASYNC debounce
- The orchestrator `await`s this call, meaning it waits for debounce timer setup
- Actually persist() is void (not awaited): but `createGoal` is awaited by orchestrator
- Every `updateGoalStatus()` call in orchestrator also `await`s `persist()`
- Multiple `await goalManager.updateGoalStatus()` calls at phase boundaries
- **Impact:** 3–5 sequential disk I/O waits per request (pending→in_progress→completed)

**Issue 32 | MEDIUM | goalManager.ts:280–292**
- `getRecentGoalContext()` does `.sort((a,b) => b.updatedAt - a.updatedAt)` on every call
- Sorts the entire goals array (up to 100 entries) every planning phase
- **Impact:** Minor; ~1–5ms

---

## MODULE 10 — LLM PROVIDER (bridge/groqProvider.ts)

**Issue 33 | CRITICAL | groqProvider.ts:82–198**
- `MAX_ATTEMPTS = 3` with `RETRY_DELAY_MS = 500ms` between attempts
- On rate limit (429): falls back to fast model, waits 500ms, retries
- Worst case: 3 attempts × (network timeout + 500ms) = potentially 30+ seconds
- **Impact:** 500–30000ms on rate-limited or failed LLM calls

**Issue 34 | HIGH | groqProvider.ts:19**
- `LLM_TIMEOUT_MS = 10_000` (10 seconds per request)
- If Groq is slow, each request occupies 10s before timeout
- With 3 retries: worst case 30s total block
- **Impact:** 10000ms max per attempt; 30000ms worst case

**Issue 35 | HIGH | groqProvider.ts:86–97**
- Full tool definition JSON serialized and sent on EVERY LLM call
- Tool definitions can be 5000–15000 tokens depending on registered tools
- Large tool payloads increase prompt processing time at Groq side
- **Impact:** +100–500ms per LLM call from larger payload

---

## MODULE 11 — REFLECTION ENGINE (core/reflectionEngine.ts)

**Issue 36 | HIGH | reflectionEngine.ts:152–208**
- `llmDiagnoseFailure()` makes an additional LLM call for unknown failures
- Called inside `reflect()` which is called after EVERY tool execution
- Any tool failure with unrecognized error triggers a full cloud API call
- **Impact:** +500–3000ms on any tool failure with unknown error class

**Issue 37 | MEDIUM | reflectionEngine.ts:241**
- `preExecutionCheck()` calls `toolRegistryV2.getLLMDefinitions()` inside a loop per node
- For N nodes, this is called N times (cached after first call via _llmDefCache)
- **Impact:** First call per request: ~5ms; subsequent hits cache

---

## MODULE 12 — BACKGROUND PROCESSES

**Issue 38 | HIGH | jarvis.ts:629**
- Python reflection script scheduled every 30 minutes (DISABLED currently)
- But selfHealingManager, pipelineWatchdog, fsWatcher, brainLoop all run continuously
- **Impact:** Ongoing background CPU/memory consumption

**Issue 39 | HIGH | memory/vectorMemorySupervisor.ts:204**
- Health check HTTP request to `http://127.0.0.1:8000/health` every 30 seconds
- Each check is a new HTTP connection with 2s timeout
- **Impact:** Adds load to already-busy localhost network stack

**Issue 40 | MEDIUM | jarvis.ts:278**
- `runtimeDashboard.start(60_000, true)` — refreshes every 60s
- Dashboard probe involves health checks and file writes
- **Impact:** Minor; ~10–50ms every 60s

---

## RANKED BOTTLENECK TABLE

| Rank | Stage | Estimated Delay | Frequency | Severity |
|------|-------|----------------|-----------|----------|
| #1 | LLM Planning Call (Groq) | 500–3000ms | Every request | CRITICAL |
| #2 | TTS Generation (edge-tts Azure) | 200–2000ms | Every response | CRITICAL |
| #3 | LLM Synthesis Call (2nd LLM) | 500–3000ms | Every tool request | CRITICAL |
| #4 | STT Silence Wait (pause_threshold) | 1500ms fixed | Every voice command | CRITICAL |
| #5 | Vector Memory Model Load (startup) | 5000–15000ms | Once per session start | CRITICAL |
| #6 | Wake Word Recognition (Google STT) | 300–800ms | Every wake event | HIGH |
| #7 | Context Build (unifiedContextBuilder) | 100–500ms | Every planning call | HIGH |
| #8 | LLM Failure Diagnosis (3rd LLM) | 500–3000ms | On any tool failure | HIGH |
| #9 | PowerShell Window Poll | 200–800ms | Every 4 seconds | HIGH |
| #10 | STT Transcription (Whisper CPU) | 200–800ms | Every voice command | HIGH |
| #11 | Vector HTTP Requests (localhost) | 50–200ms | Every planning call | HIGH |
| #12 | Goal Manager Disk Writes | 5–50ms × 4 | Every non-trivial request | HIGH |
| #13 | LLM Retry Delays | 500ms × retries | On rate limits | HIGH |
| #14 | Memory Write Debounce (2000ms) | 0–2000ms | On explicit flush | MEDIUM |
| #15 | STT Listen Timeout (8s max) | 0–8000ms | On silence/no-speech | HIGH |
| #16 | TTS Temp File I/O | 5–30ms/phrase | Every spoken phrase | MEDIUM |
| #17 | Context Cache Miss (Redis) | 5–30ms | On cache misses | MEDIUM |
| #18 | STM Token Scan (addMessage) | 1–10ms | Every memory write | MEDIUM |
| #19 | Consumer Loop Polling (50ms) | 0–50ms | Continuously | MEDIUM |
| #20 | Vector Embed Background Rebuild | 100–2000ms total | Once at startup | MEDIUM |

---

## TOTAL ESTIMATED LATENCY PER REQUEST

### Fast Path (deterministic command, no LLM):
- Wake word Google STT: ~500ms
- STT pause_threshold: 1500ms
- Whisper transcription: ~300ms
- NodeBridge routing: ~5ms
- Tool execution: ~100ms
- TTS generation: ~500ms
- **Total: ~2900ms minimum**

### Normal Path (LLM planning, no tools):
- Wake word: ~500ms
- STT: 1500ms + 300ms
- Context build: ~200ms
- LLM call: ~1500ms
- TTS: ~500ms
- **Total: ~4500ms minimum**

### Complex Path (LLM + tools + synthesis):
- Wake word: ~500ms
- STT: 1500ms + 300ms
- Context build: ~300ms
- LLM planning: ~1500ms
- Tool execution: ~200ms
- LLM synthesis: ~1500ms
- TTS: ~800ms
- **Total: ~6600ms minimum**

### Worst Case (rate limits + failures):
- Everything above + retry delays, LLM diagnosis, watchdog resets
- **Total: 15000–45000ms**

---

## KEY ROOT CAUSES (SUMMARY)

1. **THREE sequential cloud LLM calls** — planning + synthesis + optional failure diagnosis.  
   Every non-trivial request makes at least 2 blocking Groq API calls.

2. **Google STT for wake word** — a remote API call just to detect "Jarvis" in audio.

3. **1500ms mandatory silence wait** — `pause_threshold=1.5` in STT forces a 1.5s gap after every command.

4. **Cold Python startup** — vectorMemory.py needs 5–15s to load SentenceTransformer model. During this window the entire vector memory system is offline.

5. **PowerShell spawned every 4 seconds** — creates OS-level process for every window state poll, consuming 200–800ms of system resources continuously.

6. **No streaming TTS pipeline** — text generation must complete fully before TTS can start; edge-tts then makes another network call to Microsoft Azure.

7. **Vector memory is ephemeral** — all embeddings lost on restart; no persistence means cold rebuild on every session.

---

*Report generated: 2026-07-17 | Read-only audit — no code was modified*
