# JARVIS STAGE 1 — FOUNDATION ERRORS REPORT
**Audit Date:** 2026-07-04 | **Auditor:** Antigravity AI | **Scope:** Read-only inspection only. No files modified.

---

## 1. STAGE 1 ERROR SUMMARY

### Foundation Error Score: 42 / 100
*(Lower is worse. 100 = fully clean foundation.)*

### Is the foundation blocked by serious errors?
**Yes — partially.** The runtime boots and processes voice commands, but the foundation carries serious architectural rot:
- A **complete legacy event-bus pipeline** (7 modules) runs in memory but is never triggered in v2
- A **missing Python file** (`reflectionEngine.py`) is referenced by 3 active modules but does not exist on disk
- **3 orphaned tests** are never run by any npm script
- **`npm test` fails by design** (echoes an error and exits 1)
- Numerous stub/mock modules inflate startup memory on a constrained 8 GB Windows machine

### Top 10 Foundation Errors

| # | Error | Severity |
|---|-------|----------|
| 1 | `voice/reflectionEngine.py` referenced in 3 places but does not exist on disk | CRITICAL |
| 2 | Legacy messageBus pipeline (7 modules) loaded into RAM but never triggered in v2 | HIGH |
| 3 | `core/brain.ts` — orphaned legacy orchestrator, not imported anywhere in runtime | HIGH |
| 4 | `agents/` folder — 4 files are pure stubs (`export {}` / empty comment) | HIGH |
| 5 | Dual competing entrypoints: `jarvis.ts` (full) vs `index.ts` (partial, no voice/self-healing) | HIGH |
| 6 | `scheduler/` folder is completely empty — no files at all | MEDIUM |
| 7 | `"test"` script in package.json fails by design (`exit 1`) | MEDIUM |
| 8 | `next`, `react`, `react-dom` in production deps — unused by runtime, bloating install | MEDIUM |
| 9 | 11 MB junk structure dump files (`jarvis_structure.txt`, `project_tree.txt`) at project root | MEDIUM |
| 10 | 8 developer utility scripts at project root compiled by `tsc` alongside production code | MEDIUM |

---

## 2. PROJECT STRUCTURE ERRORS

