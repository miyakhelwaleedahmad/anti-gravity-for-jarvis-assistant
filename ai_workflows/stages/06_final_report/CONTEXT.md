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
✅ Update the status tracker named in _config/SOURCES_OF_TRUTH.md
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
1. Update the tracker named in _config/SOURCES_OF_TRUTH.md
   (_config/JARVIS_CURRENT_STATUS.md only points to it)
2. Update ai_workflows/CONTEXT.md if system status changed
3. Commit only the files changed for this fix, staged by name:
   git status
   git add -- <file1> <file2>
   git diff --cached --name-only
   (stop if the list shows runtime data, credentials or untracked
   personal files; unstage them with git restore --staged -- <file>)
   git commit -m "Fix [bug]: [one-line description]"
   Never git add . or git add -A.
4. Consider tagging if stable:
   git tag stable-[feature]-v[N]
   (only with user approval)
```
