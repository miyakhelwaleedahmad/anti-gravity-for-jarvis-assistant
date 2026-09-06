# Stage 03 — Patch Plan

## Purpose
Write the exact change plan before any code is touched.

## What You Are Allowed to Do
```
✅ Write the exact proposed change as a before/after diff
✅ List every file that would be changed
✅ List every test that must pass after the change
✅ Identify whether live voice verification is required
✅ Identify any risks or regressions the change might introduce
✅ Write the patch plan in output/patch_plan.md
✅ Ask the user for approval
```

## What You Must NOT Do
```
❌ Do not implement anything during this stage
❌ Do not edit any runtime file
❌ Do not advance to implementation without explicit human approval
❌ Do not assume silence = approval
❌ Do not include unrelated changes in the plan
```

## Patch Plan Format
The output/patch_plan.md must contain:

```markdown
## File: <path/to/file.ts>
### Change: <one-line description>
### Before:
<exact current code>
### After:
<exact proposed code>
### Reason: <why this change is needed>
```

Repeat for each file that would change.

Also include:
- List of tests to run after implementation
- Whether live voice verification is required (yes/no + why)
- Risk assessment: what could break?

## Advancement Condition
You may advance to `04_implementation` ONLY after:
1. `output/patch_plan.md` is complete
2. The user has explicitly written "approved" or "proceed"
