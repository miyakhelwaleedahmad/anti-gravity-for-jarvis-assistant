# Reproduction — Phase 1A

> Stage: 02b_reproduction

- **Label:** INFERRED (each gap was read in the code; see `diagnosis.md`). No test has been run in this session: the cloud clone has no dev dependencies, and installing them needs the owner's approval.
- **Why there is no failing test yet:** `tests/` is protected by the owner's rule, and Stage 02b may not edit runtime files. The four new regression tests are written first in Stage 04, once approved.
- **How the fix will be proven:** each new test is run on the **unchanged** source first and must fail (recorded in `verification.md` with its output). Then the source changes are made and the same tests must pass, with the existing groups unchanged. A new test that passes on the old code is rewritten, not accepted.
- **Exception to accept:** the owner accepts "INFERRED, fail-before shown at the start of Stage 04" instead of a failing test at Stage 02b.
