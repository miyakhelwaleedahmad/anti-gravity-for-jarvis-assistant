# Phase 13 — Integration and scenarios

## Goal
The end-to-end requests from the specification work with everything built so far.

## Current system context
All earlier phases complete; each tested alone.

## Required changes
1. A scenario harness.
2. Six scenarios as tests.
3. Fixes for whatever the scenarios expose.
4. A table of LLM requests per scenario (the free tier allows about 20 a day per model).

## Implementation steps
1. Harness (`tests/scenarios/harness.ts`): starts real Chromium with a temp
   profile and the local test site, a "backend" HTTP server, a temp git
   repository; replaces `modelRouter` with a scripted model that counts
   requests; captures speech.
2. Scenarios:
   - "What is currently open in my browser?" → tabs and the visible page, from
     observation; 0–1 LLM requests.
   - "Is my backend running?" → port and HTTP status; 0 LLM requests.
   - "Why isn't my application working?" (backend stopped) → process/port/HTTP
     checks, recent log lines, browser error page → diagnosis; restart offered
     per policy; verified.
   - "Continue what I was doing." → active window, tab and recent goals;
     confident → states the task and asks to confirm; unsure → asks a question.
   - "Check why my website isn't working." → plan → inspect browser, server,
     port, logs → diagnose → safe repair → verify → report.
   - "Delete my Downloads folder." → level 4 → approval request with code; no
     answer → nothing deleted.
3. Fix defects in the module at fault, each with a test.

## Files to inspect
All modules from P1–P12.

## Files that may be modified
`tests/scenarios/*` (new), modules where scenarios fail, docs.

## Dependencies
P1–P12.

## Tests
The scenarios themselves, plus the full suite.

## Acceptance criteria (here)
Six scenarios pass; LLM request counts recorded in PHASE_STATUS.

## Security requirements
The dangerous scenario must stop; no secrets in any captured LLM request.

## Failure conditions
Any scenario passing only with a mocked observation (observations must be real).

## Completion requirements
Gate; checklist; PHASE_STATUS; commit `phase-13-integration`; CI green.

## As built (alignment note)
- Harness and scenarios: `tests/scenarios/harness.ts`,
  `tests/scenarioIntegrationTest.ts`; rules the scenarios do not reach:
  `tests/diagnosisRulesTest.ts`.
- Three scenarios needed capabilities that did not exist: the diagnosis
  (`core/diagnosis.ts`, the `diagnose_app` tool), "continue what I was doing"
  (recent goals, an offer that a "yes" confirms), and wider phrasing for the
  browser question. Both new flows are routes without an LLM request; their
  actions go through the registry like any call.
- What JARVIS observes in the scenarios is real; two things are replaced in
  the test: the model (scripted, as this prompt says) and, in the dangerous
  scenario, the two file tools' last step — by recorders that act on nothing,
  so a fault in the checks could not delete even the temporary folder. None
  was reached.
- Details: [SCENARIOS.md](../SCENARIOS.md).
