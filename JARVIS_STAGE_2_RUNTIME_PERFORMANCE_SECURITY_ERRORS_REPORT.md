# JARVIS STAGE 2 — RUNTIME, PERFORMANCE, SECURITY ERRORS REPORT
**Audit Date:** 2026-07-04 | **Auditor:** Antigravity AI | **Scope:** Read-only inspection. No files modified.
**Continues from:** JARVIS_STAGE_1_FOUNDATION_ERRORS_REPORT.md

---

## 1. STAGE 2 ERROR SUMMARY

### Scores

| Area | Score / 100 | Notes |
|------|-------------|-------|
| **Runtime Correctness** | 58 / 100 | Core v2 path works; YouTube live voice failure + context overhead on every non-trivial request |
| **Performance** | 44 / 100 | Severe per-request latency stack: buildContext + vector retry + Neo4j try + LLM = long wait chain |
| **Security** | 71 / 100 | Good deterministic gates; approvalGate is console-only (useless in voice mode); open_app has zero safety gate |

---

### Top 10 Runtime Errors

| # | Error | Severity |
|---|-------|----------|
| 1 | unifiedContextBuilder.buildContext() runs on EVERY non-deterministic request, including greetings, despite LLM budget checks happening after | HIGH |
| 2 | graphMemory.ts Neo4j driver is commented out (isConnected = false) but unifiedContextBuilder still attempts a Cypher query every request, producing a warn log per call | HIGH |
| 3 | oice/stt.py writes a temp .wav file per session to the **project root** (not /tmp or data/) — filename has timestamp but RATE of file creation could accumulate on long sessions | HIGH |
| 4 | isSimpleConversationalInput() guard list is tiny (8 phrases) and is checked AFTER matchDeterministicCommand() fails. "who are you" AND "what can you do" are in deterministic list AND simple list — double match guard is redundant but not harmful | MEDIUM |
| 5 | modelRouter.ts has only ONE provider (Groq). If Groq circuit breaks, the chat() throws — there is no local model fallback wired in | HIGH |
| 6 | groqProvider fallback model defaults to llama-3.1-8b-instant (hardcoded) but .env.example says JARVIS_FAST_MODEL=llama-3.3-70b-versatile. The env var is read correctly but if .env is not set, fallback is a different model not in .env.example | MEDIUM |
| 7 | handleSuccess() re-calls LLM (synthesis) even for open_app results that are already in the simpleTools list — but the bypass only works when open_app was routed via LLM. When routed deterministically it bypasses handleSuccess entirely (correct). Risk: if LLM ever decides to use open_app as a tool_call, synthesis will fire | MEDIUM |
| 8 | ememberFact() calls searchVector() before every fact insert for deduplication — 1+ vector API round-trips added to every memory write, including minor fact writes like "Failed task" records written by orchestrator on abort | MEDIUM |
| 9 | memory/vectorMemorySupervisor.ts STARTUP_WAIT_MS = 15_000 — supervisor awaits 15 seconds before first health check, blocking launch() for 15 seconds during boot. This call is non-awaited in jarvis.ts but the supervisor itself blocks internally | MEDIUM |
| 10 | stt.py _pending_stt_queue retry loop flushes AFTER every _locked_listen(). If the WS connection is down, items are re-inserted at index 0. Under a persistent disconnect this can accumulate a growing queue of unsent commands that flood NodeBridge on reconnect | MEDIUM |

---

### Top 10 Speed Errors

| # | Error | Severity |
|---|-------|----------|
| 1 | unifiedContextBuilder.buildContext() is called on every LLM-bound request: it runs getCachedRecentMessages (Redis) + memoryManager.retrieveForPlanning() (Vector API + LowDB) + graphMemory.queryGraph() (Neo4j, no-op but still a function call). Minimum 3 async round-trips before LLM even starts | HIGH |
| 2 | ectorMemorySupervisor.launch() sleeps 15 000 ms before first health check — cold start ALWAYS waits 15 seconds for vector health | HIGH |
| 3 | ememberFact() blocks on searchVector() (1s timeout + 1 retry = up to 2.1s worst case) for EVERY fact write, including transient facts like "Failed task: ..." written on every plan failure | HIGH |
| 4 | groqProvider.chat() retries up to 3 times with 1-second sleeps between attempts = worst-case 3s added before final failure is raised. On 500 errors the user waits up to 3 extra seconds before hearing anything | HIGH |
| 5 | stt.py writes a temp .wav per recording session using syncio.to_thread — disk I/O on every voice input. On an HDD system this adds latency to the STT→transcription pipeline | MEDIUM |
| 6 | memoryManager.decayMemory() is called during orchestrator constructor init on boot, not async deferred — runs on startup alongside all other init tasks | MEDIUM |
| 7 | ddMessage() (short-term memory) triggers cacheRecentMessages + invalidateContextCache on EVERY message — two Redis round-trips per conversation turn, even when Redis is down (round-trip to confirm unavailability) | MEDIUM |
| 8 | LLM context budget logs console.log() 7 lines per planning call — logging is synchronous stdout on every request, minor but cumulative on Windows 10 | LOW |
| 9 | stt_debug.log appends JSON with open() + write() + close() on every STT event synchronously (inside stt_log()). High-frequency voice sessions will hammer the log file | MEDIUM |
| 10 | ectorMemorySupervisor.startHealthLoop() runs every 30 seconds with a 2-second HTTP timeout — 2 open HTTP connections per minute to localhost, even when vector is not actively used. On a constrained PC this wastes resources | LOW |

---

### Top 10 Security Errors

| # | Error | Severity |
|---|-------|----------|
| 1 | open_app skill (skills/automation/skill.ts) has NO security gate — any request that resolves to open_app immediately spawns a process. The LLM can be tricked into calling open_app with arbitrary targets including scripts, executables, or UNC paths | HIGH |
| 2 | pprovalGate.requestApproval() is console-only (eadline on stdin). In voice mode, stdout/stdin are not connected to the user's voice interface — a dangerous HIGH_RISK command during voice use will silently timeout (30s) and be auto-DENIED, with no voice notification | HIGH |
| 3 | commandSafety.ts (terminal-level allowlist used by 	erminalTools) has 
pm, pnpm, 
px, python in the SAFE allowlist. 
pm run <anything> would pass the allowlist check even if the script is destructive | HIGH |
| 4 | permissionManager.ts HIGH_RISK pattern for deletion (\bdel\b) would match del as a substring of model, iddle, etc. — regex \b helps but pattern /\bdel\b/i on the full command string could still false-positive on paths containing del | MEDIUM |
| 5 | graphMemory.ts sanitizes only the elType (relationship label) in Cypher queries — entity names (entity1, entity2) are passed directly as Cypher parameters, which is safe. However queryGraph() accepts a full raw Cypher query string from callers — if ever called with user-generated input this is a Cypher injection risk | HIGH |
| 6 | .env.example does not include NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD — these are used at runtime in graphMemory.ts with insecure defaults (olt://localhost:7687, user=
eo4j, password=password). If Neo4j is ever re-enabled, these defaults will be used | MEDIUM |
| 7 | No authentication or session token on the WebSocket bridge (port 9000). Any process on localhost can connect, impersonate a voice client, and inject stt_result messages — effectively injecting arbitrary commands into JARVIS | HIGH |
| 8 | BRIDGE_PORT=9000 and HEALTH_PORT=9001 are bound on 127.0.0.1 only — currently safe for local-only use. But no firewall rule enforcement is documented, and a misconfigured WSL/Docker port-forward could expose them | MEDIUM |
| 9 | open_app on Windows uses cmd.exe /c start "" <target> — if 	arget contains special shell characters (e.g. &, ;, |) that survive the alias lookup, they could be passed to cmd.exe with unintended side effects. The automation skill does no shell-character sanitization | HIGH |
| 10 | No audit log for open_app executions — securityAuditLogger is only called by permissionManager, which is NOT invoked by the open_app skill or the deterministic router | MEDIUM |

---

---

## 2. MEMORY SYSTEM ERRORS

