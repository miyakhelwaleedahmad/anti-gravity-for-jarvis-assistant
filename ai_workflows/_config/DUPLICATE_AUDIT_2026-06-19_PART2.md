# DUPLICATE_AUDIT_2026-06-19_PART2.md — Duplicate File Audit Results (History)

> Results of the read-only audit of 2026-06-19, kept as found (part 2 of 2: pairs 4–5 and stub files).
> Part 1: `DUPLICATE_AUDIT_2026-06-19.md`.
> **History, not current status:** every archive or legacy candidate below
> has since been moved into `_legacy/` (commits c39ca7b and fd72ce1), and
> line numbers refer to the code as it was then. Current locations: the
> summary table in `DUPLICATE_FILE_AUDIT_GUIDE.md`, and `ARCH_LEGACY_PATHS.md`.
> **Labels used:** KEEP · ACTIVE RUNTIME · ACTIVE TEST · LEGACY BUT REFERENCED ·
>                  NO IMPORTERS FOUND · ARCHIVE CANDIDATE · NEEDS HUMAN REVIEW ·
>                  DANGEROUS TO DELETE · UNKNOWN

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
