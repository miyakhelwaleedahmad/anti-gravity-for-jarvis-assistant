# Verification Report — [Replace with Bug Name]

> Stage: 05_verification · Template. Copy to `ai_workflows/runs/<run>/verification.md`
> and fill in the copy; leave this file blank.
> Status: [ ] Complete / [ ] In Progress
> Date: [fill in] · Machine: [owner's Windows PC / CI / other host] · Commit: [hash]

---

## Test Results

All tests through the runner (`tests/runAll.ts`); never `npx tsx tests/<name>.ts`.

| Check | Command | Expected | Actual (runner lines) | Status |
|---|---|---|---|---|
| Type check | `pnpm run typecheck` | 0 errors | [paste] | ✅/❌ |
| Regression test (from 02b) | `pnpm test -- --only=<name>` | PASS (failed before the fix) | [paste] | ✅/❌ |
| Required group | `pnpm test -- --only=<names from TEST_MATRIX.md>` | all PASS | [paste] | ✅/❌ |
| Voice core group (voice changes) | `pnpm test:voice-core` | all PASS | [paste] | ✅/❌/N/A |
| Whole suite | `pnpm test -- --ci` | 0 FAIL | [paste summary line] | ✅/❌ |

BLOCKED (never a pass) and SKIPPED, with the runner's reason:

| Test | Verdict | Reason | Pre-existing on base commit? |
|---|---|---|---|
| | | | |

---

## Full Test Output

<details>
<summary>Click to expand test output</summary>

```
[paste complete terminal output here]
```

</details>

---

## Live Verification (voice, microphone, speaker, Windows control, real browser)

- Required: [ ] Yes / [ ] No — reason: [ ]
- Done with the owner present: [ ] Yes / [ ] No — owed (record as INCOMPLETE)
- Example, YouTube route: say `"Jarvis open YouTube for me"`
  - Browser opened: [ ] Yes / [ ] No / [ ] N/A
  - TTS spoke confirmation: [ ] Yes / [ ] No / [ ] N/A
  - Observed latency: [Xms or "not measured"]

**Captured Live Logs:**
```
[paste full terminal output from wake word through TTS speak here]
```

---

## Remaining Issues

[Tests that still fail, checks still owed, risks not resolved]

---

## Ready to Advance to Review?

- [ ] Every command above was actually run; output pasted, not retyped or invented
- [ ] Regression test now passes for the right reason
- [ ] Live check passed, or listed as owed (INCOMPLETE)
- [ ] BLOCKED / SKIPPED listed with reasons
