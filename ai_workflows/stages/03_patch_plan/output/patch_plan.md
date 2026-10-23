# Patch Plan — [Replace with Bug Name]

> Stage: 03_patch_plan
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

## Tests to Run After Implementation

```powershell
pnpm run typecheck
pnpm test -- --only=[relevantTestA],[relevantTestB]
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

Human approval recorded: [ ] Yes — Date: [fill in]
