# ARCHITECTURE_MAP.md — JARVIS Folder and File Responsibilities

> This is a reference map only. Do not use this file to make architectural changes.
> Do not delete or rename files based on this map alone.

---

## Runtime Entry Points

| File | Role |
|---|---|
| `jarvis.ts` | Main process entry — wires voice loop, CLI, NodeBridge, orchestrator, self-healing |
| `index.ts` | Secondary entry / re-export barrel |

---

## Agents

| File | Role | Status |
|---|---|---|
| `agents/supervisorAgent.ts` | Supervisor coordination logic | Active (minimal) |
| `agents/codingAgent.ts` | Stub — `export {}` only | Stub / delete candidate |
| `agents/jarvisAgent.ts` | Stub — `export {}` only | Stub / delete candidate |
| `agents/systemAgent.ts` | Stub — `export {}` only | Stub / delete candidate |
| `agents/researchAgent.py` | Stub Python agent | Stub / delete candidate |

---

## App / Backend

| File | Role |
|---|---|
| `app/api/memory/route.ts` | Next.js API route for memory access |
| `backend/memory/redis_client.py` | Python Redis client |
| `backend/memory/test_redis.py` | Redis connection test |
| `backend/longTaskRunner.ts` | Long async task utility |
| `backend/scheduler.ts` | Task scheduler |
| `backend/selfCorrection.ts` | Self-correction loop |
| `backend/taskQueue.ts` | Task queue implementation |

---

## Bridge

| File | Role |
|---|---|
| `bridge/nodeBridge.ts` | ⭐ WebSocket server — READY client registry, TTS/STT queue flush, stt_result routing |
| `bridge/modelRouter.ts` | LLM router (Groq) |
| `bridge/groqProvider.ts` | Groq API provider |
| `bridge/llmTypes.ts` | LLM message type definitions |
| `bridge/messageSchema.json` | JSON schema for WebSocket messages |
| `bridge/pythonBridge.py` | Python-side bridge helper |

---

## Config

| File | Role |
|---|---|
| `config/llmconfig.ts` | LLM model config, system prompt, API settings |
| `config/voiceConfig.ts` | Voice service configuration |

---

## Conversation

| File | Role |
|---|---|
| `conversation/contextManager.ts` | Conversation context manager |

---

## Core

| File | Role |
|---|---|
| `core/orchestrator.ts` | ⭐ Central planning kernel + deterministic command router |
| `core/agentStateMachine.ts` | ⭐ State machine (IDLE→LISTENING→PROCESSING_STT→PLANNING→EXECUTING…) |
| `core/toolRegistryV2.ts` | ⭐ Active tool registry (use this, not toolRegistry.ts) |
| `core/skillLoader.ts` | ⭐ Loads executable skills from skills/ |
| `core/taskGraphEngine.ts` | DAG-based parallel task execution |
| `core/conversationBus.ts` | Speaking state events (speakingStarted/Ended, idle/busy) |
| `core/reflectionEngine.ts` | Post-execution reflection + repair strategy |
| `core/goalManager.ts` | Goal lifecycle tracking |
| `core/brain.ts` | Brain coordination layer |
| `core/brainLoop.ts` | Autonomy loop manager |
| `core/messageBus.ts` | Legacy pub/sub event bus (superseded by direct calls in orchestrator) |
| `core/systemController.ts` | Backward-compat shim for agentStateMachine |
| `core/commandSafety.ts` | Safety checks for shell commands |
| `core/environmentContext.ts` | OS/CWD/process awareness for LLM planning |
| `core/consciousnessClock.ts` | Consciousness tick/cycle management |
| `core/interruptManager.ts` | Interrupt signal management |
| `core/fileManager.ts` | File operation utilities |
| `core/fileTools.ts` | File tool implementations |
| `core/terminalTools.ts` | Terminal/shell tool wrappers |
| `core/skillRegistry.ts` | Skill registration helper |

### ⚠️ Audit Flag: toolRegistry.ts vs toolRegistryV2.ts

```
core/toolRegistry.ts     ← OLDER version — may still be imported somewhere
core/toolRegistryV2.ts   ← ACTIVE version — used by orchestrator and all tests
```

**Do not delete toolRegistry.ts until all importers are confirmed.**
Run: `grep -r "toolRegistry" . --include="*.ts" | grep -v "toolRegistryV2"` to find importers.

---

## Core Tools

| File | Role |
|---|---|
| `core/tools/index.ts` | Registers built-in tools (web_search, read_file, write_file, etc.) |
| `core/tools/memoryTool.ts` | Memory tool (save/search facts) |
| `core/tools/windowsCommands.json` | Windows command mappings |

---

