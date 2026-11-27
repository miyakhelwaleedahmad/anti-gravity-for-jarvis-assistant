# DUPLICATE_AUDIT_2026-06-19.md — Duplicate File Audit Results (History)

> Results of the read-only audit of 2026-06-19, kept as found (part 1 of 2: pairs 1–3).
> Part 2: `DUPLICATE_AUDIT_2026-06-19_PART2.md`.
> **History, not current status:** every archive or legacy candidate below
> has since been moved into `_legacy/` (commits c39ca7b and fd72ce1), and
> line numbers refer to the code as it was then. Current locations: the
> summary table in `DUPLICATE_FILE_AUDIT_GUIDE.md`, and `ARCH_LEGACY_PATHS.md`.
> **Labels used:** KEEP · ACTIVE RUNTIME · ACTIVE TEST · LEGACY BUT REFERENCED ·
>                  NO IMPORTERS FOUND · ARCHIVE CANDIDATE · NEEDS HUMAN REVIEW ·
>                  DANGEROUS TO DELETE · UNKNOWN

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

