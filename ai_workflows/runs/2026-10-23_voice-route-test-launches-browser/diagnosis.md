# Diagnosis — voiceRouteMockTest launches a real browser

> Stage: 02_diagnosis · Run: `ai_workflows/runs/2026-10-23_voice-route-test-launches-browser/`
> Status: [x] Complete
> Date: 2026-10-23 · Commit: `0117a56`

---

## Root Cause (Primary Hypothesis — confirmed by reproduction, see reproduction.md)

**File:** `tests/voiceRouteMockTest.ts`
**Line(s):** 130 and 151 (both call the real `orchestrator.process`)
**Description:** The test exercises the deterministic route end to end but,
unlike the other tests that send "open …" through the orchestrator, it does
not make `open_app` a dry run. Nothing between the orchestrator and the
operating system stops the launch.

```typescript
// tests/voiceRouteMockTest.ts
130:    await origProcess(input, source as any);           // via the process() wrapper
151:  await origProcess('open YouTube for me', 'voice');   // deterministic-route check
```

---

## Supporting Evidence

```
core/orchestrator.ts:661   const result = await runRoutedTool('open_app', { target: route.target, source });
core/orchestrator.ts:644   runRoutedTool → toolRegistryV2.execute(tool, args)          (no dryRun added)
security/riskEngine.ts:213 case 'open_app': dryRun → level 0; youtube needs no approval → allowed
skills/automation/skill.ts:113  const dryRun = !!args['dryRun'];   only this skips the launch
skills/automation/skill.ts:30-43  win32: cmd.exe /c start "" <url> · darwin: open · else: xdg-open
skills/automation/skill.ts:47  spawn(cmd, args, { detached: true, ... })
```

Reproduction (fake opener on PATH): 2 calls `xdg-open https://www.youtube.com`
during `voiceRouteMockTest`; 0 during the two tests that use a dry run.

---

## Control Flow Trace

```
Input: test calls orchestrator.process('open YouTube for me', 'voice')   (twice)
  → core/orchestrator.ts: matchDeterministicCommand() → route { type: open_app, target: youtube }
  → runRoutedTool('open_app', { target: 'youtube', source: 'voice' })      no dryRun
  → core/toolRegistryV2.ts execute → security/riskEngine.ts: allowed (no approval for youtube)
  → skills/automation/skill.ts execute: dryRun false → openTarget()
  ↳ FAILURE POINT: spawn(<platform opener>, ['https://www.youtube.com'])   a real launch from a test
  → test asserts only that a log line mentions the route and open_app → PASS
```

---

## Alternative Hypotheses

| Hypothesis | Likelihood | Evidence |
|---|---|---|
| H1 The test lacks the dry-run stand-in the other tests use (above) | High — confirmed | 2 opener calls, controls 0; `boundary-doubles.json` documents the dry-run convention for `noGroqForLocalCommandsTest` |
| H2 The runner is meant to block launches (e.g. an env flag) and that flag is broken | Low | `tests/runAll.ts` sets only `JARVIS_DATA_ROOT` and `JARVIS_VECTOR_STORE_DIR`; no launch flag exists in `skill.ts` |
| H3 Skills are not loaded in the test, so nothing launches | Rejected | Opener was called twice |
| H4 Product bug: the deterministic route should never launch | Rejected | Launching is the route's job in the live runtime |

---

## Files That Would Need to Change

| File | Why | Protected? |
|---|---|---|
| `tests/voiceRouteMockTest.ts` | Make `open_app` a dry run for this test; assert it | Yes (Protected Tests in `RUNTIME_PROTECTED_FILES.md`) |
| `tests/boundary-doubles.json` | `boundaryDoublesTest` requires every test that replaces a registry method to be listed with a reason | No |

No runtime file needs to change.

---

## Evidence Labels

Observed: opener calls (2 vs 0), code lines above, CI config runs the test on
Ubuntu and Windows. Inferred: a browser tab opens on the owner's Windows PC
and on the Windows CI runner (`cmd.exe /c start`); not observed here.

---

## Proposed Reproduction (for Stage 02b)

- Existing test: `tests/voiceRouteMockTest.ts`, run through the runner with a
  recording stand-in for the opener first on PATH (no real browser)
- New regression check: an assertion inside the same test that every
  `open_app` call was a dry run (fails before the fix, passes after)
- Owner's PC needed: no for reproduction; the Windows tab is inferred only

---

## Other weaknesses seen in the same test (not this run's scope)

- Line 108: `assert(sent.stt.length > 0 || true, …)` can never fail.
- Lines 133–141: the "forwarded to orchestrator" checks call
  `orchestrator.process` directly, not through NodeBridge's `stt_result`
  handler, so they check the test's own call.

Recorded as follow-ups for a separate run.

---

## Ready to Advance to Reproduction?

- [x] Root cause identified (confirmed by reproduction)
- [x] Evidence documented and labelled
- [x] Files to change listed
- [x] Reproduction method proposed
- [x] No code edits made during this stage
