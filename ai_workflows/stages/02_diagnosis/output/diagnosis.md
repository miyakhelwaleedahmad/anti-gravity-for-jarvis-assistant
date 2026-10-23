# Diagnosis — [Replace with Bug Name]

> Stage: 02_diagnosis · Template. Copy to `ai_workflows/runs/<run>/diagnosis.md`
> and fill in the copy; leave this file blank.
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

| File | Why | Protected? |
|---|---|---|
| [path] | [reason] | Yes/No |

---

## Evidence Labels

Mark each claim above: **observed** (log, issue record, code read) or
**inferred** (reasoned, not seen).

---

## Proposed Reproduction (for Stage 02b)

- Existing test: [`tests/<name>.ts`, or none]
- New regression test needed: [yes/no — what it asserts]
- Owner's PC needed: [yes/no — why: voice, microphone, speaker, Windows, real browser]

---

## Ready to Advance to Reproduction?

- [ ] Root cause identified (or hypotheses ranked)
- [ ] Evidence documented and labelled
- [ ] Files to change listed
- [ ] Reproduction method proposed
- [ ] No code edits made during this stage
