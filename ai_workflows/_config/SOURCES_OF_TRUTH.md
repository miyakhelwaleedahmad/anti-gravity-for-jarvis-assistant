# SOURCES_OF_TRUTH.md — Where Each Kind of Fact Lives

> One home per fact. Every other file points here or to the home itself.
> Paths checked against the repository on 2026-10-23 (`claude/jarvis-repair`).

| Category | Authority | Notes |
|---|---|---|
| Current runtime failures | `data/repairs/issues.json` under the data root, written only by `core/issueStore.ts` | One issue per failure signature. Lives on the PC that runs JARVIS; not in Git. |
| Failure occurrences | `data/repairs/occurrences.jsonl`, appended by `core/issueStore.ts` | Never edited; rotated at 2 MB. |
| Verified repair lessons | Notes the second brain writes (`memory/secondBrain.ts`, `noteResolvedIssue`) in the vault's Lessons Learned space | Written only for an issue resolved with passing verification evidence. |
| Findings of the 2026-10 audit (54 IDs) | `docs/audit/JARVIS_REPAIR_CHECKLIST.md` | Re-checked every finding after the tracker; latest per-finding status. |
| Other development findings (PC-nn from the owner's PC runs, and IDs not in the checklist) | `docs/remediation/REMEDIATION_TRACKER.md` | For an ID in both files, the checklist wins. |
| 2026-10-23 log audit (BUG-1 to BUG-24) | Commit messages on `claude/jarvis-repair` (`git log --grep=BUG-`) | No tracker file holds these yet: owner decision pending. |
| One maintenance run | `ai_workflows/runs/<YYYY-MM-DD>_<slug>/` | Filled in during the run from the blank stage templates; closed at Stage 07 (`runs/README.md`). A record of the run, not a runtime issue store. |
| Actual architecture | The source code | `_config/ARCHITECTURE_MAP.md`, its `ARCH_*.md` topic files and docs are maintained summaries; code wins. |
| Project or phase status | The tracker for that category (rows above) | `_config/JARVIS_CURRENT_STATUS.md` only points here and keeps dated snapshots. |

The data root is the JARVIS folder unless `JARVIS_DATA_ROOT` is set
(the test runner sets it to an empty temporary folder for each test).

## Rules

1. Obsidian issue notes (`core/obsidianMirror.ts`, vault folders
   `JARVIS/01 Active Errors` and `JARVIS/02 Resolved Errors`) mirror
   `issues.json`. They are not a second record: when they disagree, the issue
   store is right.
2. A lesson exists only for a verified resolution. Do not write lessons by
   hand for unverified fixes.
3. Never edit `issues.json` by hand to mark an issue resolved. Resolution goes
   through `issueStore.resolve()`, which requires evidence of what was checked
   and what was seen.
4. Audit reports, `docs/history/`, run archives and Claude conversation
   write-ups are dated snapshots, not live status.
5. Every test claim names its exact command, the machine (owner's Windows PC,
   CI, or another host) and the result. A Linux or CI pass is not a pass on
   the owner's PC.
6. Do not make a second file authoritative for a category above. To move a
   category, change this table in the same commit.
7. Runtime data (`data/`, `memory/jarvis_memory.json`, `data/brain/`) is the
   owner's: read it only when a task needs it, never commit it.
