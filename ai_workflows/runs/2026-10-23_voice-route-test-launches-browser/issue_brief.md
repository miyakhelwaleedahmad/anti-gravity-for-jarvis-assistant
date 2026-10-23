# Issue Brief — voiceRouteMockTest launches a real browser

> Stage: 01_intake · Run: `ai_workflows/runs/2026-10-23_voice-route-test-launches-browser/`
> Status: [x] Complete
> Date: 2026-10-23 · Machine: cloud Linux (Node 22.22.2, pnpm 10.33.0), branch `claude/jarvis-repair` at `0117a56`

---

## One-Sentence Problem Description

`tests/voiceRouteMockTest.ts`, part of `pnpm test:voice-core` and of every
`pnpm test -- --ci` run, sends "open YouTube for me" through the real
deterministic route, and `open_app` really launches the browser opener,
twice per run.

---

## Exact Symptoms

```
(owner-free reproduction, fake xdg-open first on PATH, it only records its arguments)
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

The test still reports PASS.

---

## Expected Behavior

An isolated test opens no application. `_config/TEST_MATRIX.md` says of the
voice-pipeline tests: "All run isolated through the runner; none opens an app
or speaks". `tests/boundary-doubles.json` records the same convention for
`noGroqForLocalCommandsTest`: "open_app is a dry run so the test opens no app
on the test machine".

---

## Actual Behavior

`voiceRouteMockTest` calls the real `orchestrator.process('open YouTube for me', 'voice')`
twice (lines 130 and 151). The deterministic route calls `open_app` without
`dryRun`, and the skill spawns the platform opener with `https://www.youtube.com`.

---

## Environment

- [ ] Live voice runtime (`pnpm run dev` + real microphone)
- [ ] CLI input (typed into terminal)
- [x] Test only (the test runner; isolated data folder per test)
- [ ] Unknown

Machine: cloud Linux, no real browser opener installed (`xdg-open` absent),
so the reproduction used a recording stand-in. On Windows the same code runs
`cmd.exe /c start "" https://www.youtube.com` (code read, not run here).

---

## Runtime Issue Record

Read: [ ] Yes
      [x] Not read — reason: no runtime issue. This is test behaviour, not a
      JARVIS runtime failure; `data/repairs/` is not in this clone and the
      issue store does not record test runs.

Tracker ID (from `_config/SOURCES_OF_TRUTH.md`): **none at intake.** This
finding was not tracked anywhere before this run: not in
`docs/audit/JARVIS_REPAIR_CHECKLIST.md`, not in
`docs/remediation/REMEDIATION_TRACKER.md`, not a BUG-n. Belongs in
`REMEDIATION_TRACKER.md` ("other development findings … IDs not in the
checklist") at Stage 07, with an ID the owner agrees to.

*Correction (2026-10-23, after review finding R2):* intake noted "last PC id
there: PC-16". That holds for `REMEDIATION_TRACKER.md` only. **PC-17 is
already used** in `docs/audit/JARVIS_REPAIR_CHECKLIST.md:226` ("PC-17:
PowerShell 7 installed, but the tests still found none"), and for an ID in
both files the checklist wins, so PC-17 must not be reused. The owner
approved **TEST-05** (test-quality findings use TEST-nn; TEST-01…04 exist;
TEST-05 appeared nowhere in the repository before this run).

---

## Facts, reports, missing

| Item | Kind |
|---|---|
| The test makes 2 opener calls per run (recorded above) | observed |
| The two control tests that use a dry-run stand-in make 0 calls | observed |
| `orchestrator.ts` line 661: `runRoutedTool('open_app', { target, source })`, no `dryRun` | observed (code) |
| `skills/automation/skill.ts`: only `args.dryRun` stops the launch | observed (code) |
| CI runs `pnpm test -- --ci` on Ubuntu (twice, with coverage) and Windows (`ci.yml` lines 51, 59, 96) | observed (config) |
| A browser tab opens on the owner's PC during `pnpm test:voice-core` / `pnpm test -- --ci` | inferred from code; not seen here |
| The owner has noticed stray YouTube tabs during test runs | missing (not reported) |

---

## Files Likely Involved

- `tests/voiceRouteMockTest.ts` (protected test, `_config/RUNTIME_PROTECTED_FILES.md`)
- `tests/boundary-doubles.json`, `tests/boundaryDoublesTest.ts`
- Read only: `core/orchestrator.ts` (deterministic route), `skills/automation/skill.ts` (`open_app`)

---

## What Has Already Been Tried

Nothing. Found while checking Phase B's note that this test prints contract
log lines itself (those `origLog` lines are not captured, so they do not
affect its checks).

---

## Ready to Advance to Diagnosis?

- [x] All symptoms documented
- [x] Expected vs actual behavior clear
- [x] Issue record: "not read" with the reason (never invented)
- [x] No secrets or unneeded personal data in this file
- [x] File list ready
- [x] No code edits made during this stage
