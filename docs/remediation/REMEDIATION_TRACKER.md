# Remediation tracker

Source: Master Findings Register (`claude/jarvis-repair` @ `30605cf`, 2026-10-11). The detailed audit files it names (`SECURITY_AUDIT.md`, `BUGS_AND_RELIABILITY.md`, …) are not in the repository; the register was the only evidence available. Each finding was re-checked against the source before it was changed.

Statuses: `OPEN` · `IN_PROGRESS` · `FIXED_AND_TESTED` · `ALREADY_FIXED` · `NOT_REPRODUCED` · `BLOCKED` · `DOCUMENTED` (a documentation or design finding answered in writing, no code change).

Baseline at `30605cf` (Linux, Node 22): `pnpm test:ci` → 124 passed · 0 failed · 9 skipped; `tsc --noEmit` clean.

| Finding ID | Current status | Evidence | Planned change | Tests | Dependencies | Result |
|---|---|---|---|---|---|---|
| BUG-02 | FIXED_AND_TESTED | Reproduced with a state-faithful TTS stand-in: `errorRecoveryTest` 11 pass / 4 fail, `ILLEGAL TRANSITION SPEAKING -> EXECUTING / PLANNING`, "unexpected error" after successful repairs | `orchestrator.announce()` for progress messages (no state change); `speak()` only for the reply; `speechStartMovesState()` — TTS playback start moves the state only from IDLE/INTERRUPTED | `tests/errorRecoveryTest.ts` (real `speak()`, `tests/fakeTts.ts`, no-failure-phrase assertions) 18/18; `tests/speechStateTest.ts` 10/10 | TEST-02 | Phase 1 commit |
| REL-01 | FIXED_AND_TESTED | Sandbox aborted its signal but awaited the tool; admin commands never passed the signal to execa; the action queue's signal was dropped | `system/processRunner.ts` (abort/timeout stop the whole process tree: `taskkill /T /F` on Windows, process group elsewhere); signal threaded skill → kernel → adminController; sandbox stops waiting after budget + grace, keeps the slot until the tool really ends; stopped commands are final (no retry) | `tests/toolTimeoutTest.ts` 14/14 (quick call 0.8 s behind a never-ending one; tree gone; run once); Windows-only shell check runs on Windows | — | Phase 1 commit |
| SEC-01 | FIXED_AND_TESTED | Bridge had no Origin check; dev mode accepted any client | `verifyClient`: any browser Origin refused in every mode unless in `JARVIS_BRIDGE_ALLOWED_ORIGINS`; Python clients (no Origin) unchanged | `tests/bridgeSecurityTest.ts` (real server, dev 7/7, token 13/13) | — | Phase 1 commit |
| SEC-11 | FIXED_AND_TESTED | `===` token compare; no `maxPayload`; `/health` returned full pipeline records | Constant-time compare of hashed tokens, length cap 512; `maxPayload` 16 MB (`JARVIS_BRIDGE_MAX_PAYLOAD_MB`); `/health` GET returns status only, `no-store` | `tests/bridgeSecurityTest.ts` | SEC-01 | Phase 1 commit |
| HYP-01 | FIXED_AND_TESTED | Confirmed in code: `jarvis.ts` moved REFLECTING → SPEAKING on any playback start, so a background approval prompt during a foreground task broke its next transition | Same as BUG-02 (`speechStartMovesState`) | `tests/speechStateTest.ts` §3 | BUG-02 | Phase 1 commit |
| SEC-02 | OPEN | | | | | |
| SEC-03 | OPEN | | | | | |
| SEC-04 | OPEN | | | | SEC-03 | |
| SEC-05 | OPEN | | | | OPS-03 | |
| SEC-06 | OPEN | | | | | |
| SEC-07 | OPEN | | | | SEC-06 | |
| SEC-08 | OPEN | | | | | |
| SEC-09 | OPEN | | | | | |
| SEC-10 | OPEN | | | | | |
| SEC-12 | OPEN | | | | | |
| SEC-13 | OPEN | | | | | |
| SEC-14 | OPEN | | | | | |
| SEC-15 | OPEN | | | | REL-08 | |
| SEC-16 | OPEN | | | | | |
| SEC-17 | OPEN | | | | SEC-18 | |
| SEC-18 | OPEN | | | | | |
| SEC-19 | OPEN | | | | | |
| SEC-20 | OPEN | | | | SEC-06 | |
| BUG-01 | OPEN | | | | | |
| REL-02 | OPEN | | | | | |
| REL-03 | OPEN | | | | | |
| REL-04 | OPEN | | | | ARCH-03 | |
| REL-05 | OPEN | | | | ARCH-03 | |
| REL-06 | OPEN | | | | | |
| REL-07 | OPEN | | | | | |
| REL-08 | OPEN | | | | | |
| REL-09 | OPEN | | | | | |
| HYP-02 | OPEN | | | | | |
| PERF-02 | OPEN | | | | | |
| PERF-03 | OPEN | | | | | |
| PERF-04 | OPEN | | | | ARCH-09 | |
| PERF-05 | OPEN | | | | | |
| PERF-07 | OPEN | | | | | |
| ARCH-01 … ARCH-09 | OPEN | | | | | |
| TEST-01 … TEST-04 | OPEN | | | | | |
| OPS-01 … OPS-03 | OPEN | | | | | |
