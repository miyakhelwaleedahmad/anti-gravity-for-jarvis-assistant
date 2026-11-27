# Change Log — typed input while JARVIS is listening (phase B4, N-PC2)

The owner approved Gate 1 on 2026-11-02, including the protected file `core/orchestrator.ts`, with these conditions:
- keep the existing voice, interruption and request-queue behaviour;
- don't touch A3 or unrelated A4 code;
- no commit or push without separate approval.

During review round 1 (R1) the owner was asked: "what should happen when a spoken request is waiting in the queue and you type?" The owner chose: **"Typed text replaces it (Recommended)"**, described as "only in this new leftover-state case, your typed text drops the waiting spoken request, just as interrupting JARVIS while it speaks already does. Every other queue behaviour is unchanged, including when a request is really running."

Base commit: `2d35a0a`. The sections below describe the **final** code; the history is in "How it got here".

## The change (`core/orchestrator.ts`, protected; 16 added lines, nothing else changed)

The new code sits in `process()`, after the existing "request still running" check (`_loopExecuting`), which is unchanged:

| Case | What happens now |
|---|---|
| JARVIS is LISTENING (after "Jarvis") | The request takes over: LISTENING → IDLE (an allowed step). This can only be typed text; speech goes through PROCESSING_STT first. The recording finishes as usual, and what it hears comes in through the existing voice path: queued while JARVIS is busy; a barge-in while it is SPEAKING, which stops the typed request's reply; or, for a fast-route phrase, arbitration, which aborts the typed request. An empty result is dropped. |
| **Typed** text, and the state is anything but IDLE or PROCESSING_STT, with no request marked running | A warning in the log ("left over with no request marked running"), then any spoken request waiting in the voice queue is dropped (`runBargeInCallbacks()`, as barge-in does; owner's R1 choice), then a reset to IDLE. |
| Spoken input in such a state (arbitration) | Unchanged from the base code: the waiting spoken request still runs (review N1). |
| SPEAKING / INTERRUPTED | Unchanged: barge-in. |
| A request really running | Unchanged: it is aborted and the state reset. A waiting spoken request is **not** dropped here (see "Known limits"). |

The state rules in `core/agentStateMachine.ts` are unchanged: LISTENING → PLANNING is still refused.

## Tests

| File | Change |
|---|---|
| `tests/typedWhileBusyB4Test.ts` (new) | 27 checks, each with its own stub answer per request. **Typed in LISTENING:** a planner request; a fast route; a fast route through planning; small talk. **Typed in each left-over state:** PLANNING, EXECUTING, OBSERVING, REFLECTING, REPAIRING. **Queue:** a waiting spoken request plus typed text (dropped); a waiting spoken request plus a spoken fast route (both run). **Unchanged:** barge-in sends tts.py "stop"; a running request is aborted (its answer is absent); LISTENING → PLANNING is still refused. Every case also checks that JARVIS ends IDLE. The queue cases use a copy of the `jarvis.ts` queue, `onBargeIn` and drain wiring. |
| `tests/boundary-doubles.json` | An entry for the new test that lists `installFakeTts` and `sendToRole` (the test wraps `sendToRole` to record the "stop"). |

## Evidence

| Check | Result | File |
|---|---|---|
| Reproduction, read-only, on the base code | "I encountered an unexpected error, sir. Please try again." in LISTENING and REFLECTING | `evidence/probe_before.txt` |
| The first 12 checks on the base code | 8 passed, **4 failed** (LISTENING, EXECUTING, OBSERVING, REFLECTING) | `evidence/old_code_checks.txt` |
| R1 checks before their fix | 23 passed, **2 failed** | `evidence/review_r1_old_code_checks.txt` |
| N1 check before its fix | 26 passed, **1 failed** | `evidence/review_r2_old_code_checks.txt` |
| Final test | **27/27** | `evidence/review_r2_new_code_checks.txt` |
| Mutation check, 7 mutants | **6/7 caught**; M1 not caught (see Known limits, N6); tree restored (md5 unchanged) | `evidence/b4_mut.py`, `evidence/b4_mut_run_final.txt` |
| Typecheck, final code | 0 errors | `evidence/typecheck_final2.txt` |
| Full suite, final code | **209 passed, 0 failed**, 1 blocked (realTtsHandoffTest: no pygame on this machine), 9 skipped; runner exit 1 comes from the blocked test only | `evidence/full_suite_final2.txt` |
| Review round 3: related tests and probes | 18 passed; probes R3-A to R3-D as expected | `evidence/review_r3_related_tests.txt`, `evidence/review_r3_probe.txt` |

## Known limits (recorded, not changed)

- **R2:** after a request is superseded, `_loopExecuting` can read false while the newer request runs (diagnosis D6). That is why the log says "no request marked running". Fixing the flag needs `core/orchestrator.ts`; follow-up.
- **R3:** after a typed takeover in LISTENING, if stt.py never answers, nothing ends the listen session: the LISTENING watchdog is cleared, as it was by the old error path. Follow-up: an STT session timer in `jarvis.ts`.
- **R4:** what STT hears after a typed takeover can stop the typed request's reply (barge-in) or abort it (arbitration). Follow-up, for the owner.
- **N2:** while a request really is running, a spoken request is waiting and the owner types, the waiting request still replaces the typed one, which is lost silently (review probe R2-C). This is the base behaviour of the unchanged concurrent branch; the owner's R1 choice was for the new case only. Follow-up, for the owner.
- **N6 (M1 not caught):** removing the LISTENING branch changes behaviour in one case only: a spoken request waiting in the queue while JARVIS is LISTENING. The real code goes LISTENING → IDLE without clearing the queue, so the drain runs the waiting request and the typed one gets no reply; the mutant clears the queue instead (review probe R3-A, `evidence/review_r3_probe.txt`). That case cannot happen with `jarvis.ts` as it is: every way into LISTENING passes IDLE (which drains the queue) or INTERRUPTED (whose paths clear it), and the queue holds at most one item. If `jarvis.ts` ever changes that, calling `runBargeInCallbacks()` in the LISTENING branch too would need the owner's agreement (the R1 choice covers the left-over case only).
- **N5:** a waiting spoken request that is dropped (here and on barge-in) is dropped with only a log line, although JARVIS said "I will get to that right after this". Follow-up, for the owner.

## How it got here

1. **First fix:** 11 lines (P1, P2). The test went from 8/4 to 12/12, then 13/13 once the "stop to tts.py" check was added (`evidence/new_code_checks.txt`). The first mutation run caught 2/4: M4 (barge-in removed) was missed until that check was added; M1 was not caught (see "Known limits").
2. **Review round 1, CHANGES REQUIRED:**
   - R1 (owner's choice): drop a waiting spoken request for typed text.
   - R2: the log wording.
   - R5 and R6: stronger tests.
   - R4 and R7: the records.
   - `boundaryDoublesTest` then failed, because the entry did not list `sendToRole`; the entry was fixed.
   - Full suite on that code: 209/0 (`evidence/full_suite_final.txt`).
3. **Review round 2, CHANGES REQUIRED:**
   - N1: the drop also hit spoken arbitration. Fixed by limiting the left-over branch to typed text.
   - N2 and N5 recorded.
   - N3: this log rewritten.
4. **Review round 3, PASS:** no code change; N6 (M1 wording), N7 (evidence rows), N8, N9 (records) fixed.

## Not changed

- `jarvis.ts`, `voice/*.py` and `core/agentStateMachine.ts`. The voice queue's code is unchanged; its behaviour changes only as described above, for typed text in a left-over state.
- A3 and A4 code, `.env` and subagents.
