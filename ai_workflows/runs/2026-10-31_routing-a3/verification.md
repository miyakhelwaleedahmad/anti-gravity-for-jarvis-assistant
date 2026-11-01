# Verification — routing (phase A3)

Cloud machine: Linux, Node 22, no PowerShell 7, no pygame. The owner's PC and Windows not observed.

| Check | Result | Evidence |
|---|---|---|
| Probe of the old code (routes, planner tools, normaliser) | "close youtube tab", "close the youtube tab", the full-control near-misses: no route; "github.com" → "githubcom" | `evidence/probe_before.txt` |
| routingA3Test on the code before the change | 32 passed, **27 failed** | `evidence/old_code_run.txt` |
| routingA3Test after | **59 passed, 0 failed** | `evidence/new_code_run.txt`, `evidence/new_code_checks.txt` |
| Related tests (route golden, deterministic routes, voice normaliser, DO_NOT_BREAK set, browser and full-control tests) | 25 passed, 2 failed → both intended, fixed (change_log.md, Tests) → 3/3 | `evidence/related_tests.txt`, `evidence/related_tests_after.txt` |
| Typecheck | 0 errors | `evidence/typecheck.txt` |
| Full suite (before review) | **206 passed, 0 failed**, 1 blocked (realTtsHandoffTest: no pygame), 9 skipped | `evidence/full_suite.txt` |
| DO_NOT_BREAK set | all PASS | `evidence/full_suite.txt` |
| Mutation check before review (11 mutants of P1–P6 and the skill change) | **11/11 caught**; tree restored (checksums and diff stat unchanged) | `evidence/a3_mut.py`, `evidence/a3_mut_run.txt` |
| Independent review, round 1 | CHANGES REQUIRED (R1 med, R2, R3 low, R4–R7 info) | `review.md` |
| New checks for R1, R2, R5 on the code before those fixes | 62 passed, **16 failed** | `evidence/review_r1_old_code_run.txt` |
| routingA3Test after the round-1 fixes | **78 passed, 0 failed** | `evidence/review_r1_new_code_run.txt` |
| Related tests after the round-1 fixes (16, DO_NOT_BREAK and route golden included) | all pass | `evidence/review_related_tests.txt` |
| Typecheck after the round-1 fixes | 0 errors | `evidence/typecheck_review.txt` |
| Mutation check after the round-1 fixes (14 mutants) | **14/14 caught**; tree restored | `evidence/a3_mut_run_review.txt` |
| Full suite after the round-1 fixes | **206 passed, 0 failed**, 1 blocked (realTtsHandoffTest: no pygame), 9 skipped; DO_NOT_BREAK all PASS | `evidence/full_suite_review.txt` |
| Independent review, round 2 | **PASS** (N1 low, N2 and N3 info, all fixed afterwards) | `review.md` |
| N1 checks on the code before the fix (the N2 and dotted-name checks were added with the fix) | 78 passed, **7 failed** | `evidence/review_n1_old_code_checks.txt` |
| routingA3Test after the N1/N2 fixes (direct run, with counts) | **89 passed, 0 failed** | `evidence/review_n1_new_code_checks.txt` |
| Typecheck after the N1/N2 fixes | 0 errors | `evidence/typecheck_review2.txt` |
| Mutation check after the N1/N2 fixes (16 mutants) | **16/16 caught**; tree restored | `evidence/a3_mut_run_review2.txt` |
| Full suite after the N1/N2 fixes | **206 passed, 0 failed**, 1 blocked (realTtsHandoffTest: no pygame), 9 skipped; DO_NOT_BREAK all PASS | `evidence/full_suite_review2.txt` |
| Independent review, round 3 (the N1/N2 fixes) | **PASS** (no defects; N4–N6 info) | `review.md` |

## Not verified

- On the owner's PC: none of the A3 phrases yet. To check after a push the owner approves:
  - "close the youtube tab" and "close youtube tab" close the tab by the fast route (log: `close_browser_tab`, no planner); "close the tab" does not use that route;
  - "enable full controll mode" (or another near-miss) asks for approval **once**; answering no is spoken as not approved;
  - "close notepad and chrome" closes both, or says plainly which one it could not close;
  - "open github.com" keeps the dot in the log's normalised text.
- Windows CI: after the owner approves a push.
- Speech recognition: which near-misses Whisper actually produces on the PC is not known; the list comes from the PC logs of 2026-10-27 and 2026-10-31 and common one-letter slips.
