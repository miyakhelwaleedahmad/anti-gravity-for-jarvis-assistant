# Stage 05b — Independent Review

Inspect the change apart from the person or session that diagnosed and
made it. Passing tests are evidence, not approval.

## Inputs

| Source | Load | Why |
|---|---|---|
| The diff | `git status`, `git diff --stat`, `git diff` (or the commit range) | What actually changed |
| `runs/<run>/patch_plan.md` | Approved changes, tests, approval record | The scope that was approved |
| `runs/<run>/change_log.md`, `verification.md`, `reproduction.md` | Whole files | Claimed changes and evidence |
| `_config/RUNTIME_PROTECTED_FILES.md` | Sections for the files touched | Protected files |
| `_config/DO_NOT_BREAK.md` | Invariants for the subsystem touched | Behaviour that must hold |
| `_config/SECURITY_RULES.md` | Only if commands, routing, approval or permissions changed | Security boundaries |
| Code-repair path only | `data/repairs/code/<repairId>.json` on the PC that runs JARVIS; branch `jarvis/repair/<id>` | Existing evidence |

## Process

1. Record who reviews. For a real repair it must be a different person or a
   separate session that did not write the diagnosis, plan or change. If
   none is available, write "not independent" and do the review anyway.
2. Compare every changed path with the approved plan. Any file or hunk
   outside it is a finding.
3. Look for: accidental deletions; weakened tests (deleted tests, removed
   assertions, skips, raised time limits); unsafe commands in docs or
   scripts; writes to runtime data (`data/`, `memory/`); credentials or
   secret-named files; changed tool permissions, risk levels, approval
   gates or agent spawn limits; documentation that contradicts the code.
4. Check each claimed result against the commands actually run: same
   command, same commit, runner lines present, BLOCKED/SKIPPED listed.
5. Check coverage: does a test exercise the changed behaviour? Did the
   regression test from 02b fail before and pass now? Is live verification
   still owed?
6. Code-repair path: read the report (attempts, lint, checks, model review,
   `checkoutUnchanged`, `baseCommit`..`commit`) and review that diff. Do not
   rerun the whole repair pipeline; rerun a named check only where the
   evidence is missing or does not match. The model review inside the repair
   is not an independent review.
7. Record each finding with severity, file path and evidence.

Forbidden: editing code, running risky or live actions, approving because
tests pass, approving what was not inspected.

## Outputs

`runs/<run>/review.md`, copied from `output/review.md`: reviewer and
independence, inputs inspected, findings table, decision and reasons.

## Audit / advancement

- PASS: no open high or medium finding; claims match the evidence. Advance
  to `06_final_report`.
- CHANGES REQUIRED: return to `04_implementation` for fixes inside the
  approved plan, or to `03_patch_plan` (new approval) if the plan must change.
- BLOCKED: review cannot finish (diff or evidence missing, owner input
  needed). Stage 06 may report, but not as approved.
- Stage 06 may say "independently reviewed" only for PASS by an
  independent reviewer.
