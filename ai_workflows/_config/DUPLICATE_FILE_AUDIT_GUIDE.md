# DUPLICATE_FILE_AUDIT_GUIDE.md — Windows-Safe Duplicate File Audit

> **Audit method:** Both import checks AND raw filename usage in spawn/exec/python calls.
> **Labels used:** KEEP · ACTIVE RUNTIME · ACTIVE TEST · LEGACY BUT REFERENCED ·
>                  NO IMPORTERS FOUND · ARCHIVE CANDIDATE · NEEDS HUMAN REVIEW ·
>                  DANGEROUS TO DELETE · UNKNOWN
> **Last audited:** 2026-06-19
> **Status:** Read-only audit — no files moved or renamed during this pass.

---

## How to Check for Windows Runtime-Launched Files

On this project, files may be launched not via `import` but via:
- `spawn(pythonExe, [scriptPath])` — selfHealingManager.ts
- `exec(...)` — system/installer.ts, tools/systemTool.ts
- Raw `.py` filename strings passed to `launchPythonService()`

**Always check both:**

```powershell
# 1. Import check
Select-String -Path ".\**\*.ts", ".\**\*.py" -Pattern "<filename>" `
  -ErrorAction SilentlyContinue | Where-Object { $_.Path -notmatch "node_modules|.venv|ai_workflows" }

# 2. Runtime launch checks
Select-String -Path ".\**\*.ts" -Pattern "spawn"   -ErrorAction SilentlyContinue
Select-String -Path ".\**\*.ts" -Pattern "exec"    -ErrorAction SilentlyContinue
Select-String -Path ".\**\*.ts" -Pattern "python"  -ErrorAction SilentlyContinue
Select-String -Path ".\**\*.ts" -Pattern "\.py"    -ErrorAction SilentlyContinue
```

---

## Before Any Archive Action — Git Checkpoint

```powershell
git status
git add .
git commit -m "checkpoint before duplicate file archive audit"
```

After any approved archive action, run:

```powershell
npx tsc --noEmit
npx tsx tests/nodeBridgeSingletonTest.ts
npx tsx tests/voiceRouteMockTest.ts
npx tsx tests/openAppSmokeTest.ts "youtube"
npx tsx tests/openAppSmokeTest.ts "notepad"
```

If any test fails → rollback immediately:
```powershell
git checkout -- .
```

---

## Archive Folder Convention

```
_archive/manual_review/YYYY-MM-DD/<original-path>/
```

Example:
```
_archive/manual_review/2026-06-19/core/toolRegistry.ts
```

**Never permanently remove. Only move. Only after human approval.**

---

## ⚠️ Pair 1: voice/wakeWord.py vs voice/wakeWords.py

### Audit Results

**Import check:**
```
voice/wakeWord.py   → line 1 only: "# voice/wakeWord.py"  (self-reference comment)
                      No other file imports or references "wakeWord.py" by name
voice/wakeWords.py  → Referenced in jarvis.ts + wakeWords.py itself
```

**Runtime launch check (spawn):**
```
jarvis.ts line 102:
  selfHealingManager.launchPythonService('wakeWords.py', 'WakeWord');
                                          ^^^^^^^^^^^
  → The exact string 'wakeWords.py' is passed to the spawner
  → selfHealingManager.ts line 95 builds: path.join(VOICE_DIR, entry.script)
  → Spawns: voice/wakeWords.py  ← the ACTIVE file

  voice/wakeWord.py is NOT referenced anywhere in spawn calls.
```

**Conclusion:**

| File | Label | Reason |
|---|---|---|
| `voice/wakeWords.py` | 🔴 **ACTIVE RUNTIME** | Spawned by `jarvis.ts` line 102 via `selfHealingManager`. 15,961 bytes. Full implementation. |
| `voice/wakeWord.py` | 🟡 **ARCHIVE CANDIDATE** | 21 bytes. Comment only. No importers. Not spawned by any runtime code. Safe to archive after human approval. |

**Action required:** Human must approve before archiving `voice/wakeWord.py`.
Verify first: `Select-String -Path ".\**\*" -Pattern "wakeWord\.py" -ErrorAction SilentlyContinue`

---

## ⚠️ Pair 2: core/toolRegistry.ts vs core/toolRegistryV2.ts

### Audit Results

**Import check for toolRegistry.ts (V1):**
```
toolRegistry.ts line 2:  "@deprecated core/toolRegistry.ts - LEGACY V1 (TOMBSTONED 2026-06-10)"
toolRegistry.ts line 7:  documents what V2 replaced
grokCore.ts line 3:      "// toolRegistry (v1) removed - toolRegistryV2 is the single execution authority"
                          ← This is a COMMENT saying it was removed, not an import
