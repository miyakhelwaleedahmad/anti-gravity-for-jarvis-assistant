# Closure — [Replace with Run Name]

> Stage: 07_closure · Template. Copy to `ai_workflows/runs/<run>/closure.md`
> and fill in the copy; leave this file blank.
> Date: [fill in] · Run folder: `ai_workflows/runs/<YYYY-MM-DD>_<slug>/`

---

## Identity

| Field | Value |
|---|---|
| Finding / issue ID | [e.g. `SEC-04`, `PC-12`, `BUG-7`, `iss-…`, or "none (documentation/maintenance task)"] |
| Owning tracker | [from `_config/SOURCES_OF_TRUTH.md`, or "none"] |
| Final commit | [hash, or "no commit"] |
| Branch | |

## Record Check

| Artifact | Present | Note (stage skipped and why, exception, attempt count) |
|---|---|---|
| issue_brief.md | | |
| diagnosis.md | | |
| reproduction.md | | label: |
| patch_plan.md | | approved on: |
| change_log.md | | |
| verification.md | | |
| review.md | | decision: · independent: yes/no |
| final_report.md | | verdict: |

Final report agrees with verification and review: [ ] Yes / [ ] No — fix the report first

## Outcome

- Files changed: [ ]
- Tests run (command, machine, result; BLOCKED/SKIPPED listed): [ ]
- Known limitations: [ ]
- Outstanding findings: [ ]

## Tracker Update

- [ ] Existing row updated: [file, ID, new status, pointer to this run]
- [ ] No tracker owns this ID (BUG-n or none): recorded here only

## Runtime Issue (only for `iss-…`)

- Status last read: [status, date, how read] or "not read: [reason]"
- `issues.json` / `occurrences.jsonl` edited by hand: **never**
- Owner action still needed: [e.g. run JARVIS, repeat the failing action, ask "show the repair report"]
- Lesson: written by JARVIS on resolution only; none written by hand

## Follow-up (not done in this run)

1. [ ]

## Closure Status

- [ ] COMPLETE
- [ ] COMPLETE WITH LIMITATIONS (listed above)
- [ ] BLOCKED — never reported as resolved
- [ ] ABANDONED — evidence kept
