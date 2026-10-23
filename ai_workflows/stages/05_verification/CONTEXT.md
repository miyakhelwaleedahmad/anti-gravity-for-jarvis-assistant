# Stage 05 — Verification

## Purpose
Confirm the change worked — with tests AND live runtime if required.

## What You Are Allowed to Do
```
✅ Run TypeScript compile check
✅ Run all tests from _config/TEST_MATRIX.md through the runner (`pnpm test`)
✅ Run live voice verification if the bug was voice-related
✅ Capture and paste real log output into output/verification.md
✅ Record honest pass/fail for every test
✅ Report any remaining issues found during testing
```

## What You Must NOT Do
```
❌ Do not change test assertions to make tests pass artificially
❌ Do not skip any test from TEST_MATRIX.md
❌ Do not report "PASS" without running the actual command
❌ Do not claim a voice bug is fixed without live voice verification
❌ Do not skip the live test just because all mock tests pass
❌ Do not run a test file directly (`npx tsx tests/<name>.ts`): it writes to JARVIS's real data
❌ Do not start live checks (apps, microphone, speakers, LLM) without the owner present
```

## Required Test Run Order

See `_config/TEST_MATRIX.md` for the full list. Minimum (CMD or PowerShell;
the runner gives each test its own empty data folder):

```powershell
pnpm run typecheck
pnpm test -- --only=nodeBridgeSingletonTest,voiceRouteMockTest,interruptGatingTest,openAppSmokeTest,latencySmokeTest,deterministicCommandRouteTest
pnpm test -- --ci
```

No isolated test covers open_app "notepad"/"cmd" or "open YouTube for me";
the last is checked live (below), with the owner.

## Live Voice Verification (Required for Voice Bugs)

```
1. pnpm run dev
2. Wait for: [NodeBridge] ✅ READY client registered: wakeword/stt/tts
3. Say: "Jarvis open YouTube for me"
4. Confirm browser opens https://www.youtube.com/
5. Confirm TTS speaks
6. Paste all terminal output into output/verification.md
```

## Verification Report Format

```markdown
## Test Results

| Test | Expected | Actual Result | Status |
|---|---|---|---|
| pnpm run typecheck | 0 errors | [paste] | ✅/❌ |
| pnpm test -- --only=… (list above) | all PASS | [paste runner lines] | ✅/❌ |
| pnpm test -- --ci | 0 FAIL | [paste summary line; list SKIPPED/BLOCKED] | ✅/❌ |
...

## Live Voice Test
- Command spoken: "Jarvis open YouTube for me"
- Browser opened: Yes/No
- TTS spoke: Yes/No
- Captured logs:
  [paste full log output here]

## Remaining Issues
- [list any tests that still fail]
- [list any risks not yet addressed]
```

## Advancement Condition
You may advance to `06_final_report` only when:
1. All tests pass
2. Live voice test passes (if voice-related)
3. `output/verification.md` is complete with real output
