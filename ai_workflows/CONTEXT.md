# CONTEXT.md — JARVIS Project Overview for AI Agents

> Load this file at the start of every session before reading any other file.

---

## What JARVIS Is

JARVIS is a local TypeScript + Python AI voice assistant running on Windows.
It uses a WebSocket bridge (NodeBridge) to connect Node.js orchestration logic
with Python voice services (STT, TTS, WakeWord, Vision).

It features:
- Wake word detection (voice/wakeWords.py)
- Speech-to-text (voice/stt.py)
- Text-to-speech (voice/tts.py)
- Central orchestration kernel (core/orchestrator.ts)
- Deterministic command routing (bypasses LLM for known safe commands)
- LLM planning via Groq (bridge/groqProvider.ts)
- Task graph execution engine (core/taskGraphEngine.ts)
- Agent state machine (core/agentStateMachine.ts)
- Memory: Redis cache + vector memory (sentence-transformers) + graph memory (Neo4j)
- Skills (skills/automation/, skills/coding/, skills/search/, skills/weather/)
- Self-healing system (self_healing/)
- Runtime health dashboard (monitoring/runtimeDashboard.ts)

---

## Current Known Status

⚠️ **The YouTube open_app voice route is currently under investigation.**

```
"Jarvis open YouTube for me" does not reliably open YouTube in the live voice runtime.
```

Smoke tests may pass. Live runtime behavior is NOT confirmed as stable.
Do not mark this issue resolved without live voice verification.

See `_config/YOUTUBE_OPENAPP_INVESTIGATION.md` for the full investigation checklist.
See `_config/JARVIS_CURRENT_STATUS.md` for the current system state.

---

## Known Issue

| Issue | Status |
|---|---|
| Live voice `open YouTube` route | ⚠️ Under investigation |
| TypeScript compilation | ✅ Last known: 0 errors |
| Smoke tests (mock) | ✅ Last known: passing |
| Live runtime verification | ❌ Not confirmed in current session |

---

## Main Architecture Folders

| Folder | Responsibility |
|---|---|
| `jarvis.ts` | Main runtime entry point |
| `bridge/nodeBridge.ts` | WebSocket server connecting Node.js ↔ Python |
| `core/orchestrator.ts` | Central planning/execution kernel |
| `core/agentStateMachine.ts` | State machine (IDLE→LISTENING→PLANNING→EXECUTING…) |
| `core/taskGraphEngine.ts` | DAG-based task execution |
| `core/toolRegistryV2.ts` | Active tool registry (replaces toolRegistry.ts) |
| `core/skillLoader.ts` | Loads skills from skills/ directory |
| `skills/automation/skill.ts` | open_app tool (browser/app launcher) |
| `voice/wakeWords.py` | Wake word detection + inline command extraction |
| `voice/stt.py` | Speech-to-text client |
| `voice/tts.py` | Text-to-speech client |
| `memory/memoryManager.ts` | Primary memory manager |
| `memory/redisCache.ts` | Redis cache layer |
| `memory/vectorMemory.py` | Vector embedding server (sentence-transformers) |
| `memory/vectorMemorySupervisor.ts` | Manages vectorMemory.py lifecycle |
| `self_healing/selfHealingManager.ts` | Launches/restarts Python services |
| `monitoring/runtimeDashboard.ts` | Health monitoring |

---

## Voice Route (Critical Path)

```
User speaks
  → voice/wakeWords.py detects wake word
  → extracts inline command OR triggers voice/stt.py listen
  → sends stt_result WebSocket message to NodeBridge (bridge/nodeBridge.ts)
  → NodeBridge forwards to orchestrator.process(text, 'voice')
  → core/orchestrator.ts checks matchDeterministicCommand(input)
  → if matched: executes tools/open_app directly (NO LLM)
  → skills/automation/skill.ts resolves target → windows shell command
  → YouTube/Notepad/etc opens
  → bridge/nodeBridge.ts sends TTS reply
  → voice/tts.py speaks response
```

---

## Tool Route

```
orchestrator.runAgentLoop()
  → matchDeterministicCommand() — fast path (no LLM)
  → OR planPhase() — LLM call via bridge/modelRouter.ts → bridge/groqProvider.ts
  → taskGraphEngine.execute()
  → toolRegistryV2.execute(toolName, args)
  → skill or built-in tool runs
  → result collected → synthesis → TTS
```

---

## Memory Route

```
orchestrator.process()
  → agentMemory.addConversationMessage()
  → unifiedContextBuilder.buildContext() → Redis cache → vector search → graph
  → memoryManager.getShortTerm() / searchFacts()
  → injected into LLM planning prompt
```

---

## Redis Role

- Caches context packets to reduce repeated vector search calls
- Falls back gracefully if Redis is unavailable
- Does NOT block the deterministic voice route
- Used in: memory/redisCache.ts, memory/cacheManager.ts, memory/unifiedContextBuilder.ts

---

## Vector Memory Role

- Sentence-transformer model (`all-MiniLM-L6-v2`) loaded at startup via FastAPI
- Serves semantic search for long-term facts
- Managed by memory/vectorMemorySupervisor.ts
- Non-fatal if unavailable — circuit breaker in memoryManager.ts
- Does NOT block the deterministic voice route

---

## Test Requirements

See `_config/TEST_MATRIX.md` for the full list. Minimum required before any patch:

```powershell
npx tsc --noEmit
npx tsx tests/nodeBridgeSingletonTest.ts
npx tsx tests/voiceRouteMockTest.ts
npx tsx tests/interruptGatingTest.ts
npx tsx tests/openAppSmokeTest.ts "youtube"
npx tsx tests/deterministicCommandRouteTest.ts
```

---

## ICM Stage Order

```
01_intake       → Collect symptoms, relevant files, no code edits
02_diagnosis    → Trace control flow, find root cause, no code edits
03_patch_plan   → Write exact diff plan, wait for human approval
04_implementation → Apply only approved changes, small diffs
05_verification → Run all tests, live verification if voice-related
06_final_report → Summarize everything
```

---

## Human Approval Points

Approval is required before:
1. Any edit to a protected runtime file
2. Advancing from `03_patch_plan` to `04_implementation`
3. Merging a patch to the main branch
4. Marking a live voice bug as resolved

---

## Protected Files

See `_config/RUNTIME_PROTECTED_FILES.md` for the full list.

Critical: `jarvis.ts`, `bridge/nodeBridge.ts`, `core/orchestrator.ts`,
`core/agentStateMachine.ts`, `voice/wakeWords.py`, `skills/automation/skill.ts`