| Area | File/Function | Error | Evidence | Severity | Fix Direction Only |
|------|--------------|-------|----------|----------|-------------------|
| LowDB SSOT | memory/memoryManager.ts | db.write() is called directly (non-debounced) in ememberFact(), decayMemory(), orgetFact(), pplyFeedback(), clearShortTerm(). Only ddMessage() uses the debounce. Multiple fast writes from one request will trigger multiple synchronous disk flushes | wait this.db.write() at line 399, 457, 659, 685, 719 | MEDIUM | Unify all writes through scheduledWrite() |
| LowDB SSOT | memory/memoryManager.ts:360 | ememberFact() signature has parameter order (fact, source, importance, confidence) but callers in orchestrator use ememberFact(fact, importance, 'agent_failure') — source and importance are swapped, producing incorrect importance scores for failure records | gentMemory.rememberFact('Failed task: ...',  7, 'agent_failure') in orchestrator:386 — maps to source=7 (number!), importance='agent_failure' (string!) | HIGH | Fix caller argument order or add named params |
| Vector Memory | memory/memoryManager.ts:148 | ectorRequest() has MAX_RETRIES=1 and REQUEST_TIMEOUT_MS=1000. Worst case per request: 1s wait + 100ms backoff + 1s retry = 2.1s added to every vector call. ememberFact() calls this before EVERY fact insert | Confirmed in code: MAX_RETRIES = 1, RETRY_BACKOFF_MS = 100 | HIGH | For non-critical paths like deduplication checks, wrap with Promise.race() and a 500ms total budget |
| Vector Memory | memory/vectorMemorySupervisor.ts:32 | STARTUP_WAIT_MS = 15_000 — supervisor unconditionally sleeps 15 seconds after spawning Python before running the first health check. The 15s is hardcoded and has no early-exit for fast startup | Line 197: wait new Promise(r => setTimeout(r, STARTUP_WAIT_MS)) | HIGH | Poll health endpoint every 500ms for up to 15s instead of flat sleep |
| Redis | memory/redisCache.ts | initRedis() uses lazyConnect: true but c.connect() is called immediately after — combined with etryStrategy that tries 3 times with up to 2s between retries, startup adds up to 6s of Redis retry overhead if WSL Redis is slow to respond | Lines 35–74 | MEDIUM | Add explicit connection timeout (connectTimeout: 1000) to limit Redis startup wait |
| Redis | memory/redisCache.ts:269 | invalidateContextCache() deletes BOTH ecentContext AND ecentMessages keys. This means every memory write (including minor fact accesses that boost importance) invalidates the full context cache, forcing a full uildContext on the next request | Lines 268–271 | MEDIUM | Only invalidate ecentContext; keep ecentMessages until session ends |
| Redis | memory/memoryManager.ts:298–301 | ddMessage() fires cacheRecentMessages() + invalidateContextCache() on every message, even assistant acknowledgements ("Understood.", "Anytime, sir."). Two Redis round-trips per turn | Lines 299–301 | MEDIUM | Batch or debounce Redis cache updates with the same 500ms timer as LowDB writes |
| Neo4j | memory/graphMemory.ts:24–27 | Neo4j driver is commented out. isConnected = false. Yet unifiedContextBuilder.buildContext() calls graphMemory.queryGraph(...) on every planning request — the call enters queryGraph(), hits getSession() → returns null → logs [GraphMemory] Neo4j not connected. Cannot execute query. → returns []. This produces a warn log on every request | graphMemory.ts:229–233: session is null, returns [] with warn | MEDIUM | Short-circuit: if !isConnected return [] immediately without warn; or skip the call in unifiedContextBuilder |
| Neo4j | memory/graphMemory.ts:19–21 | Default credentials password='password' hardcoded. If Neo4j is ever re-enabled without setting env vars, it will connect with default credentials | Constructor defaults at lines 19–21; NEO4J_PASSWORD not in .env.example | HIGH | Add to .env.example; add fail-fast check on isConnected before using defaults |
| Context Building | memory/unifiedContextBuilder.ts:24 | uildContext() is called on EVERY non-deterministic, non-simple request. It runs: Redis lookup → vector search (with 1s timeout) → Neo4j query → merge. This entire chain runs even for conversational inputs that isSimpleConversationalInput() would catch — but uildContext() is called INSIDE planPhase(), which is reached before streamDirectChat() check | orchestrator.ts:310 checks isSimpleConversationalInput first, BUT if matchDeterministicCommand() fails and input is not simple, uildContext fires. Non-simple inputs always pay this cost | HIGH | Cache uildContext result per session for ~10s; skip if memoryManager has no facts yet |
| Context Building | memory/unifiedContextBuilder.ts:92 | enforceTokenBudget() truncates at 1500 tokens (6000 chars). The merged context includes STM, LTM, Neo4j, and system state. If STM has 10 messages averaging 100 chars each (1000 chars), LTM has 5 facts (400 chars), and system state (60 chars), the budget is barely enough — but the function just hard-truncates with no awareness of which section gets cut | Lines 62–77 | MEDIUM | Enforce per-section budgets (STM: 400, LTM: 800, Neo4j: 200) before merge |
| Short-Term Memory | memory/memoryManager.ts:304 | MAX_STM_TOKENS = 3000 but compression trigger cuts the OLDEST HALF of messages when exceeded. The "compression" is not a real LLM summary — it just concatenates the text with Summarized older context: prefix and truncates at 500 chars. Any context from before the cutoff is permanently lost without a real summary | Lines 308–324 | MEDIUM | Use LLM-based summary compression or store a rolling summary separately |
| Vector Index Rebuild | memory/memoryManager.ts:127–143 | On init, if long-term memory exists, ALL facts are re-embedded in a background loop with no concurrency limit. If there are 50 facts, 50 sequential vector API calls fire after startup. Each takes up to 2.1s worst-case — potentially 105 seconds of background vector traffic during session startup | Lines 130–142 | HIGH | Limit rebuild to 10 facts max; add concurrency limit of 3 parallel embeds; skip if vector circuit is open |
| Memory Decay | memory/memoryManager.ts:88–95 | memoryManager.decayMemory() is called inside the orchestrator constructor via .then(). Orchestrator is a singleton imported at module load time. This means decay runs during the first import of orchestrator, which happens at jarvis.ts startup — adding an async disk write chain to the startup critical path | orchestrator.ts:88–95 constructor | MEDIUM | Move decayMemory() to a scheduled background interval, not constructor |

---

## 3. ORCHESTRATOR / BRAIN / ROUTING ERRORS

| Route/File | Error | Evidence | Severity | Fix Direction Only |
|-----------|-------|----------|----------|-------------------|
| orchestrator.ts:310 — isSimpleConversationalInput() | The guard list is only 8 hardcoded phrases. Inputs like "tell me a joke", "what's the news", "chat with me" all fall through to the full PLAN path with uildContext + LLM + tools. None of these need tools | simpleGreetings array at lines 1089–1092 | MEDIUM | Expand list or add a lightweight NLU classifier |
| orchestrator.ts:234 — matchDeterministicCommand() | The clean string is created with eplace(/[^a-z0-9\s]/g, '') which removes ALL punctuation. "Open YouTube, please!" correctly becomes "open youtube please". But "open YouTube for me!" also works. However, the ALIAS scan only strips or me, please, 	he,  — NOT 's, 
ow, quickly, up, etc. "Open YouTube now" would NOT match and fall to LLM | orchestrator.ts:1048–1053 strips only 4 filler words | MEDIUM | Add more common filler words: 
ow, quickly, up, ight now, immediately |
| orchestrator.ts:302 — Memory write before routing | gentMemory.addConversationMessage('user', input) fires even for inputs that WILL be routed to the simple conversational path. The simple path check at line 310 happens AFTER this memory write | Lines 301–313 | MEDIUM | Move memory write to AFTER the simple-path check; simple phrases don't need to be stored |
| orchestrator.ts:155 — GoalManager for every request | goalManager.createGoal() is called for EVERY request including deterministic ones (open YouTube, hello). For deterministic routes it is called but then never used — the goal is created, set to in_progress, then the function returns 'success' without updating it. The goal entry is persisted forever with stale in_progress status | orchestrator.ts:155–160 and line 297 (deterministic returns 'success' before goal resolution) | HIGH | Skip GoalManager for deterministic commands; or resolve goal after deterministic path completes |
| orchestrator.ts:550 — Token budget log | 7 console.log() lines print for EVERY planning call. These are synchronous writes to stdout. On a slow Windows terminal these add measurable overhead per call | Lines 524–532 | LOW | Guard behind a DEBUG_MODE flag or reduce to a single summary line |
| core/orchestrator.ts:604–625 — Fallback planner | The rule-based fallback planner checks for search, lookup, ind, system, status — but uses TaskGraphBuilder with a graph.addTask() method that may not exist in the current TaskGraphBuilder API. If planPhase() fails (LLM down), the fallback itself may also throw | Lines 606–621: const graph = new TaskGraphBuilder(input); graph.addTask(...) — TaskGraphBuilder constructor signature may not match | HIGH | Verify TaskGraphBuilder constructor and ddTask() API compatibility; add try/catch around fallback |
| core/orchestrator.ts:704 — handleSuccess() simpleTools bypass | simpleTools list includes 'open_app' but NOT 'control_browser', 'control_app', 'control_window' — these are also deterministic-like tools but if reached via LLM path, they trigger a second LLM call for synthesis. Minor but adds latency | Lines 704–706 | LOW | Add browser/window control tools to simpleTools bypass list |
| modelRouter.ts | Only one provider registered (Groq). If llmConfig.provider is set to anything other than 'groq', chat() throws Provider not registered. There is no runtime validation of the provider name at startup | Lines 18–22 | HIGH | Add startup validation: throw if configured provider is not registered |
| ridge/groqProvider.ts:60 | Fallback model astModel reads process.env.JARVIS_FAST_MODEL with hardcoded default "llama-3.1-8b-instant". But .env.example line 13 sets JARVIS_FAST_MODEL=llama-3.3-70b-versatile. If .env is missing or the variable is unset, the fallback model is different from what .env.example implies — may cause context window mismatches | groqProvider.ts:60: || "llama-3.1-8b-instant" | MEDIUM | Align the default with .env.example; validate model name on startup |
| orchestrator.ts — Repair loop | epairCycles <= maxRepairCycles (default 3) means up to 4 iterations of PLAN → EXECUTE → REFLECT → REPAIR. Each repair with eplan strategy calls planPhase() again (full LLM call + buildContext). Worst case: 4 × (buildContext + LLM + synthesis) = 4 full round-trips | Lines 349, 902–916 | HIGH | Cap repair cycles at 2 for voice mode; skip full replan on simple tool failures |
| orchestrator.ts:482 — GoalManager recent goals | goalManager.getRecentGoalContext(4) is called inside planPhase() — adds another context source to the already-large prompt. No TTL or size guard on goal context string | Lines 481–484 | LOW | Add token budget cap on goal context (max 100 tokens) |

