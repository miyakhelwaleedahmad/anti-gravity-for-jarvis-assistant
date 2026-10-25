# Final Report — voiceRouteMockTest checks that cannot fail (TEST-06)

> Stage: 06_final_report · Run: `ai_workflows/runs/2026-10-25_voice-route-test-weak-checks/`
> Status: [x] Complete
> Date: 2026-10-25

---

## 1. Root Cause

`tests/voiceRouteMockTest.ts` never started the bridge. It put mock sockets
into NodeBridge's private maps and called `orchestrator.process` itself.
8 of its 11 checks could not catch the fault their label named (finding A,
B1, R3 and the self-filled roles); only `open_app` was watched for launches
(R5). Shown by mutation: 7 of 9 code faults passed the old test, including
a direct browser launch (`evidence/attack_old_test.txt`). A test defect; no
JARVIS runtime defect was found.

## 2. Files Changed

Commit `8ec1d89`:

| File | Change |
|---|---|
| `tests/voiceRouteMockTest.ts` | Real bridge with stand-in clients; 13 checks (see `change_log.md`) |
| `tests/boundary-doubles.json` | Reason text only; the entry is still `registry:execute` |
| `ai_workflows/_config/DO_NOT_BREAK.md` | 11/11 → 13/13 |
| `ai_workflows/_config/ARCH_VOICE.md`, `TEST_MATRIX.md` | What the test checks and does not see |

No runtime file. Three implementation attempts (`change_log.md`), each after a
review round.

## 3. Test Results Summary

Cloud Linux, Node 22.22.2, pnpm 10.33.0; committed version (round 3):

| Check | Result |
|---|---|
| Typecheck | 0 errors |
| `voiceRouteMockTest` | 13/13; 10/10 repeated runs, 1.4-1.8 s, 0 opener calls |
| Mutations | control PASS; 18 faults FAIL (9 mine, 9 the reviewer's); slow skill loading on correct code PASS |
| Related tests | 12/12 |
| `pnpm test:voice-core` | 12/12 |
| `pnpm test -- --ci` | 200 passed / 0 failed / 1 blocked (`realTtsHandoffTest`: no pygame here) / 9 skipped; 0 opener calls in the whole suite |

Evidence: `verification.md` and `evidence/`.

## 4. Review

A separate agent session, **not a human**, three rounds (`review.md`):

| Round | Decision | Main findings | Handled |
|---|---|---|---|
| 1 | CHANGES REQUIRED | V1-V4 medium: tools called directly not seen; launches before the route dropped; opener pattern too narrow; evidence missing | All fixed (attempt 2); V5-V10 low also fixed |
| 2 | CHANGES REQUIRED | N1 medium: the tool wrap raced the skill loading (spurious failure on slow machines) | Fixed (attempt 3); N2-N4 also fixed |
| 3 | **PASS** | P3 low: URLs ending in `/open` or `/start` are flagged; P4: wording | P4 done; P3 accepted and documented |

Runtime observations by the reviewer, **not changed** (they need the owner's
approval and a separate run):

- RD1: `nodeBridge.stop()` does not close the health server or reset `wss`,
  so a later `start()` is ignored.
- RD2: after a port-in-use error, a retried `start()` registers the
  `client_ready` and `hardware_error` handlers twice (inferred).
- RD3: a whitespace-only `stt_result` is recorded as a transcript (inferred).

## 5. Unresolved Risks and Follow-ups (not done in this run)

1. **Windows:** the TEST-06 version has not run on Windows (owner's PC or
   Windows CI). Two specific risks:
   - the launch check could flag a process that Windows starts during the
     test. The failure message prints the command, so it is easy to diagnose;
   - the skill loading is slower on the PC. The test waits for it, at most
     10 s.
2. **B2:** `jarvis.ts`'s `stt_result` handler is still untested (needs an
   architectural change and separate approval).
3. Not seen by the launch check: a worker thread, the `ChildProcess` class
   used directly, a native addon, a tool's `execute` saved before the wrap,
   and `powershell -EncodedCommand`.
4. RD1-RD3 above.
5. Still owed from TEST-05: the live "open YouTube for me" route; real audio
   and microphone.

## 6. Next Recommended Step

The owner runs, in PowerShell in the JARVIS folder, after the commits reach
the PC:

```
pnpm test -- --only=voiceRouteMockTest
```

Expected: `1 passed · 0 failed`, and no browser tab opens.

## 7. Verdict

**Fixed and verified on cloud Linux. Not verified on Windows.** No claim is
made about live voice, audio or the browser.

## 8. Post-Report Checklist

- [x] Every claim above has evidence in `verification.md`, `review.md` or `evidence/`
- [x] The review is labelled as an agent's, not a human's
- [x] Blocked test named, not counted as passed
- [x] No runtime file changed
