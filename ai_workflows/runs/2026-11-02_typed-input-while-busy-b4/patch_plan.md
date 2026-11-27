# Patch Plan — typed input while JARVIS is listening (phase B4, N-PC2)

Tests come first and are run on the current code. Then the change, related tests, typecheck, the full suite, a mutation check, and an independent review. Commit and push only with the owner's approval.

| # | Change | Files | Protected? |
|---|---|---|---|
| P1 | Typed text while JARVIS is LISTENING takes over: JARVIS leaves LISTENING for IDLE and runs the typed request. The speech recording that was going on finishes as usual. Anything it hears is handled as a new voice request (queued while JARVIS is busy, as today); an empty result is dropped, as today. | `core/orchestrator.ts` (`process()`, a few lines after the existing checks) | **yes** |
| P2 | A state left over with no request running (PLANNING, EXECUTING, OBSERVING, REFLECTING or REPAIRING, while `_loopExecuting` is false) is reset to IDLE before the new request, with a warning in the log. That is what `process()` already does when a request is still running. | same | **yes** |
| T | New `tests/typedWhileBusyB4Test.ts`: typed input in LISTENING and in each left-over state runs and gets its reply, not "unexpected error". It also covers the cases that must not change: barge-in while SPEAKING, typed input while a request is running (that request is aborted, as today), voice input while busy (queued), and a fast route ("open notepad"-like) typed in LISTENING. DO_NOT_BREAK tests stay green (interruptGating, voiceRouteMock, …). | tests | — |

There is no owner decision to make: the existing rules decide each case (typed text interrupts, speech is queued).

Not in this plan:
- the echo and noise from the microphone (Voice item);
- voice connections dropping under load (N-PC9);
- the B4 time-budget item.

Gate 1: **approved** by the owner on 2026-11-02 ("I approve the B4 N-PC2 fix, including the protected file core/orchestrator.ts"). The approval came with these conditions: keep the existing voice, interruption and request-queue behaviour; leave A3 and unrelated A4 code alone; no commit or push without separate approval.
