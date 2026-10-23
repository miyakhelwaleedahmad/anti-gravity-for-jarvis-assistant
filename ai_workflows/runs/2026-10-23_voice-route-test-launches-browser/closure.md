# Closure — voiceRouteMockTest launches a real browser (TEST-05)

> Stage: 07_closure · Run folder: `ai_workflows/runs/2026-10-23_voice-route-test-launches-browser/`
> Date: 2026-10-23

---

## Identity

| Field | Value |
|---|---|
| Finding / issue ID | **TEST-05**: new, approved by the owner on 2026-10-23. Not tracked under any ID before this run. PC-17 was rejected because it is already used in `docs/audit/JARVIS_REPAIR_CHECKLIST.md:226` |
| Owning tracker | `docs/remediation/REMEDIATION_TRACKER.md`, which holds "IDs not in the checklist" (`_config/SOURCES_OF_TRUTH.md`). One row; no copy in the checklist |
| Final commit | Fix: `64f1abc`. Run records: `821b25c`. This closure follows in the next commit |
| Branch | `claude/jarvis-repair` (not pushed; publishing awaits the owner) |

## Record Check

| Artifact | Present | Note |
|---|---|---|
| issue_brief.md | yes | Tracker-ID reasoning corrected after R2 (PC-17 is taken) |
| diagnosis.md | yes | |
| reproduction.md | yes | Label: REPRODUCED (Linux, stand-in opener; 2 calls vs 0) |
| patch_plan.md | yes | Approved on 2026-10-23 for Stage 04 only; the owner's words are quoted |
| change_log.md | yes | Red then green; 1 attempt |
| verification.md | yes | |
| review.md | yes | Decision: PASS · independent: yes, as a separate agent session, **not a human** |
| final_report.md | yes | Verdict: fixed and verified on Linux, not verified on Windows |
| evidence/ | yes | `red_step.txt`, `green_step.txt`, `verification_raw.txt`, `fix.diff`, copied unchanged. `verify_full.log` is not committed (`*.log` is Git-ignored) |

The final report agrees with the verification and the review: [x] Yes

## Outcome

- **Files changed:**
  - `tests/voiceRouteMockTest.ts` (+22)
  - `tests/boundary-doubles.json` (+6)
  - `ai_workflows/_config/DO_NOT_BREAK.md` (9/9 → 11/11, owner-approved)
- **Tests** (cloud Linux, Node 22.22.2, pnpm 10.33.0):

  | Check | Result |
  |---|---|
  | Red step | the new dry-run check FAILS |
  | Green step | PASS |
  | Opener calls during this test | 2 → 0 |
  | `pnpm run typecheck` | 0 errors |
  | Related tests | 7/7 passed |
  | `pnpm test:voice-core` | 12/12 passed |
  | `pnpm test -- --ci` | 200 passed / 0 failed / 1 blocked (`realTtsHandoffTest`) / 9 skipped (exit 1); 0 opener calls in the whole suite |
  | Closure re-check | `voiceRouteMockTest`, `boundaryDoublesTest`, `docsHygieneTest`, `testScriptIsolationTest`: 4/4 passed; type check 0 errors; 0 opener calls |

- **Known limitations:**
  - Windows behaviour after the fix has not been observed (no PC run, no Windows CI run yet).
  - The live voice route is untouched and not verified.
  - The review was done by an agent, not a human.
- **Outstanding findings:** review findings R3 and R5 (low) are open; R1, R2 and R4 were handled in this run (see `final_report.md`, section 4).

## Process Note

The `git add` for commit `821b25c` included `evidence/verify_full.log`,
which `.gitignore` excludes. Git refused that one file and staged the other
12. Because of how the commands were chained, the commit then ran **without
printing the `git diff --cached --name-only` check** that the workflow
requires.

The commit's contents were checked straight afterwards with
`git show --stat 821b25c`: exactly the 12 intended files, all inside this
run folder, and nothing else. The commit was not amended (no history
rewrite). Staging for the next commit runs as separate steps, with the
check shown.

## Tracker Update

- [x] Row added: `docs/remediation/REMEDIATION_TRACKER.md`, new section
  "ICM maintenance runs", TEST-05, status `FIXED_AND_TESTED (Linux); Windows
  not yet observed`, pointing to this run folder and to `64f1abc`.
- [ ] No tracker owns this ID: not applicable.

## Runtime Issue

- Status last read: not applicable. This is a test defect, not a JARVIS
  runtime failure, and there is no `iss-…` ID.
- `issues.json` / `occurrences.jsonl` edited by hand: **never** (not touched).
- Owner action still needed for the runtime: none.
- Lesson: none. No runtime issue was resolved, so JARVIS writes none. No
  Obsidian note was written, and no run document was copied into the vault.

## Follow-up (not done in this run)

1. Windows check on the owner's PC (PowerShell, JARVIS folder):
   `pnpm test -- --only=voiceRouteMockTest`. Expect no YouTube tab. Windows
   CI after publishing also covers it.
2. `tests/voiceRouteMockTest.ts:109`: `assert(sent.stt.length > 0 || true, …)`
   can never fail. Fix it in a separate ICM run.
3. `tests/voiceRouteMockTest.ts:135–154`: the "forwarded to orchestrator"
   checks bypass NodeBridge's `stt_result` handler. Fix in a separate run.
4. R3: the "open_app tool was invoked" check is near-redundant now.
   Consider it in the same run as items 2 and 3.
5. R5: the guard dry-runs only `open_app`. Revisit it if the route starts
   calling other launching tools.
6. Live "open YouTube for me" voice route: still owed (`TEST_MATRIX.md`).

## Methodology Measurement (this pilot only)

| Question | Answer |
|---|---|
| Was the failure reproduced? | Yes. Automated, 2 opener calls vs 0 for the controls, no real browser |
| How was the root cause verified? | By tracing the code (orchestrator → registry → risk engine → skill) and by the red step: the new check fails while the opener records the launch |
| Was a regression test created? | Yes. Two new assertions in the existing protected test; red, then green |
| Did the fix pass its tests? | Yes, on Linux: 7/7 related tests, 12/12 voice-core, the full suite unchanged, 0 opener calls |
| Did the review find more issues? | Yes: 5 low. R1 and R2 led to corrections, and R4 to a clearer evidence note |
| Did the failure recur in regression testing? | No. 0 opener calls in the full suite, the voice-core group, and the closure re-check |
| What stayed unverified? | Windows behaviour, the live voice route, and a human review |
| How well do the artifacts document the repair? | Every stage has a record with commands and output; the evidence is archived. Gaps: the red-step opener log was lost, and one commit skipped the visible staging check (see Process Note) |

One pilot shows that the workflow can carry a real repair from intake to
closure with evidence at each stage. It does not show any reduction in
recurring bugs; that needs repeated runs and tracking over time.

## Closure Status

- [ ] COMPLETE
- [x] **COMPLETE WITH LIMITATIONS**: Windows not observed; the review was
  done by a separate agent session, not a human; follow-ups listed above
- [ ] BLOCKED
- [ ] ABANDONED