orchestrator.ts:         references "ToolRegistry" only in log strings
skillLoader.ts:          references "ToolRegistry" only in log strings
healthManager.ts:        has probeToolRegistry() — but imports from toolRegistryV2.ts
```

**No active TypeScript file has `import ... from '...toolRegistry.js'` (V1 only).**

**Import check for toolRegistryV2.ts (V2):**
```
orchestrator.ts         → import toolRegistryV2
selfHealingManager.ts   → import toolRegistryV2
core/tools/index.ts     → uses toolRegistryV2
skillLoader.ts          → uses toolRegistryV2
All test files          → use toolRegistryV2
```

**Conclusion:**

| File | Label | Reason |
|---|---|---|
| `core/toolRegistryV2.ts` | 🔴 **ACTIVE RUNTIME** | Imported by orchestrator, selfHealingManager, skillLoader, all tests. |
| `core/toolRegistry.ts` | 🟢 **ARCHIVE CANDIDATE** | Self-tombstoned 2026-06-10. No active imports found. Only referenced in comments. |

**Action required:** Confirm with one final check before archiving:
```powershell
Select-String -Path ".\**\*.ts" -Pattern "from.*['\"].*toolRegistry['\"]" `
  | Where-Object { $_.Line -notmatch "toolRegistryV2" } `
  | Where-Object { $_.Path -notmatch "node_modules|ai_workflows|toolRegistry\.ts" }
```
If zero results → safe to archive with human approval.

---

## ⚠️ Pair 3: memory/contextBuilder.ts vs memory/unifiedContextBuilder.ts

### Audit Results

**Import check for contextBuilder.ts:**
```
orchestrator.ts line 35: import { unifiedContextBuilder } from '../memory/unifiedContextBuilder.js'
                          ← Uses UNIFIED version, not contextBuilder

contextBuilder.ts:        Contains its own class ContextBuilder + export contextBuilder
                          No external file imports contextBuilder.ts directly
```

**Import check for unifiedContextBuilder.ts:**
```
orchestrator.ts           → imports unifiedContextBuilder ✅ ACTIVE
```

**Notable content in contextBuilder.ts:**
```
Contains rankFactsFusion() — a sophisticated fact-ranking algorithm
This algorithm may not exist in unifiedContextBuilder.ts
Port rankFactsFusion() before archiving
```

**Conclusion:**

| File | Label | Reason |
|---|---|---|
| `memory/unifiedContextBuilder.ts` | 🔴 **ACTIVE RUNTIME** | Imported by orchestrator.ts. Do not touch. |
| `memory/contextBuilder.ts` | 🟡 **LEGACY BUT REFERENCED** | No active importers but contains `rankFactsFusion()` algorithm worth preserving. Marked `@deprecated`. |

**Action required before archiving `contextBuilder.ts`:**
1. Read `rankFactsFusion()` — determine if its logic is replicated in `unifiedContextBuilder.ts`
2. If not replicated → port the algorithm first, then archive
3. Human approval required

---

## ⚠️ Pair 4: memory/cacheManager.ts vs memory/redisCache.ts

### Audit Results

**Import check for cacheManager.ts:**
```
grokCore.ts line 9:   import { cacheManager } from '../memory/cacheManager.js'
grokCore.ts line 125: cacheManager.getLLMCache(...)
grokCore.ts line 156: cacheManager.setLLMCache(...)
grokCore.ts line 266: cacheManager.setLLMCache(...)
```

**Import check for redisCache.ts:**
```
contextBuilder.ts line 19:       import { getCachedContextPacket, cacheContextPacket } from "./redisCache.js"
memoryManager.ts line 36:        import from "./redisCache.js"
unifiedContextBuilder.ts line 10: import { getCachedRecentMessages } from './redisCache.js'
healthManager.ts line 78:        dynamic import redisCache
```

**These are NOT duplicates — they serve different purposes:**

| File | Label | What It Caches | Imported By |
|---|---|---|---|
| `memory/cacheManager.ts` | 🔴 **ACTIVE RUNTIME** | LLM inference results + tool results (in-memory Map) | `grokCore.ts` |
| `memory/redisCache.ts` | 🔴 **ACTIVE RUNTIME** | Context packets + recent messages (Redis) | `contextBuilder.ts`, `memoryManager.ts`, `unifiedContextBuilder.ts` |

**Verdict:** These are complementary, not duplicate. Both must be KEPT.

---

## ⚠️ Pair 5: planner/taskPlanner.ts and planner/goalDecomposer.ts

### Audit Results

**Import check for taskPlanner.ts:**
```
backend/taskQueue.ts line 1: import { PlanStep } from '../planner/taskPlanner.js'
brain.ts line 9:             import '../planner/taskPlanner.js'    ← side-effect import
goalDecomposer.ts line 1:   import { PlanStep } from './taskPlanner.js'
taskPlanner.ts line 2:      import { goalDecomposer } from './goalDecomposer.js'
```

**⚠️ Critical finding: `brain.ts` imports `taskPlanner.js` as a side effect.**

This means `TaskPlanner` subscribes to `messageBus` events on startup because `brain.ts` is in the import chain. This is NOT safe to archive without understanding what `brain.ts` does and whether `taskPlanner.ts`'s `messageBus` subscriptions are still needed.

| File | Label | Reason |
|---|---|---|
| `planner/taskPlanner.ts` | 🔴 **LEGACY BUT REFERENCED** | Imported by `brain.ts` as side effect. Has active `messageBus` subscription. Cannot archive without removing the import from `brain.ts`. |
| `planner/goalDecomposer.ts` | 🔴 **LEGACY BUT REFERENCED** | Imported by `taskPlanner.ts`. Cannot archive while `taskPlanner.ts` is active. |
| `autonomy/taskQueue.ts` | 🔴 **LEGACY BUT REFERENCED** | Imports `PlanStep` from `taskPlanner.ts`. All three are coupled. |

**Action required:** Do not archive any of these three until `brain.ts` import is understood and resolved. Needs human review of whether the messageBus pipeline is still intended.

---

## ⚠️ Stub Files — execution/ and agents/

### Audit Results

**skillExecutor.ts:**
```
execution/skillExecutor.ts line 1: "@deprecated execution/skillExecutor.ts — TOMBSTONED 2026-06-10"
No file imports it.
```

**toolSelector.ts:**
```
execution/toolSelector.ts: Returns input unchanged. No importers found.
```

**Agent stubs:**
```
agents/codingAgent.ts:  export {} only
agents/jarvisAgent.ts:  export {} only
agents/systemAgent.ts:  export {} only