| File/Folder | Error Type | Evidence | Severity | Risk | Fix Direction |
|-------------|-----------|----------|----------|------|---------------|
| `voice/wakeWord.py` | Empty stub — 21 bytes, comment only | File contains only `# voice/wakeWord.py` + newline | HIGH | `selfHealingManager` correctly uses `wakeWords.py`, but this dead file causes confusion in code review and tooling | Delete or document clearly as placeholder |
| `voice/reflectionEngine.py` | **Missing file** — referenced but does not exist | `jarvis.ts:509`, `self_healing/pipelineWatchdog.ts:25`, `self_healing/fsWatcher.ts:27` all reference it | CRITICAL | Watchdog will attempt to restart a non-existent script; jarvis.ts constructs path to it for backup reflection | Create the missing Python file or remove all references |
| `agents/codingAgent.ts` | Pure stub — `export {}` only (37 bytes) | File body: `// agents/codingAgent.ts\nexport {};` | HIGH | Misleads architecture; folder appears to have agents but none are functional | Implement or delete |
| `agents/jarvisAgent.ts` | Pure stub — `export {}` only (37 bytes) | Same pattern as codingAgent | HIGH | Same as above | Implement or delete |
| `agents/systemAgent.ts` | Pure stub — `export {}` only (37 bytes) | Same pattern | HIGH | Same as above | Implement or delete |
| `agents/researchAgent.py` | Pure stub — empty Python file (27 bytes) | File body: `# agents/researchAgent.py\n` | HIGH | Python stub in wrong language for TS project | Implement or delete |
| `agents/supervisorAgent.ts` | Only file with real code in `agents/` but not imported anywhere in runtime | Not found in any runtime import scan | MEDIUM | Dead module in RAM | Wire to orchestrator or delete |
| `scheduler/` | Empty folder — zero files | `list_dir` returned "Empty directory" | MEDIUM | No scheduler logic despite `autonomy/scheduler.ts` existing. Folder suggests future intent, currently misleading | Either add files or remove folder |
| `backend/` | Contains only an empty `memory/` subdirectory | Only child is `backend/memory/` with no files | MEDIUM | Dead folder with no content or connection | Remove or populate |
| `environment/` | Contains only `systemInfo.json` — no TypeScript modules | Single JSON data file, no `.ts` | LOW | Misleading folder name suggests environment config logic | Move JSON to `data/` or add proper module |
| `simulation/worldModel.ts` | Subscribes to messageBus events that are never published in v2 runtime | `messageBus.subscribe('TOOL_EXECUTED'...)` — messageBus is never triggered by `orchestrator.process()` | MEDIUM | Module loaded into memory, event handlers registered, but never fire | Either delete or integrate with v2 orchestrator |
| `system/codeGenerator.ts` | Not imported anywhere in runtime | Grep found zero runtime importers | LOW | Dead code using `fileManager` to generate skill templates — completely disconnected | Delete or add to skillLoader pipeline |
| `system/containerManager.ts` | Mock/stub — console.log only, not imported anywhere | All methods just log; zero runtime importers | LOW | Dead mock — gives false sense of sandboxing | Delete or implement real sandboxing |
| `system/installer.ts` | Not imported anywhere in runtime | Zero runtime importers found | LOW | Security risk if called without review (runs `npm install` via exec) | Evaluate and either import or delete |
| `learning/selfAudit.ts` | Stub with hardcoded `performanceScore = 0.95` | Not imported anywhere; hardcoded fake score | LOW | Fake-success module; gives misleading confidence | Delete or implement real audit logic |
| `conversation/contextManager.ts` | Not imported anywhere in runtime | Zero runtime importers | MEDIUM | Folder `conversation/` has only 1 file and it is unused; `memoryManager` handles context directly | Remove isolation, or wire to orchestrator context builder |
| `execution/skillExecutor.ts` | Self-documented TOMBSTONED stub | File comment: `// @deprecated... TOMBSTONED 2026-06-10. SAFE TO DELETE.` | MEDIUM | Dead file still compiled by tsc | Delete |
| `execution/toolSelector.ts` | Stub — `selectTool()` returns input unchanged | Not imported anywhere in runtime | LOW | No tool selection logic; returns identity function | Delete or implement |
| `autonomy/longTaskRunner.ts` | Stub — awaits task function with no real offload | Not imported anywhere in runtime | LOW | Comments say "offload to worker thread" but does not | Delete or implement |
| `autonomy/selfCorrection.ts` | Mock — returns hardcoded `"retry_with_fallback"` | Not imported anywhere in runtime | LOW | Fake recovery logic | Delete |
| `autonomy/scheduler.ts` | Not imported anywhere in runtime | Zero runtime importers | LOW | Scheduling logic exists but nothing schedules | Wire to brainLoop or delete |
| `perception/semanticCache.ts` | Only imported by `intentAnalyzer.ts` which is only used by legacy `brain.ts` pipeline | Transitive orphan via dead pipeline | LOW | Allocates a Map that is populated but never read in v2 | Delete when legacy pipeline is cleaned |
| `tools/dispatcher.ts` | Mock — returns `{ success: true, result: 'Executed X' }` | Not imported anywhere in runtime | LOW | Fake dispatch logic, no actual tool routing | Delete |
| `tools/claudeCodeTool.ts` | Mock — returns hardcoded string | Not imported anywhere in runtime | LOW | Gives false impression of Claude Code integration | Delete or implement |
| `core/toolRegistry.ts` | Self-documented LEGACY V1 TOMBSTONED | Header: `@deprecated... SAFE TO DELETE... Replaced by toolRegistryV2.ts` | MEDIUM | Still compiled by tsc, has overlapping definitions | Delete |
| `core/brain.ts` | Orphaned v1 orchestrator — not imported anywhere in runtime | Zero runtime import hits in grep scan | HIGH | Side-effect imports 7 legacy modules; if accidentally imported, double-instantiates pipeline | Delete |
| `core/interruptManager.ts` | Not imported anywhere in runtime | Zero hits; superseded by `agentStateMachine.interrupt()` | MEDIUM | Dead singleton in memory | Delete |
| `core/skillRegistry.ts` | Not imported anywhere in runtime | `skillLoader.ts` registers skills into `toolRegistryV2`, not `skillRegistry` | MEDIUM | Dead singleton; `skillRegistry` concept is not connected to any active execution path | Delete |
| `core/consciousnessClock.ts` | No singleton export — class only, no instance | File ends at `}` after class definition, no `export const` | LOW | Cannot be imported and used without manual instantiation; not imported anywhere | Add singleton or delete |
| `jarvis_structure.txt` | 11.29 MB junk dump at project root | Confirmed 11,291,834 bytes | MEDIUM | Massive repo bloat; slows git, IDEs, and file watchers | Delete |
| `project_tree.txt` | 11.29 MB junk dump at project root | Confirmed 11,293,060 bytes | MEDIUM | Same as above | Delete |
| `temp_stt_1777830229.wav` | Temp audio file at project root | 137,260 bytes WAV file — leftover from STT debugging | LOW | Unintentional artifact in repo | Delete |
| `tsc_output.txt` | Stale compiler output file at root | Empty per directory listing | LOW | Should not be committed to repo | Delete or gitignore |
| `clean_structure.txt` | Stale structural dump at root | 0 bytes (empty) | LOW | Useless file | Delete |

---

## 3. ENTRYPOINT AND RUNTIME FLOW ERRORS

