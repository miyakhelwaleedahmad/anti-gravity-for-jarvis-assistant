# Final Report — Close by name; tab requests close whole windows; process kill reports success unchecked

> Stage: 06_final_report
> Status: [x] Complete
> Date: 2026-10-26 · Phase A1 of `docs/audit/TOOL_REPAIR_PHASES.md` (also B1) · base `e394a26`

## 1. Root Cause
- **TRA-04:** the launch aliases (`notepad.exe`, `chrome.exe`, `calc.exe`) were reused to match windows against `Process.ProcessName`, which has no `.exe`; Calculator's window belongs to another program.
- **TRA-18:** app and window tools matched any window title containing the word, closed every match, and had no rule for browsers; the planner offered them first for "close … tab".
- **TRA-06:** a kill took the first substring match and reported success whatever Stop-Process did.
- **Found in review (pre-existing or introduced and fixed):** "close command prompt" matched every Windows Terminal window, JARVIS's own included; nested questions were answered by an earlier approval; a second Chrome window's handle was not in the window list the browser rule read; `restartProcess` restarted a different process than it killed.

## 2. Files Changed
`control/appMatch.ts` (new), `control/appController.ts`, `control/windowController.ts`, `control/processController.ts`, `control/actionQueue.ts`, `core/planningToolSelection.ts`, `core/verifiers.ts`, `tests/closeByNameTest.ts` (new), `package.json` (one script line), `ai_workflows/_config/TEST_MATRIX.md`, `ai_workflows/_config/ARCH_PC_CONTROL.md`, `docs/audit/TOOL_REPAIR_PHASES.md` (new), `docs/audit/JARVIS_TOOL_RELIABILITY_AUDIT_2026-10-25.md` (the audit, new), this run folder. No protected runtime file.

## 3. Test Results Summary
Cloud Linux only (see `verification.md`):
- `closeByNameTest`: **88 / 88** on the fixed code; on `e394a26` with only the stand-in hooks, **17 passed / 64 failed**, and the full test crashes at the restart case (`spawn notepad++ ENOENT`).
- Mutations: 50 distinct faults (`evidence/a1_mut2.py`; round 1's 12 are re-defined there against the final code), run over eight rounds: 49 caught; 1 (`R4_tab_rule_any_verb`) changed nothing observable and was removed together with the code it mutated.
- Typecheck 0 errors; related tests pass; full suite: see `verification.md`.
- Not run: Windows CI (not pushed), the owner's PC, live voice.

## 4. Review
A separate agent session (Claude), **not a human**: eight rounds. Rounds 1–4 CHANGES REQUIRED (34 findings: 17 + 8 + 4 + 5, among them R4-1: "close command prompt" reached JARVIS's terminal); rounds 5–8 PASS (round 7 checked the owner's decision D3a; 6 low findings in rounds 5 and 7, all answered). Every finding is answered in `review.md`.

## 5. Unresolved Risks
- Windows behaviour is inferred (ProcessName shape, window lists); owed on the PC (R17: Calculator may be listed twice on Windows 11, R5-4).
- "close current window" with Chrome in front asks the owner to confirm that Chrome window (owner's decision 2026-10-26); checked in tests only.
- A console titled "cmd.exe …" counts as Command Prompt even if it runs JARVIS; the protected question names it (R5-3).
- "close word" (WINWORD) and other partial names ask first.
- A mixed "close notepad and the youtube tab" gets only the tab tools (phase A3).
- A controller failure returned as text is still success at the kernel (TRA-10, phase A5).

## 6. Next Recommended Step
Owner: approve the push (not done without approval); then, on the PC (PowerShell, in the JARVIS folder): `pnpm test -- --only=closeByNameTest,appControlTest,windowControlTest,processControlSafetyTest` and the live checks in `docs/audit/TOOL_REPAIR_PHASES.md` A1. Then phase A2 (JARVIS-owned Chrome).

## 7. Verdict
- [ ] ✅ Fixed and verified — tests pass, live check passed if required, review PASS by an independent reviewer
- [x] ⚠️ Partially fixed / not verified — fixed and tested on cloud Linux; Windows CI, the owner's PC and live checks owed; review by an agent session, not a human
- [ ] ❌ Not fixed — see unresolved risks

## 8. Post-Report Checklist
- [x] Committed only the reviewed files, staged by name; `git diff --cached --name-only` checked
- [ ] Stable tag only after live verification and only at the owner's request
- [x] Next: `07_closure`
