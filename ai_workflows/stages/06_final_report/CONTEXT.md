# Stage 06 — Final Report

## Purpose
Produce a complete, honest summary of the work done.

## What You Are Allowed to Do
```
✅ Summarize the root cause found
✅ Summarize all files changed and why
✅ Summarize test results (copy from verification report)
✅ List unresolved risks or follow-up items
✅ Recommend the next step
✅ Write the final report in output/final_report.md
✅ Update _config/JARVIS_CURRENT_STATUS.md with the new system state
```

## What You Must NOT Do
```
❌ Do not claim a bug is fixed if verification was incomplete
❌ Do not omit unresolved risks
❌ Do not edit runtime files in this stage
❌ Do not start working on the next bug in this stage
```

## Final Report Format

```markdown
# Final Report — [Bug Name]
Date: [date]

## 1. Root Cause
[Exact description of what was broken and why]

## 2. Files Changed
| File | What Changed |
|---|---|
| path/to/file.ts | [description] |

## 3. Test Results
[Copy from 05_verification/output/verification.md]

## 4. Unresolved Risks
- [Any remaining risks]
- [Any follow-up items]

## 5. Next Recommended Step
[What should be done next]

## 6. Verdict
[ ] Bug confirmed fixed — live voice verified
[ ] Bug partially fixed — remaining issues listed above
[ ] Bug not fixed — see unresolved risks
```

## Post-Report Actions

After writing the final report:

```
1. Update _config/JARVIS_CURRENT_STATUS.md
2. Update ai_workflows/CONTEXT.md if system status changed
3. Commit changes with a descriptive message:
   git add .
   git commit -m "Fix [bug]: [one-line description]"
4. Consider tagging if stable:
   git tag stable-[feature]-v[N]
   (only with user approval)
```
