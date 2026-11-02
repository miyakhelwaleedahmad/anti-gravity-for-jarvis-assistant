# Issue Brief — typed input while JARVIS is listening (phase B4, N-PC2)

The owner asked on 2026-11-02 to "move to another problem". This is finding N-PC2 in the tracker (`docs/audit/TOOL_REPAIR_PHASES.md`, B4).

The owner's PC logs, on 2026-10-31 and again on 2026-11-02 at commit `2d35a0a`, show the same failure. Text typed while JARVIS is listening (after it heard "Jarvis"), or while it is still in REFLECTING, gives `ILLEGAL TRANSITION REJECTED: LISTENING -> PLANNING` (or `REFLECTING -> PLANNING`). JARVIS then says "I encountered an unexpected error, sir. Please try again." The typed request is lost.