| File/Script | Error | Evidence | Severity | Risk | Fix Direction |
|-------------|-------|----------|----------|------|---------------|
| `index.ts` vs `jarvis.ts` | **Competing entrypoints** — `index.ts` boots a partial JARVIS without voice, self-healing, systemStateObserver, healthManager, or runtimeDashboard | Both import `orchestrator`, `brainLoop`, `memoryManager`. `index.ts` header says "kept for backward compatibility" but is never explicitly deprecated in scripts | HIGH | If a developer runs `tsx index.ts`, they get a silent JARVIS clone with no voice pipeline. No warning is emitted | Either delete `index.ts` or add a prominent boot warning that redirects to `jarvis.ts` |
| `package.json` `"main"` field | Points to `jarvis.ts` (TypeScript source), not `dist/jarvis.js` | `"main": "jarvis.ts"` in package.json | MEDIUM | If project is ever `require()`d or published as a package, runtime will fail because `jarvis.ts` cannot be imported by Node without tsx | Change to `dist/jarvis.js` |
| `jarvis.ts:509` | References `voice/reflectionEngine.py` via `path.join(VOICE_DIR, 'reflectionEngine.py')` — file does not exist | `Test-Path` returned `False` for that path | CRITICAL | When `scheduleReflection()` fires, it will call `terminalTools.runPython()` on a missing file — currently DISABLED by comment but the path construction is still wrong | Create the file or remove the dead path |
| `core/brain.ts` import side-effects | `brain.ts` imports 7 modules as side-effects; `JarvisBrain.execute()` calls `messageBus.publish('INPUT_RECEIVED')` — but `jarvis.ts` never imports or calls `brain.ts` | Zero importers found in grep scan | HIGH | The entire v1 pipeline (`inputProcessor` → `intentAnalyzer` → `decisionRouter` → `grokCore` → `taskPlanner` → `taskQueue` → `actionExecutor`) is defined but never connected to v2 entrypoint | Remove `brain.ts` after confirming `grokCore` is genuinely unused in v2 |
| `reasoning/grokCore.ts` | Subscribes to `messageBus` events `FAST_PATH_INFERENCE` and `DEEP_PATH_INFERENCE` — these are only published by `decisionRouter.ts` which is only triggered by `inputProcessor.ts` which is only triggered by `messageBus.publish('INPUT_RECEIVED')` which is only called by `brain.ts` | Chain: `brain.ts` → `INPUT_RECEIVED` → `inputProcessor` → `INTENT_DETECTED` → `decisionRouter` → `DEEP_PATH_INFERENCE` → `grokCore`. None of this chain is triggered in v2 | HIGH | `grokCore` allocates memory, sets up event handlers, and has a full LLM streaming pipeline — all dead in v2 runtime. `orchestrator.ts` does NOT emit these events | Document or remove |
| Voice pipeline — missing `reflectionEngine.py` in fsWatcher | `self_healing/fsWatcher.ts:27` watches for changes to `voice/reflectionEngine.py` and maps it to `reflection_loop` pipeline | File does not exist; watcher will never trigger | MEDIUM | `pipelineWatchdog.ts:25` also lists `reflection_loop` as a monitored pipeline — watchdog monitors a pipeline for a script that doesn't exist | Create file or remove from watcher/watchdog config |
| `voice/wakeWord.py` vs `voice/wakeWords.py` | `selfHealingManager.launchPythonService('wakeWords.py', 'WakeWord')` — correctly uses `wakeWords.py`. But a dead `wakeWord.py` (stub) also sits in the same folder | `voice/wakeWord.py` is 21 bytes, `voice/wakeWords.py` is 16,391 bytes | MEDIUM | Name similarity risks future developer calling wrong file; self-healing correctly avoids it but stub is misleading | Delete `wakeWord.py` |
| Root-level utility scripts included in `tsc` | `analyze.ts`, `count_modules.ts`, `debug_imports.ts`, `find_importers.ts`, `fix_executor.ts`, `fix_imports.ts`, `refactor_mem.ts`, `refactor_p2.ts` all included in TypeScript compilation via `"include": ["**/*.ts"]` | Confirmed in root file listing; tsconfig does not exclude root-level `.ts` files | MEDIUM | Extra compile time on each `tsc --noEmit` run; these utility scripts pull in their own imports and extend compile graph | Move to a `scripts/` folder and exclude from tsconfig or add to `.gitignore` |

### Voice Pipeline Flow Assessment

| Stage | Component | Status |
|-------|-----------|--------|
| Wake Word | `voice/wakeWords.py` → NodeBridge `wake_word` event | ✅ Connected |
| STT | `voice/stt.py` → NodeBridge `stt_result` event | ✅ Connected |
| Orchestrator | `jarvis.ts` → `orchestrator.process()` | ✅ Connected |
| Context Builder | `memory/contextBuilder.ts` ← called by `orchestrator` | ✅ Connected |
| Deterministic Router | `orchestrator.matchDeterministicCommand()` | ✅ Connected |
| Tool Registry | `core/toolRegistryV2.ts` | ✅ Connected |
| Tool Execution | Skills in `skills/*/skill.ts` via `toolRegistryV2.execute()` | ✅ Connected |
| TTS | `voice/tts.py` → NodeBridge `speak` message | ✅ Connected |
| **Legacy grokCore path** | `messageBus` → `grokCore` → LLM → `taskPlanner` → `actionExecutor` | ❌ Dead — not triggered in v2 |
| **Reflection script** | `voice/reflectionEngine.py` (backup job) | ❌ Missing file |