---

## 4. TOOL SYSTEM ERRORS

| Tool/File | Error Type | Evidence | Severity | Fix Direction Only |
|-----------|-----------|----------|----------|-------------------|
| skills/automation/skill.ts — open_app | **No security gate** — any call resolves directly to spawn(cmd.exe /c start ...). LLM can call this with any target string including .exe, scripts, UNC paths, or shell sequences | Skill calls spawn with no validation beyond if (!target) check (line 108–113) | HIGH | Validate target against a URL/app allowlist before spawning; reject unknown targets |
| skills/automation/skill.ts:49 — Windows shell injection | rgs = ['/c', 'start', '', resolvedTarget] — resolvedTarget is passed directly to cmd.exe. While shell: false prevents some injection, cmd.exe /c start "" <target> will still interpret Windows shell meta-chars like &, ^, % in the target string | Confirmed: shell: false but cmd.exe itself parses the arg. A target like "https://youtube.com & calc.exe" would launch both | HIGH | Sanitize esolvedTarget to strip shell metacharacters before spawning |
| skills/automation/skill.ts — False success | esolve(JSON.stringify({ success: true, ... })) is called BEFORE proc.on('error') can fire — the skill always reports success immediately even if the spawn later fails. proc.on('error') fires asynchronously after the promise resolves | Lines 85–92 resolve before error event | HIGH | Use a short race: resolve after 200ms if no error; or listen for 'spawn' event before resolving |
| core/toolRegistryV2.ts — Tool registry | Stage 1 confirmed core/toolRegistry.ts (v1 TOMBSTONED) is still compiled. If both registries are loaded in the same process (e.g. via a script importing both), tool definitions could conflict | Stage 1 finding confirmed | MEDIUM | Delete 	oolRegistry.ts |
| core/tools/index.ts — egisterAllTools() | This is called in the JarvisOrchestrator constructor at every instantiation. If orchestrator.ts is imported as a module multiple times (e.g. in tests), tools are re-registered on each import. 	oolRegistryV2 likely silently overwrites duplicates | orchestrator.ts:68 | LOW | Add idempotency guard to egisterAllTools() |
| 	ools/web_search (inferred) | web_search is listed as a known tool. No direct file examined, but orchestrator's isSimpleConversationalInput() explicitly blocks search verb from the direct chat path, correctly forcing it through LLM routing — which is good. BUT web_search cold-start latency is not guarded; first search of a session will include DNS + TLS handshake overhead | Known concern from user | MEDIUM | Add a warmup ping to the search provider on startup |
| execution/actionExecutor.ts | Confirmed in Stage 1: has safety timeouts and interrupt hooks — the v2 execution path uses 	oolRegistryV2.execute() directly, NOT ctionExecutor. ctionExecutor is imported but effectively unused in the live path | Stage 1 finding | MEDIUM | Confirm whether ctionExecutor timeout/safety is still relevant; if not, remove |
| security/permissionManager.ts:32–41 | SAFE_READ_ONLY_COMMANDS includes 
pm, pnpm, 
px as base commands. 
pm run build, 
pm run malicious-script, 
px attacker-package all have 
pm/
px as the base and pass the safe check | Lines 37–40: 'npm', 'pnpm', 'npx' in SAFE set | HIGH | Remove 
pm, pnpm, 
px from SAFE_READ_ONLY; classify as MEDIUM_RISK at minimum |
| security/approvalGate.ts | Approval gate uses eadline on stdin. In voice mode, JARVIS has no voice approval channel. If a HIGH_RISK command is triggered via voice, the system waits 30 seconds in silence, then auto-denies. User gets no voice feedback that approval is required | Lines 97–99: if (!process.stdin.isTTY) reject(...) | HIGH | Add a voice notification path: call orchestrator.speak(...) before waiting for console approval |
| graphMemory.ts:64 — Cypher label injection | elType = relation.toUpperCase().replace(/[^A-Z_]/g, '') correctly sanitizes relationship label. BUT queryGraph() takes a raw Cypher string with no validation. If ever called with user-controlled input it is a full Cypher injection surface | graphMemory.ts:229: sync queryGraph(query: string, parameters?: any) | MEDIUM | Add a read-only flag; restrict queryGraph to pre-defined query templates |

---

## 5. VOICE PIPELINE ERRORS

