# ARCH_SELF_HEALING.md — Self-Healing, Health and Repair Reference

> Topic reference for self-healing, health and runtime-issue bugs. Paths
> checked against the repository on 2026-10-23 (`claude/jarvis-repair`).
> Who owns which responsibility, and the overlapping classifiers and
> planners: `SELF_HEALING_OWNERSHIP.md` (not repeated here). Behaviour in
> full: root `ARCHITECTURE.md`, "Self-healing".

## Service management (`self_healing/`)

| File | Role |
|---|---|
| `selfHealingManager.ts` | Single entry point: launches and restarts the Python services, backoff, circuit break at 3 |
| `failureDetector.ts` | Watches Python child processes and WebSocket events |
| `failureClassifier.ts` | Classifies raw errors (shares `core/failureSignature.ts`) |
| `recoveryPlanner.ts` → `repairExecutor.ts` | Decide and run the recovery action |
| `fallbackRouter.ts` | Active TTS and STT engine and their fallbacks |
| `healthChecker.ts`, `healthScorer.ts`, `pipelineRegistry.ts`, `pipelineWatchdog.ts` | Proactive probes, 0–100 scores, pipeline segment health, stale-pipeline watchdog |
| `alertManager.ts`, `failureAnalytics.ts`, `fsWatcher.ts` | Rate-limited alerts, failure trends, file-change watcher |

`self_healing/index.ts` (barrel) is in `_legacy/self_healing/index.ts`.

## Health and monitoring (`monitoring/`)

| File | Role |
|---|---|
| `healthLedger.ts` | Whether a pipeline works, from observed effects; no evidence = `unknown` |
| `healthManager.ts`, `runtimeDashboard.ts` | Health state for the dashboard; live terminal dashboard |
| `structuredLogger.ts`, `traceWiring.ts` | Structured JSON logs, one correlation id per request |
| `resourceMonitor.ts` | Real-time resource signals |

## Issues and repair (`core/`)

| File | Role |
|---|---|
| `failureSignature.ts`, `sourceLocation.ts` | One signature and category per failure; where it happened (`KNOWN` / `EXTERNAL` / `UNKNOWN`) |
| `issueStore.ts` | `data/repairs/issues.json` and `occurrences.jsonl`: the runtime issue authority |
| `selfCheck.ts` (`self_check` tool) | Read-only: health check, full self-check, repair report, "why are you stuck" |
| `repairRun.ts` (`self_repair` tool) | Bounded runtime repair: one run, 2 attempts, 20 minutes, restart + effect check |
| `codeRepair.ts`, `worktreeExecutor.ts` (`propose_code_repair`) | Code-repair proposal on `jarvis/repair/<id>` in a worktree; typed console approval; report in `data/repairs/code/<repairId>.json`; never merged by JARVIS |
| `diagnosis.ts` (`diagnose_app`) | Why a local application or website is not working |

### Issue record (schema version 1, `core/issueStore.ts`)

- Issue: `issueId` (`iss-…`), `signature`, `status`, `severity`,
  `category`, `component`, `tool`, `pipeline`, `summary` (redacted),
  `firstSeen`, `lastSeen`, `occurrenceCount`, `recurrenceCount`,
  `correlationIds`, `sourceLocation`, `recent` (latest occurrences),
  `diagnosis` (facts, hypotheses, confidence, reproduced), `environment`,
  `runIds`, `nextAction`, `blockedReason`, `verification`, `resolvedAt`,
  `history`, `obsidian`.
- Status: OPEN, DIAGNOSING, REPAIR_PLANNED, AWAITING_APPROVAL, REPAIRING,
  VERIFYING, RESOLVED, BLOCKED, CANCELLED, REOPENED, DUPLICATE.
- Occurrence: `occurrenceId`, `issueId`, `signature`, `at`,
  `correlationId`, `component`, `category`, `message` (redacted, ≤ 500
  characters), `source`.

### How an issue becomes RESOLVED (only inside JARVIS)

- An issue of category runtime, external, environment or unknown is resolved
  when the same pipeline effect works again (`issueStore`).
- A repair run resolves an issue whose check passed (`repairRun.ts`).
- Resolution goes through `issueStore.resolve()` with evidence; a resolved
  issue that returns is reopened with its recurrence count.
- The maintenance workflow never edits these files; Stage 07 records the
  owner action still needed.

## Tests and docs

`selfHealingHonestyTest`, `boundaryDoublesTest`, issue-store and repair
tests through the runner (`TEST_MATRIX.md`). History:
`docs/SELF_HEALING_CAPABILITY_INVENTORY.md`, `docs/upgrade/ERROR_RECOVERY.md`.
