# DUPLICATE_FILE_AUDIT_GUIDE.md — Windows-Safe Duplicate File Audit

> **Audit method:** Both import checks AND raw filename usage in spawn/exec/python calls.
> **Labels used:** KEEP · ACTIVE RUNTIME · ACTIVE TEST · LEGACY BUT REFERENCED ·
>                  NO IMPORTERS FOUND · ARCHIVE CANDIDATE · NEEDS HUMAN REVIEW ·
>                  DANGEROUS TO DELETE · UNKNOWN
> **This file:** the procedure for a read-only audit, and a summary of the
> last one. Detailed findings of 2026-06-19: `DUPLICATE_AUDIT_2026-06-19.md`
> and `DUPLICATE_AUDIT_2026-06-19_PART2.md` (history).
> An audit is read-only: no file is moved, renamed or deleted during it.

---

## How to Check for Windows Runtime-Launched Files

On this project, files may be launched not via `import` but via:
- `spawn(pythonExe, [scriptPath])` — `self_healing/selfHealingManager.ts`
  (`launchPythonService()` builds the path from a raw `.py` file name)
- `exec` / `spawn` of commands — e.g. `control/appController.ts`,
  `control/processController.ts`, `tools/devTools.ts`, `tools/gitTools.ts`
  (2026-06 examples `system/installer.ts` and `tools/systemTool.ts` are now in `_legacy/`)

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

Record each result with the command, the date and the commit, in a run
folder (`ai_workflows/runs/`), as Stage 01 and 02 evidence.

---

## Before Any Archive Action — Git Checkpoint

```powershell
git status
```

Commit only the tracked changes you made, by name (`git add -- <file> ...`).
Never `git add .` or `git add -A`: the owner keeps untracked personal files
and runtime data in the working tree (notes, `data/brain/`), which must not be
staged.

After any approved archive action, run (each test isolated by the runner):

```powershell
pnpm run typecheck
pnpm test -- --only=nodeBridgeSingletonTest,voiceRouteMockTest,openAppSmokeTest
```

Do not run test files directly (`npx tsx tests/<name>.ts` is prohibited: it
writes to JARVIS's real data). The runner checks open_app for "youtube" in
dry-run mode only; there is no isolated "notepad" case.

If any test fails → put back only the files you moved:
```powershell
Move-Item "<archive path>" "<original path>"
```
Never `git checkout -- .` or `git reset --hard`: they discard every
uncommitted change in the working tree, not only yours.

---

## Archive Folder Convention

Since 2026-09 the project has quarantined unreachable modules in
`_legacy/<original-path>` (see `_legacy/README.md`); the 2026-06 guide proposed:

```
_archive/manual_review/YYYY-MM-DD/<original-path>/
```

Ask the owner which one to use before moving anything.

**Never permanently remove. Only move. Only after human approval.**
A move of a runtime file is a patch plan (Stage 03) with approval.

---

## Archive Procedure (When Approved)

```powershell
# 1. Git checkpoint: only the tracked files you changed, by name
git status
# git add -- <file> ...    (never "git add ." or "git add -A")
# git commit -m "checkpoint before duplicate file archive audit"

# 2. Create the archive folder the owner chose, e.g.
New-Item -ItemType Directory -Path "_archive\manual_review\YYYY-MM-DD" -Force

# 3. Move approved files (example — only run after human approval)
# Move-Item "<original path>" "<archive path>"

# 4. Run verification suite (through the runner; never npx tsx tests/<name>.ts)
pnpm run typecheck
pnpm test -- --only=nodeBridgeSingletonTest,voiceRouteMockTest,openAppSmokeTest

# 5. If tests fail → move back only the files you moved, e.g.
# Move-Item "<archive path>" "<original path>"
# (never "git checkout -- ." or "git reset --hard")
```

---

## Summary of the 2026-06-19 Audit, With Current Locations

| File (2026-06 path) | Label then | Safe to Archive? (then) | Notes then | Now (2026-10-23) |
|---|---|---|---|---|
| `voice/wakeWords.py` | 🔴 ACTIVE RUNTIME | ❌ Never | Spawned by jarvis.ts line 102 | Active, same path |
| `voice/wakeWord.py` | 🟢 ARCHIVE CANDIDATE | ✅ After approval | 21 bytes, comment only, not spawned | `_legacy/voice/wakeWord.py` |
| `core/toolRegistryV2.ts` | 🔴 ACTIVE RUNTIME | ❌ Never | Used everywhere | Active, same path |
| `core/toolRegistry.ts` | 🟢 ARCHIVE CANDIDATE | ✅ After final grep + approval | Self-tombstoned, no active imports | `_legacy/core/toolRegistry.ts` |
| `memory/unifiedContextBuilder.ts` | 🔴 ACTIVE RUNTIME | ❌ Never | Used by orchestrator | Active, same path |
| `memory/contextBuilder.ts` | 🟡 LEGACY BUT REFERENCED | ⚠️ Port `rankFactsFusion()` first | No active importers but has valuable algorithm | `_legacy/memory/contextBuilder.ts` |
| `memory/cacheManager.ts` | 🔴 ACTIVE RUNTIME | ❌ Never | Used by grokCore (LLM cache) | `_legacy/memory/cacheManager.ts` (with grokCore) |
| `memory/redisCache.ts` | 🔴 ACTIVE RUNTIME | ❌ Never | Used by memoryManager, contextBuilders | Active, same path |
| `planner/taskPlanner.ts` | 🔴 LEGACY BUT REFERENCED | ❌ Not yet | Imported by brain.ts as side-effect | `_legacy/planner/taskPlanner.ts` (with brain.ts) |
| `planner/goalDecomposer.ts` | 🔴 LEGACY BUT REFERENCED | ❌ Not yet | Coupled with taskPlanner | `_legacy/planner/goalDecomposer.ts` |
| `autonomy/taskQueue.ts` | 🔴 LEGACY BUT REFERENCED | ❌ Not yet | Coupled with taskPlanner | `_legacy/autonomy/taskQueue.ts` |
| `execution/skillExecutor.ts` | 🟢 ARCHIVE CANDIDATE | ✅ After approval | Tombstoned, no importers | `_legacy/execution/skillExecutor.ts` |
| `execution/toolSelector.ts` | 🟢 ARCHIVE CANDIDATE | ✅ After approval | Stub, no importers | `_legacy/execution/toolSelector.ts` |
| `agents/codingAgent.ts` | 🟢 ARCHIVE CANDIDATE | ✅ After approval | export {} only, no importers | `_legacy/agents/codingAgent.ts` |
| `agents/jarvisAgent.ts` | 🟢 ARCHIVE CANDIDATE | ✅ After approval | export {} only, no importers | `_legacy/agents/jarvisAgent.ts` |
| `agents/systemAgent.ts` | 🟢 ARCHIVE CANDIDATE | ✅ After approval | export {} only, no importers | `_legacy/agents/systemAgent.ts` |

Moves: commits c39ca7b (2026-09-06) and fd72ce1 (2026-10-16). Any new
duplicate audit starts from the current tree, not from this table.
