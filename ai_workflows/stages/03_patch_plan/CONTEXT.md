# Stage 03 — Patch Plan

Write the exact change before any code is touched, then wait for the
owner's approval. This is the approval gate for implementation.

## Inputs

| Source | Load | Why |
|---|---|---|
| `runs/<run>/diagnosis.md` | Whole file | Root cause and files to change |
| `runs/<run>/reproduction.md` | Label, test, exception | Proof the failure is real, or why not |
| `_config/RUNTIME_PROTECTED_FILES.md` | Sections for the files in the plan | Protected-file rules |
| `_config/DO_NOT_BREAK.md` | Invariants for the subsystem | What the change must keep |
| `_config/SECURITY_RULES.md` | Only if routing, commands, approval or permissions change | Security boundaries |
| `_config/TEST_MATRIX.md` | Commands and required groups | Tests to list |

## Process

1. For each file: the exact before and after code, and why it fixes the
   root cause (format in `output/patch_plan.md`).
2. List every file that will change and mark the protected ones.
3. List the tests to run, through the runner only: the regression test from
   Stage 02b, the required group from `TEST_MATRIX.md`, then
   `pnpm test -- --ci`.
4. State whether live verification on the owner's PC is required and why
   (always for voice, microphone, speaker, Windows-control or real-browser
   behaviour).
5. Assess risks: what could break, and how it would show.
6. Copy the reproduction label. If it is an exception, restate it: why
   reproduction is unavailable and what evidence will verify the fix.
7. Present the plan and ask for approval.

Forbidden: implementing anything; editing runtime files; unrelated changes
in the plan; treating silence, a report, a test result or an automated
agent's output as approval.

## Outputs

`runs/<run>/patch_plan.md` from `output/patch_plan.md`, with the approval
recorded: the owner's words ("approved" or "proceed"), date, and any
reproduction exception they accepted.

## Audit / advancement

- APPROVED: the owner explicitly wrote "approved" or "proceed" for this
  plan, and any reproduction exception is named in the plan. Advance to
  `04_implementation`.
- REVISE: the owner asked for changes; revise and ask again.
- REJECTED or no answer: stop. Silence is not approval.
- A changed plan needs a new approval.
