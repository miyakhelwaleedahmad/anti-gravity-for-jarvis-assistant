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
| SEC-02 | FIXED_AND_TESTED | A spoken "yes" approved level-3 actions; the microphone hears videos, calls and other people | `voiceApprovalMaxRisk()` (default 2, `JARVIS_VOICE_APPROVAL_MAX_RISK`); above it the spoken question says to type approve, a spoken yes leaves the request pending, a spoken cancel still works | `tests/voiceApprovalTest.ts` 35/35 | — | Phase 2 commit |
| SEC-03 | FIXED_AND_TESTED | Tool output went into the synthesis **system** message; replies built from it were replayed in later plans as plain assistant turns | `security/untrustedText.ts`; synthesis and planning put tool output, memory and history in user messages inside `<untrusted_context>`, with `UNTRUSTED_RULE` in the system message; tool-derived replies saved with tag `from_tool_output` and replayed wrapped | `tests/promptInjectionFlowTest.ts` 10/10 (whole request, scripted model obeying the injection is still stopped by the registry); `promptInjectionHardeningTest` 13/13 | TEST-03 | Phase 2 commit |
| SEC-04 | FIXED_AND_TESTED | A page could make JARVIS open a router / local admin page / cloud metadata address at level 1 | `navigationLevel()`: private/loopback/link-local/.local targets the request did not name are level 2 (asks); JARVIS's own servers stay level 1; after a redirect onto a private address the tab is sent to about:blank and the step fails | `tests/navigationPolicyTest.ts` 15/15 (real Chromium, public name redirecting to 127.0.0.1); `browserControlAgentTest` 71/71 | SEC-03 | Phase 2 commit |
| SEC-05 | FIXED_AND_TESTED | Facts had no origin; research results were offered to the planner like the owner's statements; no way to delete a fact | `LongTermFact.origin` (user / agent / external) set from the source; planning labels each fact; `forget_memory` tool (risk 2, max 5 facts, removes from the fact store and the search index, says when the index could not be updated) | `tests/memoryForgetTest.ts` 16/16 | OPS-03 | Phase 2 commit |
| SEC-06 | FIXED_AND_TESTED | Child processes got `{...process.env}`: provider keys, bridge and A2A tokens | `system/childEnv.ts` (allow-list of names, secret-looking names never passed) used by dev scripts, dev servers, git, terminal tools, automation, process runner, Windows probe, vector service | `tests/childEnvTest.ts` 7/7 (real child prints its env) | — | Phase 2 commit |
| SEC-07 | FIXED_AND_TESTED | `run_script` in any project was level 1 whatever the script did | Risk target shows `project: script → body`; an agent running a script outside the JARVIS folder is level 2 | `tests/projectScriptPolicyTest.ts` 6/6 | SEC-06 | Phase 2 commit |
| SEC-08 | OPEN | | | | | |
| SEC-09 | OPEN | | | | | |
| SEC-10 | OPEN | | | | | |
| SEC-12 | OPEN | | | | | |
| SEC-13 | OPEN | | | | | |
| SEC-14 | OPEN | | | | | |
| SEC-15 | OPEN | | | | REL-08 | |
| SEC-16 | OPEN | | | | | |
| SEC-17 | FIXED_AND_TESTED | Same root cause as SEC-04 for `control_browser open_url` and `browser_tab new` | Same `navigationLevel()` on all three navigation paths | `tests/navigationPolicyTest.ts` | SEC-18 | Phase 2 commit |
| SEC-18 | FIXED_AND_TESTED | Reproduced on the old service: a cross-site `text/plain` POST /clear with no token answered 200 and emptied the store (2 → 0) | Token header `X-JARVIS-Token` required on every route but /liveness (JARVIS_VECTOR_TOKEN, else a kept owner-only token in data/security/vector_token, shared by both sides); any Origin header refused; POST bodies must be JSON; /docs and /openapi off; JARVIS's clients send the token; service started with `childEnv` + its own settings | `tests/python/test_vector_access.py` 33/33 (whole ASGI app; refused requests leave count and contents unchanged); `tests/vectorAuthTest.ts` 14/14 (token file, env, spawn env, Python reads the same token) | — | Phase 2 commit |
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
