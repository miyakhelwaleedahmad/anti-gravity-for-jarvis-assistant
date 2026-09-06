# Stage 02 — Diagnosis

## Purpose
Identify the exact root cause by reading and tracing relevant code.

## What You Are Allowed to Do
```
✅ Read files identified in the Stage 01 issue brief
✅ Follow the control flow from input to output
✅ Read test files for existing behavioral contracts
✅ Identify the exact file + line where the failure occurs
✅ List all probable root causes (most likely first)
✅ Cross-reference with _config/VOICE_ROUTE_CONTRACT.md
✅ Write diagnosis in output/diagnosis.md
```

## What You Must NOT Do
```
❌ Do not edit any code during this stage
❌ Do not apply any fixes — not even "obvious" ones
❌ Do not add debug logging to runtime files (except temporarily with user approval)
❌ Do not advance to patch plan without completing the diagnosis document
```

## Context Loading
Use `_config/CONTEXT_LOADING_RULES.md` to decide which files to read.
Do not load irrelevant files (memory files for a voice bug, etc.).

## Output Required
Complete `output/diagnosis.md` before advancing to Stage 03.

The diagnosis must include:
- Root cause (specific file + line if possible)
- Supporting evidence (log lines, code traces)
- Alternative possible causes (secondary hypotheses)
- Which hypothesis is most likely and why
- List of files that would need to change to fix this

## Advancement Condition
You may advance to `03_patch_plan` only when `output/diagnosis.md` is complete.
