# CONTEXT_LOADING_BY_BUG_TYPE.md — What to Read for Each Bug Type

> Per-bug-type load lists, moved here from `CONTEXT_LOADING_RULES.md`
> (which keeps the general rules and the `_config/` safety rules: read it
> first). Paths checked against the repository on 2026-10-23; the old
> `agents/`, `planner/` and `reasoning/` folders are now in `_legacy/`.
> For a fuller map of each area, see the `ARCH_*.md` topic file named in
> `ARCHITECTURE_MAP.md`.

---

## Voice Pipeline Bugs

**Symptom examples:**
- "Jarvis open YouTube" not working
- Wake word not detected
- STT result not forwarded
- TTS not speaking
- NodeBridge not receiving messages

**Load these files:**
```
voice/wakeWords.py
bridge/nodeBridge.ts
core/orchestrator.ts
core/deterministicRoutes.ts
core/agentStateMachine.ts
core/toolRegistryV2.ts
skills/automation/skill.ts
jarvis.ts (stt_result handler section)
tests/voiceRouteMockTest.ts
tests/openAppSmokeTest.ts
tests/deterministicCommandRouteTest.ts
```

**Do NOT load:**
```
memory/* (unless memory is a suspected cause)
reasoning/*
planner/*
agents/*
monitoring/*
```

---

## Memory Bugs

**Symptom examples:**
- Context not being retrieved
- Redis connection failing
- Vector search errors
- Memory decay issues
- Facts not being saved

**Load these files:**
```
memory/memoryManager.ts
memory/redisCache.ts
memory/unifiedContextBuilder.ts
memory/vectorMemorySupervisor.ts
memory/vectorMemory.py
memory/agentMemory.ts
config/llmconfig.ts (for any memory-related config)
```

**Do NOT load:**
```
voice/*
bridge/* (unless NodeBridge memory sync is suspected)
skills/*
reasoning/*
```

---

## Tool / Skill Execution Bugs

**Symptom examples:**
- open_app not executing
- Tool not found in registry
- Skill not loading
- Tool result wrong or malformed

**Load these files:**
```
core/toolRegistryV2.ts
core/skillLoader.ts
core/tools/index.ts
skills/automation/skill.ts  (for open_app bugs)
skills/<affected-skill>/skill.ts
core/commandSafety.ts
security/approvalGate.ts
tests/deterministicCommandRouteTest.ts
tests/openAppSmokeTest.ts
```

**Do NOT load:**
```
memory/* (unless tool uses memory)
voice/* (unless testing voice → tool path)
```

---

## State Machine Bugs

**Symptom examples:**
- ILLEGAL TRANSITION REJECTED in logs
- Agent stuck in wrong state
- Interrupt not working
- Barge-in broken

**Load these files:**
```
core/agentStateMachine.ts
core/orchestrator.ts (transition calls)
core/conversationBus.ts
jarvis.ts (stt_result handler + speech_detected handler)
tests/interruptGatingTest.ts
```

---

## Self-Healing Bugs

**Symptom examples:**
- Python service not restarting after crash
- Port conflict not recovered
- Dashboard showing wrong status
- Health check always failing

**Load these files:**
```
self_healing/selfHealingManager.ts
self_healing/pipelineRegistry.ts
self_healing/pipelineWatchdog.ts
self_healing/failureDetector.ts
self_healing/repairExecutor.ts
monitoring/runtimeDashboard.ts
bridge/nodeBridge.ts (for port conflict behavior)
```

Runtime issues and repair (issue store, repair run, code repair):
`ARCH_SELF_HEALING.md` and `SELF_HEALING_OWNERSHIP.md`.

---

## TypeScript Compile Bugs

**Symptom examples:**
- `npx tsc --noEmit` produces errors
- Type errors in specific files

**Load only:**
```
The file(s) mentioned in the error output
tsconfig.json
Directly related type definition files
```

Do NOT load unrelated runtime files.

---

---

## Performance Bugs

**Symptom examples:**
- Response taking over 100ms for deterministic commands
- Groq 429 errors affecting local commands
- Vector memory blocking startup

**Load these files:**
```
core/deterministicRoutes.ts (matchDeterministicCommand)
core/orchestrator.ts (planPhase)
memory/vectorMemorySupervisor.ts
memory/memoryManager.ts (circuit breaker)
bridge/modelRouter.ts
bridge/groqProvider.ts
tests/latencySmokeTest.ts
```

---