Select-String found NO imports of these from any other file.
```

| File | Label |
|---|---|
| `execution/skillExecutor.ts` | 🟢 **ARCHIVE CANDIDATE** — Tombstoned, no importers |
| `execution/toolSelector.ts` | 🟢 **ARCHIVE CANDIDATE** — No importers, stub body |
| `agents/codingAgent.ts` | 🟢 **ARCHIVE CANDIDATE** — No importers, `export {}` only |
| `agents/jarvisAgent.ts` | 🟢 **ARCHIVE CANDIDATE** — No importers, `export {}` only |
| `agents/systemAgent.ts` | 🟢 **ARCHIVE CANDIDATE** — No importers, `export {}` only |

**Human approval required before archiving any of these.**

---

## Summary Table

| File | Label | Safe to Archive? | Notes |
|---|---|---|---|
| `voice/wakeWords.py` | 🔴 ACTIVE RUNTIME | ❌ Never | Spawned by jarvis.ts line 102 |
| `voice/wakeWord.py` | 🟢 ARCHIVE CANDIDATE | ✅ After approval | 21 bytes, comment only, not spawned |
| `core/toolRegistryV2.ts` | 🔴 ACTIVE RUNTIME | ❌ Never | Used everywhere |
| `core/toolRegistry.ts` | 🟢 ARCHIVE CANDIDATE | ✅ After final grep + approval | Self-tombstoned, no active imports |
| `memory/unifiedContextBuilder.ts` | 🔴 ACTIVE RUNTIME | ❌ Never | Used by orchestrator |
| `memory/contextBuilder.ts` | 🟡 LEGACY BUT REFERENCED | ⚠️ Port `rankFactsFusion()` first | No active importers but has valuable algorithm |
| `memory/cacheManager.ts` | 🔴 ACTIVE RUNTIME | ❌ Never | Used by grokCore (LLM cache) |
| `memory/redisCache.ts` | 🔴 ACTIVE RUNTIME | ❌ Never | Used by memoryManager, contextBuilders |
| `planner/taskPlanner.ts` | 🔴 LEGACY BUT REFERENCED | ❌ Not yet | Imported by brain.ts as side-effect |
| `planner/goalDecomposer.ts` | 🔴 LEGACY BUT REFERENCED | ❌ Not yet | Coupled with taskPlanner |
| `autonomy/taskQueue.ts` | 🔴 LEGACY BUT REFERENCED | ❌ Not yet | Coupled with taskPlanner |
| `execution/skillExecutor.ts` | 🟢 ARCHIVE CANDIDATE | ✅ After approval | Tombstoned, no importers |
| `execution/toolSelector.ts` | 🟢 ARCHIVE CANDIDATE | ✅ After approval | Stub, no importers |
| `agents/codingAgent.ts` | 🟢 ARCHIVE CANDIDATE | ✅ After approval | export {} only, no importers |
| `agents/jarvisAgent.ts` | 🟢 ARCHIVE CANDIDATE | ✅ After approval | export {} only, no importers |
| `agents/systemAgent.ts` | 🟢 ARCHIVE CANDIDATE | ✅ After approval | export {} only, no importers |

---

## Archive Procedure (When Approved)

```powershell
# 1. Git checkpoint
git add .
git commit -m "checkpoint before duplicate file archive audit"

# 2. Create archive folder
New-Item -ItemType Directory -Path "_archive\manual_review\2026-06-19" -Force

# 3. Move approved files (example — only run after human approval)
# Move-Item "voice\wakeWord.py" "_archive\manual_review\2026-06-19\wakeWord.py"

# 4. Run verification suite
npx tsc --noEmit
npx tsx tests/nodeBridgeSingletonTest.ts
npx tsx tests/voiceRouteMockTest.ts
npx tsx tests/openAppSmokeTest.ts "youtube"
npx tsx tests/openAppSmokeTest.ts "notepad"

# 5. If tests fail → rollback
git checkout -- .
```
