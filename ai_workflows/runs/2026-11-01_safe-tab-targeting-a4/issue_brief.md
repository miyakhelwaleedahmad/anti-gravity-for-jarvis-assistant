# Issue Brief — safe tab targeting (phase A4: TRA-01, TRA-02, TRA-11)

Owner request 2026-11-01: "move for another phase". Tracker `docs/audit/TOOL_REPAIR_PHASES.md`, phase A4, plus findings N-PC4, N-PC5, N-PC6 (A2 follow-up) and N-PC8 (A3 PC test).

On the owner's PC, 2026-11-01, commit `915584c`:
- "close youtube tab" closed a YouTube tab, and JARVIS said "I could not confirm it worked: the tab is still open". This happened twice.
- The extra YouTube tab came from an echo of JARVIS's own reply ("opening YouTube search").
- After the second close, JARVIS's Chrome was gone: the next tab question found "JARVIS's own Chrome is not running".
- "close the youtube tab the current one" and "close this tab" still go to the planner, which reads the tabs and closes nothing.
