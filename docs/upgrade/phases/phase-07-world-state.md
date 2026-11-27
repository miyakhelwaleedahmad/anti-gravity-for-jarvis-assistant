# Phase 7 — World-state model

## Goal
One structured, timestamped picture of the current world — system, apps,
browser, development, task — refreshed when stale, summarised for planning,
never stored as long-term memory.

## Current system context
- `perception/systemStateObserver.ts` polls in the background and writes
  `data/runtime/system_state.json`.
- `agentMemory` working context holds goal, observations and tool results for
  one request; `goalManager` holds goals.
- Planning context: system prompt + unified memory context + recent goals +
  optional OCR text.

## Required changes
1. `core/worldState.ts` with sections and timestamps.
2. `refresh(sections, maxAgeMs)` using the P6 probes and existing perception.
3. Task section (goal, plan, current step, done, failed, pending approvals).
4. Planning summary, relevant to the request, capped, redacted, as data.
5. Never written to long-term memory.

## Implementation steps
1. Types: `WorldState { system?, apps?, browser?, development?, task }`, each
   section `{ data, observedAt, source }`.
2. Freshness limits: apps and browser 30 s, development 60 s, system 5 min.
   `refresh()` re-reads only stale requested sections; concurrent refreshes
   share one in-flight promise per section.
3. Task section updated by the orchestrator at plan, node start/finish,
   approval request/decision (from P3 records).
4. `summarizeForPlanning(input)`: picks sections by keywords (browser/tab/page
   → browser; running/server/port/backend → development; app/window → apps;
   cpu/memory/disk → system); ≤ 600 characters; redacted; wrapped in
   `<untrusted_context source="world-state">` for any text that came from
   pages or titles.
5. `systemStateObserver` writes into world state instead of only its file
   (file kept for compatibility).

## Files to inspect
`perception/systemStateObserver.ts`, `perception/windowsState.ts`,
`perception/chromeState.ts`, `core/orchestrator.ts` (planPhase context),
`memory/agentMemory.ts`, `core/goalManager.ts`.

## Files that may be modified
`core/worldState.ts` (new), `core/orchestrator.ts`,
`perception/systemStateObserver.ts`, tests, docs.

## Dependencies
P3 (approval records), P6.

## Tests
`tests/worldStateTest.ts`: fresh section not re-read; stale section re-read
once even with concurrent callers; planning messages for "is my backend
running" contain the development summary and not the browser one; summary
≤ 600 characters and redacted; memory files unchanged after observations;
task section shows pending approval during an approval request.

## Acceptance criteria (here)
All tests; planner receives the summary; suite unchanged.

## Security requirements
No persistence to long-term memory; redacted; untrusted text marked.

## Failure conditions
Background polling added; summary over the cap; secrets in the summary.

## Completion requirements
Gate; checklist; PHASE_STATUS; SYSTEM_AWARENESS; commit `phase-07-world-state`; CI green.
