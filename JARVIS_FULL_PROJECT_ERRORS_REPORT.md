# JARVIS FULL PROJECT ERRORS REPORT
**Project:** W:\anti gravity for jarvis assistant
**Audit Date:** 2026-07-04 | **Auditor:** Antigravity AI | **Stage:** 3 of 3 — Final Combined Report
**Based on:** Stage 1 Foundation Audit + Stage 2 Runtime/Performance/Security Audit + direct file inspection
**Rule:** READ-ONLY. No files were modified during this audit.

---

## 1. FINAL ERROR EXECUTIVE SUMMARY

### Overall Severity Scores

| Score Category | Score / 100 | Meaning |
|----------------|-------------|---------|
| **Overall Project Health** | **49 / 100** | Below stable threshold — multiple blocking issues |
| **Foundation** | 52 / 100 | Core structure exists; missing files, dead code, broken test runner |
| **Runtime Correctness** | 58 / 100 | Main voice path mostly works; critical state/memory bugs present |
| **Performance** | 44 / 100 | Severe per-request latency chain on constrained 8GB RAM hardware |
| **Security** | 71 / 100 | Good intent; critical gaps in tool gating, WS auth, and approval path |
| **Cloud Readiness** | 08 / 100 | Single-user, local-only by architecture — not cloud-ready in any dimension |

---

### Project Status Answers

| Question | Answer |
|----------|--------|
| Is the project blocked by serious errors? | **YES** — 4 critical bugs block reliable voice operation |
| Is it locally usable right now? | **PARTIALLY** — basic voice + open-app commands work most of the time |
| Is it ready for daily local use? | **NO** — stuck-state bugs, memory corruption, and silent failures prevent reliability |
| Is it cloud-ready? | **NO** — missing auth, single-user state machine, PC-control exposure |
| Is it safe for multi-user access? | **ABSOLUTELY NOT** — no identity, no auth, global state, PC-control tools exposed |

---

### Top 10 Biggest Errors

| # | Error | File(s) | Severity |
|---|-------|---------|----------|
| 1 | edge-tts communicate.save() has **no timeout** — TTS can hang forever if Microsoft HTTPS stalls, freezing the entire voice pipeline | oice/tts.py:121 | CRITICAL |
| 2 | ememberFact() argument order is swapped by orchestrator callers — importance and source are transposed, silently corrupting every failure record stored in long-term memory | orchestrator.ts:385–388, memoryManager.ts:360 | CRITICAL |
| 3 | open_app skill has **no security gate** — any target string (including .exe, scripts, UNC paths) is spawned via cmd.exe with no validation | skills/automation/skill.ts:63–83 | CRITICAL |
| 4 | SPEAKING state has **no watchdog timeout** — if speaking_end from TTS is never received, JARVIS is permanently stuck and must be restarted | orchestrator.ts:196–202, 	ts.py | CRITICAL |
| 5 | WebSocket bridge port 9000 has **no authentication** — any process on localhost can connect and inject arbitrary commands including stt_result | ridge/nodeBridge.ts:85–88 | HIGH |
| 6 | oice/reflectionEngine.py is **missing** but referenced by 3 modules (sWatcher, pipelineRegistry, selfHealingManager) — causes silent watchdog errors on every session | Stage 1 confirmed | HIGH |
| 7 | 
pm, pnpm, 
px are listed in the **SAFE_READ_ONLY** allowlist — 
pm run <any-script> bypasses the security gate entirely | security/permissionManager.ts:37–40 | HIGH |
| 8 | unifiedContextBuilder.buildContext() runs 3 async subsystem calls **on every LLM-bound request** with no caching — adds 1–3 seconds to every voice command | memory/unifiedContextBuilder.ts:24 | HIGH |
| 9 | pprovalGate.requestApproval() uses eadline on stdin — in voice mode it **silently auto-denies** any HIGH_RISK command after 30s with no voice notification | security/approvalGate.ts:97–99 | HIGH |
| 10 | GROQ_API_KEY is never validated at startup — JARVIS boots normally then fails deep inside the first LLM call with a cryptic network error | jarvis.ts — no env validation present | HIGH |

---

### Top 10 Speed Errors

| # | Error | File | Severity |
|---|-------|------|----------|
| 1 | edge-tts communicate.save() — HTTPS call to Microsoft with no timeout; worst case: indefinite hang | 	ts.py:121 | CRITICAL |
| 2 | ectorMemorySupervisor sleeps **15 000ms flat** before first health check — every cold start adds 15s | ectorMemorySupervisor.ts:197 | HIGH |
| 3 | unifiedContextBuilder.buildContext() — Redis + Vector API + Neo4j stub per request, no cache | unifiedContextBuilder.ts:24 | HIGH |
| 4 | ememberFact() calls searchVector() before every insert — up to 2.1s added per fact write | memoryManager.ts:364 | HIGH |
| 5 | groqProvider.chat() retries up to 3× with 1s sleeps — worst case 3+ seconds before failure raised | groqProvider.ts:99,164 | HIGH |
| 6 | handleSuccess() fires a **second LLM call** (synthesis) after every successful tool execution, even for simple open_app results | orchestrator.ts:762 | HIGH |
| 7 | Vector index rebuilds ALL facts on startup with no concurrency limit — N × 2.1s worst case | memoryManager.ts:130–142 | HIGH |
| 8 | sr.Microphone() opened fresh per recording — hardware enumeration overhead on every voice command | stt.py:237 | MEDIUM |
| 9 | STT writes a temp .wav to disk and reads it back per voice command — unnecessary disk I/O | stt.py:344,346 | MEDIUM |
| 10 | GoalManager.createGoal() fires for every request including deterministic — 2 async DB writes per fast-path command | orchestrator.ts:155, goalManager.ts:130 | MEDIUM |

---

### Top 10 Security Errors

| # | Error | File | Severity |
|---|-------|------|----------|
| 1 | open_app has zero security gate — arbitrary process launch from voice input | utomation/skill.ts:63 | CRITICAL |
| 2 | cmd.exe /c start "" <target> — target is unsanitized; shell metachar injection possible | utomation/skill.ts:49 | CRITICAL |
| 3 | WebSocket port 9000 has no auth token — any localhost client can inject voice commands | 
odeBridge.ts:85 | CRITICAL |
| 4 | 
pm, pnpm, 
px in SAFE_READ_ONLY allowlist | permissionManager.ts:37 | HIGH |
| 5 | pprovalGate is console-only — voice HIGH_RISK commands silently time out with no feedback | pprovalGate.ts:97 | HIGH |
| 6 | enable_full_control_session deterministic command has no approval gate | orchestrator.ts:280–282 | HIGH |
| 7 | Neo4j default password = "password" — used if Neo4j ever re-enabled without .env | graphMemory.ts:21 | HIGH |
| 8 | graphMemory.queryGraph() accepts raw Cypher string — Cypher injection surface | graphMemory.ts:229 | MEDIUM |
| 9 | No audit log for open_app executions via deterministic router | orchestrator.ts:241–295 | MEDIUM |
| 10 | No rate limiting on voice command input | Architecture | HIGH |

---

### Top 10 Cloud Readiness Blockers

