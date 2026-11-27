# Patch Plan — [Replace with Bug Name]

> Stage: 03_patch_plan · Template. Copy to `ai_workflows/runs/<run>/patch_plan.md`
> and fill in the copy; leave this file blank.
> Status: [ ] Awaiting Approval / [ ] Approved / [ ] Rejected
> Date: [fill in]

---

## Summary

[One paragraph describing what will be changed and why]

---

## Proposed Changes

### Change 1

**File:** `path/to/file.ts`
**Lines:** X–Y
**Change:** [one-line description]

**Before:**
```typescript
// current code
```

**After:**
```typescript
// proposed code
```

**Reason:** [why this change fixes the root cause]

---

### Change 2 (if needed)

[Repeat format above]

---

## Files That Will Change

| File | Protected? | Change Description |
|---|---|---|
| [path] | Yes/No | [description] |

---

## Reproduction (from Stage 02b)

- Label: [REPRODUCED / REPRODUCED-MANUAL / MOCK-ONLY / FLAKY / INFERRED / NOT REPRODUCED / BLOCKED]
- Regression test: [`tests/<name>.ts`, failing before the fix — or none]
- Exception (any label other than REPRODUCED / REPRODUCED-MANUAL):
  why reproduction is unavailable [ ]; evidence that will verify the fix [ ]

---

## Tests to Run After Implementation

```powershell
pnpm run typecheck
pnpm test -- --only=[regressionTest],[relevantTestA],[relevantTestB]
# ... list all applicable tests (file names without .ts), then:
pnpm test -- --ci
```

Tests run through the runner only (each gets its own empty data folder);
never `npx tsx tests/<name>.ts`. Live checks are listed separately, under
Live Voice Verification below.

---

## Live Voice Verification Required?

- [ ] Yes — this change affects the voice pipeline
- [ ] No — this is a non-voice change

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| [risk description] | High/Medium/Low | [how to mitigate] |

---

## Approval

**Status:** [ ] Awaiting human approval

> This plan must NOT be implemented until the user explicitly approves.
> Write "approved" or "proceed" in the conversation to unlock Stage 04.
> Silence, a report, a test result or an automated agent is never approval.

Human approval recorded: [ ] Yes — Date: [fill in]
Owner's words: [quote]
Reproduction exception accepted (if any): [ ] Yes / [ ] N/A
