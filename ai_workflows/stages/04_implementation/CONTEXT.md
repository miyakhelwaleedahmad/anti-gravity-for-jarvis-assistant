# Stage 04 — Implementation

## Purpose
Apply ONLY the approved changes from the patch plan — nothing more.

## What You Are Allowed to Do
```
✅ Apply exactly the changes described in 03_patch_plan/output/patch_plan.md
✅ Keep each change small and focused
✅ Run npx tsc --noEmit immediately after each file change
✅ Fix TypeScript compile errors caused by the approved change
✅ Record every changed file in output/change_log.md
```

## What You Must NOT Do
```
❌ Do not add "bonus" changes not in the patch plan
❌ Do not refactor unrelated code ("while I'm here...")
❌ Do not change multiple files simultaneously without tracking each one
❌ Do not skip TypeScript compile check after each change
❌ Do not advance to verification if TypeScript has errors
❌ Do not edit _config/ or ai_workflows/ as part of implementation
```

## Change Log Format
Record every file touched in output/change_log.md:

```markdown
## Changed Files

| File | Change | Lines Affected |
|---|---|---|
| path/to/file.ts | Description of change | Line X–Y |

## TypeScript Compile Status
- After all changes: npx tsc --noEmit → [ ] 0 errors
```

## Advancement Condition
You may advance to `05_verification` only when:
1. All approved changes are applied
2. `npx tsc --noEmit` shows 0 errors
3. `output/change_log.md` is complete
