# CLAUDE.md — Behavioral Contract for JARVIS AI Development Workflow

> This file governs how Claude (or any AI agent) must behave inside this workflow space.
> Read this file first before taking any action on this project.

---

## Identity

You are working inside the **JARVIS AI Development Workflow Space**.
This is NOT a place for free-form code editing.
Every action you take must follow the stage order defined in `stages/`.

---

## Mandatory Rules

### Stage Order

You MUST follow the stage pipeline in order:

```
01_intake → 02_diagnosis → 03_patch_plan → [HUMAN APPROVAL] → 04_implementation → 05_verification → 06_final_report
```

- You MUST NOT skip from diagnosis directly to implementation.
- You MUST NOT skip from patch_plan to implementation without explicit human approval.
- You MUST complete the output document for each stage before moving to the next.

---

### Code Editing Rules

- You MUST NOT modify runtime code during a diagnosis or documentation task.
- You MUST NOT delete files automatically — ever.
- You MUST NOT rename or move runtime files without a recorded patch plan and approval.
- You MUST NOT change protected runtime files (see `_config/RUNTIME_PROTECTED_FILES.md`) without:
  1. A written diagnosis
  2. A written patch plan
  3. Explicit human approval
  4. A post-implementation verification report

---

### Stability Claims

- You MUST NOT claim a feature is stable unless:
  - TypeScript compiles with 0 errors (`npx tsc --noEmit`)
  - All relevant tests pass
  - **Live runtime logs** confirm the behavior

- You MUST treat the **YouTube open_app route as currently under investigation**.
  Do not mark it fixed. Do not assume smoke test success equals live success.

- You MUST NOT say "the 46ms stable route is confirmed" unless you have current live logs from this exact runtime session.

---

### Routing Protection

- You MUST always protect deterministic command routing.
- You MUST NOT broaden the deterministic router aliases without:
  - Adding matching security boundary tests
  - Verifying `"launch cmd /c del *"` still does NOT match `cmd`

---

### Post-Implementation

- You MUST run all required tests after any implementation (see `_config/TEST_MATRIX.md`).
- You MUST produce a verification report in `stages/05_verification/output/verification.md`.
- You MUST produce a final report in `stages/06_final_report/output/final_report.md`.
- You MUST NOT close a bug as resolved without live voice verification for voice-related bugs.

---

### What You Must NOT Connect To

This workflow layer must never import from or connect to:

- NodeBridge
- Orchestrator
- Voice Pipeline
- Redis
- Vector Memory
- Tool Registry
- Skill Loader
- Self-healing runtime
- Runtime dashboard

This layer is **documentation, workflow scaffolding, and structured diagnosis only**.

---

## Quick Reference

| Do | Don't |
|---|---|
| Follow stage order | Skip stages |
| Read files for diagnosis | Edit files during diagnosis |
| Write patch plans first | Jump straight to code changes |
| Run tests after changes | Claim stability without tests |
| Produce reports | Delete files silently |
| Wait for human approval | Self-approve major changes |
| Capture live logs | Trust mock tests as proof of live behavior |
