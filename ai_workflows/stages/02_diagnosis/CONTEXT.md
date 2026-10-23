# Stage 02 — Diagnosis

Find the root cause by reading and tracing the relevant code. No edits.

## Inputs

| Source | Load | Why |
|---|---|---|
| `runs/<run>/issue_brief.md` | Whole file | Symptom, record, files to read |
| Files listed in the brief | Only those, plus files the trace leads to | The code path |
| `_config/CONTEXT_LOADING_RULES.md` | The section for this bug type | What to read and what not to |
| `_config/VOICE_ROUTE_CONTRACT.md` | Voice bugs only | Expected live behaviour |
| `_config/SELF_HEALING_OWNERSHIP.md` | Self-healing or recovery bugs only | Which owner to extend |
| Existing tests for the behaviour | Only the relevant `tests/<name>.ts` | Behavioural contracts |

## Process

1. Trace the control flow from input to the failure point.
2. Identify the file and line where the failure occurs, if possible.
3. List probable causes, most likely first, each with its evidence.
4. Label each claim: observed (log, record, code read) or inferred.
5. List the files that would need to change, and which are protected
   (`_config/RUNTIME_PROTECTED_FILES.md`).
6. Name the tests that cover the behaviour and propose how Stage 02b can
   reproduce the failure (existing test, new test, or owner's PC).
7. A change to a classifier or recovery planner names the others it may
   affect (`_config/SELF_HEALING_OWNERSHIP.md`).

Allowed: reading files, searching the code. Forbidden: editing any code;
applying a fix, even an "obvious" one; adding debug logging to runtime
files (only temporarily, with the owner's approval, and removed again);
loading unrelated subsystems.

## Outputs

`runs/<run>/diagnosis.md` from `output/diagnosis.md`: root cause (file and
line), evidence, control-flow trace, alternative hypotheses, files to
change, proposed reproduction method.

## Audit / advancement

- PASS: root cause or ranked hypotheses with evidence, and a reproduction
  method. Advance to `02b_reproduction`.
- BLOCKED: evidence missing (logs, record, access); ask the owner.
- Never: skip to `03_patch_plan` or to implementation.
