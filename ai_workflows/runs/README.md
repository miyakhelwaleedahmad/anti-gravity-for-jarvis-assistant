# runs/ — Maintenance Run Records

Each maintenance run keeps its artifacts here, in its own folder, from
Stage 01 to Stage 07. This is the record of one run (see
`_config/SOURCES_OF_TRUTH.md`); it is not a runtime issue database.

## Folder Layout

```
runs/
└── YYYY-MM-DD_<slug>/
    ├── issue_brief.md      01_intake
    ├── diagnosis.md        02_diagnosis
    ├── reproduction.md     02b_reproduction
    ├── patch_plan.md       03_patch_plan (with the approval record)
    ├── change_log.md       04_implementation
    ├── verification.md     05_verification
    ├── review.md           05b_review
    ├── final_report.md     06_final_report
    └── closure.md          07_closure
```

## How It Works

1. Stage 01 creates the folder: date the run started, short slug
   (`2026-11-02_tts-silent-after-wake`).
2. Each stage copies its template from `stages/<stage>/output/` into the
   folder and fills in the copy. The templates stay blank.
3. A stage that did not run still gets a line in `closure.md` saying why.
   For the code-repair path, the report `data/repairs/code/<repairId>.json`
   stays on the PC that runs JARVIS; quote its fields, do not copy runtime data.
4. A failed attempt stays in the folder (for example `change_log.md`
   section "Attempt 1", or `attempt-1/`). Never delete evidence to make a
   run look clean.
5. Stage 07 adds a row to the table below and commits the folder by name:
   ```
   git add -- ai_workflows/runs/<run>/<file> ... ai_workflows/runs/README.md
   git diff --cached --name-only
   ```
   Never `git add .` or `git add -A`. Pushing needs the owner's approval.
6. Never put credentials, `.env` contents or unredacted personal data in a run.

## Runs

| Date | Run folder | Finding / issue ID | Closure status |
|---|---|---|---|
| 2026-10-23 | `2026-10-23_voice-route-test-launches-browser/` | TEST-05 | COMPLETE WITH LIMITATIONS (Windows not observed; review by a separate agent session, not a human) |
| 2026-10-25 | `2026-10-25_voice-route-test-weak-checks/` | TEST-06 | COMPLETE WITH LIMITATIONS (Windows not observed; B2 open; review by a separate agent session, not a human) |
