# Stage 02b — Reproduction

Show whether the Stage 02 diagnosis can be reproduced, and whether a
regression test fails for the diagnosed reason. No runtime code changes.

## Inputs

| Source | Load | Why |
|---|---|---|
| `runs/<run>/diagnosis.md` | Root cause, evidence, files, proposed reproduction | What to reproduce |
| `runs/<run>/issue_brief.md` | Expected vs observed, environment, issue ID | The failure as reported |
| `_config/TEST_MATRIX.md` | "How tests must be run", Windows note, Live Runtime Verification | Runner commands and isolation |
| `tests/<name>.ts` named in the diagnosis | Only those test files | The existing contract |

## Process

1. Restate the failure: exact symptom, expected behaviour, observed
   behaviour, affected file or subsystem, steps that trigger it.
2. Choose the method, first that applies:
   a. an existing test that covers the behaviour;
   b. a new regression test file under `tests/`, drafted here, not committed;
   c. a manual check on the owner's PC (owner present, steps written first).
3. Run tests only through the runner: `pnpm test -- --only=<name>`.
   Never `npx tsx tests/<name>.ts` (it writes JARVIS's real data).
4. For a code defect that an automated test can reach: the test must fail
   now, and its failure message must match the diagnosed cause. A failure
   for another reason is not a reproduction. Record the command and output.
5. A result seen only sometimes: run it at least 3 times and record the count.
6. Label the result with one term from the template; never round up:
   REPRODUCED, REPRODUCED-MANUAL, MOCK-ONLY, FLAKY, INFERRED, NOT REPRODUCED,
   BLOCKED.
7. Windows-only, microphone, speaker, live voice or real-browser failures
   that this machine cannot exercise are BLOCKED or INFERRED, never
   REPRODUCED. Write the exact owner-PC steps: command (CMD or PowerShell),
   what to say or click, and the log lines expected.
8. If no reproduction is possible, record the limitation, the evidence that
   exists, and the evidence that would verify a fix.

Allowed: read the inputs; draft a new test file; run named tests through
the runner. Forbidden: editing runtime code or existing tests, weakening
an assertion, committing, live checks without the owner.

## Outputs

`runs/<run>/reproduction.md`, copied from `output/reproduction.md` (the
template stays blank). It holds: method, command, machine, raw runner
lines, label, the failing assertion and why it matches the cause, and any
exception with the evidence needed later.

## Audit / advancement

- PASS: REPRODUCED or REPRODUCED-MANUAL, with the command or the owner's
  steps and the captured output. Advance to `03_patch_plan`.
- EXCEPTION: any other label. Advance only with the exception written out
  (why reproduction is unavailable, what evidence exists, what would
  verify the fix). Stage 03 must show it to the owner; plan approval must
  name it.
- FAIL: the test fails for a different reason, or the diagnosis is
  contradicted. Return to `02_diagnosis`.
- Never: claim a reproduction from a mock alone, or from hardware that was
  not used.
