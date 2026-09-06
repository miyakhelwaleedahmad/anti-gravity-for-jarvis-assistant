# Verification Report — [Replace with Bug Name]

> Stage: 05_verification
> Status: [ ] Complete / [ ] In Progress
> Date: [fill in]

---

## Test Results

| Test | Expected | Actual Result | Status |
|---|---|---|---|
| `npx tsc --noEmit` | 0 errors | [paste count] | ✅/❌ |
| `nodeBridgeSingletonTest.ts` | 9/9 PASS | [paste] | ✅/❌ |
| `voiceRouteMockTest.ts` | 9/9 PASS | [paste] | ✅/❌ |
| `interruptGatingTest.ts` | 3/3 PASS | [paste] | ✅/❌ |
| `openAppSmokeTest.ts youtube` | PASS | [paste] | ✅/❌ |
| `openAppSmokeTest.ts notepad` | PASS | [paste] | ✅/❌ |
| `openAppSmokeTest.ts cmd` | PASS | [paste] | ✅/❌ |
| `latencySmokeTest.ts` | <100ms | [paste ms] | ✅/❌ |
| `deterministicCommandRouteTest.ts` | 39/39 | [paste] | ✅/❌ |
| `pnpm test:voice-core` | all pass | [paste] | ✅/❌/N/A |

---

## Full Test Output

<details>
<summary>Click to expand test output</summary>

```
[paste complete terminal output here]
```

</details>

---

## Live Voice Test (Required for Voice Bugs)

- Command spoken: `"Jarvis open YouTube for me"`
- Browser opened: [ ] Yes / [ ] No / [ ] N/A (non-voice bug)
- TTS spoke confirmation: [ ] Yes / [ ] No / [ ] N/A
- Total observed latency: [Xms or "not measured"]

**Captured Live Logs:**
```
[paste full terminal output from wake word through TTS speak here]
```

---

## Remaining Issues

[List any tests that still fail or any risks not fully resolved]

---

## Ready to Advance to Final Report?

- [ ] All tests pass
- [ ] Live voice test pass (or confirmed N/A)
- [ ] Real output pasted (not fabricated)
- [ ] Remaining issues documented
