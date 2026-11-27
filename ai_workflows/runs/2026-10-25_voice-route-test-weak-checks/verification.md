# Verification Report — voiceRouteMockTest checks that cannot fail

> Stage: 05_verification · Run: `ai_workflows/runs/2026-10-25_voice-route-test-weak-checks/`
> Status: [x] Complete
> Date: 2026-10-25 · Machine: cloud Linux 6.18, Node 22.22.2, pnpm 10.33.0 · Commit: `76f4712` + uncommitted change (5 files + this run folder)

A recording stand-in `xdg-open` was first on PATH for every run; it opens
nothing.

---

## Test Results

| Check | Result | Evidence |
|---|---|---|
| `pnpm run typecheck` | 0 errors | `evidence/related_tests.txt` |
| `voiceRouteMockTest` | PASS, 13 passed / 0 failed | `evidence/repeat_runs.txt`, `change_log.md` |
| 10 repeated runs | 10/10 PASS, 1446-2018 ms, 0 opener calls, no test process left afterwards | `evidence/repeat_runs.txt` |
| 9 mutations (M1-M8; M5 as a and b) and a control, on the final file | control PASS; all 9 mutations FAIL | `evidence/attack_new_test.txt` |
| The same 9 on the old test | 7 of 9 PASS (M8 was run on it afterwards and also passes) | `evidence/attack_old_test.txt` |
| Launch pattern, 14 sample command lines | 0 wrong | `evidence/launch_pattern_check.txt` |
| Route probe (unchanged runtime) | tools `open_app` ×2; no child process during the route; a real launch is seen when the dry run is off | `evidence/probe_route.txt` |
| Related tests (`boundaryDoublesTest`, `docsHygieneTest`, `testScriptIsolationTest`, `bridgeSecurityTest`, `healthLedgerTest`, `nodeBridgeSingletonTest`, `voiceContinuationFallbackTest`, `bargeInEchoTest`, `voiceYouTubeIntegrationTest`, `deterministicCommandRouteTest`, target) | 11/11 PASS, 0 opener calls | `evidence/related_tests.txt` |
| `pnpm test:voice-core` | 12/12 PASS, 0 opener calls | `evidence/voice_core.txt` |
| `pnpm test -- --ci` | 200 passed / 0 failed / 0 timed out / **1 blocked** (`realTtsHandoffTest`: no Python with pygame and websockets here) / 9 skipped; exit 1 because of the blocked test; 0 opener calls | `evidence/full_suite_summary.txt` |

The suite totals equal TEST-05's (200 / 0 / 1 / 9): no test changed verdict.
`voiceRouteMockTest` took 1883 ms in the suite (3244 ms before this change on
the same machine: it now runs the route once instead of twice).

### Round 3 (after review round 2; the version to be committed)

| Check | Result | Evidence |
|---|---|---|
| `pnpm run typecheck` | 0 errors | `evidence/related_tests_round3.txt` |
| `voiceRouteMockTest`, raw output | 13 passed / 0 failed | `evidence/green_step.txt` |
| 10 repeated runs | 10/10 PASS, 1420-1787 ms, 0 opener calls, no test process left | `evidence/repeat_runs_round3.txt` |
| 9 M mutations, X1-X7, X10, and a control | control PASS; all 18 FAIL | `evidence/attack_round3.txt` |
| X9: skill registration 400 ms slower, correct runtime | PASS (the test waits for the skills; it failed in review round 2) | `evidence/attack_round3.txt` |
| Launch matcher, 33 sample command lines | 0 wrong; accepted false positives and one false negative listed | `evidence/launch_pattern_round3.txt` |
| Related tests (12) | 12/12 PASS, 0 opener calls | `evidence/related_tests_round3.txt` |
| `pnpm test:voice-core` | 12/12 PASS, 0 opener calls | `evidence/voice_core_round3.txt` |
| `pnpm test -- --ci` | 200 passed / 0 failed / 0 timed out / 1 blocked (`realTtsHandoffTest`, environment) / 9 skipped; exit 1 because of the blocked test; 0 opener calls | `evidence/full_suite_summary_round3.txt` |

### Round 2 (after review round 1)

| Check | Result | Evidence |
|---|---|---|
| `pnpm run typecheck` | 0 errors | `evidence/related_tests_round2.txt` |
| `voiceRouteMockTest`, raw output | 13 passed / 0 failed | `evidence/green_step.txt` |
| 10 repeated runs | 10/10 PASS, 1350-1797 ms, 0 opener calls, no test process left | `evidence/repeat_runs_round2.txt` |
| 9 M mutations + the reviewer's 8 X mutations, and a control | control PASS; all 17 FAIL | `evidence/attack_round2.txt` |
| Launch matcher, 23 sample command lines | 0 wrong (one accepted false positive: anything naming "youtube") | `evidence/launch_pattern_round2.txt` |
| Related tests (the 11 above plus `openAppSmokeTest`) | 12/12 PASS, 0 opener calls | `evidence/related_tests_round2.txt` |
| `pnpm test:voice-core` | 12/12 PASS, 0 opener calls | `evidence/voice_core_round2.txt` |
| `pnpm test -- --ci` | 200 passed / 0 failed / 0 timed out / 1 blocked (`realTtsHandoffTest`, environment) / 9 skipped; exit 1 because of the blocked test; 0 opener calls | `evidence/full_suite_summary_round2.txt` |

The round-1 rows above are kept as the record of attempt 1.

---

## Full Test Output

The full suite log is not committed (`*.log` is Git-ignored and is not
force-added). The summary lines are in `evidence/full_suite_summary.txt`.

---

## Live Verification (voice, microphone, speaker, Windows control, real browser)

None in this run. Not verified:

- Windows (owner's PC or Windows CI) for the TEST-06 version. The owner's last
  result (1 passed, about 70.8 s) was for the TEST-05 version.
- The live "open YouTube for me" route, real audio, microphone.
- `jarvis.ts`'s `stt_result` handler (B2): not covered by this test.

---

## Remaining Issues

- `realTtsHandoffTest` blocked in cloud Linux (environment). It passed on
  Windows CI run #81 for an earlier commit.
- B2 open.

---

## Ready to Advance to Review?

- [x] All planned checks run, with raw evidence
- [x] Blocked test named, not counted as passed
