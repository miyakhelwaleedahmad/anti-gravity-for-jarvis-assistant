# RUNTIME_PROTECTED_FILES.md — Files That Must Not Be Changed Without Approval

> Any change to a file listed here requires:
> 1. Written diagnosis (stages/02_diagnosis/)
> 2. Written patch plan (stages/03_patch_plan/)
> 3. Explicit human approval
> 4. Post-implementation verification (stages/05_verification/)
>
> Paths checked against the repository on 2026-10-23 (`claude/jarvis-repair`).

---

## Critical Runtime Entry Points

```
jarvis.ts                          ← Main process entry point
```

(`index.ts` was moved to `_legacy/index.ts` in commit c39ca7b; it is no
longer an entry point.)

**Why protected:** This file wires the entire voice pipeline, CLI loop,
shutdown hooks, and all startup sequencing. A single wrong change here
can break all voice services silently.

---

## Critical Bridge Files

```
bridge/nodeBridge.ts               ← WebSocket server, READY client registry, TTS/STT queue
bridge/modelRouter.ts              ← LLM routing and failover (Gemini/Groq; Claude first when JARVIS_LLM_PROVIDER=anthropic)
bridge/groqProvider.ts             ← OpenAI-compatible client (Gemini or Groq)
bridge/anthropicProvider.ts        ← Claude client (official SDK)
```

**Why protected:** NodeBridge is a singleton. Duplicate starts cause EADDRINUSE.
Model router changes affect all LLM responses.

---

## Critical Orchestrator & State Machine

```
core/orchestrator.ts               ← Central planning kernel
core/deterministicRoutes.ts        ← Deterministic pre-router (moved out of orchestrator.ts)
core/agentStateMachine.ts          ← State transitions (IDLE→PLANNING→EXECUTING…)
core/toolRegistryV2.ts             ← Active tool registry (replaces toolRegistry.ts)
core/toolCatalog.ts                ← Tool metadata: kind, risk level 0–4 per action, reversibility
core/skillLoader.ts                ← Loads skills from skills/ directory
core/taskGraphEngine.ts            ← DAG execution engine
core/conversationBus.ts            ← Speaking state + idle/busy events
```

**Why protected:** The deterministic router (`core/deterministicRoutes.ts`) keeps
`open YouTube` off the LLM. State machine changes cause illegal transition errors.
Tool metadata sets every tool's risk level, which the approval gates rely on.

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
voice/stt.py                       ← Speech-to-text client
voice/tts.py                       ← Text-to-speech client
```

(`voice/wakeWord.py` was moved to `_legacy/voice/wakeWord.py` in commit fd72ce1.)

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
security/approvalRequest.ts        ← What an approval request shows, and how an answer is read
security/riskEngine.ts             ← Run / ask / refuse decision for each tool call
security/commandValidator.ts       ← Command validation before execution
security/permissionManager.ts      ← Permission check logic
core/toolExecutionSandbox.ts       ← Concurrency caps and budgets around risky tool calls
core/commandSafety.ts              ← Safety checks for open_app and shell commands
```

(`security/sandbox.ts` was moved to `_legacy/security/sandbox.ts` in commit fd72ce1.)

**Why protected:** Security regressions can allow dangerous shell commands or
actions without the owner's approval. The `"launch cmd /c del *"`
false-positive fix must remain in effect.

---

## Self-Healing and Code Repair

```
core/issueStore.ts                 ← Runtime failure record (data/repairs/issues.json, occurrences.jsonl)
core/repairRun.ts                  ← Bounded runtime repair attempts and their outcomes
core/codeRepair.ts                 ← Code-repair proposals; refuses approval not typed at the console
core/worktreeExecutor.ts           ← Runs a proposed repair in its own git worktree, never the checkout
```

**Why protected:** These decide what counts as broken, resolved or repaired,
and gate changes to JARVIS's own code. See `_config/SELF_HEALING_OWNERSHIP.md`.

---

## Specialist Agents

```
core/agents/*                      ← Agent manager, the seven specialist roles, permissions, spawn policy, A2A
```

**Why protected:** The roles (JARVIS and its seven specialists, listed in
`core/agents/specialists.ts`), their tool permissions and spawn limits keep
delegated work inside its bounds.

---

## Second Brain (Obsidian)

```
memory/secondBrain.ts              ← Categories, retrieval, verified lessons, error notes
memory/vault.ts                    ← Safe access to the owner's vault (path guard, owned notes)
core/obsidianMirror.ts             ← Issue notes mirrored from the issue store
```

**Why protected:** They write into the owner's own notes; a bug can overwrite
or misplace them.

---

## PC Control

```
control/pcControlKernel.ts         ← Single authority for local PC actions (permissions, audit log)
```

**Why protected:** Every Windows window, app, file and process action passes
through it, with its permission checks.

---

## Protected Tests

```
tests/nodeBridgeSingletonTest.ts   ← NodeBridge singleton + READY registry
tests/voiceRouteMockTest.ts        ← Full voice mock route (bridge → orchestrator → open_app)
tests/interruptGatingTest.ts       ← Barge-in gating (speech_detected during PLANNING must be ignored)
tests/openAppSmokeTest.ts          ← open_app resolution, dry-run (the runner checks "youtube")
tests/latencySmokeTest.ts          ← One request through the orchestrator ("hello" under the runner)
tests/deterministicCommandRouteTest.ts ← Router matching + security boundary
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
