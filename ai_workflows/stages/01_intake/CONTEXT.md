# Stage 01 — Intake

Collect the facts about the problem before any analysis. Start from a real
JARVIS failure record when one exists, not only from a description.

## Inputs

| Source | Load | Why |
|---|---|---|
| The owner's report | Exact words, error messages, log lines | The symptom |
| Runtime issue record, when an `iss-…` ID or failure is named | Only that issue's entry in `data/repairs/issues.json` and its lines in `occurrences.jsonl`, on the PC that runs JARVIS (under `JARVIS_DATA_ROOT` if set) | Observed failure data |
| JARVIS's own answer, if supplied | Text of "show the repair report", "why are you stuck" or the self-check | Status as JARVIS sees it |
| `_config/SOURCES_OF_TRUTH.md` | Table | Which tracker owns the ID |

## Process

1. Create the run folder `runs/<YYYY-MM-DD>_<slug>/` (see `runs/README.md`)
   and copy `output/issue_brief.md` into it. Fill in the copy only.
2. Record the symptom, expected and actual behaviour, and environment
   (live voice, CLI, test, CI; which machine).
3. If an issue record is available and the owner allows it, read only that
   one record, read-only. PowerShell, in the JARVIS folder on the owner's PC:
   `(Get-Content data\repairs\issues.json -Raw | ConvertFrom-Json).issues | Where-Object issueId -eq 'iss-…' | ConvertTo-Json -Depth 6`
   Copy the fields the template lists (issueId, signature, status,
   category, component, sourceLocation, counts, first/last seen, recent
   occurrences, diagnosis, blockedReason, nextAction).
4. If the record is not in this clone, not reachable, or not found, write
   "Issue record: not read — <reason>" and ask the owner for the minimum:
   that one entry, or the repair-report text. Never fabricate a record or
   mark one as read.
5. Mark each fact as observed (seen in a record or log), reported (the
   owner said so) or missing. No root-cause conclusions here.
6. Sanitize before writing: no tokens, keys, passwords, or personal data
   the task does not need. Store messages are redacted at source; check
   again anyway.
7. List the files likely involved; do not read runtime code yet.

Forbidden: importing runtime modules, starting JARVIS or calling its
internals to get a record; editing code or data; running tests; proposing
fixes; opening secret-named files.

## Outputs

`runs/<run>/issue_brief.md`: one-sentence problem, exact symptoms,
expected vs actual, environment, runtime issue record (or why not read),
tracker ID, files likely involved, what was already tried.

## Audit / advancement

- PASS: every template section filled, or marked missing with a reason.
  Advance to `02_diagnosis`.
- BLOCKED: no usable symptom or evidence; ask the owner and wait.
- Never: quote an issue record that was not actually read.