| Voice Area | File | Error | Evidence | Severity | Fix Direction Only |
|-----------|------|-------|----------|----------|-------------------|
| STT — Temp file location | oice/stt.py:344 | ilename = f"temp_stt_{int(time.time())}.wav" writes temp files to the **current working directory** (project root). On a long session, if cleanup fails (exception at line 381), these accumulate | os.remove(filename) in inally at line 376–380 — can fail silently | HIGH | Write to 	empfile.gettempdir() or data/temp/; ensure cleanup in inally always runs |
| STT — Empty result sent | oice/stt.py:351 | When STT times out (WaitTimeoutError), an empty string is sent as stt_result. NodeBridge receives a stt_result with empty text. If orchestrator processes this empty string, it reaches matchDeterministicCommand("") (returns null) → isSimpleConversationalInput("") (returns false) → full LLM plan with empty input — LLM response to empty string is undefined | _send_result("") called at line 351 | HIGH | NodeBridge or jarvis.ts must filter stt_result with empty/whitespace-only text before routing to orchestrator |
| STT — Recording to transcription gap | oice/stt.py:346,361 | Both _record_audio and _transcribe use syncio.to_thread() — they run in separate thread pool threads. Between them, the WAV file is written to disk and then read back. No in-memory buffer is used — disk round-trip on every recognition | Lines 346, 361 | MEDIUM | Pass audio data in memory (bytes) directly to Whisper instead of disk I/O if API supports it |
| STT — Pending queue flood | oice/stt.py:308–310 | If WS send fails, the normalized text is appended to _pending_stt_queue. If NodeBridge is down for 5 minutes of voice session, queue accumulates. On reconnect, _flush_pending_queue() sends all queued items with only 0.3s gap — could flood orchestrator with stale commands | Lines 312–337 | MEDIUM | Cap queue at 3 items; discard oldest on overflow |
| TTS — No timeout on communicate.save() | oice/tts.py:121 | wait communicate.save(tmp_path) calls edge-tts which makes an HTTPS request to Microsoft. There is no timeout set on this call. If Microsoft's TTS endpoint is slow or unreachable, speak() will hang indefinitely, blocking the TTS worker loop | Line 121: wait communicate.save(tmp_path) — no timeout | HIGH | Wrap with syncio.wait_for(communicate.save(tmp_path), timeout=10.0) |
| TTS — Temp file race | oice/tts.py:114–154 | Temp file is created, then communicate.save() streams to it. If the process crashes between creation and save, the temp file is left on disk. 	mp_path cleanup in inally covers most cases but CancelledError re-raises before the inally runs in some Python exception ordering scenarios | Line 139–147: aise after cancel cleanup | LOW | Use contextlib.AsyncExitStack or syncio.shield() to guarantee cleanup |
| TTS — Worker task not restarted on connection loss | oice/tts.py:171 | _worker_task is created once in un(). If the WebSocket connection drops and un() loops (reconnects), the existing _worker_task continues running — but self.websocket is None during reconnect. The worker tries to send speaking_start/speaking_end on a None websocket | Line 89: if self.audio_queue.empty() and self.websocket: — guard exists but only for speaking_end. Line 70: if not self.speaking and self.websocket is not None: guards speaking_start | MEDIUM | Restart _worker_task on each reconnect; drain the queue before restart |
| Echo Filter — Both Python and JS | oice/stt.py:148, jarvis.ts:111 | Echo filter logic is **duplicated** in both Python (stt.py) and TypeScript (jarvis.ts). Both run independently. A TTS phrase filtered by Python stt.py and NOT sent will never reach TS. A phrase that passes Python but is caught by TS will be silently dropped. The last_tts_text state they compare against may be out of sync | Two separate is_echo() implementations at stt.py:148 and jarvis.ts:111 | MEDIUM | Single source of truth for echo filtering — remove the Python copy and do it only in jarvis.ts NodeBridge handler, which has authoritative TTS knowledge |
| Wake word → STT handoff | oice/wakeWords.py (not read but inferred from self-healing) | Wake word detection triggers listen_start sent to NodeBridge. NodeBridge relays it to STT. If STT receives listen_start while already recording (session_lock.locked()), the command is silently dropped. No queue for missed listen_start events | stt.py:414–416: if self.session_lock.locked(): log.warning ... continue | MEDIUM | Queue at most 1 deferred listen_start for replay after current recording completes |
| Microphone reuse | oice/stt.py:237 | sr.Microphone() is opened fresh on EVERY _record_audio() call via with sr.Microphone() as source:. Opening the microphone device on each call adds hardware enumeration overhead. On some Windows setups this can take 200–500ms per call | Line 237: with sr.Microphone() as source: inside _record_audio | MEDIUM | Cache the sr.Recognizer() and use a persistent microphone stream with VAD |

---

## 6. STATE MACHINE ERRORS

| State/Transition | File | Error | Evidence | Severity | Fix Direction Only |
|-----------------|------|-------|----------|----------|-------------------|
| IDLE → PLANNING → EXECUTING (deterministic path) | core/orchestrator.ts:238–239 | Deterministic commands force PLANNING then EXECUTING transitions using 	ry/catch silently swallowing any illegal transition. If state is already EXECUTING when a second deterministic command arrives, the transition is silently ignored and the command still runs | 	ry { agentStateMachine.transition(AgentState.PLANNING); } catch {} — exception swallowed | MEDIUM | Log swallowed transitions; do not execute a command if state could not be properly set |
| SPEAKING → reset | core/orchestrator.ts:196–202 | After process() completes, if state is SPEAKING, reset is deferred to when speaking:end event fires. But if TTS Python client crashes or disconnects without sending speaking_end, the speaking:end event never fires — JARVIS stays in SPEAKING state permanently | isConversationEndDeferred = true with no timeout fallback if speaking:end never arrives | HIGH | Add a 30-second watchdog timer that forces reset if still in SPEAKING after TTS should have finished |
| INTERRUPTED — ignored requests | core/orchestrator.ts:142–145 | When state is INTERRUPTED, process() returns early and the input is discarded. No feedback is given to the user. No voice message is spoken | Lines 143–144: console.log ... return with no 	his.speak() | MEDIUM | Speak a short message: "One moment, sir — still processing." before returning |
| PLANNING state exposed to interrupt | core/agentStateMachine.ts (inferred) | Stage 1 confirmed PLANNING and EXECUTING are in BUSY_STATES. A barge-in during PLANNING will interrupt the orchestrator mid-plan. But if the interrupt arrives between wait buildContext() and wait modelRouter.chat(), the LLM call may already be in-flight. The interrupt sets state to INTERRUPTED but the in-flight fetch cannot be cancelled without an AbortSignal | orchestrator.ts:556: if (this.isInterrupted()) return null checks AFTER the LLM call — too late if already called | HIGH | Pass an AbortController.signal to every modelRouter.chat() call so it can be cancelled mid-flight |
| OBSERVING / REFLECTING states not gated | core/orchestrator.ts:360–366 | OBSERVING and REFLECTING states are set and immediately advance without any real work — they are marker states only. A barge-in during these transitions is checked via isInterrupted() between them. But collectObservations() and eflectionEngine.reflect() are synchronous-ish and do not check for interrupts mid-execution | Lines 360–367 | LOW | Add interrupt check inside the reflection loop |
| STT handoff race — PROCESSING_STT state | jarvis.ts (inferred from stt_result handler) | When stt_result arrives while state is PLANNING/EXECUTING (busy), the input is queued in oiceInputQueue. On return to IDLE, the queue is replayed. But if 3 commands are queued and the user says "stop", the stop command may be in the queue BEHIND the earlier commands, not processed first | oiceInputQueue is FIFO; stop is not special-cased for priority processing | MEDIUM | Process stop/cancel commands from the voice queue immediately, ahead of other queued inputs |
| No timeout on PLANNING or EXECUTING | core/agentStateMachine.ts (inferred) | Stage 1 confirmed watchdog tests exist for SPEAKING state. But PLANNING and EXECUTING states have no watchdog timer. If modelRouter.chat() hangs (e.g., Groq connection stalls without timeout), JARVIS stays in PLANNING forever | No evidence of PLANNING watchdog timer | HIGH | Add watchdog timers for PLANNING (max 30s) and EXECUTING (max 60s); transition to IDLE on timeout |

---

## 7. SECURITY ERRORS

| Area | Dangerous Behavior | Evidence | Severity | Fix Direction Only | Must Fix Before Cloud? |
|------|-------------------|----------|----------|-------------------|----------------------|
| open_app — No allowlist | Skill spawns any process without security gate | skills/automation/skill.ts:63–83 | HIGH | Validate target against hardcoded URL/app allowlist before spawning | YES |
| open_app — Shell meta-chars | cmd.exe /c start "" <target> with unsanitized target | utomation/skill.ts:49 | HIGH | Strip &, |, ;, %, ^, >, < from target before passing to cmd | YES |
| pprovalGate.ts — Voice mode dead | Approval prompt is console-only; voice commands that trigger HIGH_RISK silently time out | pprovalGate.ts:97–99: denies immediately if not TTY | HIGH | Add voice notification before waiting; expose approval to UI layer | YES |
| permissionManager.ts — npm/npx in SAFE | 
pm run <anything> passes the safe check | permissionManager.ts:37–40 | HIGH | Move 
pm, pnpm, 
px to MEDIUM_RISK minimum | YES |
| WebSocket bridge — No auth | Port 9000 WebSocket has no auth token; any localhost process can connect and inject commands | ridge/nodeBridge.ts — no token exchange found | HIGH | Add shared secret / HMAC token handshake on client_ready | YES |
| Neo4j — Hardcoded password default | Default password=password will be used if Neo4j is re-enabled without .env | graphMemory.ts:21 | HIGH | Add to .env.example; validate before connecting | YES |
| graphMemory.queryGraph() — Raw Cypher | Full raw Cypher string accepted from callers | graphMemory.ts:229 | MEDIUM | Restrict to named parameterized query templates | YES |
| Deterministic router — No audit log | open_app, close_app, enable_full_control_session log nothing to securityAuditLogger | orchestrator.ts:241–295 — no securityAuditLogger call | MEDIUM | Log all automation-class commands to audit log regardless of route | YES |
| commandSafety.ts — Parallel allowlist | Terminal-level allowlist in commandSafety.ts overlaps with permissionManager.ts — two separate sources of truth for what's safe | Stage 1 finding confirmed | MEDIUM | Consolidate into single permissionManager; delete commandSafety.ts | YES |
| enable_full_control_session — No approval | Deterministic route enables full control session without any approval gate | orchestrator.ts:280–282 | HIGH | Require verbal/console confirmation before enabling full control mode | YES |
| No per-user identity | All requests are treated as a single trusted user; no session identity, no user ID in audit logs | Architecture-level | CRITICAL | Must implement user identity layer before any cloud or multi-user access | YES |
| No rate limiting | Orchestrator accepts unlimited voice commands per second | Architecture-level | HIGH | Add input rate limiter (max 1 command per 2 seconds) for voice path | YES |

