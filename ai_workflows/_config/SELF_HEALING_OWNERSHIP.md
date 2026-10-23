# SELF_HEALING_OWNERSHIP.md — Who Owns What in Self-Healing

> Documents the existing systems; it does not change them. Do not add a new
> classifier, recovery planner, issue database or repair engine: extend the
> owner listed here. Paths checked on 2026-10-23 (`claude/jarvis-repair`).

## Responsibilities

| Area | Owner | Responsibility |
|---|---|---|
| Service management (legacy) | `self_healing/*`, entry `selfHealingManager.ts` | Watches the Python voice services and WebSocket events (`failureDetector`), classifies (`failureClassifier`), plans (`recoveryPlanner`) and runs restarts and fallbacks (`repairExecutor`, `fallbackRouter`); health probes, alerts and watchdogs (`healthChecker`, `alertManager`, `pipelineWatchdog`, `pipelineRegistry`). |
| Does a pipeline work? | `monitoring/healthLedger.ts` | Effect-based health: what was observed working or failing. |
| Failure identity | `core/failureSignature.ts` | One signature and category per failure, used by the issue store, repair run, goal recovery, reflection, the tool registry and `self_healing/failureClassifier.ts`. |
| Runtime failure record | `core/issueStore.ts` | `data/repairs/issues.json` and `occurrences.jsonl`; an issue is resolved only with evidence (`resolve()`). The authority (see `SOURCES_OF_TRUTH.md`). |
| Runtime repair | `core/repairRun.ts` | "Heal yourself": bounded attempts, checked by the same effect that failed; may ask `selfHealingManager` for a restart. |
| Code repair | `core/codeRepair.ts`, `core/worktreeExecutor.ts` | Proposes a fix for a suspected code defect on its own branch in a separate worktree; needs the owner's approval typed at the console; never edits the checkout. |
| Read-only answers about JARVIS | `core/selfCheck.ts` | Health check, full self-check, repair report, "why are you stuck". |
| Application diagnosis | `core/diagnosis.ts` | "Why isn't my application working?": looks at what serves the app and what the browser shows. |
| Issue notes in Obsidian | `core/obsidianMirror.ts` | Mirrors each issue into the vault (`JARVIS/01 Active Errors`, `02 Resolved Errors`); a copy, not a record. |
| Lessons and the vault | `memory/secondBrain.ts`, `memory/vault.ts` | Turns verified resolutions into lessons; vault access with a path guard and owned-note checks. |

## Overlaps that need a clear owner (not proven bugs)

Several modules classify failures or decide what to do next. Each has its
own scope today; whether they agree on the same failure has not been checked.

Failure classification:
- `self_healing/failureClassifier.ts` (service and process failures)
- `core/failureSignature.ts` (shared signature and category)
- `core/goalRecovery.ts` (goal-task failures)
- `core/reflectionEngine.ts` (`failureClass` of a failed request)
- `bridge/llmStatus.ts` `classifyLLMError` (LLM provider errors)

Recovery planning:
- `self_healing/recoveryPlanner.ts` → `repairExecutor.ts` (services)
- `core/repairRun.ts` (runtime repair on request)
- `core/stepRecovery.ts` (a failed step in a request)
- `core/goalRecovery.ts` (retry, wait, re-plan, block, give up)
- `core/reflectionEngine.ts` (`repairStrategy` within a request)

Rules until ownership is decided:
1. A change to one of these names the others it may affect and checks them.
2. No new parallel classifier or planner: extend the one whose scope fits.
3. Merging any of them is a separate, approved change (diagnosis, patch
   plan, tests), not part of a documentation task.