## Data

| Path | Content |
|---|---|
| `data/conversations/` | Stored conversation logs |
| `data/knowledge/` | Knowledge base files |
| `data/logs/` | Data-layer logs |
| `data/goals.json` | Persisted goal states |
| `data/systemInfo.json` | System info cache |

---

## Execution

| File | Role | Status |
|---|---|---|
| `execution/actionExecutor.ts` | Tool execution with timeout + abort | Active |
| `execution/skillExecutor.ts` | Tombstoned — `export {}` | Delete candidate |
| `execution/toolSelector.ts` | Stub — returns input unchanged | Archive candidate |

---

## Learning

| File | Role |
|---|---|
| `learning/improvementEngine.py` | Python improvement loop |
| `learning/mistakeAnalyzer.py` | Error analysis |
| `learning/selfAudit.ts` | TypeScript self-audit utility |

---

## Logs

| File | Content |
|---|---|
| `logs/jarvis-health.jsonl` | Runtime health log (JSONL) |
| `logs/vector_stderr.txt` | Vector memory server stderr |
| `logs/vector_stdout.txt` | Vector memory server stdout |

---

## Memory

| File | Role | Status |
|---|---|---|
| `memory/memoryManager.ts` | ⭐ Primary memory manager | Active |
| `memory/redisCache.ts` | ⭐ Redis cache layer | Active |
| `memory/vectorMemory.py` | ⭐ Vector embedding server | Active |
| `memory/vectorMemorySupervisor.ts` | ⭐ Manages vectorMemory.py lifecycle | Active |
| `memory/unifiedContextBuilder.ts` | ⭐ Active context builder | Active |
| `memory/graphMemory.ts` | Neo4j graph memory | Active |
| `memory/agentMemory.ts` | Working memory for agent loop | Active |
| `memory/intentClassifier.ts` | Intent classification helper | Active |
| `memory/jarvis_memory.json` | Persisted LowDB memory file | Data file |
| `memory/taskHistory.json` | Task history store | Data file |
| `memory/userMemory.json` | User memory store | Data file |
| `memory/memoryIndexer.py` | Python memory indexer | Active |

### ⚠️ Audit Flag: contextBuilder.ts vs unifiedContextBuilder.ts

```
memory/contextBuilder.ts        ← DEPRECATED/TOMBSTONED 2026-06-10
                                   Contains valuable rankFactsFusion() algorithm
                                   NOT imported by active code
memory/unifiedContextBuilder.ts ← ACTIVE — used by orchestrator.ts
```

**Do not delete contextBuilder.ts** until `rankFactsFusion()` is ported or confirmed unnecessary.

### ⚠️ Audit Flag: cacheManager.ts vs redisCache.ts

```
memory/cacheManager.ts    ← Purpose overlaps with redisCache.ts — needs review
memory/redisCache.ts      ← Active Redis cache layer used by contextBuilder
```

---

## Monitoring

| File | Role |
|---|---|
| `monitoring/runtimeDashboard.ts` | 60s health refresh, logs to logs/ |
| `monitoring/healthCheck.ts` | Health check utilities |
| `monitoring/healthManager.ts` | Health state management |
| `monitoring/performanceMonitor.ts` | Performance metrics |
| `monitoring/eventLogger.ts` | Event logging |

---

## Perception

| File | Role |
|---|---|
| `perception/inputProcessor.ts` | Input processing pipeline |
| `perception/intentAnalyzer.ts` | Intent analysis |
| `perception/semanticCache.ts` | Semantic result caching |
| `perception/visionIntentManager.ts` | Vision-based intent management |

---

## Planner

| File | Role | Status |
|---|---|---|
| `planner/taskPlanner.ts` | Old messageBus-based planner — superseded by orchestrator | Archive candidate |
| `planner/goalDecomposer.ts` | Used only by taskPlanner.ts stub | Archive candidate |

---

## Reasoning

| File | Role |
|---|---|
| `reasoning/decisionRouter.ts` | Decision routing logic |
| `reasoning/grokCore.ts` | Groq/LLM core reasoning |
| `reasoning/promptTemplates.ts` | Prompt template library |
| `reasoning/systemPrompt.ts` | System prompt definition |

---

## Security

| File | Role |
|---|---|
| `security/approvalGate.ts` | Human approval gating |
| `security/commandValidator.ts` | Command validation |
| `security/permissionManager.ts` | Permission checks |
| `security/sandbox.ts` | Sandboxed execution |

---

## Self-Healing