---

## 4. TYPESCRIPT / NODE ERRORS

| Command/File | Error Message | Root Cause | Severity | Fix Direction |
|-------------|---------------|-----------|----------|---------------|
| `npx tsc --noEmit` | **Exit 0 — ZERO compile errors** | All TypeScript types resolve correctly | ✅ PASS | None needed |
| `package.json` `"test"` script | `"echo \"Error: no test specified\" && exit 1"` — fails by design | No unified test runner configured | HIGH | Replace with a real test runner command or point to `test:all` |
| `package.json` `"test:voice-core"` | Chains 13 test files with `&&` — one failure aborts the chain. `openAppSmokeTest.ts` **actually opens apps** (YouTube, Notepad, CMD) during CI | `openAppSmokeTest.ts` calls `execute({ target })` from `skills/automation/skill.ts` which launches real processes | HIGH | Separate smoke/integration tests from unit tests; add a `--dry-run` flag or mock |
| `package.json` `"start"` script | `node dist/jarvis.js` — `dist/` is generated by `tsc build` but the `build` script is separate | If `dist/` doesn't exist, `start` silently fails with "Cannot find module" | MEDIUM | Document build-before-start requirement or use a pre-start hook |
| `package.json` `dependencies` — `next@^16.2.9` | `next`, `react`, `react-dom` listed as production dependencies | The `app/` folder is a Next.js app but is **excluded from tsconfig** and not started by `jarvis.ts` | MEDIUM | Move to `devDependencies` or separate `app/package.json`; remove from root production deps to save ~100 MB |
| `package.json` `dependencies` — `neo4j-driver@^6.0.1` | `neo4j-driver` pulled in as a dependency; `memory/graphMemory.ts` uses it | If Neo4j is not running locally, `graphMemory.ts` will fail silently on init | MEDIUM | Guard Neo4j connection with a try/catch and graceful fallback in `graphMemory.ts`; document that Neo4j is optional |
| `tsconfig.json` `"include": ["**/*.ts"]` | Compiles all root-level developer utility `.ts` files (analyze.ts, fix_imports.ts, refactor_*.ts, etc.) | No exclusion for root-level dev scripts | MEDIUM | Add a `scripts/` subfolder, move utilities there, or add an `exclude` pattern |
| `tsconfig.json` missing `"dist"` in `exclude` | `dist/` is not explicitly excluded | TypeScript default behavior excludes `outDir` automatically — low actual risk but non-standard | LOW | Explicitly add `"dist"` to `exclude` array for clarity |
| `core/consciousnessClock.ts` | Class exported but no singleton exported | File ends after class declaration; no `export const consciousnessClock = new ConsciousnessClock()` | LOW | Not a compile error, but any future importer must manually instantiate — inconsistent with all other modules | Add singleton export |
| `autonomy/taskQueue.ts` | `PlanStep.parentId`, `dependsOn`, `assignedTo` marked `INACTIVE FEATURE` in comments | `taskPlanner.ts` comment says "INACTIVE FEATURE" for these fields | LOW | Type definitions advertise multi-agent features that don't exist yet | Remove from type until implemented |

---

## 5. TEST ERRORS