---

## 8. PERFORMANCE ERRORS

| Area | File/Function | Slow Behavior | Evidence | Severity | Fix Direction Only |
|------|--------------|---------------|----------|----------|-------------------|
| Context building | memory/unifiedContextBuilder.ts:24 | uildContext() fires on every LLM-bound request — 3 async subsystem calls before LLM starts | Lines 28–51 | HIGH | Cache result for 10s per session; skip if no long-term facts |
| Vector health check sleep | memory/vectorMemorySupervisor.ts:197 | 15-second flat sleep on every cold start of vector supervisor | STARTUP_WAIT_MS = 15_000 | HIGH | Replace with health-poll loop at 500ms intervals |
| Vector dedup on every fact write | memory/memoryManager.ts:364 | ememberFact() calls searchVector() synchronously before insert — adds up to 2.1s per fact write | Lines 364–410 | HIGH | Make dedup async background check; do not block fact insert |
| LLM retry sleep | ridge/groqProvider.ts:99,164 | 1s sleep on 500 error; 1s sleep between 3 attempts = up to 3s added latency before LLM failure is raised | Lines 99, 164 | HIGH | Reduce 500-error sleep to 500ms; circuit break after 2 consecutive 500s |
| Memory write frequency | memory/memoryManager.ts | db.write() called directly (non-debounced) in 5 methods — each adds a synchronous LowDB JSON flush | Lines 399, 457, 659, 685, 719 | MEDIUM | Route all writes through scheduledWrite() debounce |
| Startup vector rebuild | memory/memoryManager.ts:127–143 | All long-term facts re-embedded on init with no concurrency limit | Lines 130–142 | HIGH | Cap at 10 facts; add parallelism limit of 3 |
| Redis retry on startup | memory/redisCache.ts:40–44 | 3 retries with up to 2s each = up to 6s Redis wait on startup when WSL is slow | etryStrategy at lines 40–44 | MEDIUM | Add connectTimeout: 1000 config option |
| STT disk I/O per recording | oice/stt.py:244,262 | WAV written to disk, then read back by Whisper on every voice command | _record_audio writes, _transcribe reads | MEDIUM | Use in-memory bytes buffer if Whisper supports it |
| Microphone re-init per call | oice/stt.py:237 | sr.Microphone() context manager opened fresh per recording | Line 237 | MEDIUM | Cache microphone device handle |
| TTS edge-tts network call | oice/tts.py:121 | communicate.save() makes HTTPS call to Microsoft on every TTS phrase with no timeout | Line 121 | HIGH | Add 10s timeout; consider local TTS fallback (pyttsx3) if offline |

---

## 9. LATENCY ERROR TABLE

| Area | File/Function | When It Runs | Slow Risk | Evidence | Severity | Fix Direction Only |
|------|--------------|-------------|-----------|----------|----------|-------------------|
| Memory decay | memoryManager.decayMemory() | At orchestrator constructor init (first import) | Adds disk write at startup | orchestrator.ts:88–95 | MEDIUM | Move to scheduled background interval |
| STM context retrieval | getCachedRecentMessages() | Every uildContext() call | Redis round-trip (fast if up, adds 1 round-trip if down) | unifiedContextBuilder.ts:28 | LOW | Already has Redis fast path — acceptable |
| LTM vector search | memoryManager.retrieveForPlanning() | Every uildContext() call | Up to 2.1s if vector API is slow | unifiedContextBuilder.ts:35 | HIGH | Cache with 10s TTL per query |
| Neo4j graph query | graphMemory.queryGraph() | Every uildContext() call | No-op (disabled) but still function call + warn log | unifiedContextBuilder.ts:40–51 | MEDIUM | Short-circuit when !isConnected without warn |
| LLM planning call | modelRouter.chat() | Every non-deterministic, non-simple request | Network latency to Groq API (500–3000ms) | orchestrator.ts:559 | HIGH | Cannot eliminate — reduce context to lower token processing time |
| LLM synthesis call | handleSuccess() → modelRouter.streamChat() | After every successful tool execution | Additional LLM call after tool results | orchestrator.ts:762 | HIGH | Skip synthesis for open_app, system_info, other simple tools |
| STT audio recording | stt.py:_record_audio() | Every voice command after wake word | Microphone re-init + audio buffer + disk write | stt.py:224–254 | MEDIUM | Cache mic handle; use in-memory buffer |
| STT Whisper transcription | stt.py:_transcribe() | Every voice command | CPU-bound — tiny model is fast but thread-blocked | stt.py:256–271 | LOW | syncio.to_thread already used — acceptable |
| TTS edge-tts HTTPS | 	ts.py:communicate.save() | Every TTS phrase | HTTPS request to Microsoft + disk write + pygame load | 	ts.py:121 | HIGH | Add timeout; pre-cache common phrases |
| Vector index rebuild | memoryManager._init() | At startup if long-term facts exist | N × 2.1s worst-case (N = fact count) | memoryManager.ts:130–142 | HIGH | Background, rate-limited, max 10 facts |
| Tool registration | egisterAllTools() | Every JarvisOrchestrator constructor call | Synchronous iteration over all tools | orchestrator.ts:68 | LOW | Add idempotency guard |
| Skill loading | SkillLoader.loadSkills() | Every JarvisOrchestrator constructor call | Async file system scan of skills/ directory | orchestrator.ts:73 | LOW | Already async non-blocking — acceptable |

---

## 10. STARTUP COST ERROR TABLE

| Module | Starts On Boot? | Error/Concern | Evidence | Severity | Fix Direction Only |
|--------|----------------|---------------|----------|----------|-------------------|
| memoryManager.init() | YES — awaited | Reads LowDB JSON + Redis init + triggers background vector rebuild | jarvis.ts:188 | MEDIUM | Acceptable; vector rebuild should be rate-limited |
| ectorMemorySupervisor.start() | YES — fire-and-forget | Spawns Python process + sleeps 15s before health check | jarvis.ts:194 | HIGH | Replace 15s sleep with poll loop |
| 
odeBridge (WebSocket server) | YES | Starts WS server on port 9000 — fast | jarvis.ts | LOW | OK |
| selfHealingManager | YES | Starts all Python voice services (wakeWords.py, stt.py, 	ts.py) via spawn | jarvis.ts | LOW | OK — necessary |
| pipelineWatchdog | YES | HTTP health server on port 9001 + periodic pipeline checks | jarvis.ts | LOW | OK — lightweight |
| sWatcher | YES | Watches oice/ folder for Python file changes — watches for eflectionEngine.py which does not exist | sWatcher.ts:27 | MEDIUM | Remove watcher for missing file |
| systemStateObserver | YES | Polls Windows OS state — may use WMI/PowerShell periodically | jarvis.ts:45 | MEDIUM | Ensure polling interval is ≥ 30s on 8GB RAM system |
| untimeDashboard | YES | Starts a health dashboard — check if it opens a server/port | jarvis.ts:41 | MEDIUM | If it opens a port, document it; make it optional |
| healthManager | YES | Unknown cost — imported at startup | jarvis.ts:46 | UNKNOWN | Audit startup cost |
| goalManager.init() | YES — in orchestrator constructor | Reads from persistence (LowDB or similar) | orchestrator.ts:82 | LOW | Already non-blocking via .catch |
| Legacy pipeline modules (7 modules) | YES — if rain.ts imported | 7 modules register messageBus listeners on import | Stage 1 finding | HIGH | Delete rain.ts to prevent accidental import |
| orchestrator constructor | YES — singleton instantiation | Calls egisterAllTools() + loadSkills() + goalManager.init() + memoryManager.init() + decayMemory() — 5 async chains in constructor | orchestrator.ts:64–111 | HIGH | Separate construction from initialization; add explicit orchestrator.init() call |

