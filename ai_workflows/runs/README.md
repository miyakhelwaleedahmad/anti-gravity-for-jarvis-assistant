# runs/ — Session Run Archives

This folder stores archived run outputs for completed bug fix sessions.

## Purpose

When a full ICM pipeline run completes (all 6 stages), copy the output files here
for permanent reference.

## Naming Convention

```
runs/
└── YYYY-MM-DD_<bug-slug>/
    ├── issue_brief.md
    ├── diagnosis.md
    ├── patch_plan.md
    ├── change_log.md
    ├── verification.md
    └── final_report.md
```

## Example

```
runs/
└── 2026-06-19_youtube-openapp-live-voice/
    ├── issue_brief.md
    ├── diagnosis.md
    ├── patch_plan.md
    ├── change_log.md
    ├── verification.md
    └── final_report.md
```

## When to Archive

After completing Stage 06 (final_report):

1. Create the run folder: `runs/YYYY-MM-DD_<bug-slug>/`
2. Copy all 6 output files into it
3. Clear the stage output files (reset to templates) for the next run
4. Commit the archive: `git add runs/ && git commit -m "Archive run: <bug-slug>"`

## Current Runs

| Date | Bug | Verdict |
|---|---|---|
| *(none yet)* | | |