| Test File | Error Type | Safe or Unsafe | Evidence | Severity | Fix Direction |
|-----------|-----------|----------------|----------|----------|---------------|
| `tests/openAppSmokeTest.ts` | **Unsafe** — actually launches real apps (YouTube in browser, Notepad, CMD window) | ❌ UNSAFE | Calls `execute({ target })` from `skills/automation/skill.ts` which runs `start` shell commands; listed in `test:voice-core` script | HIGH | Add `--dry-run` mode or mock the skill execution; move to a separate `test:integration` script |
| `tests/latencySmokeTest.ts` | Integration test disguised as unit test — calls `orchestrator.process()` which makes real LLM API calls | ❌ UNSAFE (network) | Imports `orchestrator`, calls `process()` — requires `JARVIS_BRAIN_MODEL`, Groq API key, and model to be running | HIGH | Mock the LLM call; or clearly label as integration test and exclude from `test:voice-core` |
| `tests/bargeInEchoTest.ts` | **Orphaned** — exists in `/tests/` but NOT listed in any npm test script | ⚠️ SAFE but orphaned | Not in `test:voice-core`, `test:pc-control`, or `test:all` | MEDIUM | Add to appropriate test script |
| `tests/securityGateUnitTest.ts` | **Orphaned** — exists in `/tests/` but NOT listed in any npm test script | ✅ SAFE | Pure in-memory risk classification tests; not in any script | MEDIUM | This is the safest, most valuable test — add to `test:voice-core` immediately |
| `tests/watchdogUnitTest.ts` | **Orphaned** — exists in `/tests/` but NOT listed in any npm test script | ✅ SAFE | Pure in-memory timing tests on AgentStateMachine; not in any script | MEDIUM | Add to `test:voice-core` |
| `tests/interruptGatingTest.ts` | Test logic copies exact handler from `jarvis.ts` but the copy is **incomplete** — does not include the `BUSY_STATES` interrupt path from `wake_word` handler | ⚠️ Partial proof | Test only validates SPEAKING-state barge-in; does not test barge-in during PLANNING/EXECUTING | MEDIUM | Expand test to cover all BUSY_STATES |
| `tests/noThinkMemoryTest.ts` | Calls `(orchestrator as any).streamDirectChat()` — accesses private method | ⚠️ Fragile | Uses `as any` cast to access private API; will silently break if method is renamed | MEDIUM | Expose a testable interface or use the public `process()` API |
| `tests/voiceRouteMockTest.ts` | Manually emits log lines to simulate NodeBridge — asserts on log string content | ⚠️ Brittle | Test writes `origLog('[NodeBridge] RX type=client_ready role=wakeword')` manually; if log format changes, test breaks | LOW | Assert on state changes and return values, not log strings |
| `package.json` `"test"` script | `exit 1` by design — running `pnpm test` always fails | ❌ Broken | Script body: `echo "Error: no test specified" && exit 1` | HIGH | Replace with `npm run test:all` or a proper test runner |
| Root-level `stabilityTest.ts` | Large test file (14 KB) at project root — not in any npm test script | ⚠️ Unlisted | Confirmed at root; calls `messageBus.publish`, `memoryManager`, etc. | MEDIUM | Move to `tests/` and add to test script |
| Root-level `stateMachineVerification.ts` | Large file (17 KB) at project root — not in any npm test script | ⚠️ Unlisted | Confirmed at root | MEDIUM | Move to `tests/` and add to test script |
| Root-level `test_production_hardening.ts` | 16 KB test file at project root — not in any npm test script | ⚠️ Unlisted | Confirmed at root | MEDIUM | Move to `tests/` and add to test script |
| Root-level `test_node_redis.ts` | Redis test at project root — not in any npm test script | ⚠️ UNSAFE (network) | Will attempt Redis connection; not in any script | MEDIUM | Move to `tests/integration/` with clear label |

---

## 6. DUPLICATE / UNUSED / STALE / STUB COMPONENTS

