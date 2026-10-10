# Goal Runtime — Phase 0 audit and implementation checklist

Branch `claude/jarvis-repair`, starting commit `49aee51` (clean working tree, nothing unpushed).
`main` is the original upload (`f429071`); the branch is 83 commits ahead and 0 behind.

This file is the plan; every item below is done and tested (see `docs/GOAL_RUNTIME.md` §16 for what is verified offline and what is not). `docs/GOAL_RUNTIME.md` describes what was built.

## 1. The architecture report, checked against this checkout

`JARVIS_CURRENT_ARCHITECTURE_REPORT.md` was written from `fbb248f`; the only commit since is the report itself, so its findings still describe the code. Re-checked:

| # | Report finding | Still true? | Detail found in Phase 0 |
|---|---|---|---|
| 1 | Autonomy loop is a flag | Yes | `orchestrator.startLoop()` sets `isLoopRunning`; nothing reads it. |
| 2 | Goals never re-run | Yes | `getPriorityQueue`, `resumeGoal`, `mergeGoals`, `updatePriority` have no live callers. |
| 3 | No scheduler | Yes | No cron library; `backupRestore.startScheduled()` never called. |
| 4 | Agent tasks lost on restart | Partly wrong | Each root task is archived to `data/agents/<root>.json` at start and end; at startup RUNNING archives are marked INTERRUPTED. Nothing resumes them. |
| 5 | Narrow agent routing | Yes | `delegate_task` is offered to the planner only for research/compare/background words. |
| 6–8 | Two health systems, three buses, two memory stores | Yes | To be checked for real overlap in Phase 6 before any change. |
| 9 | Decay once at startup | Yes, and worse | `decayMemory()` subtracts `decayPerDay × days since last seen` on every call, so running it on a schedule would decay the same days again and again. It must be made idempotent before it is scheduled. |
| 10–11 | Stubs and legacy folders | Yes | Only touched where a feature needs them. |

New problems found in Phase 0 (not in the report):

| # | Problem | Risk |
|---|---|---|
| N1 | Every user request is a goal. A failed request becomes `retry`; at shutdown every active request is saved `paused`; at startup stale ones become `pending`. A runtime that simply ran pending/retry goals would replay old commands ("delete …", "close …") after a restart. | High: autonomous replay of interactive commands. |
| N2 | The goal store keeps the newest 100 goals (`slice(-100)`). A long-running goal would be silently dropped after 100 requests. | High for permanent goals. |
| N3 | `updateGoalStatus` accepts any status change; there is no lifecycle policy and no history of why a goal changed. | Medium. |
| N4 | Goal writes are debounced 300 ms. A crash after "task started" and before the write loses the claim. | Medium for crash safety. |
| N5 | Backups do not include `data/runtime/goals.json`. | Medium. |
| N6 | Running a goal through `orchestrator.process()` would abort the user's current request (it cancels the previous one) and drive the voice state machine. Background goals must not use that path. | High: would disturb the user. |
| N7 | The approval gate shows one request at a time (good), but a request from background work does not say which goal it belongs to. | Medium. |
| N8 | YouTube's Trending page was retired in July 2025; "what is trending" needs another source (YouTube Data API `chart=mostPopular`, or clearly labelled search results). | Accuracy. |

## 2. Design decisions

1. **Request records stay request records.** Goals get a `kind`: `request` (what every typed or spoken command already creates; never run by the runtime), `temporary`, `permanent`, `recurring`. Goals stored before this change have no kind and are read as `request`.
2. **One store.** The lowdb file `data/runtime/goals.json` is extended with optional fields. No new database.
3. **Background execution goes through the agent system**, not `orchestrator.process()`: `agentManager.startRootTask()` runs a specialist in its own AsyncLocalStorage scope beside the foreground request. Every tool call still passes the registry, the risk engine and the approval gate.
4. **Central lifecycle** in `core/goalLifecycle.ts`; every status change records from, to, reason and time.
5. **Runtime** in `core/goalRuntime.ts`: wakes on events and on one timer for the next due time; claims a task with a persisted lease before running it; bounded concurrency; stops cleanly.
6. **Time** in `core/goalSchedule.ts`: once, interval, daily/weekly at a local time in an IANA time zone. No new dependency.
7. **Safe restart**: a task that was running when JARVIS stopped is re-run only if it cannot change anything (read-only specialists). A task that could have acted (desktop, browser, code changes) is checked against the agent archive; if its outcome is unknown it waits for the user.
8. **Desktop is opt-in for goals.** Background goals use read-only specialists unless the goal was created with desktop access.

