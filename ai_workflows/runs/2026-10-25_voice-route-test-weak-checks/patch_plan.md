# Patch Plan — voiceRouteMockTest checks that cannot fail

> Stage: 03_patch_plan · Run: `ai_workflows/runs/2026-10-25_voice-route-test-weak-checks/`
> Status: [ ] Awaiting Approval / [x] Approved (scope, in advance; see Approval) / [ ] Rejected
> Date: 2026-10-25 · Base commit: `76f4712`

---

## Summary

Run the test against the real bridge with stand-in Python clients, check
what each label says, and record every tool and child process during the
route. Test-only; no runtime file changes.

---

## Proposed Changes

### Change 1 — real bridge, real handshake (B1, finding E)

Set `BRIDGE_HOST=127.0.0.1`, free `BRIDGE_PORT`/`HEALTH_PORT`, a test token
and `JARVIS_BRIDGE_DEV_MODE=false` before the bridge loads (the pattern in
`healthLedgerTest`). Start the bridge. Stand-in `wakeword`, `tts` and `stt`
clients connect and answer the handshake with `client_ready`. The three
"registered" checks then test the real handshake.

### Change 2 — listen_start is really sent (A)

```ts
const listenSent = nodeBridge.sendListenStart();
await waitFor(() => stt.received.some((m) => m.type === 'listen_start'));
assert(listenSent && stt.received.some((m) => m.type === 'listen_start'), …);
```

### Change 3 — stt_result through the bridge (B1)

A recording `stt_result` handler. The wake-word client sends an empty
`stt_result`, then "open YouTube for me". Checks: the empty one reaches the
handlers but is not counted as a transcript; the text reaches them; the
engine is "Google STT" (the bridge used the sender's role); speech
recognition is recorded healthy. The three checks of the test's own values
are removed. The test says that `jarvis.ts`'s handler is not covered (B2).

### Change 4 — route checks (R3, R5)

`orchestrator.process(<delivered text>, 'voice')` once (it was twice).
Checks: the route line `Deterministic command route: type="open_app"
target="youtube"` on one line; `open_app` ran once, for youtube, a dry run;
**no tool but `open_app`** ran; **no opener process** (`xdg-open`, `open`,
`explorer`, `cmd … start`) and no process naming YouTube was started. The
`child_process` functions are wrapped to record, not replaced, before the
JARVIS modules load.

### Change 5 — no imitation log lines (finding F)

Remove the `origLog` lines that imitate bridge and orchestrator logs.

---

## Files That Will Change

| File | Change |
|---|---|
| `tests/voiceRouteMockTest.ts` | Changes 1-5 |
| `tests/boundary-doubles.json` | reason text: the wrapper also records tool names |
| `ai_workflows/_config/DO_NOT_BREAK.md` | 11/11 → 13/13 |
| `ai_workflows/_config/ARCH_VOICE.md`, `TEST_MATRIX.md` | the description of the test |

---

## Reproduction (from Stage 02b)

Mutations M1-M8 (M8: an empty `stt_result` is counted as a transcript, added
with Change 3) in the scratchpad export. Acceptance: every mutation fails the
new test; the unchanged code passes.

---

## Tests to Run After Implementation

Typecheck; `voiceRouteMockTest` repeatedly; `boundaryDoublesTest`,
`docsHygieneTest`, `testScriptIsolationTest`; the bridge and voice tests
(`bridgeSecurityTest`, `healthLedgerTest`, `nodeBridgeSingletonTest`,
`voiceContinuationFallbackTest`, `bargeInEchoTest`, `voiceYouTubeIntegrationTest`,
`deterministicCommandRouteTest`); `pnpm test:voice-core`; `pnpm test -- --ci`.

---

## Live Voice Verification Required?

No: no runtime change. The live "open YouTube for me" check stays owed from
TEST-05 (`TEST_MATRIX.md`).

---

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Port clash or a slow bind | free ports; the stand-in retries the connection for up to 5 s |
| Fixed sleeps make it slow or flaky | bounded waits on conditions (`waitFor`, 10 ms poll, 3 s limit) |
| The owner's `.env` changes the bridge host or token | the test sets them first; `dotenv` does not override set variables |
| Windows starts other processes (the PowerShell session) | the launch check flags openers and YouTube only, not every process |
| A real launch during a regression | the dry run stays; the record makes the test fail |

---

## Rollback

`git revert` of the implementation commit. No data or runtime state is touched.

---

## Acceptance Criteria

- [ ] M1-M8 each fail the new test; the control passes
- [ ] 0 opener calls in all runs
- [ ] Related tests, voice-core and the full suite unchanged
- [ ] No runtime file in the diff

---

## What This Fix Cannot Prove

`jarvis.ts`'s `stt_result` handler (B2), real audio and microphone, the live
browser launch, and Windows behaviour (until the owner or Windows CI runs it).

---

## Approval

The owner approved this run's scope in advance on 2026-10-25 (mission
"JARVIS TEST-06"): "Approved scope: finding A (`|| true`), B1 (real
`stt_result` path through NodeBridge), R3 (route verification), R5
(unintended tool invocation / browser-launch alternatives). B2 stays open."
The mission also says to work test-first and to stop for approval if a
runtime defect appears (none appeared).

**Deviation:** this detailed plan was not shown to the owner before Stage 04.
It stays inside the approved scope and changes no runtime file. The doc and
`boundary-doubles.json` updates keep existing records true; they are listed
here for the owner to confirm.
