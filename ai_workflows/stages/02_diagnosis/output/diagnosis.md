# Diagnosis — [Replace with Bug Name]

> Stage: 02_diagnosis
> Status: [ ] Complete / [ ] In Progress
> Date: [fill in]

---

## Root Cause (Primary Hypothesis)

**File:** [path/to/file.ts]
**Line(s):** [line number(s)]
**Description:** [Exact description of what is broken]

```typescript
// Relevant code snippet showing the problem:
```

---

## Supporting Evidence

```
[Paste relevant log lines or code traces here]
```

---

## Control Flow Trace

```
Input: [what the user said/typed]
  → [Component 1]: [what it does]
  → [Component 2]: [what it does]
  ↳ [FAILURE POINT]: [what goes wrong here]
  → [Component 3]: never reached
```

---

## Alternative Hypotheses

| Hypothesis | Likelihood | Evidence |
|---|---|---|
| [H1] | High/Medium/Low | [why] |
| [H2] | High/Medium/Low | [why] |

---

## Files That Would Need to Change

| File | Why |
|---|---|
| [path] | [reason] |

---

## Ready to Advance to Patch Plan?

- [ ] Root cause identified
- [ ] Evidence documented
- [ ] Files to change listed
- [ ] No code edits made during this stage
