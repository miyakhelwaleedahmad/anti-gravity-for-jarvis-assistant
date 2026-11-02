# Review — typed input while JARVIS is listening (phase B4, N-PC2)

Reviewer: a separate agent session (general-purpose), read-only; tests run through the runner only. Not a human.

## Round 1 — CHANGES REQUIRED

The reviewer ran 21 tests through the runner (21 passed) and `tsc --noEmit` (0 errors). Its probe P1–P3 used `fakeTts` and stubbed model calls, with a copy of the `jarvis.ts` queue drain.

Confirmed correct:
- **Every entry into `process()` is now safe.** SPEAKING and INTERRUPTED are handled by barge-in. PROCESSING_STT is left alone. LISTENING goes to IDLE. A left-over state is reset.
- **A typed "yes" during an approval** is consumed by `offerConsoleAnswer` and never reaches `process()`.
- **Only the orchestrator moves the agent state.** GoalRuntime does not.
- **The reset is safe even when the running flag is wrong (P2),** because the request was already aborted.
- **After a typed takeover in LISTENING, JARVIS ends consistent (P3),** and the mic bookkeeping recovers.
- **M1 (LISTENING branch removed) is not caught.** The left-over branch then resets LISTENING instead. Round 3 (N6) found one difference: a spoken request waiting during LISTENING, a case `jarvis.ts` cannot produce today (see `change_log.md`, Known limits).

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| R1 | med | Left-over state with a spoken request waiting in the queue: the reset drains it on IDLE and it replaces the typed request, which gets no reply (P1). The same happens in the existing concurrent branch | **Fixed** (owner's choice): in the new branch, typed text replaces the waiting spoken request, as barge-in does. Test first; M6 |
| R2 | low | A superseded request clears `_loopExecuting` while the newer one runs, so the new branch logs "no request running" falsely; this is also a likely source of left-over states | Log reworded ("no request marked running"); diagnosis D6; flag fix is a follow-up |
| R3 | low | After the takeover, if stt.py never answers, nothing ends the listen session (the watchdog is cleared) | Recorded; follow-up (an STT session timer in `jarvis.ts`) |
| R4 | low | What STT hears after the takeover can barge in on, or abort, the typed request; the records said only "queued" | Records corrected; the behaviour is a follow-up for the owner |
| R5 | low | "That one is aborted" could not fail (same stub answer for both) | **Fixed**; M5 caught |
| R6 | low | Untested: a waiting spoken request, small talk in LISTENING, "ends idle" for each case | **Fixed** (added) |
| R7 | info | Diagnosis D4 said only CLI text reaches `process()` directly | **Fixed** |
| R8 | info | The uncommitted A3 `verification.md` edit is outside B4 | Left out of B4, as the owner instructed |

## Round 2 — CHANGES REQUIRED

The reviewer ran 20 tests through the runner (20 passed) and `tsc --noEmit` (0 errors), with probes R2-A to R2-C. It found R1, R5 and R6 fixed for typed text, and the test's copy of the `jarvis.ts` queue drain faithful for these cases (M6 caught).

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| N1 | med | The new queue clear also ran for spoken input through arbitration in a left-over state: a waiting spoken request that ran on the base code was dropped (probe R2-A). Outside the owner's R1 choice | **Fixed:** the left-over branch now takes typed text only (`source === 'cli'`). Test first (26 passed, 1 failed before the fix); M7 |
| N2 | low | The unchanged concurrent branch: a request really running, a spoken request waiting, the owner types; the typed request is lost (probe R2-C). Not listed as a follow-up | Recorded in `change_log.md` "Known limits"; follow-up, for the owner |
| N3 | low | Records described the code before review ("12 checks", "3/4 caught", the boundary entry, the "Not changed" line); the owner's R1 decision not quoted; the M1 sentence too strong | **Fixed:** `change_log.md` rewritten for the final code, with the owner's words and date; M1 sentence softened above |
| N4 | info | The test's drain copy leaves out the 30 s stale drop, re-queueing when busy, `tryTransition`, and the other drain triggers; none changes these results | No change |
| N5 | info | A dropped spoken request gets only a log line, although JARVIS said "I will get to that right after this" (also on barge-in today) | Recorded; follow-up, for the owner |

## Round 3 — PASS

The reviewer ran 18 tests through the runner (18 passed; `evidence/review_r3_related_tests.txt`), `tsc --noEmit` (0 errors), and probes R3-A to R3-D (`evidence/review_r3_probe.mts`, `review_r3_probe.txt`). It checked all five callers of `process()`: the CLI, the queue drain, the normal voice path, arbitration and follow-ups. The `source === 'cli'` guard changes only arbitration in a left-over state, back to the base behaviour. Voice cannot reach `process()` in LISTENING. No code change needed.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| N6 | low | M1 called "equivalent", but it differs when a spoken request waits during LISTENING (probe R3-A); `jarvis.ts` cannot produce that case today | **Fixed** (records): M1 "not caught", difference described in `change_log.md` Known limits |
| N7 | info | Evidence rows said only "see …" | **Fixed**: results filled in |
| N8 | info | "12/12" had no evidence file; the file shows 13/13 | **Fixed** |
| N9 | info | Diagnosis D6: the reset fires only for typed text since N1 | **Fixed** |
