# Reproduction — Close by name; tab requests close whole windows; process kill reports success unchecked

> Stage: 02b_reproduction
> Date: 2026-10-25 · Machine: cloud Linux 6.18 x86_64, Node 22.22.2, pnpm 10.33.0 (not the owner's PC, not Windows)

## Failure Being Reproduced
TRA-04, TRA-18, TRA-06 as in `diagnosis.md`.

## Method
- [ ] Existing test: `tests/<name>.ts`
- [x] New regression test (draft, not committed): `tests/closeByNameTest.ts`
- [ ] Manual check on the owner's PC (owner present)
- [ ] None possible (fill in the Exception section)

The controllers read the window list, run `win_automate.ps1` and PowerShell, and ask for approval directly, so a test can't give them a window list on Windows. The test gives stand-ins through constructor arguments. To run it against the old logic, a scratchpad export of `e394a26` (`git archive`) got **only those constructor arguments**, with every matching and kill line unchanged: `evidence/hooks_only.diff`. The reproduction ran only in that export. **Order, honestly:** the fix had already been written in the working tree when this ran (see `patch_plan.md`, Deviation); the export is `e394a26` plus the hooks, not the working tree.

## Commands and Output
In the export (`<scratchpad>/a1old`, `node_modules` linked):
```
pnpm test -- --only=closeByNameTest
```
Result: `=== 0 passed · 1 failed ===`; inside the test, **10 passed, 26 failed** (`evidence/old_code_run.txt`). The failures, grouped:
- TRA-04: "close notepad", "close Notepad.exe", "close calculator" → "No open application matches"; "focus notepad" → "No running window found"; "restart notepad" closed nothing, then opened a second copy.
- TRA-18: `control_app close "youtube"` closed `0x2B` (the YouTube Chrome window), "gmail" closed `0x2C`, "google chrome" closed both, "edge" closed the Edge window; `control_window close "youtube"`/`"chrome"` closed `0x2B`; two Notepad windows were never asked about; the planner offered `control_app, control_window` first for all four tab phrases.
- TRA-06: kill "notepad" stopped `notepad++` (PID 900, first in the list) and said "Successfully terminated"; also after a failed Stop-Process ("Access is denied") and with the process still running; kill "chrome" asked and killed.

The three kernel checks (section 6) passed on the old code too: the kernel already reports a thrown error as `success: false`. They are kept as the B1 coverage that MF lacked outside the browser path.

### Re-run with the final test (after review round 1, R15)
Same export, test copied from the working tree after round 2:
- The full test **crashes** at the restart case: `Error: spawn notepad++ ENOENT`, uncaught (the old `restartProcess` restarted `matches[0]`, review R3). `evidence/old_code_run_final_crash.txt`.
- Final test (after review round 5), the two restart cases removed in a scratchpad copy only: **17 passed, 64 failed** (`evidence/old_code_run_final.txt`); the full final test crashes at the restart case (`evidence/old_code_run_final_crash.txt`). The 14 that pass on the old code guard what must not change (a not-open app, "close notepad" through control_window, "close current window", the app/window planner offers, the three kernel checks, …).
- Fixed code: **83 passed, 0 failed**; 85 / 85 after the owner's D3a change (two checks for "close current window" with Chrome in front, which the old code fails by closing it unasked); 88 / 88 after review round 7.

## Result Label (choose one)
**REPRODUCED** (test, cloud Linux; logic only, with real-shaped data). The Windows desktop effect is not reproduced here.

## Exception (any label other than REPRODUCED / REPRODUCED-MANUAL)
None. Owed: a Windows check on the owner's PC (`closeByNameTest` runs there too, and Notepad live).

## Ready for Patch Plan?
- [x] Label recorded honestly; no runtime code or existing test changed for the reproduction (it ran in the export)
- [x] REPRODUCED / REPRODUCED-MANUAL, or the exception is written out for the owner
