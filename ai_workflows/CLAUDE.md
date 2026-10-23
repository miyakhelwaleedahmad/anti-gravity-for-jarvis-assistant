# CLAUDE.md — Behavioral Contract for JARVIS AI Development Workflow

> This file governs how Claude (or any AI agent) must behave inside this workflow space.
> Read this file first before taking any action on this project.
> Then use `CONTEXT.md` to decide what else to load.

---

## Identity

You are working inside the **JARVIS AI Development Workflow Space**.
This is NOT a place for free-form code editing.
Every maintenance task follows the stage order below; each stage's
`stages/<stage>/CONTEXT.md` is its contract (Inputs, Process, Outputs, Audit).

---

## Stage Order

```
(optional) read-only repository audit — no edits; may start a run
01_intake            facts, runtime issue record if any
   ↓
02_diagnosis         root cause, no edits
   ↓
02b_reproduction     failing test or honest exception, no runtime edits
   ↓
03_patch_plan        exact change, tests, risks
   ↓
══ GATE 1: HUMAN APPROVAL REQUIRED ("approved" / "proceed") ══
   ↓
04_implementation    approved changes only
   ↓
05_verification      runner tests, live checks with the owner
   ↓
05b_review           independent review: PASS / CHANGES REQUIRED / BLOCKED
   ↓
06_final_report      honest verdict, commit by name
   ↓
07_closure           run record, tracker row, follow-ups
   ↓
══ GATE 2: HUMAN APPROVAL to push, merge, tag, or accept a limitation ══
```

- Each run lives in `runs/<YYYY-MM-DD>_<slug>/` (see `runs/README.md`).
  Stage `output/` files are blank templates: copy them, never fill them in.
- You MUST NOT skip a stage, or go from diagnosis to implementation.
- You MUST NOT start `04_implementation` without Gate 1. Silence, a report,
  a test result or an automated agent never grants approval.
- A stage that cannot finish records BLOCKED with the reason; it is never
  reported as passed.
- The order is followed by hand; it does not depend on any script.

### Human Approval Points

Approval is required before:
1. Any edit to a protected runtime file
2. Advancing from `03_patch_plan` to `04_implementation` (Gate 1)
3. Merging a patch to the main branch, pushing, or tagging (Gate 2)
4. Marking a live voice bug as resolved

### Code-repair path (JARVIS's `propose_code_repair`)

`core/codeRepair.ts` may already have produced a repair proposal: an issue
diagnosed, a regression test that failed first, a patch on branch
`jarvis/repair/<id>` in a separate worktree, type check and tests, a model
review, and a report in `data/repairs/code/<repairId>.json`. It needed the
owner's typed console approval to start.

- Read that report and diff instead of repeating the pipeline; join at
  `05b_review` (then 06, 07).
- Record in the run folder which normal artifacts exist and which do not.
  Never write that a stage's evidence exists when the report lacks it.
- The model review in the report is not the independent review.
- JARVIS never merges the branch; merging is Gate 2.

---

## Code Editing Rules

- You MUST NOT modify runtime code during a diagnosis or documentation task.
- You MUST NOT delete files automatically — ever.
- You MUST NOT rename or move runtime files without a recorded patch plan and approval.
- You MUST NOT change protected runtime files (see `_config/RUNTIME_PROTECTED_FILES.md`) without:
  1. A written diagnosis
  2. A written patch plan
  3. Explicit human approval
  4. A post-implementation verification report
- Stage files by name (`git add -- <file>`); never `git add .` or `git add -A`.

---

## Stability Claims

- You MUST NOT claim a feature is stable unless:
  - TypeScript compiles with 0 errors (`pnpm run typecheck`)
  - All relevant tests pass (through the runner, `_config/TEST_MATRIX.md`)
  - **Live runtime logs** confirm the behavior
- You MUST treat the **YouTube open_app route as under investigation**
  (`_config/YOUTUBE_OPENAPP_INVESTIGATION.md`). Do not mark it fixed. Do not
  assume smoke test success equals live success.
- You MUST NOT say "the 46ms stable route is confirmed" unless you have current live logs from this exact runtime session.
- You MUST NOT close a voice bug as resolved without live voice verification.

---

## Routing Protection

- You MUST always protect deterministic command routing (`core/deterministicRoutes.ts`).
- You MUST NOT broaden the deterministic router aliases without:
  - Adding matching security boundary tests
  - Verifying `"launch cmd /c del *"` still does NOT match `cmd`

---

## Runtime Records

- Never edit `data/repairs/issues.json` or `occurrences.jsonl` by hand;
  JARVIS resolves issues itself (`_config/SOURCES_OF_TRUTH.md`).
- Never write lessons or error notes into the Obsidian vault by hand.

---

## What You Must NOT Connect To

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
Reading one issue record as a file (Stage 01) is allowed; starting JARVIS
or calling its code to get one is not.

---

## Quick Reference

| Do | Don't |
|---|---|
| Follow stage order | Skip stages |
| Read files for diagnosis | Edit files during diagnosis |
| Reproduce before planning, or record why not | Present a guess as a reproduction |
| Write patch plans first | Jump straight to code changes |
| Run tests after changes, through the runner | Claim stability without tests |
| Get an independent review | Approve your own change as independent |
| Produce reports and close the run | Delete files or evidence silently |
| Wait for human approval | Self-approve major changes |
| Capture live logs | Trust mock tests as proof of live behavior |
