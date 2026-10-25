# Change Log — voiceRouteMockTest checks that cannot fail

> Stage: 04_implementation · Run: `ai_workflows/runs/2026-10-25_voice-route-test-weak-checks/`
> Status: [x] Complete
> Date: 2026-10-25 · Base commit: `76f4712` · Not committed (Stage 06 commits the reviewed files)

---

## Changed Files

| File | Lines | Change |
|---|---|---|
| `tests/voiceRouteMockTest.ts` | +125 / −104 | Changes 1-5 of the patch plan |
| `tests/boundary-doubles.json` | 1 | reason: the wrapper also records the tools the route runs |
| `ai_workflows/_config/DO_NOT_BREAK.md` | 1 | `voiceRouteMockTest → 13/13 PASS` (was 11/11) |
| `ai_workflows/_config/ARCH_VOICE.md` | 4 | the test runs the real bridge, prints no imitation lines; still not `jarvis.ts`'s handler |
| `ai_workflows/_config/TEST_MATRIX.md` | 1 | what the test checks |

Full diff: `evidence/fix.diff`. No runtime file changed.

---

## Change Details

The 13 checks, with the mutation each one catches
(`evidence/attack_new_test.txt`):

| Check | Catches |
|---|---|
| wakeword / tts / stt registered (real `client_ready`) | M3 |
| sendListenStart sent listen_start to the ready STT client | M1, M3 |
| an empty stt_result reaches the handlers but is not counted as a transcript | M2, M8 |
| the bridge delivered "open YouTube for me" to the stt_result handlers | M2 |
| …as sent by the wake-word client | M7 |
| …and recorded a transcript | M3 |
| Deterministic pre-router chose open_app for "youtube" (one line) | M2 |
| open_app ran once for "youtube" | M2, M4 |
| open_app was a dry run | M6 |
| the route ran no tool but open_app | M2, M4, M5a |
| no browser or opener process was started | M5b, M6 |

Removed: the three checks of the test's own values ("orchestrator.process()
was called", "correct STT text forwarded", "source is voice"), the `|| true`
check, the loose "open_app tool was invoked" check, and the imitation log
lines. Each one is replaced by a check above that fails on the matching
fault.

### Red step (new checks against broken code)

Done on the scratchpad export before the repository was changed. Every
mutation fails the new test; the unchanged code passes:

```
none                       PASS     opener_calls=0 failing_checks=0
M1_no_listen_send          FAIL     opener_calls=0 failing_checks=1
M2_no_handler_dispatch     FAIL     opener_calls=0 failing_checks=5
M3_no_ready_register       FAIL     opener_calls=0 failing_checks=5
M4_route_skips_tool        FAIL     opener_calls=0 failing_checks=2
M5a_extra_tool             FAIL     opener_calls=0 failing_checks=1
M5b_direct_spawn           FAIL     opener_calls=1 failing_checks=1
M6_skill_ignores_dryrun    FAIL     opener_calls=1 failing_checks=2
M7_engine_not_set          FAIL     opener_calls=0 failing_checks=1
M8_empty_counts_as_transcript FAIL     opener_calls=0 failing_checks=1
```

M5b and M6 still launch the stand-in opener once each: the record catches a
launch but does not block it. On a real machine such a regression opens one
tab before the test fails.

### Green step

Repository, unchanged runtime: `voiceRouteMockTest` PASS, 13 passed, 0
failed, 0 opener calls (see `verification.md`).

### Launch pattern

The launch check was run on 14 sample command lines: Windows `cmd.exe /c
start`, `explorer.exe`, `xdg-open`, `open`, a YouTube URL (all flagged), and
the PowerShell session, `pwsh`, `openssl`, `git`, `cmd /c dir`, `tasklist`
(none flagged). 0 wrong (`evidence/launch_pattern_check.txt`).

---

## TypeScript Compile Check

`pnpm run typecheck`: 0 errors (export and repository).

---

## Unplanned Changes

After the first red/green runs, `BRIDGE_HOST` was pinned to `127.0.0.1`
(one line), so an owner's `.env` with another host cannot move the bridge
away from where the stand-ins connect. The mutation runs were repeated on the
final file (`evidence/attack_new_test.txt` is from that run).

