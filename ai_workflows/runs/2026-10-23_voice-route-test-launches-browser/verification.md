# Verification Report — voiceRouteMockTest launches a real browser

> Stage: 05_verification · Run: `ai_workflows/runs/2026-10-23_voice-route-test-launches-browser/`
> Status: [x] Complete
> Date: 2026-10-23 · Machine: cloud Linux 6.18, Node 22.22.2, pnpm 10.33.0 · Commit: `0117a56` + uncommitted fix (2 files)

---

## Test Results

All tests through the runner (`tests/runAll.ts`); never `npx tsx tests/<name>.ts`.

| Check | Command | Expected | Actual (runner lines) | Status |
|---|---|---|---|---|
| Type check | `pnpm run typecheck` | 0 errors | rc=0 | ✅ |
| Regression test, red | `pnpm test -- --only=voiceRouteMockTest,boundaryDoublesTest` (assertions, no fix) | FAIL on dry-run check | `FAIL voiceRouteMockTest` · `❌ FAIL: open_app was a dry run (no browser launched)` · 2 opener calls | ✅ (expected failure) |
| Regression test, green | same command, fix applied | PASS, 0 opener calls | `2 passed · 0 failed` · 0 opener calls | ✅ |
| Test area | `pnpm test -- --only=voiceRouteMockTest,boundaryDoublesTest,noGroqForLocalCommandsTest,simpleNoGoalTest,voiceYouTubeIntegrationTest,openAppSmokeTest,deterministicCommandRouteTest` | all PASS | `7 passed · 0 failed · 0 timed out · 0 blocked · 0 environment · 0 skipped` | ✅ |
| Voice core group | `pnpm test:voice-core` | all PASS | `12 passed · 0 failed · 0 timed out · 0 blocked · 0 environment · 0 skipped` | ✅ |
| Whole suite | `pnpm test -- --ci` (stand-in opener on PATH) | 0 FAIL; same as baseline | `200 passed · 0 failed · 0 timed out · 1 blocked · 0 environment · 9 skipped` (exit 1); **0 opener calls** | ✅ |

BLOCKED (never a pass) and SKIPPED, with the runner's reason:

| Test | Verdict | Reason | Pre-existing on base commit? |
|---|---|---|---|
| realTtsHandoffTest | BLOCKED | needs a Python with pygame and websockets | Yes (same at `e4a9cda`, `0117a56`) |
| dashboardAccuracyTest | SKIPPED | needs Redis and an LLM API | Yes |
| dashboardHealthSystemTest | SKIPPED | needs Windows PowerShell, an LLM API and Redis | Yes |
| finalIntegrationSuiteTest | SKIPPED | live provider test (`pnpm test:live`) | Yes |
| processControlSafetyTest | SKIPPED | needs Windows process table | Yes |
| startupPerformanceTest | SKIPPED | needs JARVIS_BRIDGE_TOKEN | Yes |
| sttReliabilityTest | SKIPPED | needs `.venv` | Yes |
| successfulExecutionLifecycleAuditTest | SKIPPED | live provider test | Yes |
| windowControlTest | SKIPPED | needs Windows window manager | Yes |
| windowsScriptsTest | SKIPPED | needs PowerShell 7 | Yes |

Opener probe: a stand-in `xdg-open` in the session scratchpad (outside the
repository) recorded every launch attempt. Before the fix: 2 per
`voiceRouteMockTest` run. After: 0 for that test and 0 for the entire `--ci` suite.

---

## Full Test Output

Kept in the session scratchpad (`verification_raw.txt`, `red_step.txt`,
`green_step.txt`, `verify_full.log`); the runner lines above are copied
from them unchanged.

---

## Live Verification (voice, microphone, speaker, Windows control, real browser)

- Required: [ ] Yes / [x] No — reason: test-only change; no runtime file changed
- Owed (optional, owner's PC): PowerShell, JARVIS folder,
  `pnpm test -- --only=voiceRouteMockTest`. Expect no YouTube tab. Not run here.
- Windows CI: not run yet for this change (nothing pushed).

---

## Remaining Issues

- Windows behaviour (no tab opens) is inferred from the code path, not seen.
- Out of scope, recorded as follow-ups: line 108 `|| true` assertion; the
  "forwarded to orchestrator" checks bypass NodeBridge's `stt_result` handler.
- Independent review (Stage 05b) not done yet: the implementer must not review.

---

## Ready to Advance to Review?

- [x] Every command above was actually run; output pasted, not retyped or invented
- [x] Regression test now passes for the right reason (red shown first)
- [x] Live check: not required; optional owner check listed
- [x] BLOCKED / SKIPPED listed with reasons
