# Final Report — voiceRouteMockTest launches a real browser (TEST-05)

> Stage: 06_final_report · Run: `ai_workflows/runs/2026-10-23_voice-route-test-launches-browser/`
> Status: [x] Complete
> Date: 2026-10-23

---

## 1. Root Cause

**Defect.** `tests/voiceRouteMockTest.ts` sent "open YouTube for me" through
the real deterministic route twice per run, via `orchestrator.process` at the
test's lines 130 and 151 (pre-fix numbering). `core/orchestrator.ts:661` calls
`open_app` without `dryRun`. The skill launches unless `dryRun` is set
(`skills/automation/skill.ts:113`, platform opener at lines 30–47).

**Effect.** Every run of `pnpm test:voice-core`, `pnpm test -- --ci` and CI
tried to open the browser twice while the test reported PASS. This breaks
the rule in `TEST_MATRIX.md` that no isolated voice test opens an app, and
the dry-run convention recorded in `tests/boundary-doubles.json`.

Reproduction label (02b): **REPRODUCED**, automated, through the runner, on
Linux, with a recording stand-in opener. The stand-in recorded 2 calls to
`xdg-open https://www.youtube.com` for this test and 0 for the two control
tests (`reproduction.md`). No real browser was used: this host has no
`xdg-open`.

---

## 2. Files Changed

| File | What Changed | Protected File? |
|---|---|---|
| `tests/voiceRouteMockTest.ts` | Imports `toolRegistryV2`. Adds a wrapper that runs `open_app` with `dryRun: true` and records each result; the original `execute` is restored after the last call. Adds 2 assertions: "open_app ran for youtube once per request" and "open_app was a dry run (no browser launched)". +22 / −0 lines. | Yes (Protected Tests) |
| `tests/boundary-doubles.json` | Adds an entry for `tests/voiceRouteMockTest.ts`: `replaces: ["registry:execute"]`, with the reason. +6 lines. | No |
| `ai_workflows/_config/DO_NOT_BREAK.md` | Test invariant count changed from "voiceRouteMockTest.ts → 9/9 PASS" to "11/11 PASS". Approved by the owner after review finding R1; the count was checked at 11 `assert(` calls. | No |

Not changed: any runtime file (orchestrator, routing, registry, risk engine,
skills, browser or Windows control, voice, security, agents, memory), and the
runtime issue store. Exact diff: `evidence/fix.diff` (the two test files,
as reviewed).

---

## 3. Test Results Summary

Machine: cloud Linux 6.18, Node 22.22.2, pnpm 10.33.0. Base `0117a56` plus
the fix (uncommitted while tested).

| Check | Command | Result | Raw evidence |
|---|---|---|---|
| Red: new assertions, fix not yet applied | `pnpm test -- --only=voiceRouteMockTest,boundaryDoublesTest` | `FAIL voiceRouteMockTest`: `❌ FAIL: open_app was a dry run (no browser launched)`, `Results: 10 passed, 1 failed`, `[open_app] platform=linux command=xdg-open args=https://www.youtube.com` | `evidence/red_step.txt` |
| Green: fix applied | same | `2 passed · 0 failed` | `evidence/green_step.txt` |
| Opener calls, red → green | stand-in `xdg-open` first on PATH | 2 → 0 | See the note on evidence below |
| Type check | `pnpm run typecheck` | 0 errors | `evidence/verification_raw.txt` |
| Test area | `pnpm test -- --only=voiceRouteMockTest,boundaryDoublesTest,noGroqForLocalCommandsTest,simpleNoGoalTest,voiceYouTubeIntegrationTest,openAppSmokeTest,deterministicCommandRouteTest` | 7 passed · 0 failed | `evidence/verification_raw.txt` |
| Voice core group | `pnpm test:voice-core` | 12 passed · 0 failed | `evidence/verification_raw.txt` |
| Whole suite | `pnpm test -- --ci` (stand-in opener on PATH) | 200 passed · 0 failed · 1 blocked · 9 skipped (exit 1); 0 opener calls | `evidence/verification_raw.txt`, `evidence/verify_full.log` (line 219) |
| Live verification | — | Not required (test-only); optional owner check owed | — |

