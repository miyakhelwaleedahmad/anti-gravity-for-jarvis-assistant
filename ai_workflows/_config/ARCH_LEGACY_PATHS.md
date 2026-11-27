# ARCH_LEGACY_PATHS.md — Where the Old Map's Files Went

> History, not current architecture. The 2026-06 `ARCHITECTURE_MAP.md`
> listed the files below at paths that no longer exist. Most were moved,
> unchanged, into `_legacy/` in commit c39ca7b ("quarantine 57 unreachable
> modules into _legacy/") or fd72ce1 (ARCH-08); see `_legacy/README.md`.
> Checked against the repository on 2026-10-23 (`claude/jarvis-repair`).
> Nothing in `_legacy/` is imported by the running system; do not restore a
> file from it without a patch plan and approval.

## Old path → current location

| Old path (2026-06 map) | Role recorded then | Now |
|---|---|---|
| `index.ts` | Secondary entry / re-export barrel | `_legacy/index.ts` (c39ca7b) |
| `agents/supervisorAgent.ts` | Supervisor coordination logic — Active (minimal) | `_legacy/agents/supervisorAgent.ts` |
| `agents/codingAgent.ts` | Stub — `export {}` only — Stub / delete candidate | `_legacy/agents/codingAgent.ts` |
| `agents/jarvisAgent.ts` | Stub — `export {}` only — Stub / delete candidate | `_legacy/agents/jarvisAgent.ts` |
| `agents/systemAgent.ts` | Stub — `export {}` only — Stub / delete candidate | `_legacy/agents/systemAgent.ts` |
| `agents/researchAgent.py` | Stub Python agent — Stub / delete candidate | `_legacy/agents/researchAgent.py` |
| `app/api/memory/route.ts` | Next.js API route for memory access | deleted in b7f1393 |
| `backend/memory/redis_client.py` | Python Redis client | `_legacy/backend/memory/redis_client.py` |
| `backend/memory/test_redis.py` | Redis connection test | `_legacy/backend/memory/test_redis.py` |
| `backend/longTaskRunner.ts` | Long async task utility | `_legacy/autonomy/longTaskRunner.ts` |
| `backend/scheduler.ts` | Task scheduler | `_legacy/autonomy/scheduler.ts` |
| `backend/selfCorrection.ts` | Self-correction loop | `_legacy/autonomy/selfCorrection.ts` |
| `backend/taskQueue.ts` | Task queue implementation | `_legacy/autonomy/taskQueue.ts` |
| `bridge/pythonBridge.py` | Python-side bridge helper | `_legacy/bridge/pythonBridge.py` |
| `config/voiceConfig.ts` | Voice service configuration | `_legacy/config/voiceConfig.ts` |
| `conversation/contextManager.ts` | Conversation context manager | `_legacy/conversation/contextManager.ts` |
| `core/brain.ts` | Brain coordination layer | `_legacy/core/brain.ts` |
| `core/systemController.ts` | Backward-compat shim for agentStateMachine | deleted in e0c69d4 (`core/stateShim.ts` is now the compatibility proxy; `control/systemController.ts` is a different file) |
| `core/consciousnessClock.ts` | Consciousness tick/cycle management | `_legacy/core/consciousnessClock.ts` |
| `core/interruptManager.ts` | Interrupt signal management | `_legacy/core/interruptManager.ts` |
| `core/skillRegistry.ts` | Skill registration helper | `_legacy/core/skillRegistry.ts` |
| `data/systemInfo.json` | System info cache | `environment/systemInfo.json` |
| `execution/actionExecutor.ts` | Tool execution with timeout + abort | `_legacy/execution/actionExecutor.ts` |
| `execution/skillExecutor.ts` | Tombstoned — `export {}` — Delete candidate | `_legacy/execution/skillExecutor.ts` |
| `execution/toolSelector.ts` | Stub — returns input unchanged — Archive candidate | `_legacy/execution/toolSelector.ts` |
| `learning/improvementEngine.py` | Python improvement loop | `_legacy/learning/improvementEngine.py` |
| `learning/mistakeAnalyzer.py` | Error analysis | `_legacy/learning/mistakeAnalyzer.py` |
| `learning/selfAudit.ts` | TypeScript self-audit utility | `_legacy/learning/selfAudit.ts` |
| `logs/jarvis-health.jsonl` | Runtime health log (JSONL) | runtime file, Git-ignored (`logs/*.jsonl`, `logs/*.txt`); exists only on the PC that runs JARVIS |
| `logs/vector_stderr.txt` | Vector memory server stderr | runtime file, Git-ignored (`logs/*.jsonl`, `logs/*.txt`); exists only on the PC that runs JARVIS |
| `logs/vector_stdout.txt` | Vector memory server stdout | runtime file, Git-ignored (`logs/*.jsonl`, `logs/*.txt`); exists only on the PC that runs JARVIS |
| `memory/intentClassifier.ts` | Intent classification helper | `_legacy/memory/intentClassifier.ts` |
| `memory/memoryIndexer.py` | Python memory indexer | `_legacy/memory/memoryIndexer.py` |
| `monitoring/healthCheck.ts` | Health check utilities | `_legacy/monitoring/healthCheck.ts` |
| `monitoring/performanceMonitor.ts` | Performance metrics | `_legacy/monitoring/performanceMonitor.ts` |
| `monitoring/eventLogger.ts` | Event logging | `_legacy/monitoring/eventLogger.ts` |
| `perception/inputProcessor.ts` | Input processing pipeline | `_legacy/perception/inputProcessor.ts` |
| `perception/intentAnalyzer.ts` | Intent analysis | `_legacy/perception/intentAnalyzer.ts` |
| `perception/semanticCache.ts` | Semantic result caching | `_legacy/perception/semanticCache.ts` |
| `perception/visionIntentManager.ts` | Vision-based intent management | `_legacy/perception/visionIntentManager.ts` |
| `planner/taskPlanner.ts` | Old messageBus-based planner — superseded by orchestrator — Archive candidate | `_legacy/planner/taskPlanner.ts` |
| `planner/goalDecomposer.ts` | Used only by taskPlanner.ts stub — Archive candidate | `_legacy/planner/goalDecomposer.ts` |
| `reasoning/decisionRouter.ts` | Decision routing logic | `_legacy/reasoning/decisionRouter.ts` |
| `reasoning/grokCore.ts` | Groq/LLM core reasoning | `_legacy/reasoning/grokCore.ts` |
| `reasoning/promptTemplates.ts` | Prompt template library | `_legacy/reasoning/promptTemplates.ts` |
| `reasoning/systemPrompt.ts` | System prompt definition | `_legacy/reasoning/systemPrompt.ts` |
| `security/sandbox.ts` | Sandboxed execution | `_legacy/security/sandbox.ts` (fd72ce1) |
| `self_healing/index.ts` | Self-healing barrel export | `_legacy/self_healing/index.ts` |
| `simulation/worldModel.ts` | World state simulation model | `_legacy/simulation/worldModel.ts` |
| `system/codeGenerator.ts` | Code generation utility | `_legacy/system/codeGenerator.ts` |
| `system/containerManager.ts` | Container management | `_legacy/system/containerManager.ts` |
| `system/installer.ts` | Package installer helper | `_legacy/system/installer.ts` |
| `tools/systemTool.ts` | System info tool | `_legacy/tools/systemTool.ts` |
| `tools/claudeCodeTool.ts` | Claude code tool integration | `_legacy/tools/claudeCodeTool.ts` |
| `tools/dispatcher.ts` | Tool dispatch helper | `_legacy/tools/dispatcher.ts` |
| `tools/browserTool.py` | Python browser automation | `_legacy/tools/browserTool.py` |
| `voice/wakeWord.py` | Stub (2 bytes — comment only) — ⚠️ Needs human review | `_legacy/voice/wakeWord.py` (fd72ce1) |
| `analyze.ts` | Diagnostic script — codebase analysis | `_legacy/analyze.ts` |
| `count_modules.ts` | Diagnostic script — module counter | `_legacy/count_modules.ts` |
| `debug_imports.ts` | Diagnostic script — import tracer | `_legacy/debug_imports.ts` |
| `find_importers.ts` | Diagnostic script — finds who imports what | `_legacy/find_importers.ts` |
| `fix_executor.ts` | Refactor script — executor fix | `_legacy/fix_executor.ts` |
| `fix_imports.ts` | Refactor script — import fixer | `_legacy/fix_imports.ts` |
| `refactor_mem.ts` | Refactor script — memory refactor | `_legacy/refactor_mem.ts` |
| `refactor_p2.ts` | Refactor script — phase 2 refactor | `_legacy/refactor_p2.ts` |
| `report.ts.bak` | Backup of report generator | removed from Git in ccf6118 |
| `scaffold.ps1` | PowerShell scaffold generator | `_legacy/scaffold.ps1` |
| `stabilityTest.ts` | Manual stability test (should be in tests/) | `_legacy/stabilityTest.ts` |
| `stateMachineVerification.ts` | State machine verification script | `_legacy/stateMachineVerification.ts` |
| `test_node_redis.ts` | Redis connection test | `_legacy/test_node_redis.ts` |
| `test_production_hardening.ts` | Production hardening test | `_legacy/test_production_hardening.ts` |

## Audit flags recorded in the 2026-06 map

These flags were written when the files were still at their old paths.
Each one is now settled by the move to `_legacy/`; the original concern is
kept so it is not lost if a file is ever brought back.

| Flag (2026-06) | Original note | Status on 2026-10-23 |
|---|---|---|
| `core/toolRegistry.ts` vs `core/toolRegistryV2.ts` | V1 "may still be imported somewhere"; do not delete until all importers are confirmed | V1 is `_legacy/core/toolRegistry.ts`; V2 is the only registry |
| `memory/contextBuilder.ts` vs `memory/unifiedContextBuilder.ts` | contextBuilder tombstoned 2026-06-10 but holds `rankFactsFusion()`; port it or confirm it unnecessary before deleting | contextBuilder is `_legacy/memory/contextBuilder.ts`; the name `rankFactsFusion` appears only there. Whether its logic lives on under another name was not checked |
| `memory/cacheManager.ts` vs `memory/redisCache.ts` | Not duplicates: cacheManager cached LLM and tool results for `grokCore.ts`; redisCache caches context packets | cacheManager and grokCore are in `_legacy/`; redisCache is active |
| `voice/wakeWord.py` vs `voice/wakeWords.py` | 21-byte comment-only stub; check for `from voice.wakeWord` imports before any action | Stub is `_legacy/voice/wakeWord.py`; `voice/wakeWords.py` is the active service |

The detailed import evidence for these pairs, as found on 2026-06-19, is in
`DUPLICATE_AUDIT_2026-06-19.md` and `DUPLICATE_AUDIT_2026-06-19_PART2.md`.