| File/Folder | Problem Type | Evidence | Risk | Later Action |
|-------------|-------------|----------|------|--------------|
| core/toolRegistry.ts | Duplicate + Stale | Self-documented as TOMBSTONED; 	oolRegistryV2.ts exists and is actively used | Confusion for new developers; compile overhead | **Delete** |
| core/brain.ts | Stale orphan | Not imported anywhere; v2 uses orchestrator.ts directly | If accidentally imported, double-initializes 7 pipeline modules | **Delete** after Stage 2 |
| core/interruptManager.ts | Stale / Duplicate | Not imported; gentStateMachine.interrupt() handles all interrupts | Memory waste; confusing for developers | **Delete** |
| core/skillRegistry.ts | Stale / Duplicate | Not imported; skillLoader.ts loads into 	oolRegistryV2, not skillRegistry | Dead concept; no skills actually register here | **Delete** |
| core/commandSafety.ts | Duplicate safety logic | Imported only by 	ools/terminalTool.ts; overlaps significantly with security/permissionManager.ts | Two safety systems for terminal commands with different allowlists | Consolidate into permissionManager.ts |
| memory/contextBuilder.ts vs memory/unifiedContextBuilder.ts | Duplicate context builders | Both exist; unclear which is authoritative; orchestrator uses contextBuilder.ts | Divergent context logic could cause LLM prompt inconsistency | Confirm which is active; delete the other |
| core/consciousnessClock.ts | Stub / disconnected | No singleton; not imported anywhere; replaced by event-driven orchestrator | Dead class definition | **Delete** |
| gents/codingAgent.ts | Pure stub | export {} only — 37 bytes | No agent logic exists | Delete or implement |
| gents/jarvisAgent.ts | Pure stub | export {} only — 37 bytes | No agent logic exists | Delete or implement |
| gents/systemAgent.ts | Pure stub | export {} only — 37 bytes | No agent logic exists | Delete or implement |
| gents/researchAgent.py | Pure stub | Empty Python file | Wrong language; no logic | Delete |
| execution/skillExecutor.ts | Self-declared TOMBSTONED | File header says SAFE TO DELETE | Dead file increasing compile surface | **Delete** |
| execution/toolSelector.ts | Stub — identity function | selectTool() returns its input unchanged | No tool selection logic | Delete |
| utonomy/longTaskRunner.ts | Stub | un() just awaits its argument; "offload to worker thread" is a comment | False sense of concurrency safety | Delete or implement |
| utonomy/selfCorrection.ts | Mock | Returns hardcoded "retry_with_fallback" | Not called; fake recovery | Delete |
| utonomy/scheduler.ts | Disconnected | Not imported by anything | No jobs are scheduled | Wire to rainLoop or delete |
| 	ools/dispatcher.ts | Mock — fake success | Returns { success: true, result: 'Executed X' } always | Not imported; false routing guarantee | Delete |
| 	ools/claudeCodeTool.ts | Mock | Returns hardcoded string | Not imported; gives false impression of Claude integration | Delete or implement |
| learning/selfAudit.ts | Mock | Hardcoded performanceScore = 0.95 | Not imported; fake telemetry | Delete |
| simulation/worldModel.ts | Disconnected | Subscribes to messageBus events never published by v2 orchestrator | Registers dead handlers; message subscriptions consume EventEmitter slots | Delete or re-wire to v2 |
| conversation/contextManager.ts | Unused wrapper | Thin wrapper around memoryManager; not imported anywhere | Redundant abstraction | Delete (memoryManager already provides this) |
| system/codeGenerator.ts | Disconnected | Not imported; generates skill files but nothing calls it | Dead generator | Delete or wire to skill scaffolding workflow |
| system/containerManager.ts | Mock | Console.log only; not imported | No real sandboxing | Delete |
| system/installer.ts | Disconnected | Not imported; executes 
pm install via child_process.exec | Security risk if connected carelessly | Delete or gate behind strict permission check |
| oice/wakeWord.py | Dead stub | 21 bytes — comment only; wakeWords.py (16 KB) is the real file | Name-collision confusion | **Delete** |
| jarvis_structure.txt | Junk file | 11.29 MB — generated structural dump | Massive git bloat; slows editor file watchers | **Delete + gitignore *.txt** |
| project_tree.txt | Junk file | 11.29 MB — same | Same as above | **Delete** |
| resh_structure.txt | Junk file | 23 KB structural dump at root | Clutter | Delete |
| older_structure.txt | Junk file | 1.3 KB structural dump at root | Clutter | Delete |
| jarvis-clean-folder-tree.txt | Junk file | 16 KB folder tree dump at root | Clutter | Delete |
| nalyze.ts | Dev utility at wrong location | Root-level; compiled by tsc; not a runtime module | Adds compile overhead | Move to scripts/ + exclude from tsconfig |
| count_modules.ts | Dev utility at wrong location | Same as above | Same | Move to scripts/ |
| debug_imports.ts | Dev utility at wrong location | Same | Same | Move to scripts/ |
| ind_importers.ts | Dev utility at wrong location | Same | Same | Move to scripts/ |
| ix_executor.ts | Dev utility at wrong location | Same | Same | Move to scripts/ |
| ix_imports.ts | Dev utility at wrong location | Same | Same | Move to scripts/ |
| efactor_mem.ts | Dev utility at wrong location | Same | Same | Move to scripts/ |
| efactor_p2.ts | Dev utility at wrong location | Same | Same | Move to scripts/ |
| eport.ts.bak | Backup file in repo | .bak extension; stale content | Should never be in version control | Delete |
| 	emp_stt_1777830229.wav | Temp artifact in repo | 137 KB WAV file leftover from STT debugging | Should never be in version control | **Delete** |

---

## 7. MISSING TEST COVERAGE ERRORS

| Module/File | Missing Test Type | Risk | Severity | Recommended Test Later |
|-------------|-------------------|------|----------|----------------------|
| core/orchestrator.ts (54 KB) | No direct unit test for PLAN→EXECUTE→OBSERVE→REFLECT→REPAIR cycle | Any regression in orchestrator state machine is invisible | HIGH | Integration test for each state transition; mock LLM responses |
| self_healing/selfHealingManager.ts | No test for Python service restart logic | If restart logic regresses, Python voice services silently die | HIGH | Mock child_process.spawn; verify restart on process exit |
| ridge/nodeBridge.ts | No test for WebSocket message routing (actual WS frames) | Message routing bugs are silent until voice breaks at runtime | HIGH | Unit test with real WebSocket server on random port |
| memory/memoryManager.ts (29 KB) | No test for lush(), uildContextSummary(), or Redis fallback | Memory corruption or context truncation goes undetected | HIGH | Unit test with in-memory LowDB; test all public methods |
| core/agentStateMachine.ts | Watchdog tests exist but are **not in any npm script** (watchdogUnitTest.ts orphaned) | Watchdog regressions go undetected | HIGH | Add watchdogUnitTest.ts to 	est:voice-core immediately |
| security/permissionManager.ts | securityGateUnitTest.ts exists and is SAFE but **orphaned** from npm scripts | Security gate regressions undetected | CRITICAL | Add securityGateUnitTest.ts to 	est:voice-core immediately |
| control/pcControlKernel.ts (19 KB) | pcControlKernelTest.ts is in 	est:pc-control but no test for rollback on failed sequence | Partial PC control sequences could leave system in broken state | HIGH | Add rollback path test |
| control/permissionSession.ts | permissionSessionTest.ts exists but does not test session expiry under load | Expired sessions could silently grant elevated access | MEDIUM | Add time-mock test for session expiry edge case |
| self_healing/pipelineWatchdog.ts | No test — monitors eflection_loop pipeline that references a missing file | Watchdog produces errors for a pipeline that can never succeed | MEDIUM | Create test; also fix missing eflectionEngine.py |
| memory/vectorMemorySupervisor.ts | No test for supervisor start/stop/restart lifecycle | Vector memory could silently fail to start | MEDIUM | Mock Python process; test supervisor state transitions |
| oice/stt.py (17 KB) | No Python test for STT pipeline | STT failures cause silent voice degradation | MEDIUM | Add pytest unit tests for audio processing and WebSocket message format |
| oice/tts.py (10 KB) | No Python test | TTS failures cause no spoken output — hard to debug remotely | MEDIUM | Add pytest for TTS queue processing and WebSocket protocol |
| oice/wakeWords.py (16 KB) | No Python test | Wake word detection regression goes unnoticed | MEDIUM | Add pytest for keyword matching logic |

