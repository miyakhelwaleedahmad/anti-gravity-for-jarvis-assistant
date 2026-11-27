# Issue Brief — diagnostics (phase A6)

The owner asked to move to A6 on 2026-11-06, after A5e's checks passed on the PC ("now if it is don so move to next problem"; earlier: "Only then consider A5e complete and move towards A6 diagnostics"). A6 is the next phase in `docs/audit/TOOL_REPAIR_PHASES.md`. It covers audit findings TRA-13 and TRA-15 (`docs/audit/JARVIS_TOOL_RELIABILITY_AUDIT_2026-10-25.md`), and B4's item "Action log fields (with A6)".

What the audit found:
- **TRA-13 (P3):** "Kernel action log fields are hard-coded and written as success before verification; disagrees with the trace log."
- **TRA-15 (P3):** "Test Chromium processes survive on Windows (`proc.kill()` ends the parent only): CI 'Terminate orphan process: chrome' ×2."

Acceptance (audit section I): one request can be followed end to end. The trace and the action log agree after a VERIFICATION_FAILED. Windows CI shows no orphan Chrome.
