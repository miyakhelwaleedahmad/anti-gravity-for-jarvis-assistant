# Final Report — [Replace with Bug Name]

> Stage: 06_final_report · Template. Copy to `ai_workflows/runs/<run>/final_report.md`
> and fill in the copy; leave this file blank.
> Status: [ ] Complete
> Date: [fill in]

---

## 1. Root Cause

[Exact description of what was broken and why]
Reproduction label (02b): [ ]

---

## 2. Files Changed

| File | What Changed | Protected File? |
|---|---|---|
| [path/to/file.ts] | [description] | Yes/No |

---

## 3. Test Results Summary

Copied from `verification.md` (machine: [ ], commit: [ ]):

| Check | Status |
|---|---|
| `pnpm run typecheck` | ✅/❌ |
| Regression test `<name>` | ✅/❌ |
| Required group (`pnpm test -- --only=…`) | ✅/❌ |
| `pnpm test -- --ci` (BLOCKED/SKIPPED listed) | ✅/❌ |
| Live verification | ✅/❌/owed/N/A |

---

## 4. Review

- Decision (05b): [ ] PASS / [ ] CHANGES REQUIRED / [ ] BLOCKED
- Reviewer independent: [ ] Yes / [ ] No — "reviewed, not independently"
- Open findings: [ ]

---

## 5. Unresolved Risks

| Risk | Severity | Recommended Action |
|---|---|---|
| [risk] | High/Medium/Low | [action] |

---

## 6. Next Recommended Step

[What should be done next — specific and actionable]

---

## 7. Verdict

- [ ] ✅ Fixed and verified — tests pass, live check passed if required, review PASS by an independent reviewer
- [ ] ⚠️ Partially fixed / not verified — owed checks, BLOCKED items or non-independent review listed above
- [ ] ❌ Not fixed — see unresolved risks

---

## 8. Post-Report Checklist

- [ ] Committed only the reviewed files, staged by name; `git diff --cached --name-only` checked
- [ ] Stable tag only after live verification and only at the owner's request
- [ ] Next: `07_closure` (tracker update and run record happen there)
