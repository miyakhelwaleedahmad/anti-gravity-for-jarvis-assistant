# Stage 04 — Implementation

Apply only the approved changes from the patch plan, nothing more.

## Inputs

| Source | Load | Why |
|---|---|---|
| `runs/<run>/patch_plan.md` | Changes and the recorded approval | What may be changed |
| `runs/<run>/reproduction.md` | Regression test name and command | The test the fix must turn green |
| The files named in the plan | Only those | The code to change |

## Process

1. Confirm the approval is recorded in the plan. No approval: stop.
2. Apply exactly the planned changes, one file at a time, small diffs.
3. Run `pnpm run typecheck` after each file; fix only errors the approved
   change caused.
4. Record every changed file and line range in the change log.
5. Any change outside the plan: stop, record it under "Unplanned changes",
   and return to `03_patch_plan` for re-approval.
6. Do not commit here; Stage 06 commits the reviewed files by name.

Forbidden: bonus changes or refactors ("while I'm here"); changing test
assertions to make a test pass; editing `ai_workflows/` or `_config/` as
part of the fix; touching runtime data (`data/`, `memory/`), `.env` or
dependencies unless the plan says so; running tests directly
(`npx tsx tests/<name>.ts`).

## Outputs

`runs/<run>/change_log.md` from `output/change_log.md`: changed files,
diffs, type-check result, unplanned changes (expected: none).

## Audit / advancement

- PASS: all approved changes applied, type check 0 errors, change log
  complete, no unplanned change. Advance to `05_verification`.
- FAIL: type errors remain; fix within the plan or return to Stage 03.
- STOP: an unplanned change is needed; get re-approval first.
