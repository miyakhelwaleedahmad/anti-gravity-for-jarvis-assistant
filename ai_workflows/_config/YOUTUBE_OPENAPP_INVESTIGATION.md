# YOUTUBE_OPENAPP_INVESTIGATION.md — Active Bug Investigation

> Status: ⚠️ OPEN — Under Investigation
> Do NOT close this investigation without live voice verification producing expected logs.

---

## Bug Description

```
"Jarvis open YouTube for me" does not reliably open YouTube in the live voice runtime.
```

Smoke tests (mock) may pass. **This does not mean the bug is fixed.**
The only way to confirm the fix is with a real voice command that opens a real browser.

---

## Do Not Assume Test Success Equals Live Success

| Evidence Type | Is This Proof of Fix? |
|---|---|
| `voiceRouteMockTest.ts` passes | ❌ No — mock, no real voice input |
| `openAppSmokeTest.ts` passes | ❌ No — calls tool directly, no voice path |
| `latencySmokeTest.ts` shows 47ms | ❌ No — CLI call, not voice triggered |
| `deterministicCommandRouteTest.ts` passes | ❌ No — logic test only |
| Live voice → YouTube opens → logs captured | ✅ YES — this is proof |

---

## Current Status (2026-10-23)

- **Not established.** The last recorded observation (2026-06-19) is that
  the route did not reliably work live; no live log since then shows it
  fixed or still failing (`JARVIS_CURRENT_STATUS.md`).
- Since then the router moved to `core/deterministicRoutes.ts`, and some
  log lines changed wording: use the "what the code prints now" column in
  `ARCH_VOICE.md` when reading live logs.
- History is evidence of what was seen then, not proof of today's behaviour.

---

## How to Investigate

1. Start a maintenance run at `stages/01_intake/` (the workflow in
   `ai_workflows/CLAUDE.md`). Stage 02b records this as BLOCKED or
   INFERRED until the owner runs it live.
2. Live run with the owner: `TEST_MATRIX.md`, Live Runtime Verification.
3. Expected log sequence, step-by-step checklist, known failure points and
   temporary debug logging (history, 2026-06):
   `YOUTUBE_OPENAPP_CHECKLIST_2026-06.md`.
4. Behaviour contract: `VOICE_ROUTE_CONTRACT.md`.

---

## Resolution Criteria

This bug is resolved ONLY when:

1. User says "Jarvis open YouTube for me" with real voice
2. All 8 expected log lines appear in the terminal
3. YouTube opens in the default browser
4. TTS speaks a confirmation
5. No illegal transition warnings appear
6. Total time is under 100ms
7. Logs are pasted into the run's `verification.md`
   (`ai_workflows/runs/<run>/`, copied from `stages/05_verification/output/`)
8. The tracker named in `SOURCES_OF_TRUTH.md` is updated at Stage 07
   (`JARVIS_CURRENT_STATUS.md` only points to it)

Criterion 2: compare with the current wording in `ARCH_VOICE.md`; a line
that the code no longer prints cannot be required. Criteria 7 and 8 were
`stages/05_verification/output/verification.md` and
`_config/JARVIS_CURRENT_STATUS.md` in 2026-06; the stage templates now stay
blank and the status file is a pointer.
