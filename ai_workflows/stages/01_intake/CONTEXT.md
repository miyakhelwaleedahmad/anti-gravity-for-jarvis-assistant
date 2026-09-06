# Stage 01 — Intake

## Purpose
Collect all facts about the problem before any analysis begins.

## What You Are Allowed to Do
```
✅ Read the problem statement from the user
✅ Collect exact error messages, log lines, and symptoms
✅ List the files that are likely relevant (do not read them yet — just list)
✅ Identify what the user expected vs. what actually happened
✅ Note the environment (live runtime vs. test, voice vs. CLI)
✅ Write the issue brief in output/issue_brief.md
```

## What You Must NOT Do
```
❌ Do not read runtime files during this stage
❌ Do not form root cause conclusions
❌ Do not suggest fixes
❌ Do not edit any code
❌ Do not run tests
```

## Output Required
Complete `output/issue_brief.md` before advancing to Stage 02.

The issue brief must include:
- One-sentence problem description
- Exact symptoms (copy/paste from logs or user description)
- Expected behavior
- Actual behavior
- Environment (voice/CLI/test)
- Files likely involved (list only — do not read yet)
- What has already been tried (if anything)

## Advancement Condition
You may advance to `02_diagnosis` only when `output/issue_brief.md` is complete.
