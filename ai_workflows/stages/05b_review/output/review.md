# Review — [Replace with Bug Name]

> Stage: 05b_review · Template. Copy to `ai_workflows/runs/<run>/review.md`
> and fill in the copy; leave this file blank.
> Date: [fill in]

---

## Reviewer

- Reviewer: [person or session identifier]
- Independent of diagnosis, plan and implementation: [ ] Yes / [ ] No — not independent
- Path: [ ] Normal stages / [ ] Code-repair proposal (`repairId`: [ ], branch `jarvis/repair/<id>`)

## What Was Inspected

| Input | Reference (commit, range or file) |
|---|---|
| Diff | [e.g. `git diff <base>..<head>`, or working tree at `<commit>`] |
| Approved plan | `runs/<run>/patch_plan.md`, approved [date] |
| Verification | `runs/<run>/verification.md` |
| Reproduction | `runs/<run>/reproduction.md` (label: [ ]) |
| Code-repair report | [`data/repairs/code/<repairId>.json`, or N/A] |

## Checks

| Check | Result | Evidence |
|---|---|---|
| Only planned files and hunks changed | | |
| No accidental deletions | | |
| No weakened tests (deleted, assertions removed, skips, longer limits) | | |
| No unsafe commands added to docs or scripts | | |
| No runtime data, credentials or secret-named files | | |
| Tool permissions, risk levels, approval gates, spawn limits unchanged (or planned) | | |
| Protected files touched only as approved | | |
| `DO_NOT_BREAK.md` invariants still hold | | |
| Claimed results match commands actually run | | |
| Regression test failed before, passes now | | |
| Live verification done, or listed as still owed | | |
| Documentation consistent with the code | | |

## Findings

| ID | Severity (high/medium/low) | File:line | Finding | Evidence |
|---|---|---|---|---|
| R1 | | | | |

## Decision

- [ ] PASS
- [ ] CHANGES REQUIRED — return to: [ ] 04_implementation / [ ] 03_patch_plan
- [ ] BLOCKED — what is missing: [ ]

Reasons: [ ]

> A PASS by a reviewer who is not independent must be reported as
> "reviewed, not independently". Never mark a check done that was not done.