## 3. Checklist

Each phase is finished only when its tests pass and the full suite still passes.

### Phase 1 — Goal data model and lifecycle
- [x] `kind`, objective, success criteria, plan tasks, milestones, schedule, budget, policy, history, lessons fields (all optional, old files load).
- [x] `core/goalLifecycle.ts`: states `pending planning ready executing waiting retry paused blocked completed failed cancelled expired` (+ legacy `in_progress`), allowed transitions, reasons.
- [x] Every status change goes through the policy; refused changes are logged and not applied.
- [x] Retention: managed goals are never dropped by the 100-request window; finished managed goals are archived to a file after a retention period, not deleted.
- [x] Durable writes (`persistImmediate`) for claims and results.
- Acceptance: old goal files load; existing goal tests pass; invalid transitions refused; 150 requests do not drop a permanent goal.
- Risks: breaking `goalLifecycleAuditTest`, `goalRuntimeMigrationTest`.

### Phase 2 — Goal Runtime worker and scheduler
- [x] Eligible-work selection by priority, dependencies, deadline, budget, `nextRunAt`.
- [x] Persisted leases; one task never runs twice at once.
- [x] Wake on create/resume/event/due time; single timer; bounded concurrency; clean start/stop.
- [x] Planner: LLM decomposition into tasks with specialists and dependencies; deterministic fallback.
- [x] Verifier: success criteria checked from evidence; no criteria judge → `waiting` for review, not `completed`.
- [x] Recurring instances with dedupe key, overlap prevention, missed-run policy.
- [x] Permanent goals: milestones, progress, dormant between cycles.
- [x] `jarvis.ts` starts/stops the runtime; startup log tells the truth.
- Acceptance: a pending temporary goal completes with no user message; a recurring goal creates one instance per slot; parallel limit respected.

### Phase 3 — Retry and restart recovery
- [x] Failure classes: transient, invalid plan, dependency/service down, permission/approval, contradictory evidence, budget, needs human, unrecoverable.
- [x] Bounded attempts with backoff; the worker picks retries up.
- [x] Startup reconciliation of leases and running tasks (safe re-run vs needs review).
- [x] Attempt ids so a stale completion cannot overwrite a newer attempt.
- Acceptance: retryable failure is retried and succeeds; non-retryable becomes blocked/failed with reason; crash mid-task does not repeat a side-effect task.

### Phase 4 — Multi-agent integration
- [x] Goal tasks run as agent root tasks; ids persisted on the task.
- [x] Budgets passed down; pause/cancel propagate to agents.
- [x] Approval requests carry goal and task ids; concurrent goals cannot answer each other's approvals; a timed-out approval leaves the goal waiting.
- [x] Agent archives used as evidence on restart.
- [x] Delegation routing beyond fixed phrases, without delegating trivial requests.
- Acceptance: tests through the real `AgentManager` with a scripted model.

### Phase 5 — Learning, memory, status
- [x] Lessons from verified outcomes and user feedback, stored in long-term memory and the goal record; retrieved when planning similar goals; tracked for effect.
- [x] Repeated failure pattern → bounded improvement proposal (no code changes).
- [x] `goal_status` / goal control tools, CLI `goals`, voice routes, dashboard section.
- [x] Idempotent decay, scheduled.

### Phase 6 — Remaining gaps
- [x] Scheduled backup started at startup; goal store included; tested.
- [x] Health, event-bus and recovery-layer responsibilities documented; overlap removed only if safe.
- [x] Python reflection: decide (TypeScript engine already covers it) and fix the misleading code/comments.

### DC — Desktop control and background research
- [x] YouTube search in the user's Chrome (new tab), best-match open/play, verified through CDP.
- [x] Background research through the Research agent; current news with dates and sources.
- [x] "What is trending on YouTube": YouTube Data API `mostPopular` with region and time when a key is set; otherwise labelled search results; never invented numbers.
- [x] Routing tests: foreground actions vs background research; background work never opens or focuses tabs.

### Phase 7 — Verification and documentation
- [x] Full suite, typecheck, diff review.
- [x] `docs/GOAL_RUNTIME.md` with Mermaid diagrams matching the code; commands for Windows.
