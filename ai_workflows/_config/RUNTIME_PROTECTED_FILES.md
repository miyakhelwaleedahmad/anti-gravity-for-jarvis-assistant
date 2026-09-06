# RUNTIME_PROTECTED_FILES.md — Files That Must Not Be Changed Without Approval

> Any change to a file listed here requires:
> 1. Written diagnosis (stages/02_diagnosis/)
> 2. Written patch plan (stages/03_patch_plan/)
> 3. Explicit human approval
> 4. Post-implementation verification (stages/05_verification/)

---

## Critical Runtime Entry Points

```
jarvis.ts                          ← Main process entry point
index.ts                           ← Secondary entry / re-export
```

**Why protected:** These files wire the entire voice pipeline, CLI loop,
shutdown hooks, and all startup sequencing. A single wrong change here
can break all voice services silently.

---

## Critical Bridge Files

```
bridge/nodeBridge.ts               ← WebSocket server, READY client registry, TTS/STT queue
bridge/modelRouter.ts              ← LLM routing (Groq)
bridge/groqProvider.ts             ← Groq API client
```

**Why protected:** NodeBridge is a singleton. Duplicate starts cause EADDRINUSE.
Model router changes affect all LLM responses.

---

## Critical Orchestrator & State Machine

```
core/orchestrator.ts               ← Central planning kernel + deterministic router
core/agentStateMachine.ts          ← State transitions (IDLE→PLANNING→EXECUTING…)
core/toolRegistryV2.ts             ← Active tool registry (replaces toolRegistry.ts)
core/skillLoader.ts                ← Loads skills from skills/ directory
core/taskGraphEngine.ts            ← DAG execution engine
core/conversationBus.ts            ← Speaking state + idle/busy events
```

**Why protected:** The deterministic router in orchestrator.ts is the only thing that
makes `open YouTube` sub-100ms. State machine changes cause illegal transition errors.

---

## Critical Voice Skill

```
skills/automation/skill.ts         ← open_app tool (resolves youtube/notepad/cmd → shell)
```

**Why protected:** This is the exact file that resolves `"youtube"` to
`https://www.youtube.com/` and executes the Windows shell command. Any change
here directly affects the YouTube open_app route.

---

## Critical Voice Services (Python)

```
voice/wakeWords.py                 ← Wake word detection + inline command extraction
voice/wakeWord.py                  ← Stub/legacy (do not delete — needs human review)
voice/stt.py                       ← Speech-to-text client
voice/tts.py                       ← Text-to-speech client
```

**Why protected:** Python voice services are child processes managed by selfHealingManager.
Changes here affect microphone input, wake word triggering, and TTS output.

---

## Protected Memory Files

```
memory/memoryManager.ts            ← Primary memory manager + circuit breaker
memory/redisCache.ts               ← Redis cache layer
memory/vectorMemorySupervisor.ts   ← Manages vectorMemory.py lifecycle
memory/vectorMemory.py             ← Vector embedding FastAPI server
memory/unifiedContextBuilder.ts    ← Active context builder (replaces contextBuilder.ts)
memory/graphMemory.ts              ← Neo4j graph memory
```

**Why protected:** Memory system has circuit breakers and fallbacks.
Changes here can break LLM context injection or Redis cache behavior.

---

## Protected Security Files

```
security/approvalGate.ts           ← Human approval gating for dangerous actions
security/commandValidator.ts       ← Command validation before execution
security/permissionManager.ts      ← Permission check logic
security/sandbox.ts                ← Sandbox environment for risky tool execution
core/commandSafety.ts              ← Safety checks for open_app and shell commands
```

**Why protected:** Security regressions can allow dangerous shell commands.
The `"launch cmd /c del *"` false-positive fix must remain in effect.

---

## Protected Tests

```
tests/nodeBridgeSingletonTest.ts   ← NodeBridge singleton + READY registry
tests/voiceRouteMockTest.ts        ← Full voice mock route (bridge → orchestrator → open_app)
tests/interruptGatingTest.ts       ← Barge-in gating (speech_detected during PLANNING must be ignored)
tests/openAppSmokeTest.ts          ← open_app tool execution (youtube/notepad/cmd)
tests/latencySmokeTest.ts          ← Deterministic route latency (<100ms)
tests/deterministicCommandRouteTest.ts ← Router matching + security boundary (39 assertions)
```

**Why protected:** These tests encode behavioral contracts.
If a test is changed to make it pass artificially, the contract is broken.

---

## Change Approval Checklist

Before changing any file above:

- [ ] Is this change in response to a diagnosed bug? (Link diagnosis document)
- [ ] Is there a written patch plan? (Link patch plan document)
- [ ] Has the human explicitly approved this change?
- [ ] Are all affected tests identified?
- [ ] Will all existing tests still pass after the change?
- [ ] Is live voice verification required? (Yes for any voice pipeline change)
