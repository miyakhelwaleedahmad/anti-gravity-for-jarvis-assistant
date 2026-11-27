# Reproduction — voiceRouteMockTest launches a real browser

> Stage: 02b_reproduction · Run: `ai_workflows/runs/2026-10-23_voice-route-test-launches-browser/`
> Date: 2026-10-23 · Machine: cloud Linux (Node 22.22.2, pnpm 10.33.0), commit `0117a56`

---

## Failure Being Reproduced

| Field | Value |
|---|---|
| Issue ID | none (no runtime issue; test behaviour) |
| Symptom | Running the isolated suite calls the platform browser opener with `https://www.youtube.com` |
| Expected behaviour | No isolated test opens an application (`TEST_MATRIX.md`) |
| Observed behaviour | `voiceRouteMockTest` calls the opener twice and reports PASS |
| Affected file / subsystem | `tests/voiceRouteMockTest.ts` (test); route through `core/orchestrator.ts` → `open_app` |
| Trigger steps | 1. `pnpm test -- --only=voiceRouteMockTest` (also `pnpm test:voice-core`, `pnpm test -- --ci`) |

## Method

- [x] Existing test: `tests/voiceRouteMockTest.ts`, through the runner
- [ ] New regression test (draft, not committed)
- [ ] Manual check on the owner's PC
- [ ] None possible

The machine has no real opener (`xdg-open` absent). A stand-in
`xdg-open` in the session scratchpad (outside the repository), first on
`PATH`, appends its arguments to a log and exits 0. No browser opened; no
repository file was changed. The runner passes `PATH` to the test, and
`system/childEnv.ts` keeps `path` for the spawned opener.

## Commands and Output

Baseline of the test area, unmodified (all pass):

```
pnpm test -- --only=voiceRouteMockTest,noGroqForLocalCommandsTest,simpleNoGoalTest,voiceYouTubeIntegrationTest,boundaryDoublesTest,openAppSmokeTest,deterministicCommandRouteTest
=== 7 passed · 0 failed · 0 timed out · 0 blocked · 0 environment · 0 skipped ===
```

Reproduction, one test at a time, stand-in opener on `PATH`:

```
PATH="<scratchpad>/fakebin:$PATH" pnpm test -- --only=<test>

  PASS    voiceRouteMockTest                           1568ms
   -> browser-opener calls during voiceRouteMockTest: 2
  PASS    noGroqForLocalCommandsTest                   1511ms
   -> browser-opener calls during noGroqForLocalCommandsTest: 0
  PASS    simpleNoGoalTest                             1169ms
   -> browser-opener calls during simpleNoGoalTest: 0
--- recorded calls:
17:17:22 xdg-open https://www.youtube.com
17:17:22 xdg-open https://www.youtube.com
```

Runs: 1 (deterministic: two calls in the code path, two calls recorded) · git working tree clean afterwards.

## Result Label (choose one)

Label: **REPRODUCED** (automated, through the runner, Linux, stand-in opener)

Why the failure matches the diagnosed cause: the two recorded calls match the
two `orchestrator.process` calls in the test (lines 130, 151); the URL is
the one `open_app` resolves for "youtube"; tests that make `open_app` a dry
run record zero calls.

Not reproduced here: the Windows form (`cmd.exe /c start "" https://www.youtube.com`
opening a real tab). It follows from `skills/automation/skill.ts` lines 30–33
(inferred, not run). Owner-PC check, optional (PowerShell, in the JARVIS folder):
`pnpm test -- --only=voiceRouteMockTest`. Before the fix, expect two YouTube
tabs; after it, none.

## Exception

None needed: REPRODUCED.

## Ready for Patch Plan?

- [x] Label recorded honestly; no runtime code or existing test changed
- [x] REPRODUCED