---

## 11. PER-REQUEST COST ERROR TABLE

| Step | Runs On Every Request? | Error/Concern | Evidence | Severity | Fix Direction Only |
|------|----------------------|---------------|----------|----------|-------------------|
| matchDeterministicCommand() | YES — all requests | Fast (synchronous string ops) — NOT an error | orchestrator.ts:234 | OK | None |
| gentMemory.addConversationMessage() | YES — all non-deterministic requests | LowDB write + Redis cache update + Redis context invalidation | orchestrator.ts:302 | MEDIUM | Skip for simple/deterministic inputs |
| goalManager.createGoal() | YES — all requests including deterministic | Creates and persists a goal object even for "open youtube" | orchestrator.ts:155 | HIGH | Skip for deterministic commands |
| uildContext() = 3 async I/O ops | YES — all LLM-bound requests | Redis + Vector API + Neo4j stub | unifiedContextBuilder.ts:24 | HIGH | Cache 10s per session; skip if no facts |
| getLLMDefinitions() — tool list | YES — every planning call | JSON serialization of all tool definitions for prompt | orchestrator.ts:517 | LOW | Cache serialized result; invalidate only when tools change |
| console.log × 7 — token budget | YES — every planning call | Synchronous stdout writes | orchestrator.ts:524–532 | LOW | Guard behind DEBUG flag |
| modelRouter.chat() — LLM call | YES — all LLM-bound requests | Network call to Groq API | orchestrator.ts:559 | HIGH (unavoidable) | Minimize context to reduce token processing time |
| eflectionEngine.preExecutionCheck() | YES — all tool-using requests | Another LLM-like analysis before tools run | orchestrator.ts:328 | MEDIUM | Cache for identical plan structures |
| eflectionEngine.reflect() | YES — after every execution | Full graph inspection per cycle | orchestrator.ts:367 | MEDIUM | Fast if no LLM involved — verify it is in-process only |
| gentMemory.addConversationMessage() | YES — after LLM response | Second message write per turn | orchestrator.ts:570 | LOW | Already debounced — OK |
| handleSuccess() synthesis LLM call | YES — all non-simple tool requests | Second LLM call after tool execution | orchestrator.ts:762 | HIGH | Bypass for all simple/informational tools |
| gentMemory.rememberFact() on failure | YES — on every abort | Vector dedup check (up to 2.1s) + LowDB write + Redis invalidation | orchestrator.ts:385–388 | HIGH | Skip vector dedup for ephemeral failure records |

---

## 12. TIMEOUT/RETRY ERROR TABLE

| File | Service | Timeout | Retry Count | Worst-Case Delay | Safe or Unsafe? | Fix Direction Only |
|------|---------|---------|-------------|-----------------|-----------------|-------------------|
| memory/memoryManager.ts:156 | Vector API (etch) | 1000ms per attempt | 1 retry | 2.1s (1s + 100ms + 1s) | SAFE (circuit breaker exists) | Reduce total budget to 800ms; no retry for non-critical paths |
| memory/vectorMemorySupervisor.ts:214 | Vector health check | 2000ms | 0 (single check) | 2s per health poll | SAFE | Acceptable — runs async in background |
| memory/vectorMemorySupervisor.ts:197 | Vector startup wait | **15 000ms flat sleep** | N/A | 15s added to startup | UNSAFE for 8GB PC | Replace with 500ms polling loop |
| memory/redisCache.ts:40–44 | Redis connect | No explicit timeout | 3 retries | Up to 6s (3 × 2000ms backoff) | UNSAFE on slow WSL | Add connectTimeout: 1000 to ioredis config |
| ridge/groqProvider.ts:75–100 | Groq API chat | No explicit request timeout | 3 attempts | Up to ~10s (3 × 1s sleep + request time) | UNSAFE | Add AbortSignal timeout of 30s per fetch |
| ridge/groqProvider.ts:172–232 | Groq API stream | No explicit request timeout | 3 attempts | Up to ~10s | UNSAFE | Add stream timeout |
| oice/tts.py:121 | edge-tts Microsoft HTTPS | **No timeout** | 0 | Indefinite hang | CRITICAL | syncio.wait_for(..., timeout=10.0) |
| security/approvalGate.ts:37 | Console approval | 30s | 0 | 30s silent wait in voice mode | UNSAFE for voice | Reduce to 15s; add voice notification |
| ridge/nodeBridge.ts | WS reconnect for Python clients | Inferred 2s from stt.py | Infinite loop | N/A | SAFE | OK |
| memory/redisCache.ts:192 | Vector circuit breaker reset | 60 000ms auto-reset | N/A | 60s blackout window | SAFE | OK — documented behavior |

---

## 13. CONFIG / ENVIRONMENT ERRORS

| Config/File | Error | Evidence | Severity | Fix Direction Only |
|------------|-------|----------|----------|-------------------|
| .env.example — Missing Neo4j vars | NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD are used in graphMemory.ts with insecure defaults but are NOT documented in .env.example | graphMemory.ts:19–21; .env.example has no Neo4j section | HIGH | Add Neo4j variables to .env.example with safe placeholder values |
| .env.example — Missing Redis vars | REDIS_HOST, REDIS_PORT, REDIS_PASSWORD are read in edisCache.ts with defaults but are NOT in .env.example | edisCache.ts:21–23; .env.example has no Redis section | MEDIUM | Add Redis variables with defaults 127.0.0.1:6379 documented |
| .env.example — Missing vector service var | No VECTOR_API_URL or VECTOR_PORT documented — hardcoded http://127.0.0.1:8000 in memoryManager.ts:166 | memoryManager.ts:166 | MEDIUM | Add VECTOR_API_URL to .env.example so the port is configurable |
| .env.example — JARVIS_FAST_MODEL mismatch | .env.example sets JARVIS_FAST_MODEL=llama-3.3-70b-versatile but groqProvider.ts defaults to llama-3.1-8b-instant if env var is unset | .env.example:13, groqProvider.ts:60 | MEDIUM | Align default in groqProvider.ts with .env.example; add startup validation |
| .env.example — No HEALTH_PORT documented fully | HEALTH_PORT=9001 is in .env.example but the health server also needs BRIDGE_HOST. If BRIDGE_HOST changes, health port binding may not update | .env.example:41 | LOW | Document that HEALTH_PORT binds on same host as BRIDGE_HOST |
| config/llmconfig.ts (inferred) | llmConfig.systemPrompt is injected into every LLM call. If this prompt is large, it consumes a significant portion of the 5000-token budget. No size validation at startup | orchestrator.ts:455–456: 	rimToTokens(systemPrompt, 1200) limits it to 1200 tokens — but only at call time | MEDIUM | Validate system prompt length at startup; warn if > 1000 tokens |
| Port conflicts — No validation | BRIDGE_PORT=9000 and HEALTH_PORT=9001 are used without checking if they are already bound at startup. On Windows, a second JARVIS process or another app on port 9000 causes silent failures | No port-in-use check found in startup code | MEDIUM | Add 
et.createServer().listen(port) probe at startup; fail fast with clear error |
| Windows/WSL — Redis assumption | Redis is assumed to be running in WSL at 127.0.0.1:6379. No documentation of WSL requirement in .env.example or README. If WSL is not started, Redis silently fails and JARVIS runs without cache (acceptable) but user gets no guidance | edisCache.ts:22: default 127.0.0.1 | LOW | Add comment in .env.example about WSL Redis requirement |
| No .env validation at startup | No startup check that critical env vars (GROQ_API_KEY, BRIDGE_PORT, JARVIS_BRAIN_MODEL) are set before JARVIS tries to use them | No dotenv validation call found in jarvis.ts | HIGH | Add startup env validation: fail fast with clear message if GROQ_API_KEY is empty |
| WHISPER_MODEL — Not validated | WHISPER_MODEL=tiny in .env.example. stt.py hardcodes "tiny" model and does not read this env var at all | stt.py:38: WhisperModel("tiny", ...) hardcoded | MEDIUM | Read WHISPER_MODEL env var in stt.py; default to 	iny |

---

## 14. CLOUD READINESS ERRORS