---

## 8. STAGE 1 PRIORITY ERROR TABLE

| Priority | Area | Error | Severity | Evidence | Fix Direction | Should Fix Now? |
|----------|------|-------|----------|----------|---------------|-----------------|
| P1 | Runtime | oice/reflectionEngine.py missing — referenced in 3 active files | CRITICAL | jarvis.ts:509, pipelineWatchdog.ts:25, sWatcher.ts:27 | Create minimal Python stub or remove all 3 references | **YES** |
| P2 | Tests | 
pm test / pnpm test fails by design | HIGH | package.json "test" script = exit 1 | Change to 
pm run test:all | **YES** |
| P3 | Tests | openAppSmokeTest.ts opens real apps in CI — dangerous in automated runs | HIGH | Listed in 	est:voice-core; calls actual start shell commands | Extract to 	est:integration script; add mock mode | **YES** |
| P4 | Architecture | Legacy messageBus v1 pipeline (7 modules) loads into RAM but is never triggered | HIGH | rain.ts not imported by runtime; all 7 modules start subscriptions to messageBus events that never fire | Stage 2 cleanup: delete rain.ts and verify grokCore detachment | Stage 2 |
| P5 | Tests | securityGateUnitTest.ts is a SAFE, high-value test that is orphaned from all npm scripts | HIGH | Not in 	est:voice-core or 	est:pc-control | Add to 	est:voice-core | **YES** |
| P6 | Tests | watchdogUnitTest.ts is SAFE and orphaned | MEDIUM | Not in any npm script | Add to 	est:voice-core | **YES** |
| P7 | Tests | argeInEchoTest.ts is SAFE and orphaned | MEDIUM | Not in any npm script | Add to 	est:voice-core | **YES** |
| P8 | Deps | 
ext, eact, eact-dom in production deps — add ~100 MB to install | MEDIUM | package.json confirmed | Move to pp/package.json or devDependencies | YES (quick win) |
| P9 | Structure | Competing entrypoints: index.ts silently creates partial JARVIS with no voice pipeline | HIGH | Both boot orchestrator; index.ts skips nodeBridge/selfHealingManager | Add deprecation warning to index.ts or delete it | Stage 2 |
| P10 | Structure | 22+ MB of junk text dumps at project root slow git and IDEs | MEDIUM | jarvis_structure.txt (11 MB) + project_tree.txt (11 MB) confirmed | Delete both files; add *.txt to .gitignore at root level | **YES** |
| P11 | Structure | 8 developer utility scripts compiled by 	sc alongside production code | MEDIUM | 	sconfig.json include: ["**/*.ts"] | Move to scripts/ folder; add exclude to tsconfig | YES (quick win) |
| P12 | Structure | core/toolRegistry.ts still compiled despite TOMBSTONED header | MEDIUM | Self-documented as SAFE TO DELETE | Delete | YES (quick win) |
| P13 | Structure | execution/skillExecutor.ts still compiled despite TOMBSTONED header | MEDIUM | Self-documented as SAFE TO DELETE | Delete | YES (quick win) |
| P14 | Memory | 
eo4j-driver dependency: if Neo4j is not running, graphMemory.ts fails at init | MEDIUM | memory/graphMemory.ts uses 
eo4j-driver without graceful fallback | Add try/catch guard and fallback-to-local-DB mode | Stage 2 |
| P15 | Tests | 	ests/latencySmokeTest.ts makes real LLM API calls — not a unit test | HIGH | Calls orchestrator.process() which requires real Groq API + model | Label as integration test; move to 	est:integration | Stage 2 |

---

## 9. STAGE 1 FINAL ERROR VERDICT

### What foundation errors are blocking progress?

