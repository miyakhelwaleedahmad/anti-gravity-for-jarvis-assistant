# Phase 11 — Permission-aware error recovery

## Goal
When a step fails: observe, diagnose, plan a repair, check the repair's risk,
repair only if allowed, verify; stop and ask when the repair is risky.

## Current system context
- `reflectionEngine.reflect` classifies failures (patterns, LLM diagnosis when
  retries remain) and picks retry_same / retry_with_delay / fallback_tool /
  replan / abort; `orchestrator.repairPhase` applies it.
- A replan's new steps pass through the registry (so P2 checks them), but
  retries and fallback tools are chosen without looking at the world again.

## Required changes
1. Fresh observation on failure (world-state sections the step touched).
2. `core/recoveryPlanner.ts`: known failure → concrete repair candidates.
3. Each candidate assessed by the risk engine; risky → approval or report.
4. Verify after repair; bounded attempts; honest final message.

## Implementation steps
1. On a failed node: map tool → sections (browser tools → browser; dev tools →
   development; app/window → apps) and `worldState.refresh(...)`.
2. Candidates: dev server not listening → start it (devTools, level 1) if
   JARVIS knows the script; tab missing → open URL (1); file missing → ask
   the user (no guess); service down → start service (3, approval);
   process hung → kill (3, approval); otherwise the existing strategies.
3. `assessRisk` + `decide` for each candidate; `deny` → skip; `approve` →
   approval gate (P3) with WHY = the failure; refused → stop and report.
4. After a repair: re-run the failed step once, verify (P5); at most 2 repair
   rounds per request; final message states what was repaired or why not.

## Files to inspect
`core/reflectionEngine.ts`, `core/orchestrator.ts` (repair loop, repairPhase),
`core/plannerIntelligence.ts`, P2/P3/P5/P7 modules.

## Files that may be modified
`core/recoveryPlanner.ts` (new), `core/reflectionEngine.ts`,
`core/orchestrator.ts`, tests, docs.

## Dependencies
P2, P3, P5, P7 (P10 for dev-server repairs).

## Tests
`tests/errorRecoveryTest.ts`: a request that needs a dev server that is down →
server started, port verified, request completed; a repair that needs a
process kill → approval requested; denied → nothing killed, honest message;
repairs stop after 2 rounds; every repair step appears in the risk engine log.

## Acceptance criteria (here)
All tests through the real orchestrator with a scripted model.

## Security requirements
No repair bypasses the risk engine or approval gate.

## Failure conditions
A risky repair executed without approval; an endless repair loop.

## Completion requirements
Gate; checklist; PHASE_STATUS; commit `phase-11-error-recovery`; CI green.