| File | Role |
|---|---|
| `self_healing/selfHealingManager.ts` | Launches/restarts Python services, health checks |
| `self_healing/pipelineRegistry.ts` | Records pipeline health events |
| `self_healing/pipelineWatchdog.ts` | Watchdog for pipeline stages |
| `self_healing/failureDetector.ts` | Detects WebSocket and other failures |
| `self_healing/failureClassifier.ts` | Classifies failure types |
| `self_healing/fallbackRouter.ts` | Routes to fallback on failure |
| `self_healing/recoveryPlanner.ts` | Plans recovery actions |
| `self_healing/repairExecutor.ts` | Executes repair actions |
| `self_healing/fsWatcher.ts` | File system change watcher |
| `self_healing/index.ts` | Self-healing barrel export |

---

## Simulation

| File | Role |
|---|---|
| `simulation/worldModel.ts` | World state simulation model |

---

## Skills

| File | Role |
|---|---|
| `skills/automation/skill.ts` | ⭐ open_app tool (YouTube, Notepad, Chrome, etc.) |
| `skills/automation/description.json` | Skill metadata |
| `skills/coding/skill.ts` | explain_code tool |
| `skills/coding/description.json` | Skill metadata |
| `skills/search/skill.ts` | deep_search tool |
| `skills/search/description.json` | Skill metadata |
| `skills/weather/skill.ts` | get_weather tool |
| `skills/weather/description.json` | Skill metadata |

---

## System

| File | Role |
|---|---|
| `system/codeGenerator.ts` | Code generation utility |
| `system/containerManager.ts` | Container management |
| `system/installer.ts` | Package installer helper |

---

## Tests

| File | What It Tests |
|---|---|
| `tests/nodeBridgeSingletonTest.ts` | NodeBridge singleton, idempotency, READY registry |
| `tests/voiceRouteMockTest.ts` | Full mock voice route (bridge→orchestrator→open_app) |
| `tests/interruptGatingTest.ts` | Barge-in blocked during PLANNING/EXECUTING |
| `tests/openAppSmokeTest.ts` | open_app tool execution |
| `tests/latencySmokeTest.ts` | Deterministic route latency |
| `tests/deterministicCommandRouteTest.ts` | Router matching + security boundary (39 assertions) |

---

## Tools

| File | Role |
|---|---|
| `tools/webSearchTool.ts` | Web search integration |
| `tools/fileTool.ts` | File read/write operations |
| `tools/terminalTool.ts` | Terminal command execution |
| `tools/systemTool.ts` | System info tool |
| `tools/claudeCodeTool.ts` | Claude code tool integration |
| `tools/dispatcher.ts` | Tool dispatch helper |
| `tools/browserTool.py` | Python browser automation |

---

## Vision

| File | Role |
|---|---|
| `vision/screen_capture.py` | Screen capture + OCR Python service |

---

## Voice

| File | Role | Status |
|---|---|---|
| `voice/wakeWords.py` | ⭐ Active wake word service + inline command extraction | Active |
| `voice/wakeWord.py` | Stub (2 bytes — comment only) | ⚠️ Needs human review |
| `voice/stt.py` | Speech-to-text service | Active |
| `voice/tts.py` | Text-to-speech service | Active |

### ⚠️ Audit Flag: wakeWord.py vs wakeWords.py

```
voice/wakeWords.py   ← ACTIVE — 15,961 bytes — full wake word implementation
voice/wakeWord.py    ← STUB   — 21 bytes — comment only: "# voice/wakeWord.py"
```

**Both files exist. Do not delete either without human review.**
`wakeWord.py` may be a legacy placeholder or import target.
Check if any file imports `from voice.wakeWord` before any action.

---

## Audit-Only: Root Diagnostic / Refactor Scripts

These files exist at the project root and are for one-time use.
They are NOT runtime code and should NOT be imported from runtime files.

| File | Category |
|---|---|
| `analyze.ts` | Diagnostic script — codebase analysis |
| `count_modules.ts` | Diagnostic script — module counter |
| `debug_imports.ts` | Diagnostic script — import tracer |
| `find_importers.ts` | Diagnostic script — finds who imports what |
| `fix_executor.ts` | Refactor script — executor fix |
| `fix_imports.ts` | Refactor script — import fixer |
| `refactor_mem.ts` | Refactor script — memory refactor |
| `refactor_p2.ts` | Refactor script — phase 2 refactor |
| `report.ts.bak` | Backup of report generator |
| `scaffold.ps1` | PowerShell scaffold generator |
| `stabilityTest.ts` | Manual stability test (should be in tests/) |
| `stateMachineVerification.ts` | State machine verification script |
| `test_node_redis.ts` | Redis connection test |
| `test_production_hardening.ts` | Production hardening test |

See `ROOT_FILE_AUDIT_GUIDE.md` for full classification of all root files.
