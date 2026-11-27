# Issue Brief — voiceRouteMockTest checks that cannot fail

> Stage: 01_intake · Run: `ai_workflows/runs/2026-10-25_voice-route-test-weak-checks/`
> Status: [x] Complete
> Date: 2026-10-25 · Machine: cloud Linux (Node 22.22.2, pnpm 10.33.0), branch `claude/jarvis-repair` at `76f4712`

---

## One-Sentence Problem Description

8 of the 11 checks in `tests/voiceRouteMockTest.ts` cannot catch the fault
their label names: 7 check nothing or only values the test set itself, and
one (R3) cannot fail while another check passes. The test passes when the
bridge, the listen_start send or the route's tool use is broken.

*Correction (review finding V10):* this sentence first said "7 of the 11
checks", which did not match the table below (8 rows).

---

## Exact Symptoms

Found by reading the test (TEST-05 follow-ups 2-5 in
`runs/2026-10-23_voice-route-test-launches-browser/closure.md`):

| Line (at `76f4712`) | Check | Why it cannot catch a fault |
|---|---|---|
| 99-101 | wakeword / tts / stt registered | reads back the map the test filled itself (L83-96) |
| 109 | sendListenStart called | `sent.stt.length > 0 \|\| true` (finding A) |
| 152-154 | process() called, text forwarded, source voice | the test's own wrapper, called by the test with its own arguments (finding B) |
| 170 | open_app tool was invoked | satisfied by the route line `type="open_app"`, which the L166 check needs anyway (R3) |
| — | (no check) | a launch by any tool but `open_app`, or outside the registry (R5) |

Shown by mutation in `reproduction.md`: 6 of 8 code faults pass the test.

---

## Expected Behavior

Each check fails when the behaviour named in its label is broken. The test
says what it does not cover.

---

## Actual Behavior

See the table. The test also prints imitation bridge log lines
(`[NodeBridge] RX type=client_ready …`, `Forwarding STT result …`) through
`origLog`: they are not captured, so they satisfy no check, but the output
shows bridge activity that never happened.

---

## Environment

- [ ] Live voice runtime
- [ ] CLI input
- [x] Test only (the runner; isolated data folder per test)
- [ ] Unknown

---

## Runtime Issue Record

Read: [ ] Yes
      [x] Not read — reason: no runtime issue; this is a test-quality
      finding. `data/repairs/` is not in this clone.

Tracker ID: **TEST-06**, named by the owner for this run. Before this run
`git grep TEST-06` found nothing in the repository. Test-quality findings use
TEST-nn (TEST-01…05 exist). Owning tracker: `docs/remediation/REMEDIATION_TRACKER.md`
(IDs not in the checklist).

Approved scope (owner, 2026-10-25): A, B1, R3, R5. **B2** (moving the
`jarvis.ts` `stt_result` handler into a testable module) stays open and is not
part of this run.

---

## Facts, reports, missing

| Item | Kind |
|---|---|
| The checks listed above, and their lines | observed (code) |
| 6 of 8 mutations pass the current test | observed (`evidence/attack_old_test.txt`) |
| A direct browser launch (M5b) passes it, with 2 opener calls | observed |
| On unchanged code the route runs `open_app` twice and starts no child process | observed (probe, `reproduction.md`) |
| The owner's PC ran the TEST-05 version: 1 passed, about 70.8 s | reported by the owner |
| Behaviour of the TEST-06 version on Windows | missing (not run) |

---

## Files Likely Involved

- `tests/voiceRouteMockTest.ts` (protected test)
- `tests/boundary-doubles.json` (the stand-in's reason)
- Read only: `bridge/nodeBridge.ts`, `jarvis.ts:579`, `core/orchestrator.ts`, `skills/automation/skill.ts`

---

## What Has Already Been Tried

Nothing in code. TEST-05 (`64f1abc`) made `open_app` a dry run and listed
these weaknesses as follow-ups.

---

## Ready to Advance to Diagnosis?

- [x] All symptoms documented
- [x] Expected vs actual behavior clear
- [x] Issue record: "not read" with the reason
- [x] No secrets or unneeded personal data in this file
- [x] File list ready
- [x] No code edits made during this stage