**The whole suite is not fully green.** `realTtsHandoffTest` is BLOCKED
(needs a Python with pygame and websockets). The 9 SKIPPED tests need
Windows, Redis or an LLM, live keys, `.venv`, the bridge token or
PowerShell 7. These are the same as at `e4a9cda` and `0117a56`.

**Note on evidence (review finding R4).**
- The opener-call counts ("2" in the red step, "0" in the green step) were
  printed to the console by the same shell command that ran the tests. They
  were not written into `red_step.txt` or `green_step.txt`, which hold only
  the runner's output.
- The stand-in's own log from the red step no longer exists: it was cleared
  before the reviewer's runs.
- Counts that remain on file:
  - 2 calls before the fix: `reproduction.md`, and the `[open_app] …
    xdg-open` line in `evidence/red_step.txt`;
  - 0 calls after the fix: `evidence/verification_raw.txt` (whole suite),
    plus the reviewer's re-runs in `review.md`.
- The red-step version of the test was not kept as a file; the one changed
  line is in `change_log.md`.

---

## 4. Review

- Decision (05b): [x] PASS / [ ] CHANGES REQUIRED / [ ] BLOCKED
- Reviewer independent: **reviewed independently by a separate agent session
  (not a human).** It had no access to the implementer's conversation, but it
  was spawned by the implementer's session, is the same model family, and was
  briefed by the implementer (`review.md`).
- Findings, all low, no high or medium:

| ID | Finding | Handling in this run |
|---|---|---|
| R1 | `DO_NOT_BREAK.md` said 9/9 for this test; it now has 11 assertions | Fixed (one line, owner-approved) |
| R2 | The PC-17 rejection did not say PC-17 is already used in the audit checklist | Fixed in `issue_brief.md` and `patch_plan.md`; TEST-05 used |
| R3 | "open_app tool was invoked" now matches only the orchestrator's route log line, so it can hardly fail | Recorded; the new `length === 2` assertion covers the call. Not changed |
| R4 | The red/green raw files lack the opener-count lines; the red-step code is not kept | Recorded above; the evidence files are archived unchanged |
| R5 | The guard dry-runs only `open_app`; a launch through another tool would not be caught | Recorded as a follow-up |

---

## 5. Unresolved Risks and Follow-ups (not done in this run)

| Item | Severity | Recommended Action |
|---|---|---|
| Windows: no tab opens after the fix | Medium (unverified) | Owner's PC, PowerShell, JARVIS folder: `pnpm test -- --only=voiceRouteMockTest`. Expect no YouTube tab. A Windows CI run after publishing also covers it. |
| Line 109: `assert(sent.stt.length > 0 \|\| true, …)` can never fail | Low | Separate run: make it a real check of `sendListenStart` |
| Lines 135–154: the "forwarded to orchestrator" checks call the test's own `process` wrapper, not NodeBridge's `stt_result` handler | Low | Separate run: drive the real handler |
| R3, R5 (above) | Low | Consider them in the same follow-up run |
| Live "open YouTube for me" voice route | — | Untouched; still owed per `TEST_MATRIX.md` Live Runtime Verification |

---

## 6. Next Recommended Step

The owner reviews these commits. If approved: publish, check that Windows
CI passes, and optionally run the one-line PC check above. Then open a
second ICM run for the two weak assertions.

---

## 7. Verdict

- [ ] ✅ Fixed and verified (this verdict requires review PASS by an independent reviewer and every required check passed)
- [x] ⚠️ **Fixed and verified on Linux, not verified on Windows.** The test
  fix passed every check in the reported Linux environment, and the review
  (by a separate agent session, not a human) passed. Windows behaviour after
  the fix has not been observed.
- [ ] ❌ Not fixed

---

## 8. Post-Report Checklist

- [x] Commit only the reviewed files, staged by name, after checking `git diff --cached --name-only` (Stage 06/07 commits)
- [x] No tag
- [x] Next: `07_closure` (tracker row TEST-05 and the run record)