**Semi-blocking (will cause errors when triggered):**
- oice/reflectionEngine.py is missing. If scheduleReflection() is re-enabled (currently commented out), JARVIS will crash the reflection job. The selfHealingManager watchdog also monitors this pipeline — it cannot self-heal a script that does not exist.
- pnpm test / 
pm test fails immediately. No CI can pass a test gate.

**Not blocking runtime today but will cause bugs tomorrow:**
- The 7-module legacy messageBus pipeline occupies RAM and CPU for subscriptions that never fire. On an 8 GB Windows machine, this is meaningful waste.
- The competing index.ts entrypoint will mislead any future contributor who runs it expecting full JARVIS.

---

### What is duplicated?

| What | Where |
|------|-------|
| Tool Registry | core/toolRegistry.ts (v1, TOMBSTONED) vs core/toolRegistryV2.ts (active) |
| Safety validation | core/commandSafety.ts (terminal-level allowlist) vs security/permissionManager.ts (full risk classifier) |
| Context building | memory/contextBuilder.ts (used by orchestrator) vs memory/unifiedContextBuilder.ts (not clearly wired) |
| Interrupt handling | core/interruptManager.ts (orphaned) vs gentStateMachine.interrupt() (active) |
| Entrypoints | jarvis.ts (full) vs index.ts (partial, no voice) |

---

### What is stale or unused?

The following are confirmed as not imported by any active runtime path:

core/brain.ts, core/interruptManager.ts, core/skillRegistry.ts, core/consciousnessClock.ts, core/toolRegistry.ts, easoning/grokCore.ts (v2 only, unused via messageBus), easoning/decisionRouter.ts, perception/inputProcessor.ts, perception/intentAnalyzer.ts, perception/semanticCache.ts, planner/taskPlanner.ts, planner/goalDecomposer.ts, utonomy/taskQueue.ts (messageBus path), utonomy/scheduler.ts, utonomy/longTaskRunner.ts, utonomy/selfCorrection.ts, execution/skillExecutor.ts, execution/toolSelector.ts, 	ools/dispatcher.ts, 	ools/claudeCodeTool.ts, system/codeGenerator.ts, system/containerManager.ts, system/installer.ts, simulation/worldModel.ts, conversation/contextManager.ts, learning/selfAudit.ts, gents/supervisorAgent.ts.

---

### What is fake/stub?

| File | Fake Behavior |
|------|--------------|
| gents/codingAgent.ts | export {} — empty |
| gents/jarvisAgent.ts | export {} — empty |
| gents/systemAgent.ts | export {} — empty |
| gents/researchAgent.py | Empty Python file |
| utonomy/selfCorrection.ts | Returns hardcoded "retry_with_fallback" always |
| 	ools/dispatcher.ts | Returns { success: true } always |
| 	ools/claudeCodeTool.ts | Returns hardcoded string |
| learning/selfAudit.ts | Returns hardcoded  .95 score |
| system/containerManager.ts | Console.log only — no real containers |
| execution/toolSelector.ts | Identity function — returns input unchanged |

---

### What is broken in TypeScript or tests?

- **TypeScript compile:** ✅ Zero errors (	sc --noEmit exits 0)
- **
pm test:** ❌ Broken by design — exits 1 immediately
- **	ests/openAppSmokeTest.ts:** ❌ Unsafe — opens real apps during test run
- **	ests/latencySmokeTest.ts:** ❌ Unsafe — makes real LLM API calls
- **	ests/bargeInEchoTest.ts:** ⚠️ Orphaned — never executed by any script
- **	ests/securityGateUnitTest.ts:** ⚠️ Orphaned — never executed despite being SAFE
- **	ests/watchdogUnitTest.ts:** ⚠️ Orphaned — never executed despite being SAFE
- **Root-level stabilityTest.ts, stateMachineVerification.ts, 	est_production_hardening.ts:** ⚠️ Not in any npm script

---

### What must be investigated in Stage 2?

1. **core/orchestrator.ts internals (54 KB)** — confirm it does not call messageBus.publish() for any event the legacy grokCore listens to (would mean double-processing)
2. **easoning/grokCore.ts instantiation** — confirm grokCore singleton constructor is never called in v2 runtime path. If it is, all 3 messageBus subscriptions fire even though events never arrive — wasted RAM
3. **Memory subsystem under load** — memory/memoryManager.ts (29 KB), memory/vectorMemorySupervisor.ts, Redis connection stability on 8 GB Windows
4. **control/pcControlKernel.ts (19 KB) rollback behavior** — critical safety path for PC control commands
5. **self_healing/selfHealingManager.ts restart loop stability** — confirm Python process restarts don't accumulate zombie processes
6. **memory/graphMemory.ts Neo4j connection error handling** — confirm fails gracefully when Neo4j is offline
7. **ridge/nodeBridge.ts message queuing** — confirm pendingTTS and pendingListenStart queues drain correctly under rapid-fire voice commands
8. **Confirm grokCore LLM path is truly dead in v2** — or document it as an intentional fallback