| Area | Cloud/Multi-user Error | Evidence | Severity | Fix Direction Only |
|------|----------------------|----------|----------|-------------------|
| **Identity** | No user authentication, no session tokens, no user ID in any request | Architecture — all requests treated as single trusted user | CRITICAL | Implement JWT or session-based auth before any remote access |
| **Authorization** | No per-user permission levels — all users would have identical access including PC control | Architecture | CRITICAL | Implement RBAC before cloud |
| **PC control** | pcControlKernel.ts, open_app, file write tools can control the host OS. In cloud mode this means remote users controlling a physical Windows PC | Architecture | CRITICAL | PC control must be disabled or require additional hardware-level auth for remote users |
| **WebSocket bridge** | Port 9000 WebSocket has no authentication. Any network-reachable client could connect | ridge/nodeBridge.ts | CRITICAL | Add token-based handshake; validate client_ready messages |
| **Single-user state machine** | gentStateMachine is a global singleton. Multiple simultaneous users would corrupt each other's state | core/agentStateMachine.ts — single instance | CRITICAL | Per-user state machine instances required for multi-user |
| **LowDB JSON** | LowDB writes to a single JSON file. Concurrent users would corrupt it | memory/memoryManager.ts | CRITICAL | Replace with a proper database (SQLite, PostgreSQL) for multi-user |
| **Console approval gate** | pprovalGate.ts reads from process.stdin — meaningless in a server environment | pprovalGate.ts:97–99 | HIGH | Replace with async approval API endpoint |
| **Hardcoded 127.0.0.1** | Vector API URL, Redis host, Neo4j URI all hardcoded to localhost — cannot be reconfigured for cloud deployment | Multiple files | HIGH | Move all service URLs to .env variables |
| **No API boundary** | JARVIS has no REST/WebSocket API for external clients — only the NodeBridge WS at port 9000 for Python voice clients | Architecture | HIGH | Design a proper API gateway before cloud deployment |
| **No rate limiting** | No request rate limiting — a remote attacker could flood the orchestrator | Architecture | HIGH | Implement per-IP or per-session rate limiting |
| **Secrets in process.env** | GROQ_API_KEY is in a flat .env file. In cloud deployment this would be exposed via process inspection | Architecture | HIGH | Use secrets manager (AWS Secrets Manager, Azure Key Vault, etc.) |
| **No HTTPS** | All WebSocket connections use ws:// (unencrypted) | .env.example:38: BRIDGE_WS_URI=ws://127.0.0.1:9000 | HIGH | Upgrade to wss:// for any non-localhost deployment |

---

## 15. YOUTUBE OPEN COMMAND ERROR INVESTIGATION

### Direct Test Path (Works)
`
openAppSmokeTest.ts
  → import execute from skills/automation/skill.ts
  → execute({ target: 'youtube' })
  → openTarget('youtube')
  → websiteAliases['youtube'] = 'https://www.youtube.com'
  → spawn('cmd.exe', ['/c', 'start', '', 'https://www.youtube.com'], { detached: true, shell: false })
  → resolve({ success: true }) IMMEDIATELY
`
**Result: Always succeeds.** The smoke test resolves before the process even confirms launch.

---

### Live Voice Path (Fails intermittently)
`
User says: "Jarvis, open YouTube for me"
  ↓
wakeWords.py detects wake word → sends listen_start to NodeBridge
  ↓
stt.py receives listen_start → records audio → Whisper transcribes
  ↓
Raw STT: "Jarvis, open YouTube for me."
normalize_stt():
  → lowercase: "jarvis, open youtube for me."
  → strip punctuation: "jarvis open youtube for me"
  → strip "jarvis" prefix: "open youtube for me"
  → result: "open youtube for me"
  ↓
stt.py sends stt_result { text: "open youtube for me" }
  ↓
jarvis.ts NodeBridge handler receives stt_result
  → echo filter check: isEcho("open youtube for me", lastTtsText)?
  ↓
orchestrator.process("open youtube for me", 'voice')
  ↓
matchDeterministicCommand("open youtube for me"):
  clean = "open youtube for me"  ← filler "for me" NOT stripped in matchDeterministicCommand clean step
  → BUT filler IS stripped inside the alias loop:
    afterTrigger = "youtube for me"
    stripped = "youtube for me"
      .replace(/\bfor me\b/g, '') = "youtube "  → .trim() = "youtube"
    → alias match: 'youtube' === 'youtube' ✅
    → return { type: 'open_app', target: 'youtube' }
  ↓
toolRegistryV2.execute('open_app', { target: 'youtube' })
  → calls skills/automation/skill.ts execute()
  → spawn cmd.exe /c start "" https://www.youtube.com
  → resolve({ success: true }) IMMEDIATELY
  ↓
speak("Opening youtube, sir.")
`

**Theoretically this path SHOULD work.** The alias stripping handles "for me".

---

### Most Likely Failure Points

| Failure Point | Evidence | Likelihood |
|--------------|----------|-----------|
| **Echo filter false positive** | If JARVIS just spoke anything containing "open", "youtube", or overlapping words, and the overlap ratio hits 0.60–0.75, the STT result is discarded before reaching orchestrator. "Opening youtube, sir" has youtube — if user immediately repeats "open youtube" it could be filtered | **HIGHEST** |
| **STT state gating** | If JARVIS is still in SPEAKING state (TTS not yet finished) when stt_result arrives, input is queued in oiceInputQueue. If speaking finishes quickly, queue replays and works. BUT if speaking_end from TTS Python is delayed or lost, the queue is never drained and the command is silently held | **HIGH** |
| **STT normalization edge case** | Whisper may transcribe "YouTube" with capital Y or add punctuation. 
ormalize_stt() lowercases and strips punctuation correctly — BUT if Whisper returns "You Tube" as two words, alias lookup 	argetLower = "you tube" would NOT match 'youtube' | MEDIUM |
| **listen_start missed** | If wake word fires while JARVIS is already speaking (SPEAKING state), NodeBridge may not relay listen_start to STT. Wake word heard → silence (no STT triggered) | MEDIUM |
| **spawn false success** | spawn resolves { success: true } immediately. The actual OS process launch happens asynchronously. If Windows is slow or Chrome is launching from cold start, JARVIS says "Opening YouTube" but YouTube may not actually appear for 3–5 seconds. User may repeat the command thinking it failed | MEDIUM |
| **Empty STT result** | If Whisper fails to transcribe clearly (background noise, mic cutoff), it returns empty string → _send_result("") → orchestrator receives empty input → falls into full planning path with empty string → LLM confused | MEDIUM |

---

### Key Difference: Direct Test vs Live Voice

| Factor | Direct Test | Live Voice |
|--------|-----------|------------|
| Echo filter | Not run | Runs — can falsely filter command |
| State machine | Not checked | Must be IDLE to accept input |
| STT transcription | Not involved | Whisper may garble "YouTube" |
| listen_start relay | Not involved | Can be missed if in SPEAKING state |
| Timing | Instant | Depends on STT pipeline (2–4s) |
| speaking_end event | Not involved | Must fire to unblock state |

---

### Fix Direction (Do Not Fix Now)
1. **Echo filter**: Add youtube to COMMAND_KEYWORDS_SET in jarvis.ts (already there — verify threshold is working). Add STT debug log review to confirm if it is being filtered.
2. **State machine**: Add oiceInputQueue priority processing for commands received during SPEAKING state — drain immediately on speaking:end.
3. **STT normalization**: Add "you tube" → "youtube" alias normalization in 
ormalize_stt().
4. **listen_start missed**: Buffer one listen_start event even during SPEAKING; replay after speaking_end.
5. **spawn false success**: Add a 500ms post-spawn check (poll process list or use shell: true with start /wait timeout).
6. **Empty STT**: Filter empty or < 3-character results in NodeBridge before routing to orchestrator.

---

## 16. STAGE 2 PRIORITY ERROR TABLE

