# Verification Report — Close by name; tab requests close whole windows; process kill reports success unchecked

> Stage: 05_verification
> Status: [x] Complete (cloud Linux only)
> Date: 2026-10-26 · Machine: cloud Linux 6.18 x86_64, Node 22.22.2, pnpm 10.33.0 · Commit: working tree on `e394a26` (before the local commit)

## Test Results

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | exit 0, 0 errors |
| Regression test | `pnpm test -- --only=closeByNameTest` | PASS, 88 / 88 checks (count from a scratchpad copy that prints its summary) |
| Same test on `e394a26` + stand-in hooks only | same, in `<scratchpad>/a1old` | 17 passed / 64 failed with the two restart cases removed; the full test crashes at the restart case (`spawn notepad++ ENOENT`) |
| Related tests | `pnpm test -- --only=closeByNameTest,appControlTest,processControlSafetyTest,windowsToolsTest,windowControlTest,taskFailureHonestyTest,closeAppRouteTest,routeGoldenTest,toolDiscoverabilityAuditTest,plannerDecisionAuditTest,plannerDesktopToolSelectionTest,registryRepairHonestyTest,riskEngineTest,adminControlTest,verifyAfterActTest,windowsStateFreshnessTest,childEnvCoverageTest,browserControlAgentTest,deterministicCommandRouteTest,systemStateRouteTest,dispatchAuthzTest,executionDispatchAuditTest,errorRecoveryTest,scenarioIntegrationTest,boundaryDoublesTest,docsHygieneTest,actionQueueRecoveryTest,pcControlKernelTest` (after review round 1) | 26 passed · 0 failed · 1 blocked (`windowControlTest`, needs Windows) · 1 environment (`processControlSafetyTest`, needs the Windows process table) |
| Full suite (final code) | `pnpm test -- --ci` | **201 passed · 0 failed · 0 timed out · 1 blocked · 0 environment · 9 skipped** (211 files); `evidence/full_suite.txt` |
| Mutations | `evidence/a1_mut2.py` | 50 distinct faults, 49 caught, 1 removed with its code (`evidence/mutation_run*.txt`) |

Blocked: `realTtsHandoffTest` (no pygame/websockets here; blocked before this run too). Skipped (this host lacks the prerequisite): dashboardAccuracyTest, dashboardHealthSystemTest, finalIntegrationSuiteTest (live), processControlSafetyTest, startupPerformanceTest, sttReliabilityTest, successfulExecutionLifecycleAuditTest (live), windowControlTest, windowsScriptsTest. The runner exits 1 because of the blocked test ("No failures, but the blocked tests above were not verified").

Baseline for comparison (TEST-06, `e394a26`, same host): 200 passed / 0 failed / 1 blocked / 9 skipped; the one added pass is `closeByNameTest`.

## Full Test Output
`evidence/full_suite.txt` (one line per file, from the runner).

## Live Verification (voice, microphone, speaker, Windows control, real browser)
**Not done.** Owed on the owner's PC (PowerShell, in the JARVIS folder):
1. `pnpm test -- --only=closeByNameTest,appControlTest,windowControlTest,processControlSafetyTest` → expected `4 passed` (save open Notepad work first; `appControlTest` opens and closes its own Notepad).
2. Live, by voice and typed: open Notepad → "close notepad" closes it; "close calculator" on Windows 11 closes Calculator (R17: it may ask about 2 windows); with YouTube open, "close the YouTube tab" leaves the Chrome window open; with JARVIS's terminal open, "close command prompt" closes nothing; Chrome in front + "close current window" → a question naming that Chrome window, "no" leaves it open.
3. Windows CI after the owner approves the push.

## Remaining Issues
See `final_report.md` §5.

## Ready to Advance to Review?
- [x] Every command above was actually run; output pasted, not retyped or invented
- [x] Regression test now passes for the right reason (fails on the old logic, 49 of 50 faults caught)
- [ ] Live check passed, or listed as owed (INCOMPLETE) — **owed**
- [x] BLOCKED / SKIPPED listed with reasons
