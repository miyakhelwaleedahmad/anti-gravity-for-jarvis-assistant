# Issue Brief — honest capability (phase A5)

The owner asked to start phase A5 on 2026-11-03 ("approved commited and start a5"). It is the next phase in `docs/audit/TOOL_REPAIR_PHASES.md` and covers audit findings TRA-07, 08, 09, 10, 12 and 19 (`docs/audit/JARVIS_TOOL_RELIABILITY_AUDIT_2026-10-25.md`). B3 (health honesty) is done with it. One item comes from B1: a controller failure returned without throwing.

What the audit found (root cause RC4: "registration treated as capability; unavailable reported as empty or unchecked success"):
- **TRA-07:** without Chrome or PowerShell, read tools answer an empty list or `false` with `success: true`. "Is YouTube open?" then says "No".
- **TRA-08:** `self_check` reports the last tool that ran as "tools working". Redis counts as VERIFIED on its in-memory fallback. There is no item for Chrome (CDP), PowerShell or the permission level.
- **TRA-09:** there is no capability model. Every tool is offered on every OS.
- **TRA-10:** the kernel turns any returned text into success.
- **TRA-19:** `open_app` reports success without checking that the opener started, and an "unverifiable" check counts as success.
- **TRA-12 (D2):** settled in phase A4, where the owner chose one permission rule for closing any tab (A4 P5).

Goal (audit section I): JARVIS says "Chrome is not reachable", "needs Windows" or "enable full control" instead of a false "no" or a false success. No read tool reports empty when its source failed.