| Priority | Area | Error | Severity | Evidence | Fix Direction Only | Should Fix Now? |
|----------|------|-------|----------|----------|-------------------|-----------------|
| P1 | Security | open_app has no security gate — arbitrary process launch | HIGH | utomation/skill.ts:63 | Add target allowlist before spawn | YES |
| P2 | Security | WebSocket bridge port 9000 has no authentication | HIGH | Architecture | Add HMAC token on client_ready handshake | YES |
| P3 | Security | pprovalGate is console-only — HIGH_RISK commands silently time out in voice mode | HIGH | pprovalGate.ts:97 | Add voice notification before waiting | YES |
| P4 | Performance | Vector supervisor sleeps 15s flat on startup | HIGH | ectorMemorySupervisor.ts:197 | Replace with 500ms health poll loop | YES |
| P5 | Performance | unifiedContextBuilder.buildContext() runs every request with no cache | HIGH | unifiedContextBuilder.ts:24 | Add 10s session-level cache | YES |
| P6 | Performance | edge-tts communicate.save() has no timeout — can hang indefinitely | CRITICAL | 	ts.py:121 | syncio.wait_for(..., timeout=10.0) | YES |
| P7 | Runtime | ememberFact() arg order is wrong — importance/source swapped by orchestrator caller | HIGH | orchestrator.ts:385–388 | Fix caller argument order | YES |
| P8 | Runtime | GoalManager creates/persists a goal for every request including deterministic ones | HIGH | orchestrator.ts:155 | Skip GoalManager for deterministic commands | YES |
| P9 | Voice | STT empty result routes to orchestrator with empty string | HIGH | stt.py:351 | Filter empty results in NodeBridge before routing | YES |
| P10 | Voice | STT temp .wav files written to project root (not tmp dir) | HIGH | stt.py:344 | Use 	empfile.gettempdir() | YES |
| P11 | YouTube | Echo filter may falsely discard "open youtube" in rapid follow-up | HIGH | jarvis.ts:111 | Verify STT debug log; raise command-keyword threshold | YES |
| P12 | State | SPEAKING state has no timeout fallback if speaking_end never fires | HIGH | orchestrator.ts:200 | Add 30s watchdog for stuck SPEAKING state | YES |
| P13 | Config | GROQ_API_KEY not validated at startup — fails deep in LLM call | HIGH | jarvis.ts — no env validation | Add startup env check with clear error | YES |
| P14 | Config | Neo4j, Redis vars not in .env.example | MEDIUM | .env.example | Add missing vars | YES (quick) |
| P15 | Security | 
pm, pnpm, 
px in SAFE_READ_ONLY_COMMANDS allowlist | HIGH | permissionManager.ts:37 | Move to MEDIUM_RISK | YES |
| P16 | Performance | Vector index rebuild on startup: all facts, no limit | HIGH | memoryManager.ts:130–142 | Cap at 10; add concurrency limit | Stage 2 |
| P17 | Performance | ememberFact() calls searchVector() synchronously for dedup on every fact write | HIGH | memoryManager.ts:364 | Make async background; don't block insert | Stage 2 |
| P18 | Performance | LLM synthesis call fires after every tool execution, even simple ones | HIGH | orchestrator.ts:762 | Expand simpleTools bypass list | Stage 2 |
| P19 | State | No AbortSignal on in-flight LLM calls — interrupt arrives too late | HIGH | orchestrator.ts:556 | Pass AbortController.signal to modelRouter.chat() | Stage 2 |
| P20 | Cloud | No user authentication or per-user state | CRITICAL | Architecture | Full auth layer before any remote deployment | Stage 3 |

---

## 17. STAGE 2 FINAL ERROR VERDICT

### What runtime errors are blocking progress?

**Immediately blocking (will cause incorrect behavior now):**
- **ememberFact() arg order bug**: Importance and source are swapped in orchestrator callers — failure records are stored with importance='agent_failure' (a string) and source=7 (a number). This silently corrupts the long-term memory scoring for all abort events.
- **speaking_end never-fires**: If TTS Python client crashes during speech, JARVIS never resets from SPEAKING state. The user has to manually restart JARVIS.
- **GoalManager in_progress leak**: Deterministic commands create Goals that never get resolved — the goal table grows forever with stale entries.
- **open_app false-success**: Smoke test passes because the promise resolves before spawn error can fire. A spawn error produces { success: false } but it arrives AFTER the promise already resolved { success: true }.

**Semi-blocking (causes degraded behavior):**
- uildContext() on every LLM request with no caching — acceptable for CLI, painful for voice (adds 1–3s per command).
- edge-tts no timeout — voice can silently hang if Microsoft HTTPS is slow.

---

### What is slow?

In order of user-perceived impact:

1. **TTS latency** — edge-tts HTTPS to Microsoft (no timeout, no local fallback)
2. **Context building** — uildContext() = Redis + Vector + Neo4j stub per request (1–3s)
3. **LLM planning call** — Groq API 500ms–3000ms
4. **Vector startup** — 15-second hard sleep before health check
5. **LLM synthesis call** — Second LLM call after tool results (should be bypassed for simple tools)
6. **Redis retry on startup** — Up to 6s if WSL Redis is slow
7. **STT disk I/O** — WAV to disk and back per voice command

---

### What is unsafe?

| Risk | Worst Case |
|------|-----------|
| open_app no allowlist | LLM tricked into opening any executable |
| cmd.exe target unsanitized | Shell metachar injection via LLM-crafted target |
| WebSocket no auth | Localhost process injects arbitrary commands |
| 
pm/
px in SAFE allowlist | 
pm run <attacker-script> passes safety check |
| pprovalGate console-only | HIGH_RISK commands during voice silently auto-denied with no feedback |
| enable_full_control_session no approval | Full control activated by voice command alone |

---

### What is fake/stub?

*(Confirmed in Stage 1 and unchanged in Stage 2 — see Stage 1 report Section 9)*
- graphMemory.ts — Neo4j driver commented out; all methods return empty/warn
- gents/ folder — 4 pure stubs
- 	ools/dispatcher.ts, 	ools/claudeCodeTool.ts, learning/selfAudit.ts — mocks

---

### What is likely causing YouTube live voice failure?

**Most likely cause (in order):**

1. **Echo filter false positive** — JARVIS just spoke "Opening youtube, sir." After the first successful open, if the user says "open YouTube" again quickly, the overlap of youtube between TTS and STT triggers the echo filter. The command is silently discarded. Check data/logs/stt_debug.log for ECHO_FILTER_* events.

2. **SPEAKING state blocking** — TTS is still playing when the next wake word fires. listen_start is sent to STT, STT records and sends stt_result, but jarvis.ts finds state is SPEAKING → queues the command. If speaking_end is delayed or missed, queue is never drained.

3. **STT transcription variant** — Whisper may return "You Tube" (two words) or "YouTube" with capital Y. Normalization lowercases but does NOT handle "you tube" as two words. Alias lookup fails → falls to LLM → LLM may or may not call open_app.

---

### What should be optimized first for the 8 GB RAM PC?

| Priority | Optimization | Expected Gain |
|----------|-------------|---------------|
| 1 | Cache uildContext() result for 10s per session | Saves 1–3s per LLM request |
| 2 | Fix vector supervisor 15s → 500ms poll | Saves 12–15s on startup |
| 3 | Rate-limit vector rebuild at startup to 10 facts | Prevents 100s background CPU spike |
| 4 | Add timeout to edge-tts communicate.save() | Prevents indefinite hang |
| 5 | Move decay + goal init out of orchestrator constructor | Reduces startup blocking |
| 6 | Expand simpleTools list for synthesis bypass | Saves 1 full LLM call for browser/system commands |
| 7 | Skip GoalManager for deterministic commands | Saves 2 async DB calls per fast-path command |
| 8 | Delete legacy brain pipeline (7 modules) | Frees RAM on already-constrained 8GB system |

---

### What should be investigated in Stage 3?

1. **control/pcControlKernel.ts (19 KB)** — Full audit of rollback, safety gates, and whether enable_full_control_session is properly gated
2. **ridge/nodeBridge.ts** — Full message routing audit: pendingTTS queue behavior, multi-client state, port conflict on restart
3. **self_healing/selfHealingManager.ts** — Python process restart loop audit: zombie process accumulation, restart count limits
4. **monitoring/runtimeDashboard.ts** — What port does it open? What data does it expose? Is it safe on a local network?
5. **monitoring/healthManager.ts** — Startup cost and behavior
6. **core/reflectionEngine.ts** — Is the TypeScript reflection engine doing real LLM calls or heuristics? Cost per request?
7. **core/goalManager.ts** — How does it persist goals? LowDB? How large does the goal table grow? Is there pruning?
8. **STT debug log analysis** — Run JARVIS, say "open YouTube", check data/logs/stt_debug.log for the exact echo-filter event that explains the YouTube failure
9. **perception/systemStateObserver.ts** — Polling interval, WMI usage on Windows, CPU cost
10. **self_healing/pipelineRegistry.ts** — Full registry of monitored pipelines; confirm eflection_loop pipeline is either removed or backed by a real script
