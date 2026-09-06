# DEVELOPMENT_CHECKLIST.md — Step-by-Step Development Workflow

> Follow this checklist for every bug fix or feature change.
> Do not skip steps. Do not self-approve.

---

## The 8-Step Workflow

### Step 1 — Intake
```
[ ] Read the problem statement carefully
[ ] Collect exact error messages or failure logs
[ ] List the files that are likely relevant
[ ] Document symptoms in stages/01_intake/output/issue_brief.md
[ ] Do NOT edit any code in this step
[ ] Do NOT form conclusions in this step — only collect facts
```

---

### Step 2 — Diagnosis
```
[ ] Read only the relevant files (see _config/CONTEXT_LOADING_RULES.md)
[ ] Trace the control flow from input to output
[ ] Identify the exact line or component where failure occurs
[ ] List all probable root causes (most likely first)
[ ] Document in stages/02_diagnosis/output/diagnosis.md
[ ] Do NOT edit any code in this step
```

---

### Step 3 — Patch Plan
```
[ ] Write the exact proposed change (file, line range, before/after)
[ ] List every file that would change
[ ] List every test that must pass after the change
[ ] Identify if live voice verification is required
[ ] Document in stages/03_patch_plan/output/patch_plan.md
[ ] Do NOT implement anything yet
[ ] Wait for explicit human approval before proceeding
```

---

### Step 4 — Human Approval
```
[ ] Present the patch plan to the user
[ ] Wait for explicit "approved" or "proceed" confirmation
[ ] Do NOT assume silence = approval
[ ] If the user asks for changes to the plan, revise and wait again
```

---

### Step 5 — Implementation
```
[ ] Apply ONLY the approved changes
[ ] Keep diffs small and focused
[ ] Do NOT add unrelated changes ("while I'm here..." is forbidden)
[ ] Record every changed file in stages/04_implementation/output/change_log.md
[ ] Run TypeScript compile immediately after changes: npx tsc --noEmit
[ ] Fix any compile errors before moving on
```

---

### Step 6 — Tests
```
[ ] Run all tests from _config/TEST_MATRIX.md
[ ] Record honest pass/fail for each test
[ ] If any test fails: stop, diagnose, do not proceed to verification
[ ] Record results in stages/05_verification/output/verification.md
```

---

### Step 7 — Live Verification (if voice/runtime-related)
```
[ ] Start JARVIS: pnpm run dev
[ ] Wait for all READY clients: wakeword, stt, tts
[ ] Say the trigger phrase: "Jarvis open YouTube for me"
[ ] Confirm browser opens https://www.youtube.com/
[ ] Confirm TTS speaks
[ ] Capture full terminal log output
[ ] Paste captured logs into verification report
[ ] Do NOT mark bug fixed without completing this step for voice bugs
```

---

### Step 8 — Final Report
```
[ ] Summarize root cause found
[ ] Summarize files changed and why
[ ] Summarize test results
[ ] List any unresolved risks
[ ] List next recommended step
[ ] Document in stages/06_final_report/output/final_report.md
[ ] Update _config/JARVIS_CURRENT_STATUS.md with new state
```

---

## Hard Rules

```
❌ Never jump directly from problem statement to code changes
❌ Never edit protected files without recording exactly why
❌ Never mark a bug fixed because a mock test passes
   — Live voice bugs require live voice verification
❌ Never self-approve a patch to a critical runtime file
❌ Never make multiple unrelated changes in one step
❌ Never skip the final report
```

---

## Per-Bug Checklist Template

Copy this for each new bug:

```markdown
## Bug: [description]

### Intake
- [ ] Symptoms documented
- [ ] Relevant files listed
- [ ] No code edited

### Diagnosis
- [ ] Root cause identified
- [ ] Control flow traced
- [ ] No code edited

### Patch Plan
- [ ] Exact diff written
- [ ] Files to change listed
- [ ] Tests identified
- [ ] Human approved: [ ]

### Implementation
- [ ] Only approved changes applied
- [ ] npx tsc --noEmit: [ ] PASS

### Verification
- [ ] All tests: [ ] PASS
- [ ] Live test (if voice): [ ] PASS / N/A

### Final Report
- [ ] Documented
- [ ] JARVIS_CURRENT_STATUS.md updated
```
