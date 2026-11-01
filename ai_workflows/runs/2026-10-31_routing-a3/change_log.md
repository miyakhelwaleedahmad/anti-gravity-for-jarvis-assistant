# Change Log — routing (phase A3)

Gate 1: owner approval of the A3 plan (P1–P6, protected files included) on 2026-10-31 ("push it and approve for a3"). Base: `38fa190`. "Close this tab" / "close the current tab" wait for phase A4, as recommended in the plan (the owner had no preference).

## Test first

`tests/routingA3Test.ts` on the code before the change: **32 passed, 27 failed** (`evidence/old_code_run.txt`). The failures reproduce the PC: "close youtube tab" and "close the youtube tab" had no route; the near-misses of "enable full control mode" had no route and the planner was not offered the full-control tool; enabling asked twice; "close notepad and chrome" was not offered `control_app`; "github.com" lost its dot. The checks that must not change (shell text, "all/this/current", "disable …", questions, "close chrome" alone) passed.

## Changes

| # | File | Change |
|---|---|---|
| P1 | `core/deterministicRoutes.ts` (**protected**; approved A3) | `close [the] <name> tab` (1–3 words of letters/digits, 2+ characters each) routes to `close_browser_tab` with that name, before the `close current tab` route. Names containing all, every, other(s), this, that, these, those, current, active, new, last, browser, chrome or "and" do not. Same tool and checks as "close youtube" (JARVIS's own Chrome; the risk engine sets the level). |
| P2 | `core/fullControlPhrase.ts` (new); `core/deterministicRoutes.ts` | `isEnableFullControlPhrase(clean)`: verb enable / turn on / switch on / activate (plus the speech forms enabled, unable, inable, anable); "full" with one vowel or letter slip ("fool", "ful"); "control" within 2 edits, 5–9 letters, starting c/k; "mode" optional (mode, modes, mod, mood); optional trailing "on"/"now". Nothing else may follow. The exact-match test `clean === 'enable full control mode'` is replaced by this function. The approval is still asked. |
| P3 | `core/planningToolSelection.ts` | The planner is offered the full-control tools for the same phrases. |
| P4 | `core/orchestrator.ts` (**protected**; one line) | The enable route speaks `failureReply(result, 'I did not turn on full control mode, sir.')` instead of "Failed to enable full control, sir."; a refusal now says it was not approved. |
| P5 | `core/planningToolSelection.ts` | A close request naming the browser **and** something else ("close notepad and chrome") is also offered `control_app` and `control_window`. Those tools still refuse browsers (phase A1). "close chrome" alone is unchanged. |
| P6 | `core/voiceInput.ts` | The normaliser keeps a dot that sits between letters or digits ("github.com", "www.google.com", "2.5"); other dots go as before. Routes that matched before still match (golden test). |
| N-PC3 | `skills/enable_full_control_session/skill.ts` | The skill no longer asks a second time when the tool registry has already approved this exact call (`currentApproval()` from `security/approvalScope.ts`: tool `enable_full_control_session`, action enable or none). Called any other way, it still asks. Root cause (diagnosis D7): the skill's own `approvalGate.requestApproval` matched the registry's approval only by chance on the planner path ("15" in the args) and never on the route path (`{source: 'cli'}`). |

## Tests

| File | Change |
|---|---|
| `tests/routingA3Test.ts` (new) | Sections 1–6 as listed in its header. |
| `tests/boundary-doubles.json` | Entry for `routingA3Test` (uses `installFakeTts`), standard reason. |
| `tests/fixtures/route-golden.json` | Re-recorded with `--record`. Only the three normalised strings with a dot changed ("notes.txt", "report.md", "example.com"); routes and tools unchanged. Intended (P6). |
| `tests/honestActionReplyTest.ts` | Its planner-path cases used "close the youtube tab", which now has its own route (P1) and so no longer reached the planner. They now say "close the youtube page", which still goes to the planner; the checks are unchanged. |

After: routingA3Test **59/59** (`evidence/new_code_run.txt`, `evidence/new_code_checks.txt`); related tests 25/27, then the two above fixed and 3/3 (`evidence/related_tests.txt`, `evidence/related_tests_after.txt`); typecheck 0 errors (`evidence/typecheck.txt`).

## Changes made in review (round 1; `review.md`)

Tests first: the new checks on the code before these fixes: routingA3Test **62 passed, 16 failed** (`evidence/review_r1_old_code_run.txt`). The failures include full control turning on inside an approval of the same tool with other arguments.

| ID | File | Change |
|---|---|---|
| R1 | `core/deterministicRoutes.ts` (protected; A3) | Filler words are not a tab's name: the, a, an, my, your, his, her, our, their, it, its, one, first, second, third, next, previous, prev, left, right, old, tab, tabs. "close the tab" and "close the first tab" go to the planner, as "close this tab" does until A4. |
| R2 | `core/deterministicRoutes.ts` | The tab name is read from the normalised text with its dots ("close the github.com tab" → `github.com`, not `githubcom`). Each word still needs 2+ characters; 1–3 words. |
| R5 | `skills/enable_full_control_session/skill.ts` | The question is skipped only when the approval in scope is this exact call (`isSameCall`: same tool and the same arguments), not any approval of this tool. |
| R3 | `diagnosis.md` | D7 added (the double approval's cause); this log cites D7. |
| tests | `tests/routingA3Test.ts` | 11 filler-word non-routes, "close the youtube.tab", two dotted names, three direct calls of the skill (no approval in scope; another tool's approval; this tool with other arguments: each asks once and full control stays off); "open github.com" must have no route (was: none or open_app). |

After: routingA3Test **78/78** (`evidence/review_r1_new_code_run.txt`); 16 related tests incl. the DO_NOT_BREAK set and routeGoldenTest pass (`evidence/review_related_tests.txt`); typecheck 0 errors (`evidence/typecheck_review.txt`); mutation check **14/14** (M3 updated for the new pattern; M12–M14 for R1, R2, R5; `evidence/a3_mut_run_review.txt`).

## Changes made in review (round 2)

| ID | File | Change |
|---|---|---|
| N1 | `core/deterministicRoutes.ts` | www, http, https, com, org, net are not a tab name. The word list now matches whole words only (`(?<![a-z0-9.])…(?![a-z0-9.])` instead of `\b`), so "com" inside "github.com" does not block it. |
| N2 | `core/deterministicRoutes.ts` | Each tab-name word is at most 64 characters. |
| tests | `tests/routingA3Test.ts` | 7 URL-piece non-routes, a 65-character word (no route) and a 64-character one (routes), "www.google.com" and "my.site" (route). |

Tests first for N1: 78 passed, 7 failed before the fix (the N2 and dotted-name tests were added with the fix; mutant M16 shows the 65-character test fails without the cap); 89/89 after (`evidence/review_n1_old_code_checks.txt`, `evidence/review_n1_new_code_checks.txt`); typecheck 0 errors (`evidence/typecheck_review2.txt`); mutation check 16/16 (`evidence/a3_mut_run_review2.txt`).

## Deviations

- Two protected files changed, as approved: `core/deterministicRoutes.ts` (P1, P2) and `core/orchestrator.ts` (P4, one line).
- One skill changed that was not named in the plan's table: `skills/enable_full_control_session/skill.ts`, for N-PC3 (double approval), which the tracker had placed under A3. It removes only the duplicate question; the registry's approval for risk 3 is unchanged.
- Three existing test files changed, as explained above.
- No change to `skills/automation/skill.ts`, `security/riskEngine.ts`, `security/approvalScope.ts`, `control/pcControlKernel.ts`, `.env`, subagents (`core/agents/**`) or browser-control code.
