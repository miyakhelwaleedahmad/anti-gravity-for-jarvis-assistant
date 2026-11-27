# Phase 15 — Final verification

## Goal
Prove the finished system and report every result as measured.

## Current system context
P1–P14 complete (P14 with the owner's Windows report).

## Required changes
None in code unless a test exposes a defect (fixed with its own test).

## Implementation steps
1. Run: full suite (`pnpm test`, `pnpm test -- --ci`), typecheck, scenarios
   (P13), browser tests (P8–P9), Windows pack results (P14), permission tests
   (P2–P3), security tests (redaction leaks, approval bypass attempts, page and
   OCR injection, path and command injection), failure/recovery tests (P11),
   regression (every pre-upgrade test), performance (latency of deterministic
   routes, LLM requests per scenario, memory use of the Node process).
2. Write `docs/upgrade/FINAL_JARVIS_IMPLEMENTATION_REPORT.md`: phases, tasks,
   tests run, passed, failed, blocked items, security findings, limitations,
   architecture changes, new dependencies, recommended next steps.

## Files to inspect
Everything changed by P1–P14.

## Files that may be modified
Only to fix defects found; the report.

## Dependencies
P1–P14.

## Tests
As listed in step 1.

## Acceptance criteria
Every number in the report comes from a run; failures and blocked items are
listed, none hidden.

## Security requirements
No approval bypass found; no secret in any sink.

## Failure conditions
A result stated without a run behind it.

## Completion requirements
Report committed; checklist complete; CI green.
