# Closure — Close by name; tab requests close whole windows; process kill reports success unchecked

> Stage: 07_closure
> Date: 2026-10-26 · Run folder: `ai_workflows/runs/2026-10-25_close-by-name-and-window-close/`

## Identity
Findings TRA-04, TRA-18, TRA-06 (audit `docs/audit/JARVIS_TOOL_RELIABILITY_AUDIT_2026-10-25.md`); phase A1 (and B1) of `docs/audit/TOOL_REPAIR_PHASES.md`.

## Record Check
| Stage | File | State |
|---|---|---|
| 01 | `issue_brief.md` | complete |
| 02 | `diagnosis.md` | complete |
| 02b | `reproduction.md` | REPRODUCED (test, cloud Linux) |
| 03 | `patch_plan.md` | approved in advance by scope; written after implementation (deviation recorded) |
| 04 | `change_log.md` | complete, eight rounds |
| 05 | `verification.md` | complete, cloud Linux only |
| 05b | `review.md` | PASS (rounds 5–8), agent session, not human |
| 06 | `final_report.md` | ⚠️ partially verified |
| 07 | this file | — |

Evidence: `evidence/` (hooks-only diff, old-code runs, mutation runs 1–8 and harness, full-suite lines).

## Outcome
Fixed and tested on cloud Linux. **Partially verified**: not verified on Windows, the owner's PC or by live voice; stays partially verified until those checks pass.

## Tracker Update
- [x] Existing row updated: `docs/audit/TOOL_REPAIR_PHASES.md` phase A1 and B1 ticked; the B1 kernel item moved to A5
- [ ] No tracker owns this ID (BUG-n or none): recorded here only

## Runtime Issue (only for `iss-…`)
None.

## Follow-up (not done in this run)
- Owner: PC and voice checks listed in A1 (including "close current window" with Chrome in front: a confirmation question naming that window).
- A3: mixed app-and-tab requests; A5: kernel text-as-success (TRA-10) with the B1 item.
- Push needs the owner's approval (Gate 2).

## Closure Status
- [ ] COMPLETE
- [x] COMPLETE WITH LIMITATIONS (Windows and the owner's PC not observed; review by an agent session, not a human)
- [ ] BLOCKED — never reported as resolved
- [ ] ABANDONED — evidence kept