| # | Blocker | Severity |
|---|---------|----------|
| 1 | No user authentication — no JWT, no session token, no identity layer | CRITICAL |
| 2 | No authorization — no RBAC, all callers have identical access | CRITICAL |
| 3 | gentStateMachine is a global singleton — cannot handle multiple users | CRITICAL |
| 4 | LowDB writes to a single JSON file — concurrent users would corrupt it | CRITICAL |
| 5 | PC-control tools (open_app, file write, process kill) operate on host OS | CRITICAL |
| 6 | WebSocket bridge has no authentication or transport encryption (ws:// not wss://) | CRITICAL |
| 7 | pprovalGate reads from process.stdin — meaningless in a server environment | HIGH |
| 8 | All service URLs hardcoded to 127.0.0.1 — cannot be reconfigured for remote deployment | HIGH |
| 9 | No REST/HTTP API boundary — only a raw WebSocket for internal voice clients | HIGH |
| 10 | No secrets management — GROQ_API_KEY exposed in flat .env file | HIGH |

---
## 2. ARCHITECTURE ERRORS

### Reference Flow
`
Wake Word → STT → NodeBridge → Orchestrator → Context Builder → Planner/Router →
Tool Registry V2 → Tool Execution → Skill → TTS → NodeBridge → TTS Python
`

| Architecture Area | File/Folder | Error | Evidence | Severity | Fix Direction |
|------------------|-------------|-------|----------|----------|---------------|
| **Wake Word → STT handoff** | oice/wakeWords.py → ridge/nodeBridge.ts | listen_start sent to STT while JARVIS is in SPEAKING state is silently ignored — STT records, sends stt_result, but orchestrator queues it in oiceInputQueue. If speaking_end is delayed or lost, queue is never drained | stt.py:414–416; jarvis.ts voiceInputQueue drains only on speaking_end | HIGH | Buffer one deferred listen_start; replay on speaking:end event |
| **STT → NodeBridge → Orchestrator path** | oice/stt.py → ridge/nodeBridge.ts | Empty STT results (timeout, Whisper failure) are sent as stt_result {text: ""} — NodeBridge forwards empty text to orchestrator which routes it into the full LLM planning path with an empty string input | stt.py:351; 
odeBridge.ts:243–248 — no empty-string guard | HIGH | Filter empty/whitespace-only stt_result in NodeBridge before forwarding |
| **Echo filter duplication** | oice/stt.py:148, jarvis.ts:111 | Echo filter logic is **duplicated** in two places — Python stt.py and TypeScript jarvis.ts. Both maintain separate lastTtsText state. If they diverge, a command may be filtered by one and pass the other, or vice versa | Two is_echo() implementations running independently | MEDIUM | Single echo filter in jarvis.ts NodeBridge handler only; remove Python copy |
| **Context Builder on every request** | memory/unifiedContextBuilder.ts:24 | uildContext() is called on EVERY non-deterministic, non-simple request with no cache. It makes 3 async I/O calls (Redis, Vector API, Neo4j) before the LLM even receives a prompt | orchestrator.ts → planPhase() calls uildContext() every time | HIGH | Cache result per-session for 10s; short-circuit if no long-term facts exist |
| **Disconnected Neo4j path** | memory/graphMemory.ts, memory/unifiedContextBuilder.ts | Neo4j driver is **commented out** (isConnected = false), but unifiedContextBuilder still calls graphMemory.queryGraph() on every planning request — the call hits the null-session guard and logs a warn, adding overhead | graphMemory.ts:24–27; unifiedContextBuilder.ts:40–51 | MEDIUM | Short-circuit in uildContext(): skip Neo4j call when !graphMemory.isConnected |
| **Fake reflection path** | oice/reflectionEngine.py (missing), self_healing/pipelineRegistry.ts, self_healing/fsWatcher.ts | The Python reflection script is **registered as a pipeline** and **watched by fsWatcher** but the file does not exist. TypeScript eflectionEngine.ts does the real work. The Python script produces a silent watch error on every session | Stage 1 confirmed: file absent; pipelineRegistry references it | HIGH | Remove eflectionEngine.py from fsWatcher and pipelineRegistry; document that TypeScript version is the real engine |
| **GoalManager on every route** | core/goalManager.ts, core/orchestrator.ts:155 | goalManager.createGoal() is called for EVERY request including deterministic fast-path commands (open youtube, hello). For deterministic commands the goal is set to in_progress then never resolved — creating a permanent leak of stale in_progress goals in data/goals.json | orchestrator.ts:155–160: no goal resolution on deterministic return path | HIGH | Skip GoalManager for deterministic commands; or resolve goal status after deterministic path completes |
| **Tool registry dual authority** | core/toolRegistry.ts (v1, tombstoned), core/toolRegistryV2.ts | Two tool registries exist. v1 is marked tombstoned but still compiles. If both are imported, tool definitions conflict. v2 is the live path but documentation references both | Stage 1 confirmed: both files present | MEDIUM | Delete 	oolRegistry.ts (v1) |
| **Fallback planner architecture** | core/orchestrator.ts:604–625 | Rule-based fallback planner calls 
ew TaskGraphBuilder(input) and graph.addTask() — the TaskGraphBuilder constructor signature in the live code does not match this usage pattern. If LLM is down, the fallback itself throws | orchestrator.ts:606–621 | HIGH | Fix TaskGraphBuilder usage in fallback; add try/catch |
| **Stale brain pipeline modules** | core/brain.ts, gents/ folder | Legacy rain.ts and 4 agent stubs still exist and compile. If rain.ts is ever accidentally imported, 7 dead modules register messageBus listeners, consuming RAM and potentially intercepting messages | Stage 1: rain.ts, gents/queryAgent.ts, gents/plannerAgent.ts etc. confirmed | HIGH | Delete rain.ts and all agent stubs |
| **ModelRouter single provider** | ridge/modelRouter.ts | Only one LLM provider (Groq) is registered. If Groq circuit-breaks, all LLM-dependent paths (planPhase, handleSuccess, eflectionEngine.llmDiagnoseFailure) throw — no local model fallback exists | modelRouter.ts:8–11 | HIGH | Add a local model provider (Ollama/LM Studio) as fallback; validate provider at startup |
| **No AbortSignal on LLM calls** | ridge/groqProvider.ts, core/orchestrator.ts | In-flight LLM calls cannot be cancelled. A user barge-in sets state to INTERRUPTED, but isInterrupted() is only checked **after** the LLM responds — the Groq request runs to completion before the interrupt takes effect | orchestrator.ts:556: if (this.isInterrupted()) return null checked after wait modelRouter.chat() | HIGH | Pass AbortController.signal to every modelRouter.chat() call |
| **No PLANNING/EXECUTING watchdog** | core/agentStateMachine.ts (inferred) | PLANNING and EXECUTING states have no timeout watchdog. If modelRouter.chat() hangs (e.g., Groq connection stalls), JARVIS stays in PLANNING forever, unreachable by voice commands | Stage 2 confirmed: watchdog exists for SPEAKING only | HIGH | Add 30s watchdog for PLANNING; 60s for EXECUTING |
| **TTS worker not restarted on reconnect** | oice/tts.py:171 | _worker_task is created once at startup. When the WebSocket drops and reconnects, the old worker task continues running against a None websocket — speaking_start/speaking_end events may fail silently | 	ts.py:171: single syncio.create_task(self._worker()) call | MEDIUM | Restart worker task on each WebSocket reconnect |
| **Approval gate architecture mismatch** | security/approvalGate.ts | Approval gate architecture assumes a console/TTY environment. The primary use case is voice mode, where stdin is not a TTY. Any HIGH_RISK command triggered by voice silently auto-denies after 30s with no voice notification — the security model is broken for its primary use case | pprovalGate.ts:97–99: if (!process.stdin.isTTY) reject(...) | HIGH | Add voice notification path before console wait; expose approval to UI layer |

---
## 3. BROKEN COMPONENTS

| File/Folder Path | Exact Error | Error Message If Found | Likely Root Cause | Severity | Fix Direction |
|-----------------|-------------|----------------------|-------------------|----------|---------------|
| oice/reflectionEngine.py | File does not exist — referenced by self_healing/pipelineRegistry.ts, self_healing/fsWatcher.ts, self_healing/selfHealingManager.ts | [fsWatcher] ERROR: reflectionEngine.py not found at startup | File was planned but never created; TypeScript version replaced it | HIGH | Either create a minimal Python stub or remove all references in pipelineRegistry, fsWatcher, selfHealingManager |
| core/toolRegistry.ts (v1) | Tombstoned/dead registry — marked @deprecated but still compiles; if accidentally imported alongside v2, tool definitions conflict | No runtime error yet — risk is latent | Dead code not deleted after v2 was created | MEDIUM | Delete file; v2 is the live registry |
| core/brain.ts + gents/ folder | Legacy reasoning pipeline — 7 modules register messageBus listeners on import; all agent stubs (queryAgent.ts, plannerAgent.ts, eflectionAgent.ts, coordinatorAgent.ts) have empty execute methods | No error until imported — if accidentally imported, messageBus gets stale listeners | Not cleaned up after orchestrator v2 replaced brain.ts | HIGH | Delete rain.ts and all files in gents/ folder |
| security/approvalGate.ts — voice mode | _promptWithTimeout() immediately rejects with APPROVAL_TIMEOUT when !process.stdin.isTTY, which is the normal voice runtime state. HIGH_RISK commands silently denied with no voice notification | No error message — silent auto-deny after 30s | Architecture mismatch: gate designed for CLI, not voice | HIGH | Add voice notification before waiting; add TTY check at startup |
| core/orchestrator.ts:604–625 — fallback planner | 
ew TaskGraphBuilder(input) and graph.addTask(...) calls likely use wrong constructor signature for the live TaskGraphBuilder API | Runtime error when LLM is down and fallback triggers | Fallback code not updated after TaskGraphBuilder API changed | HIGH | Audit TaskGraphBuilder constructor; fix fallback usage |
| memory/vectorMemorySupervisor.ts:197 | wait new Promise(r => setTimeout(r, 15_000)) blocks the supervisor for 15 seconds on every cold start — no early exit | No error; just silent 15s delay | Hardcoded sleep instead of health polling | HIGH | Replace with 500ms polling loop |
| 
pm test runner | scripts.test in package.json executes exit 1 by design — CI is permanently broken | 
pm test exits with code 1 always | Placeholder test script never replaced | HIGH | Replace with real Jest/Mocha runner |
| data/goals.json — goal leak | Every deterministic command creates a Goal in in_progress status that is never resolved — file grows forever | No error message; silent data corruption | Orchestrator returns before calling goalManager.updateGoalStatus('completed') | HIGH | Skip GoalManager for deterministic commands OR resolve goal status after return |
| memory/memoryManager.ts:385–388 — argument order | gentMemory.rememberFact('Failed task: ...', 7, 'agent_failure') maps to (fact, source=7, importance='agent_failure') — importance is stored as the string 'agent_failure', source as the number 7 | No runtime error — silent memory corruption | Caller and callee parameter order mismatch — likely changed during refactor | CRITICAL | Fix caller argument order to (fact, 'agent_failure', 7) |
| oice/tts.py:121 — communicate.save() | No timeout on edge-tts HTTPS call to Microsoft — hangs indefinitely if connectivity is lost | TTS worker freezes; no speaking_end event ever fires | Missing syncio.wait_for() wrapper | CRITICAL | syncio.wait_for(communicate.save(tmp_path), timeout=10.0) |
| scheduler/ folder | Empty directory — no files | list_dir returned empty | Scheduled task support never implemented despite utonomy/scheduler.ts existing | MEDIUM | Remove empty folder or implement scheduler |
| ackend/ folder | Contains only empty ackend/memory/ subdirectory — no modules | — | Dead scaffolding | LOW | Remove |
| environment/systemInfo.json | JSON data file in a folder named environment/ — no TypeScript modules | — | Misleading folder name; JSON should be in data/ | LOW | Move to data/ |

---

## 4. PARTIALLY WORKING COMPONENTS WITH ERRORS

| File/Folder Path | What Is Partial | Error/Risk | Evidence | Severity | Fix Direction |
|-----------------|-----------------|-----------|----------|----------|---------------|
| skills/automation/skill.ts | openTarget() works in smoke tests; intermittently fails in live voice | Spawns cmd.exe /c start "" <target> — resolves { success: true } BEFORE proc.on('error') can fire; always reports success even if spawn fails. Target string has no sanitization | skill.ts:85–92: resolve before error event; skill.ts:49: no shell-char sanitization | HIGH | Race: resolve after 200ms if no error fires; sanitize target before spawning |
| memory/graphMemory.ts | All graph API methods compile and route correctly; zero real functionality | Neo4j driver is commented out (isConnected = false); every method returns empty/logs warn | graphMemory.ts:24–27; queryGraph() at line 229 | MEDIUM | Either connect to real Neo4j OR stub cleanly without logging warn per call |
| memory/unifiedContextBuilder.ts | Context is assembled and merged correctly when all services are up | Neo4j call always fails silently; vector call times out under load; no per-section token budget — hard truncation only | unifiedContextBuilder.ts:40–51; enforceTokenBudget() at line 92 | MEDIUM | Skip Neo4j when disabled; add per-section budgets (STM 400, LTM 800, Neo4j 200 tokens) |
| ridge/groqProvider.ts | Chat and streaming both work under normal Groq load | No timeout on individual etch() calls; fallback model default mismatches .env.example; circuit breaker resets after 60s but users see no voice feedback during downtime | groqProvider.ts:60: default "llama-3.1-8b-instant" vs .env.example:13 "llama-3.3-70b-versatile" | MEDIUM | Add AbortSignal timeout to fetch; align model defaults; add voice notification when circuit is broken |
| security/permissionManager.ts | Risk classification works correctly for most patterns | 
pm, pnpm, 
px in SAFE allowlist; \bdel\b regex pattern could false-positive on paths containing "del"; no audit log for open_app via deterministic route | permissionManager.ts:37–40; HIGH_RISK_PATTERNS[0] | HIGH | Move npm/pnpm/npx to MEDIUM_RISK; route all automation commands through securityAuditLogger |
| memory/memoryManager.ts | LowDB SSOT, Redis cache, short-term memory, and decay all work | 5 methods call db.write() directly without debounce; ddMessage() triggers 2 Redis round-trips per turn; STM "compression" is a hard truncation, not a real LLM summary | Lines 399, 457, 659, 685, 719 (direct writes); lines 308–324 (compression) | MEDIUM | Route all writes through scheduledWrite(); implement proper LLM-based compression |
| core/reflectionEngine.ts | Pre-execution check, mid-execution monitoring, and post-execution reflection all function | LLM diagnosis (llmDiagnoseFailure) fires a full LLM call for every unknown failure class — adds 500ms–3s latency to every non-trivial error path; llmPlanSanityCheck fires for all plans ≥4 nodes | eflectionEngine.ts:493–501: LLM call on unknown failure; eflectionEngine.ts:280: sanity check on complex plans | MEDIUM | Restrict LLM diagnosis to failures that have already failed 2+ times; make sanity check opt-in |
| core/goalManager.ts | Goal persistence, lifecycle, and crash-recovery heal all work correctly | createGoal() called for deterministic commands creates unresolved goals; rolling trim at 100 goals means goals from 100+ commands ago are lost (acceptable but undocumented) | orchestrator.ts:155: always called; goalManager.ts:126–128: rolling trim | MEDIUM | Guard createGoal() with deterministic-route check |
| monitoring/runtimeDashboard.ts | ASCII terminal dashboard renders correctly; 	imer.unref() prevents it from blocking process exit | Dashboard label says TTS (Kokoro) but TTS uses edge-tts + pygame, not Kokoro — misleading status display | untimeDashboard.ts:117: 'tts': 'TTS (Kokoro)' | LOW | Update label to match actual TTS engine |
| self_healing/pipelineWatchdog.ts | Monitors registered pipelines; restarts failed Python processes | Monitors eflectionEngine.py pipeline which does not exist — watchdog will report failure for a non-existent process on every health cycle | Stage 1 + Stage 2 confirmed | HIGH | Remove eflectionEngine.py from watchdog pipeline registry |
| oice/stt.py | STT recording, transcription, normalization, echo filter, and retry queue all work | Temp .wav files written to project root (not temp dir); _pending_stt_queue can flood NodeBridge on reconnect; sr.Microphone() re-initialized per recording | stt.py:344: ilename = f"temp_stt_{int(time.time())}.wav" in CWD; stt.py:309: queue can grow unbounded | HIGH | Use 	empfile.gettempdir(); cap queue at 3 items; cache microphone device |
| ridge/nodeBridge.ts | WebSocket server, role registration, command queueing, pending TTS flush all work | Zero authentication on connection — any localhost process can register as stt and inject arbitrary commands; pendingListen and pendingListenStart are two separate queue mechanisms for the same purpose (legacy + new) | 
odeBridge.ts:85–88: no auth; 
odeBridge.ts:46–47: dual pending flags | HIGH | Add HMAC token on client_ready; consolidate pending listen flags |

---
## 5. FAKE / STUB / PLACEHOLDER COMPONENTS

| File/Folder Path | Why It Appears Fake/Stub | Risk | Complete/Remove/Keep Later? |
|-----------------|--------------------------|------|---------------------------|
| gents/queryAgent.ts | Class exists; execute() returns { result: '' } — empty result every time | Any plan routing to this agent silently returns empty | REMOVE — orchestrator v2 does not use agent-based routing |
| gents/plannerAgent.ts | Class exists; execute() throws "Not implemented" | Plan will fail if ever routed here | REMOVE |
| gents/reflectionAgent.ts | Class exists; execute() returns { reflected: false } | Silent no-op — reflection appears to succeed but does nothing | REMOVE |
| gents/coordinatorAgent.ts | Class exists; execute() calls stub subagents in sequence — all return empty/false | Entire multi-agent coordination layer is non-functional | REMOVE |
| memory/graphMemory.ts | Neo4j driver creation is **commented out** — isConnected = false always; all methods return [] or warn. Used in production context build path | Logs [GraphMemory] Neo4j not connected warn on every LLM request | KEEP LATER — plumbing is correct; re-enable when Neo4j is set up; add silent short-circuit |
| oice/reflectionEngine.py | File **does not exist** — referenced in pipelineRegistry and fsWatcher as if it does | Causes watchdog errors and fsWatcher misses on every session | REMOVE all references — TypeScript eflectionEngine.ts is the real engine |
| learning/selfAudit.ts | Returns hardcoded { score: 0.8, recommendations: [] } — no real analysis | Gives false confidence that self-auditing is working | COMPLETE or REMOVE — depends on whether autonomous self-improvement is a roadmap goal |
| 	ools/dispatcher.ts | Methods exist but forward to empty stubs — no real tool dispatch happens via this path | Unused in live execution path (toolRegistryV2 handles dispatch) | REMOVE |
| 	ools/claudeCodeTool.ts | Tool definition exists; execute() always returns "Claude integration not configured" | If LLM ever selects this tool, user gets silent stub response | REMOVE or implement |
| utonomy/scheduler.ts | Exists with scheduling logic; no tasks registered; scheduler/ folder is empty | Scheduler runs but has nothing to schedule | KEEP LATER — implement scheduled tasks or remove empty folder |
| core/skillExecutor.ts | Exists as legacy shim — forwards calls to the new SkillLoader; no direct tests | Dead code risk — adds module load overhead with no benefit | REMOVE or fold into skillLoader |
| core/toolRegistry.ts (v1) | Deprecated registry with @deprecated JSDoc — still compiles; duplicate tool definitions if both are loaded | Latent conflict if accidentally imported | REMOVE — v2 is the live registry |
| ackend/ folder | Empty directory with only ackend/memory/ subdirectory containing no files | Misleading — implies a backend server exists | REMOVE |
| scheduler/ folder | Empty directory | Misleading — implies scheduler content exists | REMOVE or POPULATE |

---

## 6. UNUSED / DUPLICATE / STALE COMPONENTS

| File/Folder Path | Problem Type | Evidence | Risk | Later Action |
|-----------------|-------------|----------|------|-------------|
| core/brain.ts | STALE — legacy orchestrator replaced by orchestrator.ts v2 | Still compiles; registers messageBus listeners on import | If accidentally imported, pollutes messageBus with dead listeners; wastes RAM | DELETE |
| gents/queryAgent.ts | UNUSED + STUB | Not imported by any live module; orchestrator v2 does not use agent routing | Dead module load if imported | DELETE |
| gents/plannerAgent.ts | UNUSED + STUB | Not imported by live modules | Throws if called | DELETE |
| gents/reflectionAgent.ts | UNUSED + STUB | Not imported by live modules | Silent no-op | DELETE |
| gents/coordinatorAgent.ts | UNUSED + STUB | Not imported by live modules | Silent no-op | DELETE |
| core/toolRegistry.ts | DUPLICATE — v1 alongside v2 | Both 	oolRegistry.ts and 	oolRegistryV2.ts exist | Conflict if both imported | DELETE v1 |
| core/skillExecutor.ts | STALE — shim to skillLoader | Exists as pass-through shim with no tests | Extra indirection; module overhead | DELETE or fold into skillLoader |
| 	ools/dispatcher.ts | STALE — not in live execution path | toolRegistryV2 handles all dispatch | Confusion: developers may think this is the dispatch path | DELETE |
| 	ools/claudeCodeTool.ts | STALE + STUB | Returns "not configured" — Claude never integrated | False tool in registry | DELETE or implement |
| learning/selfAudit.ts | STUB | Returns hardcoded { score: 0.8 } always | Gives false confidence | DELETE or implement |
| oice/reflectionEngine.py | MISSING (appears stale by reference) | Referenced in 3 watchdog files; does not exist on disk | Watchdog errors on every session | DELETE all references |
| ackend/ folder | EMPTY DEAD FOLDER | list_dir returns only empty ackend/memory/ | Misleading project structure | DELETE |
| scheduler/ folder | EMPTY DEAD FOLDER | list_dir returns nothing | Misleading project structure | DELETE or populate |
| environment/systemInfo.json | MISPLACED FILE | JSON data in environment/ folder with no TypeScript modules | Misleading folder name | MOVE to data/ |
| Text dump files at project root (*.txt) | STALE STRUCTURAL DUMP FILES | Stage 1 confirmed ~22MB of text files containing structural dumps | RAM/disk waste; confuse project structure | DELETE |
| data/goals.json (stale in_progress entries) | RUNTIME STALE STATE | GoalManager heals these on init — but new ones accumulate every session due to deterministic command leak | Goals file grows unboundedly (capped at 100 by rolling trim) | Fix goal lifecycle; file is OK to keep |
| execution/actionExecutor.ts | POSSIBLY STALE — not in live execution path | orchestrator v2 uses 	oolRegistryV2.execute() directly; ctionExecutor appears imported but unused in the critical path | Safety timeouts in ctionExecutor are bypassed | Confirm and DELETE or re-wire |

---
## 7. TEST ERRORS

| Test Area/File | Error | Evidence | Severity | Recommended Test Later |
|---------------|-------|----------|----------|----------------------|
| package.json scripts.test | "test": "exit 1" — CI is permanently broken by design | 
pm test always exits with code 1 | CRITICAL | Replace with jest --passWithNoTests or equivalent; add proper test runner |
| 	ests/openAppSmokeTest.ts | **Unsafe test** — actually opens Chrome/YouTube/Notepad on the host OS during test run; cannot be run in CI | spawn(...) calls in test | HIGH | Move to 	ests/integration/; add --integration flag; unit test should mock spawn() |
| 	ests/security/securityGateUnitTest.ts | File referenced in audit as missing — no dedicated unit tests for permissionManager.ts | Stage 1 confirmed | HIGH | Add unit tests for all risk pattern matches: CRITICAL, HIGH, MEDIUM, SAFE |
| 	ests/voice/sttPipelineTest.ts | Absent — no automated tests for STT normalization, echo filter, or empty-result handling | No file found in 	ests/voice/ | HIGH | Unit test 
ormalize_stt(), is_echo(), empty string gate in NodeBridge |
| 	ests/memory/memoryManagerTest.ts | Absent or incomplete — no test for ememberFact() argument order bug | Stage 2 confirmed bug: args are swapped | CRITICAL | Test ememberFact() stores fact with correct importance and source values |
| 	ests/orchestrator/deterministicRoutingTest.ts | Absent — no automated test for deterministic route coverage | Stage 1 confirmed; only smoke tests | HIGH | Unit test each alias in ALIASES map; test filler word stripping; test "open youtube for me" |
| 	ests/ — passing tests that do not prove live behavior | openAppSmokeTest.ts passes because esolve({ success: true }) fires before proc.on('error') — test proves nothing about real spawn success | skill.ts:85–92: resolve before error event | MEDIUM | Mock spawn; test error path separately |
| 	ests/pcControlSmokeTest.ts | Performs real OS operations (launches apps, writes files) during test run | Stage 1 confirmed | HIGH | Split into mock-based unit test + opt-in live integration test |
| GoalManager tests | Absent — no test confirming stale goal cleanup on init, rolling trim, or crash recovery | goalManager.ts:80–90: heal logic | MEDIUM | Unit test stale in_progress healing; verify rolling trim at 100 goals |
| ReflectionEngine tests | Absent — no tests for LLM fallback diagnosis path or pre-execution check blocking | eflectionEngine.ts:493, eflectionEngine.ts:229–295 | MEDIUM | Mock modelRouter.chat(); test all failure classification patterns |
| Redis cache tests | Absent — no tests for cache miss/hit, TTL expiry, graceful degradation when Redis is down | edisCache.ts | MEDIUM | Unit test with mock Redis client; test all cache functions in offline mode |
| Vector memory circuit breaker tests | Absent — no test for circuit breaker open/close transitions or timeout behavior | memoryManager.ts:148–175 | MEDIUM | Test circuit opens after N timeouts; auto-recovers after 60s |
| TTS timeout test | Absent — no test for edge-tts hanging | 	ts.py:121 | HIGH | Mock communicate.save() to hang; assert timeout fires within 10s |

---

## 8. MEMORY SYSTEM ERRORS

| Memory Area | File/Function | Error | Evidence | Severity | Fix Direction |
|-------------|--------------|-------|----------|----------|---------------|
| **LowDB — Unbalanced write paths** | memory/memoryManager.ts:399,457,659,685,719 | db.write() called directly (non-debounced) in 5 methods; only ddMessage() uses the debounce timer. Multiple rapid writes during one request trigger multiple synchronous JSON flushes | 5 direct wait this.db.write() calls vs 1 debounced in scheduledWrite() | MEDIUM | Route ALL writes through scheduledWrite() debounce |
| **LowDB — ememberFact() arg order bug** | memory/memoryManager.ts:360, core/orchestrator.ts:385–388 | Orchestrator calls gentMemory.rememberFact('Failed task: ...', 7, 'agent_failure') but the method signature is (fact, source, importance) — maps to source=7 (number), importance='agent_failure' (string). LowDB stores corrupted values silently | orchestrator.ts:385: gentMemory.rememberFact(msg, 7, 'agent_failure') | CRITICAL | Fix caller: ememberFact(msg, 'agent_failure', 7) |
| **LowDB — STM compression is a truncation** | memory/memoryManager.ts:308–324 | When short-term memory exceeds MAX_STM_TOKENS=3000, the oldest half of messages is replaced with a "Summarized older context: ..." prefix + 500-char truncation. No real LLM summary — context is permanently lost | Lines 308–324 | MEDIUM | Implement LLM-based rolling summary or store a separate summary entry |
| **Redis — npm/npx in SAFE allowlist** | memory/redisCache.ts:40–44 | ioredis etryStrategy allows up to 3 retries with up to 2s between each — total Redis startup wait up to 6s when WSL Redis is slow | etryStrategy(times): if (times > 3) return null; return Math.min(times * 200, 2000) | MEDIUM | Add connectTimeout: 1000 to ioredis options |
| **Redis — Context cache invalidated too broadly** | memory/redisCache.ts:268–271 | invalidateContextCache() deletes BOTH ecentContext AND ecentMessages keys — called after every memory write including minor importance-boost updates. Forces full uildContext() on the next request | Lines 268–271 | MEDIUM | Only invalidate ecentContext; preserve ecentMessages between turns |
| **Redis — Two cache writes per conversation turn** | memory/memoryManager.ts:298–301 | ddMessage() fires cacheRecentMessages() + invalidateContextCache() on every message, including assistant one-liners ("Understood, sir.") | Lines 299–301 | MEDIUM | Debounce Redis cache writes; skip for very short assistant acknowledgements |
| **Vector — Per-request buildContext latency** | memory/unifiedContextBuilder.ts:35 | memoryManager.retrieveForPlanning(query, 5) fires on every uildContext() call — sends a fetch to the Python vector API with 1s timeout + 1 retry | unifiedContextBuilder.ts:35 | HIGH | Cache vector search results per query for 10s |
| **Vector — Dedup blocks fact writes** | memory/memoryManager.ts:364 | ememberFact() calls searchVector() synchronously before every insert — adds up to 2.1s per write (1s timeout + 100ms backoff + 1s retry) | Lines 364–410 | HIGH | Move dedup to async background check; do not block insert |
| **Vector — Unbounded startup rebuild** | memory/memoryManager.ts:127–143 | On init, if long-term facts exist, ALL facts are re-embedded in a sequential loop with no concurrency limit or maximum. 50 facts × 2.1s worst-case = 105s of background vector traffic | Lines 130–142 | HIGH | Cap rebuild at 10 facts; add concurrency limit of 3; skip if vector circuit is open |
| **Vector — 15s supervisor startup sleep** | memory/vectorMemorySupervisor.ts:197 | STARTUP_WAIT_MS = 15_000 — flat sleep before first health check | Line 197: wait new Promise(r => setTimeout(r, STARTUP_WAIT_MS)) | HIGH | Replace with 500ms poll loop; exit early when health endpoint responds |
| **Vector — Orphaned process risk** | memory/vectorMemorySupervisor.ts | If health checks fail to clear the circuit breaker correctly, a Python process that passed a port-conflict check may be adopted as the new vector service without verifying it is actually the JARVIS vector service | Stage 2 finding | MEDIUM | Add service fingerprint check on health endpoint |
| **Neo4j — Commented-out driver** | memory/graphMemory.ts:24–27 | Driver creation commented out but all graph methods still called from unifiedContextBuilder. Every request generates a [GraphMemory] Neo4j not connected warn | graphMemory.ts:26: // this.driver = neo4j.driver(...) | MEDIUM | Add if (!this.isConnected) return [] silently to all methods; OR remove the call from unifiedContextBuilder until Neo4j is enabled |
| **Neo4j — Insecure default credentials** | memory/graphMemory.ts:21 | Default password='password' used if NEO4J_PASSWORD env var not set | graphMemory.ts:21 | HIGH | Add NEO4J_* vars to .env.example; fail fast if defaults are used when isConnected=true |
| **Neo4j — Raw Cypher injection surface** | memory/graphMemory.ts:229 | queryGraph(query: string) accepts a raw Cypher string — no validation or template restriction | graphMemory.ts:229 | MEDIUM | Restrict to named parameterized query templates; never accept user-controlled query strings |
| **Context builder — Hard truncation** | memory/unifiedContextBuilder.ts:92 | enforceTokenBudget() truncates the merged context at 6000 characters with no awareness of section boundaries — may cut mid-fact or mid-sentence | Lines 92–95 | MEDIUM | Enforce per-section budgets before merge; truncate at section level |
| **Context builder — No cache** | memory/unifiedContextBuilder.ts:24 | uildContext() result is never cached — identical queries pay full cost on every call | Entire function at line 24 | HIGH | Add 10s session-scoped cache keyed by (query, sessionId) |
| **GoalManager — Stale goals file** | core/goalManager.ts:68–90 | init() heals stale in_progress goals from previous crashes — correct. BUT new stale goals accumulate during every session because deterministic commands create goals that are never resolved | orchestrator.ts:155 + goalManager.ts:130: goal created but not completed for deterministic routes | HIGH | Guard createGoal() with deterministic check; OR call completeGoal() after deterministic success |

---
## 9. ORCHESTRATOR / BRAIN / ROUTING ERRORS

| Routing Area | File/Function | Error | Evidence | Severity | Fix Direction |
|-------------|--------------|-------|----------|----------|---------------|
| **Direct chat path — simple phrase list** | core/orchestrator.ts:1089–1092 | isSimpleConversationalInput() has only 8 hardcoded phrases. "Tell me a joke", "what's the news", "chat with me" all fall through to the full PLAN path with uildContext + LLM + tools even though they need no tools | simpleGreetings array has 8 entries | MEDIUM | Expand list; add action-verb guard to catch anything with a command keyword |
| **Deterministic route — filler word gaps** | core/orchestrator.ts:1048–1053 | Filler word stripping inside alias loop only removes or me, please, 	he, . "Open YouTube now", "Open YouTube quickly", "Open YouTube right now" would NOT match and fall to the LLM path | Lines 1048–1053: only 4 filler words stripped | MEDIUM | Add: 
ow, ight now, quickly, immediately, up, sap |
| **Deterministic route — GoalManager leak** | core/orchestrator.ts:155–297 | goalManager.createGoal() fires before every request including deterministic ones. After deterministic success the function returns 'success' without resolving the goal — it stays in_progress forever | orchestrator.ts:155 creates goal; line 297 returns before updateGoalStatus('completed') | HIGH | Add goalManager.completeGoal(goal.id) before deterministic return; OR skip createGoal() for deterministic commands |
| **Deterministic route — Early memory write** | core/orchestrator.ts:301–313 | gentMemory.addConversationMessage('user', input) fires for ALL inputs — including those that will be handled by the simple conversational path. Simple "hello" now triggers LowDB write + Redis update | Line 302: memory write before simple-path check at line 310 | MEDIUM | Move memory write to AFTER simple path check |
| **LLM path — Repair loop latency** | core/orchestrator.ts:349,902–916 | Up to 4 repair cycles (plan → execute → reflect → repair → replan). Each replan invokes full uildContext + LLM + tools. Worst case: 4× (2s context + 2s LLM + 1s synthesis) = 20s per command | epairCycles <= maxRepairCycles; default maxRepairCycles = 3 | HIGH | Cap at 2 repair cycles for voice mode; skip full replan for single-tool failures |
| **LLM path — No AbortSignal** | core/orchestrator.ts:556, ridge/groqProvider.ts | In-flight LLM etch() cannot be cancelled. Barge-in interrupt sets state to INTERRUPTED, but is only checked after wait modelRouter.chat() returns — too late | orchestrator.ts:556: check after await | HIGH | Add AbortController + signal; pass to modelRouter.chat() and groqProvider.fetch() |
| **LLM path — Synthesis call on simple tools** | core/orchestrator.ts:762 | handleSuccess() fires a second LLM streaming call after every successful tool execution. simpleTools bypass list only contains 'open_app', 'get_time', 'get_date', 'get_system_info' — missing control_browser, control_window, control_app, open_website | orchestrator.ts:704–706 | HIGH | Expand simpleTools list; skip synthesis for all automation-class tools |
| **LLM path — Token budget console log** | core/orchestrator.ts:524–532 | 7 console.log() calls per planning invocation — synchronous stdout writes on every non-trivial request | Lines 524–532 | LOW | Guard behind DEBUG_MODE=true env flag |
| **Fallback planner — API mismatch** | core/orchestrator.ts:604–625 | Rule-based fallback calls 
ew TaskGraphBuilder(input) with input string; graph.addTask(...) — constructor signature likely requires different args | Lines 606–621 | HIGH | Audit TaskGraphBuilder constructor; update fallback call signature; add try/catch |
| **Model router — Single provider, no fallback** | ridge/modelRouter.ts:8–11 | Only groq provider registered. If Groq is down, all LLM paths throw — no local fallback model registered | modelRouter.ts:10: only 	his.providers.set("groq", groqProvider) | HIGH | Register a local Ollama/LM Studio provider as fallback; validate at startup |
| **No PLANNING watchdog** | core/agentStateMachine.ts (inferred) | PLANNING state has no timeout. If modelRouter.chat() hangs (no AbortSignal), JARVIS stays in PLANNING indefinitely | Stage 2 confirmed | HIGH | Add 30s PLANNING watchdog; 60s EXECUTING watchdog |
| **SPEAKING stuck state** | core/orchestrator.ts:196–202 | If speaking_end event from TTS never fires (TTS crash, edge-tts hang), the deferred state reset never happens — JARVIS stays in SPEAKING forever | orchestrator.ts:200: isConversationEndDeferred = true with no fallback timer | CRITICAL | Add 30s watchdog that forces state reset if SPEAKING persists after TTS should have finished |
| **GoalManager — recent goal context in prompt** | core/orchestrator.ts:482 | goalManager.getRecentGoalContext(4) is injected into every planning prompt — adds recent goal strings to an already large context. No size cap on this injection | Lines 481–484 | LOW | Cap goal context at 100 tokens |
| **Pre-execution check — LLM sanity overhead** | core/reflectionEngine.ts:280–286 | llmPlanSanityCheck() fires a full LLM call for any plan with ≥4 nodes — adds 500ms–3s to every complex planning cycle | eflectionEngine.ts:280: if (performLLMSanity && graph.nodes.size >= 4) | MEDIUM | Make opt-in with explicit flag; off by default in voice mode |
| **LLM diagnosis on every unknown failure** | core/reflectionEngine.ts:493–501 | llmDiagnoseFailure() fires a full LLM call for every failure with class 'unknown'. Any new error type not in FAILURE_PATTERNS triggers this | eflectionEngine.ts:493: if (dominantClass === 'unknown') | MEDIUM | Only fire LLM diagnosis after 2+ failures with same unknown class |

---

## 10. TOOL SYSTEM ERRORS

| Tool/File | Error Type | Evidence | Severity | Fix Direction |
|-----------|-----------|----------|----------|---------------|
| skills/automation/skill.ts — open_app | **No security gate** — any voice input resolving to open_app spawns a process with no allowlist check | skill.ts:63–83: no permissionManager.checkPermission() call | CRITICAL | Validate target against hardcoded URL/app allowlist before spawning; call permissionManager.assessRisk() |
| skills/automation/skill.ts:49 — shell meta-chars | cmd.exe /c start "" <target> — target is passed with shell: false but cmd.exe itself interprets &, |, ^, % in the argument | skill.ts:49: rgs = ['/c', 'start', '', resolvedTarget] — no sanitization | CRITICAL | Strip shell metacharacters from esolvedTarget before spawning |
| skills/automation/skill.ts:85–92 — false success | Promise resolves { success: true } immediately — BEFORE proc.on('error') fires. Spawn errors arrive asynchronously after the caller already has a success result | Lines 85–92 resolve before error event | HIGH | Race the error event: resolve after 200ms if no error; return error result if spawn event fires |
| core/toolRegistry.ts (v1) | DUPLICATE — dead registry still compiles | Stage 1 confirmed | MEDIUM | DELETE |
| core/toolRegistryV2.ts — egisterAllTools() | Called in JarvisOrchestrator constructor on every instantiation — if orchestrator is imported in tests, all tools re-register on each import | orchestrator.ts:68 | LOW | Add idempotency guard to egisterAllTools() |
| gents/*.ts — 4 agent stubs | STUB tools — always return empty/false/throw | Stage 1 + Stage 2 confirmed | MEDIUM | DELETE all agent stubs |
| 	ools/claudeCodeTool.ts | Returns "Claude integration not configured" always | Stage 1 confirmed | MEDIUM | DELETE or implement |
| 	ools/dispatcher.ts | Not in live execution path — 	oolRegistryV2 handles dispatch | Stage 1 confirmed | MEDIUM | DELETE |
| security/permissionManager.ts:37–40 | 
pm, pnpm, 
px, python in SAFE_READ_ONLY allowlist — 
pm run <anything> passes safety gate | Lines 37–40 | HIGH | Move to MEDIUM_RISK minimum |
| security/permissionManager.ts — no audit log for open_app | open_app via deterministic router never calls securityAuditLogger | orchestrator.ts:241–295: no audit log call on deterministic path | MEDIUM | Log all automation-class commands to securityAuditLogger regardless of route |
| security/approvalGate.ts — voice dead zone | HIGH_RISK commands triggered by voice silently timeout after 30s (non-TTY auto-deny) with no voice feedback | pprovalGate.ts:97–99 | HIGH | Speak "I need your confirmation before I can do that" before waiting for console input |
| execution/actionExecutor.ts — bypassed | Safety timeouts and rollback logic in ctionExecutor are not used in the live v2 execution path — 	oolRegistryV2.execute() is called directly | Stage 2 finding | MEDIUM | Confirm and DELETE, or re-wire safety hooks into 	oolRegistryV2.execute() |
| memory/graphMemory.ts:64 — label sanitization only | Relationship elType is sanitized but entity names use Cypher parameters (safe). However queryGraph() accepts raw Cypher — if called with user-controlled strings, full Cypher injection | graphMemory.ts:229 | MEDIUM | Restrict queryGraph() to named templates |

---
## 11. VOICE PIPELINE ERRORS

| Voice Area | File/Function | Error | Evidence | Severity | Fix Direction |
|-----------|--------------|-------|----------|----------|---------------|
| **Wake word → STT handoff blocked during SPEAKING** | oice/wakeWords.py → ridge/nodeBridge.ts → oice/stt.py | listen_start is sent to STT while JARVIS is still speaking. STT records audio and sends stt_result, but jarvis.ts finds state is SPEAKING → queues in oiceInputQueue. If speaking_end is late or lost, queue is never drained | stt.py:414–416: if session_lock.locked(): continue; jarvis.ts voice queue | HIGH | Buffer one deferred listen_start; replay immediately on speaking:end event |
| **Empty STT result forwarded to orchestrator** | oice/stt.py:351 | WaitTimeoutError (no speech detected) sends stt_result {text: ""} — NodeBridge forwards it without checking for empty text. Orchestrator processes empty string through deterministic → simple → FULL LLM path | stt.py:351: wait self._send_result(""); 
odeBridge.ts:243–248: no empty-string guard | HIGH | Filter stt_result with empty/whitespace text in NodeBridge before routing |
| **TTS hang — no timeout on edge-tts** | oice/tts.py:121 | wait communicate.save(tmp_path) makes HTTPS to Microsoft with no timeout. If Microsoft endpoint is slow or unreachable, TTS worker hangs indefinitely — no speaking_end ever sent | Line 121: no syncio.wait_for() | CRITICAL | syncio.wait_for(communicate.save(tmp_path), timeout=10.0) |
| **SPEAKING state permanent stuck** | core/orchestrator.ts:196–202, oice/tts.py | If TTS crashes, times out, or disconnects during speech, speaking_end is never sent to NodeBridge. Orchestrator deferred reset never fires — JARVIS stays in SPEAKING state forever | orchestrator.ts:200: isConversationEndDeferred = true with no watchdog timer | CRITICAL | Add 30s watchdog that forces IDLE transition if SPEAKING persists after expected TTS duration |
| **Echo filter duplication** | oice/stt.py:148–209, jarvis.ts:111–169 | Echo filter runs independently in both Python (STT side) and TypeScript (NodeBridge side). Both maintain their own last_tts_text state. The two may be out of sync — a command protected in Python may still be filtered in TS, or vice versa | Two is_echo() functions with same logic in different languages | MEDIUM | Remove Python echo filter; do all filtering in TypeScript NodeBridge handler which has authoritative lastTtsText |
| **STT temp file in project root** | oice/stt.py:344 | ilename = f"temp_stt_{int(time.time())}.wav" writes to the current working directory (project root). On long sessions with cleanup failures, .wav files accumulate | Line 344; cleanup in inally at line 376–380 can fail silently | HIGH | Use 	empfile.gettempdir() or data/temp/ directory |
| **STT pending queue — flood on reconnect** | oice/stt.py:308–310 | If WebSocket is down, failed sends append to _pending_stt_queue. On reconnect, all queued items are sent with 300ms gap — could flood orchestrator with stale commands | Lines 312–337 | MEDIUM | Cap queue at 3 items; discard oldest on overflow |
| **STT microphone re-initialized per recording** | oice/stt.py:237 | with sr.Microphone() as source: opens the microphone device fresh on every _record_audio() call — adds hardware enumeration overhead (200–500ms on some Windows setups) | Line 237 | MEDIUM | Cache sr.Recognizer() and use a persistent microphone stream |
| **TTS worker not restarted on WS reconnect** | oice/tts.py:171 | _worker_task is created once in un(). On WebSocket reconnect, the existing worker task continues with self.websocket = None — speaking_start/speaking_end sends against a None websocket fail silently | 	ts.py:171: single syncio.create_task; 	ts.py:70,89: guarded but not guaranteed | MEDIUM | Drain queue and restart worker task on each reconnect |
| **STT dedup — duplicate suppression too aggressive** | oice/stt.py:288–291 | If the same command is said twice consecutively (e.g., "open YouTube" repeated because the first attempt appeared to fail), the second is suppressed as a duplicate | stt.py:288: if normalized == self._last_sent_text: return | MEDIUM | Add a 5-second window: only suppress duplicates within 5s of last send |
| **NodeBridge — Dual pending listen flags** | ridge/nodeBridge.ts:46–47 | Two separate flags: pendingListen: boolean (legacy command: listen path) and pendingListenStart: boolean (new listen_start type). Both exist for the same purpose — sends a duplicate listen if both are set when STT reconnects | Lines 46–47, 165–194 | LOW | Consolidate to single pendingListenStart flag; remove legacy pendingListen |
| **NodeBridge — No authentication on WS** | ridge/nodeBridge.ts:119–128 | client_ready handler warns on unknown roles but still registers them — warning is not enforced. Any process can send {type:"client_ready", payload:{role:"stt"}} and begin injecting commands | 
odeBridge.ts:128–132: warn then register anyway | HIGH | Require a shared-secret HMAC token in client_ready payload; reject without token |
| **TTS temp file race on CancelledError** | oice/tts.py:139–147 | speak() re-raises CancelledError after cleanup — the inally block at line 151 should run, but Python's exception ordering guarantees inally always runs even after re-raise. Risk is LOW but cleanup order should be verified | Lines 139–147, 151–156 | LOW | Verify cleanup order; use contextlib.suppress(OSError) in finally |
| **STT disk I/O per voice command** | oice/stt.py:346,361 | Recording (_record_audio) writes WAV to disk; transcription (_transcribe) reads it back. Both use syncio.to_thread() — adds two disk I/O operations per voice command | Lines 346, 361 | MEDIUM | Pass audio bytes in-memory to Whisper if API supports it |

---

## 12. YOUTUBE OPEN COMMAND FINAL ERROR INVESTIGATION

### Full Route for "Open YouTube"

**Deterministic path (intended live route):**
`
User speaks: "Jarvis, open YouTube for me"
  ↓ wakeWords.py detects wake → sends listen_start to NodeBridge
  ↓ NodeBridge → STT: {type: "listen_start"}
  ↓ stt.py records audio (sr.Microphone + VAD, up to 30s)
  ↓ stt.py._transcribe() → Whisper Tiny returns "Jarvis, open YouTube for me."
  ↓ normalize_stt():
      lowercase → "jarvis, open youtube for me."
      strip punctuation → "jarvis open youtube for me"
      strip wake prefix "jarvis" → "open youtube for me"
  ↓ echo filter check (stt.py is_echo vs last_tts_text)
  ↓ stt_result {text: "open youtube for me"} sent to NodeBridge
  ↓ jarvis.ts receives stt_result
  ↓ isEcho("open youtube for me", lastTtsText)? — checked again in TS
  ↓ orchestrator.process("open youtube for me", 'voice')
  ↓ matchDeterministicCommand():
      clean = "open youtube for me"
      trigger = "open", afterTrigger = "youtube for me"
      stripped = "youtube for me".replace(/\bfor me\b/, '') = "youtube"
      alias match: 'youtube' === 'youtube' ✅
      → return { type: 'open_app', target: 'youtube' }
  ↓ toolRegistryV2.execute('open_app', { target: 'youtube' })
  ↓ skills/automation/skill.ts openTarget('youtube')
  ↓ websiteAliases['youtube'] = 'https://www.youtube.com'
  ↓ spawn('cmd.exe', ['/c', 'start', '', 'https://www.youtube.com'], { detached: true })
  ↓ resolve({ success: true }) IMMEDIATELY
  ↓ orchestrator.speak("Opening youtube, sir.")
  ↓ nodeBridge.speakToClients("Opening youtube, sir.")
  ↓ TTS Python speaks the phrase
`

---

### Direct Test Path (Always Passes)
`
openAppSmokeTest.ts
  → import execute from skills/automation/skill.ts
  → execute({ target: 'youtube' })
  → openTarget('youtube')
  → resolve({ success: true }) IMMEDIATELY (before proc.on('error'))
`
**This test always passes regardless of whether YouTube actually opened.**

---

### Difference: Smoke Test vs Live Voice

| Factor | Smoke Test | Live Voice |
|--------|-----------|-----------|
| Echo filter | Not run | Runs twice (Python + TypeScript) |
| State machine | Not checked | Must be IDLE; blocked during SPEAKING |
| STT pipeline | Not involved | Whisper transcription may vary |
| listen_start relay | Not involved | Can be missed if in SPEAKING state |
| Timing | Instant | 2–4s STT pipeline |
| speaking_end event | Not involved | Must fire to unblock state |
| Spawn success detection | Always "success" | Also always "success" — false positive |

---

### Most Likely Failure Points (in Order)

| Rank | Failure Point | Evidence | Fix Direction |
|------|--------------|----------|---------------|
| **#1 — MOST LIKELY** | **Echo filter false positive** — JARVIS just said "Opening youtube, sir." If user repeats "open YouTube" within seconds, youtube word overlap triggers echo filter. Result is silently discarded before orchestrator | jarvis.ts:162: threshold=0.75 for commands; "youtube" appears in both TTS and STT | Check data/logs/stt_debug.log for ECHO_FILTER_* events after the failed command |
| **#2** | **SPEAKING state blocks input** — TTS is still playing "Opening youtube, sir." when the next wake word fires. listen_start is sent to STT; STT records; stt_result arrives but state is SPEAKING → queued in oiceInputQueue. If speaking_end is delayed or TTS hangs, queue is never drained | jarvis.ts voiceInputQueue; 	ts.py:121 no timeout | Add watchdog for SPEAKING; buffer one listen_start |
| **#3** | **STT transcription variant** — Whisper returns "You Tube" (two words) or "YouTube" with capital Y. Normalization lowercases but does NOT handle "you tube" as a single word. Alias lookup for "you tube" != "youtube" → falls to LLM | stt.py:122–132: normalize does not join split words | Add "you tube" → "youtube" alias in 
ormalize_stt() |
| **#4** | **Spawn false success masks real error** — Even when the command deterministically succeeds, spawn resolves { success: true } before the OS confirms launch. Windows cold-starting Chrome takes 3–5s. User sees "Opening YouTube" speech but nothing appears → assumes failure → repeats command | skill.ts:85–92: resolve before error event | Add 500ms post-spawn verification; or inform user "YouTube is loading, may take a moment" |
| **#5** | **Empty STT result on mic timeout** — If microphone cuts off before speech is captured (e.g., long wake-word-to-speak delay), Whisper returns empty. Empty result hits the LLM planner with an empty string | stt.py:351: sends empty stt_result | Filter empty results in NodeBridge |

---

### Evidence Summary

| Claim | File | Line |
|-------|------|------|
| Echo filter runs TWICE (Python + TS) | stt.py:148, jarvis.ts:111 | Confirmed |
| "youtube" is in COMMAND_KEYWORDS_SET | jarvis.ts:103 | Confirmed |
| Threshold 0.75 for command keywords | jarvis.ts:162 | Confirmed |
| "Opening youtube, sir." → last TTS text | 
odeBridge.ts:449 | Confirmed |
| listen_start queued during SPEAKING | jarvis.ts voiceInputQueue | Confirmed |
| speaking_end has no watchdog | orchestrator.ts:200 | Confirmed |
| spawn resolves before error | skill.ts:85–92 | Confirmed |
| normalize_stt handles lowercase + prefix | stt.py:105–132 | Confirmed |
| "for me" stripped in deterministic router | orchestrator.ts:1049 | Confirmed |

---
## 13. PERFORMANCE ERRORS

### Confirmed Blocking Performance Problems

| Problem | File | Impact | Evidence |
|---------|------|--------|----------|
| edge-tts communicate.save() no timeout | 	ts.py:121 | Indefinite hang; TTS pipeline freezes; SPEAKING state never resets | No syncio.wait_for() |
| Vector supervisor 15s flat sleep | ectorMemorySupervisor.ts:197 | 15s added to every cold start | Hardcoded STARTUP_WAIT_MS = 15_000 |
| uildContext() uncached, 3 I/O calls per request | unifiedContextBuilder.ts:24 | 1–3s added before every LLM call | Redis + vector API + Neo4j every request |
| ememberFact() blocks on vector dedup | memoryManager.ts:364 | Up to 2.1s per fact write | searchVector() call before insert |
| Second LLM call for synthesis after tools | orchestrator.ts:762 | 500ms–3s added after every non-simple tool | handleSuccess() fires streaming LLM call |
| Vector index rebuild at startup — no limit | memoryManager.ts:130–142 | N × 2.1s worst case | No cap, no concurrency limit |
| Groq 3-attempt retry with 1s sleeps | groqProvider.ts:99,164 | Up to 3+ seconds added on network failures | wait sleep(1000) in retry loops |

### Suspected Performance Risks (8 GB RAM / Old PC)

| Risk | File | Why |
|------|------|-----|
| Redis retry up to 6s at startup (WSL slow to respond) | edisCache.ts:40–44 | No connectTimeout set |
| sr.Microphone() re-init overhead per recording (200–500ms on some Windows setups) | stt.py:237 | Context manager re-opened per call |
| systemStateObserver WMI/PowerShell polling on Windows | perception/systemStateObserver.ts | Not directly examined; inferred from class name; WMI calls are expensive |
| GoalManager 2 LowDB writes per request (create + write) | goalManager.ts:130,197 | Each createGoal() and persist() writes data/goals.json synchronously |
| 7 legacy brain modules register messageBus listeners on import | core/brain.ts + gents/ | Extra RAM if accidentally imported |
| STT disk write + read per voice command | stt.py:344,361 | .wav file round-trip on every recognition |
| LLM plan sanity check fires for all ≥4-node plans | eflectionEngine.ts:280 | Extra LLM call for complex plans |

### Old PC / 8 GB RAM Specific Recommendations

| Action | Expected Impact |
|--------|----------------|
| Delete rain.ts + agent stubs | Free RAM from dead module listeners |
| Cache uildContext() 10s | Save 1–3s per LLM request |
| Fix vector supervisor 15s → 500ms poll | Save 12–15s on cold start |
| Cap vector startup rebuild to 10 facts, 3 concurrent | Prevent 100s CPU spike at boot |
| Add connectTimeout: 1000 to ioredis | Limit Redis wait to 1s |
| Move decayMemory() to scheduled interval | Remove from startup critical path |
| Set untimeDashboard.start(60_000) instead of 15s | Halve dashboard poll overhead |
| Add syncio.wait_for(..., timeout=10.0) to TTS | Prevent voice pipeline freeze |

---

## 14. LATENCY ERROR TABLE

| Area | File/Function | When It Runs | Slow Risk | Evidence | Severity | Fix Direction |
|------|--------------|-------------|-----------|----------|----------|---------------|
| Vector supervisor startup | ectorMemorySupervisor.ts:197 | Every cold start | 15s flat | STARTUP_WAIT_MS = 15_000 | HIGH | 500ms poll loop |
| Context building | unifiedContextBuilder.ts:24 | Every LLM-bound request | 1–3s | 3 async I/O calls | HIGH | 10s session cache |
| LTM vector search | memoryManager.ts:retrieveForPlanning() | Every uildContext() call | Up to 2.1s | 1s timeout + 1 retry | HIGH | Cache 10s per query |
| Fact write dedup | memoryManager.ts:364 | Every ememberFact() | Up to 2.1s | searchVector() before insert | HIGH | Async background check |
| LLM planning call | modelRouter.chat() | Every non-deterministic, non-simple request | 500ms–3s | Groq API network latency | HIGH (unavoidable) | Reduce context size |
| LLM retry sleep | groqProvider.ts:99,164 | On 500/429 errors | Up to 3s | wait sleep(1000) ×3 | HIGH | Reduce to 500ms; circuit break after 2 consecutive 500s |
| LLM synthesis call | orchestrator.ts:762 | After every non-simple tool | 500ms–3s | Second streaming LLM call | HIGH | Expand simpleTools bypass |
| TTS edge-tts HTTPS | 	ts.py:121 | Every TTS phrase | Indefinite | No timeout | CRITICAL | 10s syncio.wait_for |
| STT audio recording | stt.py:_record_audio() | Every voice command | Mic re-init overhead | sr.Microphone() per call | MEDIUM | Cache mic handle |
| STT disk I/O | stt.py:344,361 | Every voice command | Disk round-trip | .wav write + read per command | MEDIUM | In-memory bytes if API supports |
| Memory decay | memoryManager.decayMemory() | At orchestrator constructor init | Disk write at startup | orchestrator.ts:88–95 | MEDIUM | Scheduled background interval |
| Neo4j stub call | graphMemory.queryGraph() | Every uildContext() | Function call + warn log | unifiedContextBuilder.ts:40–51 | MEDIUM | Skip when !isConnected without warn |
| GoalManager writes | goalManager.ts:130,197 | Every request | 2 LowDB flushes | createGoal() + persist() | MEDIUM | Skip for deterministic commands |
| Redis startup retry | edisCache.ts:40–44 | At boot when WSL slow | Up to 6s | 3 retries × 2s max | MEDIUM | Add connectTimeout: 1000 |
| LLM repair loop | orchestrator.ts:902–916 | On tool failures | Up to 4 full round-trips | epairCycles <= 3 | HIGH | Cap at 2 for voice mode |

---

## 15. STARTUP COST ERROR TABLE

| Module | Starts On Boot? | Error/Concern | Evidence | Severity | Fix Direction |
|--------|----------------|---------------|----------|----------|---------------|
| memoryManager.init() | YES — awaited | Reads LowDB + Redis init + triggers background vector rebuild (unbounded) | jarvis.ts:188 | HIGH | Rate-limit vector rebuild; defer non-critical parts |
| ectorMemorySupervisor.start() | YES — fire-and-forget | Spawns Python + sleeps 15s before health check | jarvis.ts:194 | HIGH | Replace 15s sleep with 500ms poll loop |
| decayMemory() in orchestrator constructor | YES — in constructor | Async disk write during module load | orchestrator.ts:88–95 | MEDIUM | Move to scheduled background interval |
| goalManager.init() | YES — in orchestrator constructor | Reads data/goals.json + writes healed goals | orchestrator.ts:82 | LOW | Fast operation; OK |
| egisterAllTools() | YES — in orchestrator constructor | Synchronous iteration over all tools | orchestrator.ts:68 | LOW | Add idempotency guard |
| selfHealingManager | YES | Spawns 3–4 Python processes (wakeWords.py, stt.py, 	ts.py, optionally ectorMemory.py) | jarvis.ts | LOW | Necessary; acceptable |
| sWatcher | YES | Watches oice/ folder including eflectionEngine.py which does not exist | sWatcher.ts:27 | MEDIUM | Remove watcher for non-existent file |
| pipelineWatchdog | YES | HTTP health server on 9001 + periodic pipeline checks including missing eflectionEngine.py pipeline | jarvis.ts | MEDIUM | Remove missing pipeline from registry |
| systemStateObserver | YES | Polls Windows OS state — WMI/PowerShell may be expensive | jarvis.ts:45 | MEDIUM | Ensure polling interval ≥ 30s; audit WMI usage |
| untimeDashboard.start() | YES | Refreshes every 15s by default — calls healthManager.probe() which pings all services | jarvis.ts:41 | LOW | Change to 60s on low-RAM systems |
| healthManager | YES | Probes Redis, Vector, LLM, ToolRegistry — unclear cost | jarvis.ts:46 | UNKNOWN | Audit startup probe cost |
| Legacy brain + agent modules | RISK | Not imported in live path, but if rain.ts is ever accidentally imported, 7 modules init | Stage 1 confirmed | HIGH | DELETE brain.ts + agents/ |
| Orchestrator constructor | YES | Runs egisterAllTools + loadSkills + goalManager.init + memoryManager.init + decayMemory — 5 async chains | orchestrator.ts:64–111 | HIGH | Separate construction from initialization; add explicit orchestrator.init() |

---

## 16. PER-REQUEST COST ERROR TABLE

| Step | Runs On Every Request? | Error/Concern | Evidence | Severity | Fix Direction |
|------|----------------------|---------------|----------|----------|---------------|
| matchDeterministicCommand() | YES — all | Fast synchronous string ops — NOT an error | orchestrator.ts:234 | OK | None |
| goalManager.createGoal() | YES — ALL including deterministic | Creates + persists a goal even for "open youtube" | orchestrator.ts:155 | HIGH | Skip for deterministic commands |
| gentMemory.addConversationMessage() | YES — non-deterministic | LowDB write + Redis cache + Redis context invalidation | orchestrator.ts:302 | MEDIUM | Skip for simple/deterministic inputs |
| uildContext() = 3 async I/O ops | YES — all LLM-bound | Redis + Vector API (1s timeout) + Neo4j stub + merge | unifiedContextBuilder.ts:24 | HIGH | Cache 10s; skip if no facts |
| getLLMDefinitions() serialization | YES — every planning call | JSON serialization of all tool definitions for prompt | orchestrator.ts:517 | LOW | Cache serialized result |
| console.log × 7 token budget | YES — every planning call | Synchronous stdout per request | orchestrator.ts:524–532 | LOW | Guard behind DEBUG_MODE flag |
| modelRouter.chat() LLM call | YES — all LLM-bound | Groq API network call | orchestrator.ts:559 | HIGH (unavoidable) | Minimize context size |
| preExecutionCheck() | YES — all tool-using | Validates all tool names against registry — fast | orchestrator.ts:328 | LOW | OK |
| eflect() post-execution | YES — after every execution | Full graph inspection; may invoke LLM for unknown failures | orchestrator.ts:367 | MEDIUM | LLM fallback only after 2+ unknown failures |
| handleSuccess() synthesis LLM | YES — non-simple tools | Second LLM streaming call after tool execution | orchestrator.ts:762 | HIGH | Expand simpleTools bypass list |
| gentMemory.addConversationMessage() (assistant) | YES — after LLM | Second message write per turn | orchestrator.ts:570 | LOW | Already debounced; acceptable |
| ememberFact() on failure | YES — on every abort | Vector dedup (up to 2.1s) + LowDB write + Redis invalidation | orchestrator.ts:385–388 | HIGH | Skip vector dedup for ephemeral failure records |
| GoalManager.updateGoalStatus() | YES — multiple per request | LowDB write at each phase boundary (planning, executing, completing) | orchestrator.ts multiple calls | MEDIUM | Batch phase updates; write once at end |

---

## 17. TIMEOUT / RETRY ERROR TABLE

| File | Service | Timeout | Retry Count | Worst-Case Delay | Safe or Unsafe? | Fix Direction |
|------|---------|---------|-------------|-----------------|-----------------|---------------|
| memory/memoryManager.ts:156 | Vector API | 1000ms per attempt | 1 retry | 2.1s (1s + 100ms backoff + 1s) | SAFE (circuit breaker) | Reduce to 800ms total for non-critical paths |
| memory/vectorMemorySupervisor.ts:197 | Startup wait | 15 000ms flat sleep | N/A | 15s | UNSAFE for 8GB PC | 500ms polling loop |
| memory/redisCache.ts:40–44 | Redis connect | No explicit timeout | 3 retries | Up to 6s (3 × 2000ms) | UNSAFE on slow WSL | Add connectTimeout: 1000 |
| ridge/groqProvider.ts:75–100 | Groq API chat | No request timeout | 3 attempts | 10+ seconds | UNSAFE | Add AbortSignal with 30s timeout per fetch |
| ridge/groqProvider.ts:172–232 | Groq API stream | No request timeout | 3 attempts | 10+ seconds | UNSAFE | Add stream timeout |
| oice/tts.py:121 | edge-tts Microsoft HTTPS | **NO TIMEOUT** | 0 | **Indefinite hang** | CRITICAL | syncio.wait_for(..., timeout=10.0) |
| security/approvalGate.ts:37 | Console approval | 30s | 0 | 30s silent wait in voice mode | UNSAFE for voice | Reduce to 15s; speak notification first |
| memory/vectorMemorySupervisor.ts:214 | Vector health check | 2000ms per check | 0 (single check) | 2s per poll | SAFE | Acceptable |
| memory/redisCache.ts:192 | Vector circuit breaker reset | 60 000ms auto-reset | N/A | 60s blackout window | SAFE | OK |
| ridge/nodeBridge.ts:55 | Command queue TTL | 30 000ms per command | N/A | Command expires after 30s | SAFE | OK |
| core/orchestrator.ts — SPEAKING state | speaking_end event | No watchdog | N/A | **Indefinite stuck** | CRITICAL | Add 30s watchdog |
| core/orchestrator.ts — PLANNING state | LLM call | No watchdog | N/A | **Indefinite stuck** | CRITICAL | Add 30s PLANNING watchdog |

---
## 18. SECURITY ERRORS

| Security Area | Risk/Error | Evidence | Severity | Fix Direction | Must Fix Before Cloud? |
|--------------|-----------|----------|----------|---------------|----------------------|
| open_app — No allowlist gate | Any voice command resolving to open_app spawns a process with no target validation — LLM can be tricked into opening .exe, scripts, or UNC paths | utomation/skill.ts:63–83: no permissionManager call | CRITICAL | Validate target against hardcoded URL/app allowlist; call permissionManager.assessRisk() before spawn | YES |
| open_app — Shell metachar injection | cmd.exe /c start "" <target> with unsanitized target — &, |, ^, %, >, < in target string execute as shell commands | skill.ts:49: target passed directly | CRITICAL | Strip shell metacharacters from esolvedTarget before spawning | YES |
| WebSocket port 9000 — No auth | Any localhost process can connect, send {type:"client_ready", payload:{role:"stt"}}, and inject arbitrary STT commands | 
odeBridge.ts:119–132: warns but registers unknown roles | CRITICAL | Add HMAC token in client_ready payload; reject connections without valid token | YES |
| 
pm, pnpm, 
px in SAFE allowlist | 
pm run <any-script> passes permissionManager.isBlocked() with result alse | permissionManager.ts:37–40 | HIGH | Move to MEDIUM_RISK minimum | YES |
| pprovalGate — voice dead zone | HIGH_RISK commands triggered by voice silently auto-deny after 30s with zero voice notification | pprovalGate.ts:97–99: !process.stdin.isTTY → reject | HIGH | Speak notification before waiting; add voice-based approval channel | YES |
| enable_full_control_session — no approval gate | Deterministic command enables full OS control session from voice alone — no confirmation required | orchestrator.ts:280–282 | HIGH | Require verbal + console confirmation before enabling full control | YES |
| Neo4j default credentials | password='password' used if NEO4J_PASSWORD not in .env — if Neo4j is re-enabled without env vars, connects with default password | graphMemory.ts:21 | HIGH | Add to .env.example; fail fast if defaults detected when isConnected=true | YES |
| graphMemory.queryGraph() — raw Cypher | Method accepts a full raw Cypher string from callers — if ever called with user-controlled input, full Cypher injection | graphMemory.ts:229 | MEDIUM | Restrict to named parameterized templates | YES |
| No audit log for deterministic open_app | securityAuditLogger not called when open_app is routed deterministically — no trace of voice-triggered app launches | orchestrator.ts:241–295 | MEDIUM | Log all automation-class commands via securityAuditLogger regardless of route | YES |
| Duplicate safety check systems | commandSafety.ts AND permissionManager.ts exist as separate allowlist/blocklist systems — two sources of truth for what is safe | Stage 1 + Stage 2 confirmed | MEDIUM | Consolidate into permissionManager; delete commandSafety.ts | YES |
| open_app false-success pattern | spawn resolves { success: true } immediately — error events are ignored after resolution. Security gate cannot detect spawn failures | skill.ts:85–92 | HIGH | Race error event; if spawn fails within 200ms, return failure result | YES |
| No per-user identity or audit trail | All requests treated as single trusted user; no user ID in any log or audit entry | Architecture | CRITICAL | Implement user identity layer before any multi-user or cloud access | YES |
| No input rate limiting | Orchestrator accepts unlimited commands per second from voice — no throttle or debounce at the entry point | Architecture | HIGH | Add rate limiter: max 1 command per 2s for voice path | YES |
| No wss:// transport encryption | All WebSocket connections use ws:// — unencrypted on localhost only; any network misconfiguration exposes commands | .env.example:38 | HIGH | Upgrade to wss:// for any non-localhost deployment | YES |

---

## 19. CONFIG / ENVIRONMENT ERRORS

| Config/File | Error | Evidence | Severity | Fix Direction |
|------------|-------|----------|----------|---------------|
| GROQ_API_KEY — not validated at startup | JARVIS boots normally; fails deep inside first LLM call with cryptic network/auth error | No dotenv validation in jarvis.ts | HIGH | Add startup validation: if (!process.env.GROQ_API_KEY) throw new Error(...) |
| .env.example — missing Neo4j vars | NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD used in graphMemory.ts with insecure defaults but absent from .env.example | graphMemory.ts:19–21; .env.example | HIGH | Add Neo4j section to .env.example |
| .env.example — missing Redis vars | REDIS_HOST, REDIS_PORT, REDIS_PASSWORD used in edisCache.ts with defaults but not documented | edisCache.ts:21–23; .env.example | MEDIUM | Add Redis section with defaults 127.0.0.1:6379 |
| .env.example — missing VECTOR_API_URL | Vector service URL hardcoded as http://127.0.0.1:8000 in memoryManager.ts:166 — not configurable via env | memoryManager.ts:166 | MEDIUM | Add VECTOR_API_URL=http://127.0.0.1:8000 to .env.example |
| .env.example — JARVIS_FAST_MODEL mismatch | .env.example:13 sets JARVIS_FAST_MODEL=llama-3.3-70b-versatile; groqProvider.ts:60 defaults to "llama-3.1-8b-instant" if unset | groqProvider.ts:60; .env.example:13 | MEDIUM | Align groqProvider default with .env.example; validate model name at startup |
| Hardcoded ports — no conflict detection | BRIDGE_PORT=9000 and HEALTH_PORT=9001 bound without checking if already in use; a second JARVIS process or other service causes silent failures | 
odeBridge.ts:85–88: no port-in-use probe | MEDIUM | Add 
et.createServer().listen(port) probe at startup; fail fast with clear error |
| WHISPER_MODEL env var ignored | .env.example has no WHISPER_MODEL var; stt.py:38 hardcodes "tiny" — user cannot configure model size without editing Python source | stt.py:38: WhisperModel("tiny", ...) | MEDIUM | Read WHISPER_MODEL env var in stt.py; default to 	iny |
| Redis — no connectTimeout | ioredis connection has no explicit timeout — startup can wait up to 6s for WSL Redis with no user feedback | edisCache.ts:35–50 | MEDIUM | Add connectTimeout: 1000 to ioredis config |
| No WSL documentation for Redis | Redis is assumed to run in WSL at 127.0.0.1:6379 — no documentation in .env.example or README | edisCache.ts:22: default host | LOW | Add comment in .env.example explaining WSL Redis requirement |
| untimeDashboard.ts — label TTS (Kokoro) | Dashboard shows "TTS (Kokoro)" but TTS uses edge-tts + pygame, not Kokoro | untimeDashboard.ts:117 | LOW | Update label to TTS (edge-tts) |
| System prompt size — no startup validation | llmConfig.systemPrompt is trimmed at call time to 1200 tokens but not validated at startup — large prompt consumes significant LLM budget | orchestrator.ts:455–456 | MEDIUM | Validate prompt length at startup; warn if > 800 tokens |

---

## 20. CLOUD READINESS ERRORS

| Cloud Area | Error | Evidence | Severity | Fix Direction |
|-----------|-------|----------|----------|---------------|
| **No user authentication** | No JWT, no session token, no identity layer — all requests treated as single trusted user | Architecture | CRITICAL | Implement token-based auth before any remote access |
| **No authorization / RBAC** | No per-user permission levels — all callers have identical access including PC control tools | Architecture | CRITICAL | Implement role-based access control before cloud |
| **Global singleton state machine** | gentStateMachine is a single global instance — multiple concurrent users would corrupt each other's state | core/agentStateMachine.ts | CRITICAL | Per-session state machine instances required |
| **LowDB single JSON file** | LowDB writes to one file — concurrent users cause JSON corruption | memory/memoryManager.ts, core/goalManager.ts | CRITICAL | Replace with SQLite or PostgreSQL for multi-user |
| **PC control tools on host OS** | open_app, file write, process kill, enable_full_control_session operate on the physical Windows machine | skills/automation/, control/pcControlKernel.ts | CRITICAL | PC control must be disabled or require additional hardware auth for remote users |
| **WebSocket bridge — no auth, no TLS** | Port 9000 ws:// has no auth token and no encryption — any network-reachable client can connect | 
odeBridge.ts:85; ws:// in .env.example | CRITICAL | Add HMAC handshake; upgrade to wss:// |
| **pprovalGate console-only** | eadline on process.stdin is meaningless in a server environment | pprovalGate.ts:97–99 | HIGH | Replace with async HTTP approval endpoint |
| **All service URLs hardcoded to 127.0.0.1** | Vector API, Redis, Neo4j, NodeBridge all hardcoded to localhost — cannot be reconfigured for distributed deployment | memoryManager.ts:166, edisCache.ts:22, graphMemory.ts:19 | HIGH | Move all service URLs to .env with documented defaults |
| **No REST API boundary** | JARVIS has no HTTP/REST API — only the raw WebSocket at port 9000 for internal voice clients | Architecture | HIGH | Design API gateway before cloud deployment |
| **No request rate limiting** | No throttling at any entry point — a remote attacker could flood the orchestrator | Architecture | HIGH | Implement per-IP or per-session rate limiting |
| **Secrets in flat .env file** | GROQ_API_KEY in a .env file — exposed via process inspection on a server | Architecture | HIGH | Use secrets manager (AWS Secrets Manager, Azure Key Vault, or similar) |
| **Single global memory (LowDB)** | All memory (facts, STM, goals) shared globally — no per-user isolation | memory/ folder | CRITICAL | Namespace all memory stores by user/session ID |
| **No horizontal scaling** | Single Node.js process handles all orchestration — no worker pool, no queue | Architecture | HIGH | Architecture redesign required for horizontal scale |
| **Python subprocesses not containerized** | wakeWords.py, stt.py, 	ts.py, ectorMemory.py run as raw OS processes — not container-safe | self_healing/selfHealingManager.ts | HIGH | Containerize Python services; communicate via well-defined API |

---
## 21. MAIN PRIORITY ERROR TABLE

| Priority | Area | Error | Severity | Evidence | Fix Direction | Should Fix Now? |
|----------|------|-------|----------|----------|---------------|-----------------|
| P1 | Voice/TTS | edge-tts communicate.save() has no timeout — TTS can hang forever | CRITICAL | 	ts.py:121 | syncio.wait_for(..., timeout=10.0) | **YES** |
| P2 | Voice/State | SPEAKING state has no watchdog — stuck forever if speaking_end never fires | CRITICAL | orchestrator.ts:200 | Add 30s SPEAKING watchdog timer | **YES** |
| P3 | Memory | ememberFact() arg order bug — importance/source swapped silently corrupting LTM | CRITICAL | orchestrator.ts:385, memoryManager.ts:360 | Fix caller: ememberFact(msg, 'agent_failure', 7) | **YES** |
| P4 | Security | open_app has no security gate — any target is spawned | CRITICAL | utomation/skill.ts:63 | Validate target against allowlist before spawn | **YES** |
| P5 | Security | cmd.exe target unsanitized — shell metachar injection | CRITICAL | skill.ts:49 | Strip &, |, ^, %, >, < from target | **YES** |
| P6 | Config | GROQ_API_KEY not validated at startup | HIGH | jarvis.ts — no env check | Add startup env validation with clear error message | **YES** |
| P7 | Voice | Empty STT result forwarded to orchestrator — hits LLM planner with empty string | HIGH | stt.py:351, 
odeBridge.ts:243 | Filter empty stt_result in NodeBridge | **YES** |
| P8 | Performance | Vector supervisor sleeps 15s flat on every cold start | HIGH | ectorMemorySupervisor.ts:197 | Replace flat sleep with 500ms poll loop | **YES** |
| P9 | Security | WebSocket port 9000 has no authentication | HIGH | 
odeBridge.ts:85 | Add HMAC token on client_ready | **YES** |
| P10 | Reliability | oice/reflectionEngine.py missing but watched by 3 modules | HIGH | Stage 1 confirmed | Remove from pipelineRegistry + fsWatcher | **YES** |
| P11 | Security | 
pm, pnpm, 
px in SAFE_READ_ONLY allowlist | HIGH | permissionManager.ts:37 | Move to MEDIUM_RISK | **YES** |
| P12 | Reliability | pprovalGate console-only — voice HIGH_RISK silently auto-denied | HIGH | pprovalGate.ts:97 | Add voice notification before waiting | **YES** |
| P13 | Performance | uildContext() runs uncached 3-I/O-call chain per LLM request | HIGH | unifiedContextBuilder.ts:24 | Add 10s session-level cache | Stage 2 |
| P14 | State | No PLANNING watchdog — stuck forever if Groq hangs | HIGH | orchestrator.ts:556 | Add 30s PLANNING watchdog | Stage 2 |
| P15 | Memory | GoalManager creates unresolved goals for deterministic commands | HIGH | orchestrator.ts:155–297 | Skip or resolve goal for deterministic routes | Stage 2 |
| P16 | Performance | Second LLM synthesis call fires after every non-simple tool | HIGH | orchestrator.ts:762 | Expand simpleTools bypass list | Stage 2 |
| P17 | Voice | Echo filter duplication — runs independently in Python + TypeScript | MEDIUM | stt.py:148, jarvis.ts:111 | Remove Python copy; do all filtering in TypeScript | Stage 2 |
| P18 | Performance | Vector index rebuild at startup — no limit, no concurrency cap | HIGH | memoryManager.ts:130 | Cap at 10 facts; max 3 concurrent | Stage 2 |
| P19 | Security | enable_full_control_session deterministic command has no approval | HIGH | orchestrator.ts:280–282 | Require voice + console confirmation | Stage 2 |
| P20 | Cloud | No user authentication or per-user state isolation | CRITICAL | Architecture | Full auth layer before any remote deployment | Stage 5 |

---

## 22. PERFORMANCE PRIORITY ERROR TABLE

| Priority | Slow Area | File/Function | Why It Is Slow | Evidence | Expected Impact | Fix Direction | Should Fix Now? |
|----------|----------|--------------|----------------|----------|-----------------|---------------|-----------------|
| P1 | TTS HTTPS call | 	ts.py:121 | No timeout on edge-tts Microsoft HTTPS — indefinite hang | No syncio.wait_for | Eliminates hang risk | syncio.wait_for(..., timeout=10.0) | **YES** |
| P2 | Vector supervisor cold start | ectorMemorySupervisor.ts:197 | 15s flat sleep before first health check | STARTUP_WAIT_MS = 15_000 | Save 12–15s on startup | 500ms poll loop | **YES** |
| P3 | Context building per request | unifiedContextBuilder.ts:24 | 3 async I/O calls per LLM request, no cache | Redis + vector + Neo4j | Save 1–3s per voice command | 10s session cache | Stage 2 |
| P4 | Fact write dedup | memoryManager.ts:364 | searchVector() blocks every ememberFact() — up to 2.1s | Lines 364–410 | Save 2s per fact write | Async background dedup | Stage 2 |
| P5 | Synthesis LLM call | orchestrator.ts:762 | Second LLM call after every non-simple tool execution | handleSuccess() | Save 500ms–3s per command | Expand simpleTools bypass | Stage 2 |
| P6 | Vector startup rebuild | memoryManager.ts:130 | All facts re-embedded on startup, no cap | Lines 130–142 | Prevent 100s CPU spike | Cap at 10; 3 concurrent | Stage 2 |
| P7 | Groq retry sleeps | groqProvider.ts:99,164 | 1s sleep between each of 3 retry attempts | Lines 99, 164 | Save up to 3s on network failures | Reduce to 500ms; circuit break | Stage 3 |
| P8 | STT disk I/O | stt.py:344,361 | .wav write + read per voice command | Lines 344, 361 | Save 50–200ms per command | In-memory bytes if Whisper supports it | Stage 3 |
| P9 | Microphone re-init | stt.py:237 | sr.Microphone() re-opened per recording (200–500ms overhead) | Line 237 | Save 200–500ms per command | Cache mic handle | Stage 3 |
| P10 | GoalManager writes per request | goalManager.ts:130,197 | 2 LowDB flushes per request (create + write) | persist() at lines 130, 197 | Save 2 disk writes per command | Skip for deterministic; batch writes | Stage 2 |
| P11 | Redis startup retry | edisCache.ts:40–44 | Up to 6s on slow WSL Redis | etryStrategy | Save up to 5s startup time | Add connectTimeout: 1000 | Stage 2 |
| P12 | LLM repair loop | orchestrator.ts:902–916 | Up to 4 full round-trips on failures | epairCycles <= 3 | Cap worst-case latency on errors | Max 2 repair cycles for voice | Stage 3 |

---

## 23. SECURITY PRIORITY ERROR TABLE

| Priority | Security Area | Risk | Severity | Evidence | Fix Direction | Should Fix Before Cloud? |
|----------|--------------|------|----------|----------|---------------|--------------------------|
| P1 | open_app no allowlist | Arbitrary process launch from voice/LLM input | CRITICAL | skill.ts:63 | Target allowlist before spawn | YES |
| P2 | Shell metachar injection | cmd.exe executes injected characters from target | CRITICAL | skill.ts:49 | Sanitize target string | YES |
| P3 | WebSocket no auth | Any localhost process injects voice commands | CRITICAL | 
odeBridge.ts:85 | HMAC token on client_ready | YES |
| P4 | 
pm/
px in SAFE allowlist | 
pm run evil-script passes safety check | HIGH | permissionManager.ts:37 | Move to MEDIUM_RISK | YES |
| P5 | pprovalGate voice-dead | HIGH_RISK commands silently denied with no voice feedback | HIGH | pprovalGate.ts:97 | Voice notification + shorter timeout | YES |
| P6 | enable_full_control_session no approval | Full OS control activated by voice command alone | HIGH | orchestrator.ts:280 | Require confirmation | YES |
| P7 | Neo4j default password | "password" used if env var not set | HIGH | graphMemory.ts:21 | Add to .env.example; fail fast | YES |
| P8 | No audit log for deterministic open_app | Voice-triggered launches leave no trace | MEDIUM | orchestrator.ts:241–295 | Call securityAuditLogger on all automation routes | YES |
| P9 | Cypher injection surface | queryGraph() accepts raw Cypher strings | MEDIUM | graphMemory.ts:229 | Named parameterized templates only | YES |
| P10 | Duplicate safety systems | commandSafety.ts + permissionManager.ts are separate systems | MEDIUM | Stage 1 confirmed | Consolidate; delete commandSafety.ts | YES |
| P11 | No user identity / audit trail | No user ID in any log — cannot attribute actions | CRITICAL | Architecture | User identity layer | YES (Cloud) |
| P12 | No rate limiting | Unlimited voice commands per second | HIGH | Architecture | 1 command per 2s rate limiter | YES (Cloud) |
| P13 | No wss:// encryption | ws:// on localhost; misconfigured network = exposed | HIGH | .env.example:38 | wss:// for non-localhost | YES (Cloud) |
| P14 | Secrets in .env file | GROQ_API_KEY exposed via process inspection on server | HIGH | Architecture | Use secrets manager for cloud | YES (Cloud) |

---

## 24. 30-DAY ERROR FIX ROADMAP

> **Important:** This is a prioritized fix ORDER only. Do not implement anything until ready.

### Phase 1 — Critical Stability (Days 1–5)
These are blocking bugs that cause incorrect behavior RIGHT NOW.

1. **	ts.py:121** — Add syncio.wait_for(communicate.save(tmp_path), timeout=10.0) — prevents TTS pipeline hang
2. **orchestrator.ts:200** — Add 30-second SPEAKING state watchdog timer — prevents permanent stuck state
3. **orchestrator.ts:385–388** — Fix ememberFact() argument order — corrects LTM corruption
4. **NodeBridge stt_result handler** — Filter empty/whitespace-only text before routing to orchestrator
5. **jarvis.ts startup** — Add GROQ_API_KEY validation with clear error before attempting LLM calls
6. **pipelineRegistry + sWatcher** — Remove eflectionEngine.py references — stops watchdog errors
7. **orchestrator.ts** — Add 30-second PLANNING state watchdog timer

---

### Phase 2 — YouTube / Live Voice Fix (Days 6–10)
These fix the intermittent "open YouTube" failure.

1. **data/logs/stt_debug.log** — FIRST: Read the STT debug log during a failed "open YouTube" attempt — identify whether ECHO_FILTER_* events are present
2. **Echo filter** — If echo filter is the cause: verify command-keyword threshold (0.75) in jarvis.ts:162 is working; add youtube to phrase protection list
3. **SPEAKING state queue** — Ensure oiceInputQueue drains immediately on speaking:end with no race
4. **stt.py:normalize_stt()** — Add "you tube" → "youtube" normalization for split-word transcription
5. **skill.ts** — Add 500ms post-spawn verification so JARVIS knows if YouTube actually launched
6. **Filler words** — Add 
ow, ight now, quickly, immediately to deterministic router filler word strip list

---

### Phase 3 — Performance Fixes (Days 11–18)
For better daily voice experience on 8GB RAM.

1. **unifiedContextBuilder.ts** — Add 10s session-level cache for uildContext() result
2. **ectorMemorySupervisor.ts:197** — Replace 15s sleep with 500ms health-poll loop
3. **memoryManager.ts:364** — Move searchVector() dedup in ememberFact() to async background check
4. **orchestrator.ts:762** — Expand simpleTools bypass list to include all automation-class tools
5. **memoryManager.ts:130** — Cap vector startup rebuild: max 10 facts, max 3 concurrent embeds
6. **goalManager.ts** — Skip createGoal() for deterministic commands; add completeGoal() after deterministic success
7. **groqProvider.ts:99** — Reduce 500-error sleep to 500ms; add circuit break after 2 consecutive 500s
8. **edisCache.ts:40** — Add connectTimeout: 1000 to ioredis config

---

### Phase 4 — Security Fixes (Days 19–22)

1. **utomation/skill.ts** — Add target allowlist validation before spawn() call
2. **utomation/skill.ts:49** — Sanitize esolvedTarget: strip &, |, ^, %, >, <
3. **
odeBridge.ts** — Add HMAC shared-secret token validation on client_ready handshake
4. **permissionManager.ts:37** — Move 
pm, pnpm, 
px to MEDIUM_RISK
5. **pprovalGate.ts** — Add voice notification (orchestrator.speak(...)) before waiting for console approval
6. **orchestrator.ts:280** — Add confirmation gate for enable_full_control_session
7. **graphMemory.ts:21** — Add Neo4j vars to .env.example; add fail-fast check
8. **orchestrator.ts deterministic path** — Add securityAuditLogger call for all automation commands

---

### Phase 5 — Cloud Readiness Errors (Days 23–27)

> Only begin this phase when Phase 1–4 are complete and daily local use is stable.

1. Design and implement user identity / session token system (JWT or similar)
2. Implement per-session state machine instances (remove global singleton)
3. Replace LowDB with SQLite or PostgreSQL for multi-user memory
4. Add REST/WebSocket API boundary with auth middleware
5. Upgrade WebSocket to wss:// with TLS certificates
6. Implement per-user memory namespacing
7. Replace pprovalGate with async HTTP approval endpoint
8. Add per-IP rate limiting
9. Move GROQ_API_KEY to secrets manager

---

### Phase 6 — Duplicate / Stale Cleanup (Days 28–30)

1. Delete: core/brain.ts
2. Delete: gents/queryAgent.ts, gents/plannerAgent.ts, gents/reflectionAgent.ts, gents/coordinatorAgent.ts
3. Delete: core/toolRegistry.ts (v1)
4. Delete: core/skillExecutor.ts
5. Delete: 	ools/dispatcher.ts, 	ools/claudeCodeTool.ts
6. Delete: learning/selfAudit.ts (or implement)
7. Delete: ackend/ folder, scheduler/ folder
8. Delete: all .txt structural dump files at project root (~22MB)
9. Move: environment/systemInfo.json → data/systemInfo.json
10. Fix: untimeDashboard.ts:117 label to TTS (edge-tts)

---

## 25. FINAL ERROR VERDICT

### What is broken RIGHT NOW?

| Issue | File | Impact |
|-------|------|--------|
| TTS can hang forever (no timeout) | 	ts.py:121 | Voice pipeline freezes; must restart JARVIS |
| SPEAKING state gets stuck | orchestrator.ts:200 | JARVIS goes deaf after TTS crash |
| LTM memory corrupted on every failure | orchestrator.ts:385 | Long-term memory scores are wrong |
| 
pm test always exits 1 | package.json | CI is broken by design |
| eflectionEngine.py missing | Watchdog files | Silent errors on every session startup |

---

### What is partially working but risky?

| Component | Risk |
|-----------|------|
| open_app (works, no security gate) | LLM can be tricked into launching anything |
| pprovalGate (works for CLI, not voice) | HIGH_RISK voice commands silently auto-denied |
| uildContext() (works, no cache) | 1–3s added to every LLM request |
| Echo filter (works, but runs twice) | Commands may be over-filtered or mis-filtered |
| groqProvider (works, but no AbortSignal) | Barge-in interrupt does not cancel in-flight LLM call |
| GoalManager (works, leaks in_progress goals) | data/goals.json accumulates stale entries |

---

### What is fake/stub?

| Component | Status |
|-----------|--------|
| gents/queryAgent.ts, plannerAgent.ts, eflectionAgent.ts, coordinatorAgent.ts | All stubs — return empty/false/throw |
| memory/graphMemory.ts | Driver commented out — all methods return [] |
| oice/reflectionEngine.py | Does not exist |
| learning/selfAudit.ts | Returns hardcoded score 0.8 always |
| 	ools/claudeCodeTool.ts | Returns "not configured" always |

---

### What is duplicated?

| Duplicate | Files |
|-----------|-------|
| Tool registries | 	oolRegistry.ts (v1, dead) + 	oolRegistryV2.ts (live) |
| Echo filter logic | stt.py:148 + jarvis.ts:111 |
| Safety allowlist systems | commandSafety.ts + permissionManager.ts |
| Tool execution authority | ctionExecutor.ts (unused) + 	oolRegistryV2.execute() (live) |
| Legacy orchestrator | rain.ts (dead) + orchestrator.ts (live) |

---

### What is unsafe RIGHT NOW?

| Risk | Evidence |
|------|----------|
| open_app spawns any target — no allowlist | skill.ts:63 |
| Shell metachar injection via target string | skill.ts:49 |
| WebSocket port 9000 — no auth token | 
odeBridge.ts:85 |
| 
pm/
px in SAFE allowlist | permissionManager.ts:37 |
| enable_full_control_session — no confirmation | orchestrator.ts:280 |
| HIGH_RISK voice commands silently auto-denied | pprovalGate.ts:97 |

---

### What is slow?

In order of user-perceived impact:
1. TTS edge-tts HTTPS call — no timeout (worst: indefinite)
2. Vector supervisor 15s sleep on cold start
3. uildContext() — 1–3s per LLM request, no cache
4. Groq retry chain — up to 3s on network failures
5. Second LLM synthesis call per tool execution
6. STT microphone re-init + disk I/O per voice command

---

### What should be fixed FIRST?

In strict order:
1. TTS timeout (	ts.py:121)
2. SPEAKING state watchdog (orchestrator.ts:200)
3. ememberFact() argument order (orchestrator.ts:385)
4. Empty STT result filter (NodeBridge handler)
5. GROQ_API_KEY startup validation (jarvis.ts)
6. Remove eflectionEngine.py from watchdog references

---

### What should NOT be touched yet?

- Cloud architecture redesign (user auth, multi-user state, database migration) — local stability must come first
- Replacing Python voice services with containers — out of scope until Phase 5
- eflectionEngine.ts internals — it is working; do not modify until performance profiling confirms it is a bottleneck
- graphMemory.ts — leave Neo4j disabled until local use is fully stable

---

### What should be optimized FIRST for the 8 GB RAM PC?

| Priority | Change | Expected Gain |
|----------|--------|---------------|
| 1 | TTS timeout → prevents hangs | Stability |
| 2 | Vector supervisor 15s → 500ms poll | -12s startup |
| 3 | uildContext() 10s cache | -1–3s per command |
| 4 | Cap vector startup rebuild to 10 facts | Prevent 100s CPU spike |
| 5 | Skip GoalManager for deterministic commands | -2 disk writes per fast-path command |
| 6 | Add Redis connectTimeout: 1000 | -5s startup on WSL fail |
| 7 | Delete brain.ts + agent stubs | Free RAM |
| 8 | Delete ~22MB .txt dump files | Free disk space |

---

### Is the project ready for daily local use?

**NO — not yet.** Three critical bugs block reliable voice operation:
1. TTS can permanently hang (no timeout)
2. SPEAKING state can permanently stick (no watchdog)
3. Memory corruption on every failure event (arg order bug)

Fix these 3 first. After Phase 1 fixes are complete, the project becomes suitable for **supervised daily local use** with the understanding that:
- YouTube command failures are intermittent (Phase 2 addresses these)
- Performance is suboptimal but functional on 8GB RAM
- Security is local-only; never expose to network without Phase 4 fixes

---

### Is the project ready for cloud or multi-user access?

**ABSOLUTELY NOT.** Blockers are fundamental architectural constraints:
- No authentication, no authorization, no user identity
- Global singleton state machine cannot serve multiple users
- LowDB JSON cannot handle concurrent writes
- PC control tools operate on the host machine with no remote safety gates
- WebSocket has no encryption or authentication

Minimum viable cloud readiness requires Phases 1–5 (estimated 27+ days of focused engineering).

---

### The Single Most Important Next Step

**Fix oice/tts.py line 121:**

`python
# BEFORE (can hang forever):
await communicate.save(tmp_path)

# AFTER (safe):
await asyncio.wait_for(communicate.save(tmp_path), timeout=10.0)
`

This one-line fix prevents the most severe user-visible failure: JARVIS freezing completely mid-conversation with no recovery except manual restart.

---

*Report generated: 2026-07-04 | Audit method: Read-only file inspection | No files were modified during this audit.*
