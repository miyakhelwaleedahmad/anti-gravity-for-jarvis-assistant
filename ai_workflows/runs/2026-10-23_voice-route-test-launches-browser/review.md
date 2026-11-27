# Review — voiceRouteMockTest launches a real browser

> Stage: 05b_review · Run: `ai_workflows/runs/2026-10-23_voice-route-test-launches-browser/`
> Date: 2026-10-23 · Working tree at `0117a56` plus the uncommitted fix (2 files)
> The review was read-only. The reviewer returned this report as a message,
> and the implementer's session saved it here word for word, with the owner's
> approval; only this header was added.

---

## Reviewer

- **Reviewer:** a separate agent context. It had no access to the implementer's
  conversation and was spawned by the implementer's session. It is the same
  model family and **not a human**.
- **Independent of diagnosis, plan and implementation:** Yes, by the letter of
  `05b_review/CONTEXT.md` ("a separate session that did not write the
  diagnosis, plan or change"). It is weaker than a human review:
  - the same model family may share blind spots;
  - the implementer wrote the review brief, so the implementer chose the questions.

  The reviewer considers it sufficient for this small test-only change. The
  reviewer asked that Stage 06 describe it as "independently reviewed by a
  separate agent session (not a human)".
- **Path:** normal stages. This was not a code-repair proposal.

## What Was Inspected

| Input | Reference |
|---|---|
| Diff | `git diff` / `git diff HEAD --stat` on the working tree, `claude/jarvis-repair` at `0117a56`. Two modified files, one untracked run folder. |
| Approved plan | `runs/…/patch_plan.md`, approved 2026-10-23, "Approved for Stage 04 only" (the owner's words are quoted in the file) |
| Verification | `runs/…/verification.md`, `change_log.md`. Raw logs in the session scratchpad: `red_step.txt`, `green_step.txt`, `verification_raw.txt`, `verify_full.log` |
| Reproduction | `runs/…/reproduction.md` (label: REPRODUCED) |
| Code-repair report | N/A |
| Code read (unchanged) | `core/orchestrator.ts` 620–665; `core/toolRegistryV2.ts` (`execute`, `dispatch`, `rateLimitFor`); `security/riskEngine.ts` (`case 'open_app'`, `decide`); `skills/automation/skill.ts`; `skills/automation/description.json`; `core/verifiers.ts` (`verifyOpenApp`); `tests/runAll.ts` (`runOne`); `tests/boundaryDoublesTest.ts`; `tests/noGroqForLocalCommandsTest.ts`; `system/childEnv.ts`; `.github/workflows/ci.yml` |
| Config | `_config/RUNTIME_PROTECTED_FILES.md` (Protected Tests), `_config/DO_NOT_BREAK.md` (Test Invariants), `_config/TEST_MATRIX.md`, `_config/SOURCES_OF_TRUTH.md`, `docs/remediation/REMEDIATION_TRACKER.md`, `docs/audit/JARVIS_REPAIR_CHECKLIST.md` |

## Checks

| Check | Result | Evidence |
|---|---|---|
| Only planned files and hunks changed | PASS | `git diff HEAD --stat`: `tests/boundary-doubles.json +6`, `tests/voiceRouteMockTest.ts +22`, 0 deletions. The only untracked path is the run folder. The hunks match the patch plan's "After" blocks word for word, and the line ranges in `change_log.md` (L22, L111–122, L174–182; JSON L189–194) are correct. |
| No accidental deletions | PASS | 28 insertions, 0 deletions |
| No weakened tests | PASS (one note: R3) | All 9 original assertions are unchanged and 2 stricter ones were added. HEAD has 9 `assert(` calls and the working tree has 11, which matches the red run's "10 passed, 1 failed". No skips, no time-limit changes. |
| No unsafe commands added to docs or scripts | PASS | No doc or script changed. The owner check in the run docs is `pnpm test -- --only=voiceRouteMockTest`, through the runner. |
| No runtime data, credentials or secret-named files | PASS | Nothing under `data/`, `memory/` or `logs/` changed. `find . -newermt "2026-10-23 17:00"` (excluding node_modules and .git) lists only the 2 test files and the 6 run records. Before/after mtime snapshots of `data logs memory tests` around the reviewer's test runs are identical (`diff_rc=0`). |
| Tool permissions, risk levels, approval gates, spawn limits unchanged | PASS | Nothing under `core/`, `security/`, `skills/`, `bridge/`, `voice/`, `memory/`, `control/` or the agents changed |
| Protected files touched only as approved | PASS | `tests/voiceRouteMockTest.ts` is a Protected Test. It was changed only after a diagnosis, a written plan and a recorded human approval, as the Change Approval Checklist requires. |
| `DO_NOT_BREAK.md` invariants still hold | PASS, with a documentation drift (R1) | voiceRouteMockTest still passes, but `DO_NOT_BREAK.md:114` says "voiceRouteMockTest.ts → 9/9 PASS" while the test now has 11 assertions. The other listed smoke tests pass. |
| Claimed results match commands actually run | PASS, with one evidence gap (R4) | The reviewer's green re-runs match the claims: 2/2, 7/7, 12/12, 0 opener calls. `red_step.txt` holds the red runner lines quoted in `change_log.md`. The "browser-opener calls: 2 / 0" lines are not in `red_step.txt`/`green_step.txt`. The 200/0/1/9 `--ci` result and "0 opener calls" are in `verification_raw.txt` and `verify_full.log:219`. `--ci` was not re-run by the reviewer. |
| Regression test failed before, passes now | PASS (red from the evidence; green re-run) | Red, from `red_step.txt`: `❌ FAIL: open_app was a dry run (no browser launched)`, `[open_app] platform=linux command=xdg-open args=https://www.youtube.com`, `Results: 10 passed, 1 failed`. Green, re-run by the reviewer: PASS, 0 opener calls. The code agrees (answer 2 below). The red step was not re-run, as instructed. |
| Live verification done, or listed as owed | PASS | `verification.md` lists the owner-PC/Windows check as owed and optional. Windows CI has not run for this change. |
| Documentation consistent with the code | Mostly | The `boundary-doubles.json` reason is accurate (answer 4). `DO_NOT_BREAK.md` has a stale count (R1). |

### Answers to the specific review tasks

1. **Scope.** The diff is minimal and is the approved plan's text exactly. No
   file outside the two test files and the run folder changed.

2. **Would the new assertions catch the original launch?** Yes.
   - Before the fix, the routed call reaches `skill.ts` `openTarget()`, which
     returns JSON with `success, target, resolvedTarget, platform, method` and no
     `dryRun` key, so the regex `/"dryRun":\s*true/` fails.
   - A dry run returns `{success:true, target, resolvedTarget, dryRun:true}`
     (`skill.ts:148-154`).
   - If the wrapper were bypassed (for example, the orchestrator holding a
     direct reference to the skill), `openAppResults.length === 2` fails.
   - This matches the red evidence: the "ran for youtube" check passed and the
     dry-run check failed. "ran for youtube" passed in red only because the
     stand-in exited 0. Without the stand-in on this host,
     `spawn('xdg-open')` gives ENOENT, so `success` is false and that check
     fails too.
   - What it cannot catch: a future launch through a different tool that the
     route might call (for example `control_browser` or `control_app`). The
     wrapper only dry-runs `open_app` (R5).

3. **What `dryRun: true` still exercises, and what it skips.**

   Still runs for real:
   - `matchDeterministicCommand` and the state transitions;
   - `runRoutedTool` (`orchestrator.ts:643-646`), which looks up
     `toolRegistryV2.execute` at call time, so the instance override takes effect;
   - the registry: the permission gate (`requiredLevel`), schema validation
     (`dryRun` is a declared boolean in `description.json`), `assessRisk` and
     `decide`, the rate limit, `dispatch`, the medium-risk execution queue,
     `executeWithFallbacks` (fallbacks are `[]`), redaction and `verifyResult`;
   - in the skill: source resolution, `resolveTargetUrl`, the
     `securityAuditLogger.openAppAttempt` audit (written to the per-test data
     root), the `allowed` check, and the dry-run return.

   Changed or skipped:
   - (a) The risk engine takes `if (args['dryRun']) { set(0, …); break; }`
     (`riskEngine.ts:215-217`). This skips its own `resolveTargetUrl` and the
     `requiresApproval → raise(3)` / `needsSession = 0` branch. For "youtube"
     that branch never fires: the normal path is level 1 (catalog `risk: 1`),
     and `decide` returns `allow` at session level 0 either way. Level 0 also
     puts the call in the `open_app@0` rate-limit bucket instead of `@1`.
   - (b) The skill's approval branch is skipped by
     `requiresApproval && !dryRun`; "youtube" does not require approval, so
     nothing changes in practice.
   - (c) `openTarget()` is skipped: platform command selection, `spawn`,
     spawn-error handling, and the `[open_app] target=… / platform=…` log lines.
   - (d) On win32, `verifyOpenApp` returns "a dry run opens nothing" instead
     of "a web page … is not checked"; both are `unverifiable`. On Linux it
     returns `ON_WINDOWS` either way.

   The real launch path is now covered only by `openAppSmokeTest` (resolution,
   dry run) and by live verification.

4. **The `boundary-doubles.json` entry.**
   - Its format matches the other `registry:execute` entries, and it sits in
     alphabetical order between `voiceApprovalTest` and `worldStateTest`.
   - The reason is accurate and at least 30 characters long. Its pointer
     "TEST_MATRIX.md, Live Runtime Verification" exists (`TEST_MATRIX.md:75`),
     and that section's step 3 is "open YouTube for me".
   - `boundaryDoublesTest` detects `(toolRegistryV2 as any).execute =` as
     `registry:execute`, and it passed in the reviewer's run.

5. **Evidence compared with re-runs:** see "Commands run" below. The green
   counts match exactly. The red step was not re-run, by instruction.

6. **Runner isolation.**
   - `runAll.ts:203-209` gives each test a fresh `mkdtemp` `JARVIS_DATA_ROOT`
     and `JARVIS_VECTOR_STORE_DIR`, removed afterwards, and passes the
     parent's `process.env`, including `PATH`. `childEnv.ts` keeps `path`.
   - `which xdg-open open` without the fakebin finds neither (rc=1), so no
     real browser could open on this host before or after the fix.
   - The stand-in script only appends `date` and its arguments to the
     scratchpad log and exits 0.
   - The reproduction needed no real browser.

7. **The rest of the test file.**
   - The wrapper is installed at L116, before both `process` calls: L147,
     through the test's own `process` wrapper calling `origProcess`, and L164.
   - It is restored at L174, after both calls and before the new assertions.
   - If the test throws, the process exits through `.catch`, so a leftover
     wrapper does not matter.
   - The second new assertion (`every` over the results) would pass on an
     empty array, but the first requires `length === 2`, so the pair cannot
     pass vacuously.
   - The existing assertion "open_app tool was invoked" (L170-173) is now
     satisfied only by the orchestrator's route line `type="open_app"`. See R3.

8. **No runtime code changed:** confirmed by `git diff HEAD --stat`.

9. **Issue ID.**
   - The tracker and the checklist are unchanged
     (`git diff --quiet HEAD -- …` passed).
   - TEST-05 is labelled "proposed" and appears nowhere else in the
     repository; nothing is marked resolved.
   - Rejecting PC-17 is correct: the tracker's PC-nn rows sit under "From the
     owner's PC run…" headings, and `SOURCES_OF_TRUTH.md:12` says "PC-nn from
     the owner's PC runs".
   - There is a stronger reason that the run records miss: **PC-17 is already
     taken** at `docs/audit/JARVIS_REPAIR_CHECKLIST.md:226`, and
     SOURCES_OF_TRUTH says the checklist wins when an ID is in both files (R2).

10. **Remaining concerns:** see Findings and the list after Decision.

## Findings

| ID | Severity | File:line | Finding | Evidence |
|---|---|---|---|---|
| R1 | low | `ai_workflows/_config/DO_NOT_BREAK.md:114` | The invariant count is stale. It still says "voiceRouteMockTest.ts → 9/9 PASS", but the test now has 11 assertions. The approved plan did not list this file. | HEAD has 9 `assert(` calls (10 occurrences including the definition); the working tree has 11; the red run printed "10 passed, 1 failed". Fix at Stage 06/07 with the owner's agreement, or amend the plan. |
| R2 | low | `runs/…/issue_brief.md` ("last PC id there: PC-16"), `patch_plan.md` (Approval) | The PC-17 rejection gives only the convention reason. It does not say that PC-17 already exists in the checklist, which would make it a collision. "Last PC id: PC-16" holds for the tracker only and could lead someone to reuse PC-17. | `JARVIS_REPAIR_CHECKLIST.md:226` "### PC-17: PowerShell 7 installed, but the tests still found none"; `SOURCES_OF_TRUTH.md:12` "For an ID in both files, the checklist wins." |
| R3 | low | `tests/voiceRouteMockTest.ts:170-173` | "open_app tool was invoked" (`logContains('open_app') \|\| logContains('Executing')`) is now satisfied only by the orchestrator's route log line `type="open_app"`, because the dry run removes the skill's `[open_app] …` lines. In practice it cannot fail while the L166 assertion passes. It was already near-redundant before the change. The new `openAppResults.length === 2` assertion covers the real invocation, so nothing is lost overall. | `orchestrator.ts:626` (log format); `skill.ts:24,44` (only in `openTarget`); after `log.length = 0` at L158 |
| R4 | low | `runs/…/change_log.md` (red/green blocks), `verification.md` | The "browser-opener calls: 2 / 0" lines in the red/green blocks are not in the saved raw files `red_step.txt`/`green_step.txt`, which hold only runner output. The red file shows one `[open_app] … xdg-open` line, inside a truncated failure tail. The 2-call count is evidenced separately in `reproduction.md`, and the reviewer's green re-run confirms 0. The red-step code itself was not preserved. | `cat scratchpad/red_step.txt`, `green_step.txt` |
| R5 | low | `tests/voiceRouteMockTest.ts:116-121` | The guard covers only `open_app` through `toolRegistryV2.execute`. A launch through another tool, or a direct skill call from the route, would not be dry-run. A direct skill call would still fail `length === 2`; another tool would not be caught. This is acceptable for the current route and noted for the future. | `orchestrator.ts:660-680` (other routed tools: `control_browser`, `control_app`) |

There is no high or medium finding.

## Decision

- [x] **PASS**: reviewed by a separate agent session, not a human (see the
  independence note above)
- [ ] CHANGES REQUIRED
- [ ] BLOCKED

Reasons:
- The diff is exactly the approved plan, test-only, with no runtime file touched.
- The new assertions fail on the original behaviour (red evidence and the
  code) and pass with the fix.
- Re-runs show 0 opener calls for the voice-core group and the test area,
  and no writes outside the runner's temporary data roots.
- The boundary-doubles entry is accurate and accepted.
- The issue ID is proposed, not invented and not marked resolved; the
  tracker and the checklist are untouched.
- The remaining findings are low (a stale count in docs, incomplete ID
  reasoning, gaps in the evidence files) and can be handled at Stage 06/07.

Still owed, or not provable here:
- Windows behaviour (no `cmd.exe /c start` tab on the owner's PC or the
  Windows CI runner) is inferred from the code only.
- The live "open YouTube for me" voice route is untouched and still owed
  under TEST_MATRIX Live Runtime Verification.
- The reviewer did not re-run `pnpm test -- --ci` (outside the permitted
  command form); the 200/0/1/9 result is the implementer's.
- Deferred weak assertions, for a separate run:
  - (a) `tests/voiceRouteMockTest.ts:109`, `assert(sent.stt.length > 0 || true, …)`, can never fail;
  - (b) L135-154: the "forwarded to orchestrator" checks call the test's own
    `orchestrator.process` wrapper directly instead of going through
    NodeBridge's `stt_result` handler, so they test the test.
- Nit: the restore assigns the bound original as an own property instead of
  `delete`-ing the override. This is harmless and matches
  `noGroqForLocalCommandsTest`.
- Nit: inside an outer approval context, `execute`'s
  `withoutApproval(() => this.execute(...))` re-entry would pass through the
  wrapper and record twice. That path is not reached in this test.

## Commands run (key output)

```
git status; git log --oneline -3; git diff --stat; git diff; git diff HEAD --stat; git status --porcelain --ignored
  modified: tests/boundary-doubles.json, tests/voiceRouteMockTest.ts; ?? ai_workflows/runs/2026-10-23_voice-route-test-launches-browser/
  HEAD 0117a56; 2 files changed, 28 insertions(+)

cat <scratchpad>/fakebin/xdg-open      -> appends "$(date) xdg-open $*" to fake_opener_calls.log; exit 0 (opens nothing)
which xdg-open open                    -> (none) rc=1
PATH=<fakebin>:$PATH which xdg-open    -> <scratchpad>/fakebin/xdg-open

: > fake_opener_calls.log; PATH="<fakebin>:$PATH" pnpm test -- --only=voiceRouteMockTest,boundaryDoublesTest
  PASS boundaryDoublesTest 394ms · PASS voiceRouteMockTest 1253ms
  === 2 passed · 0 failed · 0 timed out · 0 blocked · 0 environment · 0 skipped ===
  opener calls: 0

PATH="<fakebin>:$PATH" pnpm test -- --only=voiceRouteMockTest,boundaryDoublesTest,noGroqForLocalCommandsTest,simpleNoGoalTest,voiceYouTubeIntegrationTest,openAppSmokeTest,deterministicCommandRouteTest
  === 7 passed · 0 failed · 0 timed out · 0 blocked · 0 environment · 0 skipped ===
  opener calls: 0

PATH="<fakebin>:$PATH" pnpm test:voice-core     (= tsc --noEmit && runAll.ts --only=<12 voice tests>; tsc passed, as the && continued)
  === 12 passed · 0 failed · 0 timed out · 0 blocked · 0 environment · 0 skipped ===
  opener calls: 0
  (This package script is the runner with --only plus a type check, not literally `pnpm test -- --only=`.)

find data logs memory tests -type f -printf '%T@ %p\n' (before/after the runs) | diff  -> diff_rc=0
find . (excl. node_modules, .git) -newermt "2026-10-23 17:00"  -> only the 2 test files + 6 run records
git diff --quiet HEAD -- docs/remediation/REMEDIATION_TRACKER.md docs/audit/JARVIS_REPAIR_CHECKLIST.md -> unchanged
grep -rn "TEST-05" (excl. run folder) -> none;  grep PC-17 -> docs/audit/JARVIS_REPAIR_CHECKLIST.md:226,235
cat <scratchpad>/red_step.txt, green_step.txt, verification_raw.txt; grep verify_full.log
  red: "❌ FAIL: open_app was a dry run (no browser launched)", "=== Results: 10 passed, 1 failed ==="
  verify_full.log:219 "=== 200 passed · 0 failed · 0 timed out · 1 blocked · 0 environment · 9 skipped ==="
```

Not done: no red-step re-run, no `--ci` re-run, no real browser, no Windows
run, and no file in the repository was created, modified, staged or
committed. The reviewer truncated the scratchpad opener log before each run;
that log is outside the repository.