---

## Attempt 2 — after review round 1 (CHANGES REQUIRED)

The review (`review.md`) found that R5 was weaker than the test claimed. The
attempt-1 text above is kept as it was; this section records what changed.

| Finding | Change in `tests/voiceRouteMockTest.ts` |
|---|---|
| V1 (medium): a tool called as `toolRegistryV2.get(name).execute()` was not seen | Every registered tool's `execute` is wrapped to record its name during the route; the registry-level wrapper only forces `dryRun` on `open_app`. The check also fails if any tool registered by the end of the route was not wrapped |
| V2 (medium): processes started before the route were thrown away | Launches are checked over the whole test, after the sockets close |
| V3 (medium): openers matched only at the start of the command line | Any word of the command line (quotes stripped; the base name for `.exe` and absolute paths) in a list of openers and browsers, or "youtube" anywhere |
| V4 (medium): cited evidence missing | `evidence/probe_route.txt`, `launch_pattern_check.txt` (round 1), `launch_pattern_round2.txt`, `green_step.txt` (raw output of the 13 checks) |
| V5 (low) | An `stt_result` from the `stt` client must give engine "Whisper"; from `wakeword`, "Google STT" |
| V6 (low) | `open_app`'s output must contain `https://www.youtube.com` |
| V7 (low) | `exec`/`execFile` keep their promisified form, also recorded |
| V8 (low) | The dry-run check needs at least one `open_app` result |
| V9 (low) | The health port is drawn again if it equals the bridge port |
| V10 (low) | Count and line reference corrected in `issue_brief.md` and `diagnosis.md` |

Also changed: the `TEST_MATRIX.md` row and the `boundary-doubles.json` reason
now say what is recorded ("any other registered tool", "through
`child_process`", "recorded, not replaced"). Still 13 checks.

Red step, attempt 2 (`evidence/attack_round2.txt`): control PASS; all 9 M
mutations and the reviewer's 8 X mutations (X1, X2, X3, X3b, X4, X5, X6, X7)
FAIL. The launch matcher: 23 sample command lines, 0 wrong; one accepted
false positive (any command line naming "youtube").

Not recorded by design: processes started without `child_process` (for
example a native addon), and tools added to the registry after the route.
(Round 2 of the review added more; see Attempt 3.)

---

## Attempt 3 — after review round 2 (CHANGES REQUIRED)

| Finding | Change |
|---|---|
| N1 (medium): the tool wrap raced the asynchronous skill loading; with skills 400 ms slower (X9) the test failed on correct code | The test awaits the orchestrator's own `waitForSkills()` (bounded at 10 s, the wait `process()` uses) before wrapping. X9 now PASSes |
| N2 (low): claims too wide | Test header and `TEST_MATRIX.md` say "the main thread's `child_process` functions" and name what is not seen: a worker thread, the `ChildProcess` class used directly, a native addon, a tool's `execute` captured before the wrap |
| N3 (low): opener list incomplete | Linux browser names added (`google-chrome`, `chromium-browser`, `microsoft-edge`, `firefox-esr`, `brave-browser`, `wslview`, …); split on whitespace and parentheses (`Start-Process('url')`); base name for any word containing `/`. `C:\start` is still not flagged |
| N4 (info): `exec` recorded twice | Nested calls (`exec` → `execFile` → `spawn`) are recorded once |

Red step, attempt 3 (`evidence/attack_round3.txt`): control PASS; the 9 M
mutations, X1-X7 and X10 FAIL; X9 (slow skills, correct code) PASS. X11 and
X12 were not re-run: they are the documented "not seen" cases (the
reviewer observed both pass the attempt-2 test). Launch matcher
(`evidence/launch_pattern_round3.txt`): 33 sample command lines, 0 wrong.

Known and accepted: false positives `npm start`, `systemctl start …`, a URL
ending in `/start` or `/open`, anything naming "youtube" (none is started in
this test; one would fail it with the command printed). False negative:
`powershell -EncodedCommand …`.

---

## Ready to Advance to Verification?

- [x] Red then green
- [x] Typecheck clean
- [x] No runtime file changed
