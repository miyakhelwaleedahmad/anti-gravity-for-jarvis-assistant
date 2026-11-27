# DEVELOPMENT_CHECKLIST.md — Per-Run Checklist

> The stage contracts in `stages/<stage>/CONTEXT.md` are the rules; the
> order and both approval gates are in `ai_workflows/CLAUDE.md`. This file
> is only a checklist to copy into a run. Do not skip steps. Do not
> self-approve.

---

## Hard Rules

```
❌ Never jump directly from problem statement to code changes
❌ Never edit protected files without recording exactly why
❌ Never mark a bug fixed because a mock test passes
   — Live voice bugs require live voice verification
❌ Never present an inferred cause or a mock result as a reproduction
❌ Never self-approve a patch to a critical runtime file
❌ Never call a review independent when the implementer did it
❌ Never edit data/repairs/issues.json or write vault lessons by hand
❌ Never make multiple unrelated changes in one step
❌ Never skip the final report or the closure record
```

---

## Per-Run Checklist Template

Copy this into the run folder for each new run:

```markdown
## Run: [YYYY-MM-DD_slug] — [description]

### 01 Intake
- [ ] Symptoms documented; issue record read (or "not read" + reason)
- [ ] Relevant files listed
- [ ] No code edited

### 02 Diagnosis
- [ ] Root cause identified, evidence labelled observed / inferred
- [ ] Control flow traced
- [ ] No code edited

### 02b Reproduction
- [ ] Label: [REPRODUCED / … / BLOCKED]
- [ ] Failing test command and output, or exception written out

### 03 Patch Plan
- [ ] Exact diff written; files and protected files listed
- [ ] Tests identified (regression test first)
- [ ] Gate 1 — human approved: [ ] (date, words)

### 04 Implementation
- [ ] Only approved changes applied
- [ ] pnpm run typecheck: [ ] PASS

### 05 Verification
- [ ] Runner tests: [ ] PASS (BLOCKED/SKIPPED listed)
- [ ] Live test (if voice/Windows/browser): [ ] PASS / owed / N/A

### 05b Review
- [ ] Decision: [ ] PASS / CHANGES REQUIRED / BLOCKED
- [ ] Reviewer independent: [ ] yes / no

### 06 Final Report
- [ ] Verdict matches evidence; reviewed files committed by name

### 07 Closure
- [ ] Run folder complete; tracker row updated (or none)
- [ ] Follow-ups listed separately
- [ ] Gate 2 — push/merge/tag approved by the owner: [ ]
```
