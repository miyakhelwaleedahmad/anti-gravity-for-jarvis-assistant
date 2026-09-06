# CONTEXT_LOADING_RULES.md — What to Read for Each Bug Type

> These rules prevent AI agents from loading irrelevant files,
> which wastes context budget and increases the risk of accidental changes.

---

## General Rule

> Load ONLY the files necessary to understand and fix the specific bug.
> Do not load all files "just in case."
> Do not load node_modules, .venv, logs, generated reports, or temp files unless explicitly needed.

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

## Documentation / Workflow Tasks

**Task examples:**
- Creating workflow documents
- Writing audit reports
- Updating JARVIS_CURRENT_STATUS.md

**Load only:**
```
ai_workflows/_config/*.md (as needed)
ai_workflows/CONTEXT.md
```

**Do NOT load or modify:**
```
Any runtime file
Any test file
.env
memory/*
voice/*
bridge/*
```

---

## Performance Bugs

**Symptom examples:**
- Response taking over 100ms for deterministic commands
- Groq 429 errors affecting local commands
- Vector memory blocking startup

**Load these files:**
```
core/orchestrator.ts (matchDeterministicCommand + planPhase)
memory/vectorMemorySupervisor.ts
memory/memoryManager.ts (circuit breaker)
bridge/modelRouter.ts
bridge/groqProvider.ts
tests/latencySmokeTest.ts
```

---

## Files Never to Load Unnecessarily

```
node_modules/          ← Never
.venv/                 ← Never
logs/*.jsonl           ← Only if analyzing specific log events
memory/jarvis_memory.json  ← Only if debugging stored facts
jarvis_structure.txt   ← Never (11MB, useless for code bugs)
jarvis_structure_utf8.txt  ← Never
project_tree.txt       ← Never
analysis.json          ← Only if doing a module audit
temp_stt_*.wav         ← Never
```
