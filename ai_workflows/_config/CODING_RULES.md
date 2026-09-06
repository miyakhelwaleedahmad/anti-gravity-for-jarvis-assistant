# CODING_RULES.md — Development Rules for JARVIS

> These rules apply to all AI agents and human developers modifying this project.

---

## Diff Size Rules

```
✅ Small targeted diffs only
✅ One concern per diff/commit
❌ No architecture rewrites in a single PR/patch
❌ No changes to multiple unrelated files in one operation
```

---

## Runtime Safety Rules

```
✅ Follow the stage pipeline: diagnosis → patch plan → approval → implementation
❌ No runtime behavior changes during documentation or diagnosis tasks
❌ No deleting files automatically — ever
❌ No changing stable command routing without updating and running tests
❌ No broad refactors without a written diagnosis + patch plan
❌ No adding new imports to runtime files during a documentation task
```

---

## Environment Rules

```
❌ Do not modify .env
❌ Do not commit secrets (API keys, tokens, passwords)
❌ Do not commit .venv/ (add to .gitignore if missing)
❌ Do not commit node_modules/ (should be in .gitignore)
❌ Do not commit temporary audio files (e.g. temp_stt_*.wav)
❌ Do not treat generated reports as source code
```

---

## Package / Script Rules

```
✅ Explain why before changing package.json scripts
✅ Check that test:voice-core still runs all required tests after any script change
❌ Do not add test scripts that skip actual test files
❌ Do not change "dev" script without verifying jarvis.ts still starts correctly
```

---

## TypeScript Rules

```
✅ Run npx tsc --noEmit before and after every change
✅ Fix all TypeScript errors before committing
❌ No use of 'any' to silence type errors in production code
❌ No casting away error types without documented reason
❌ Do not add @ts-ignore without explaining why in a comment
```

---

## Import Rules

```
✅ Use .js extension in imports (ESM project)
✅ Import from singleton exports (e.g. orchestrator, not JarvisOrchestrator)
❌ Do not import ai_workflows/ from runtime code — ever
❌ Do not import runtime singletons in test files unless the test explicitly needs them
❌ Do not create circular imports between core modules
```

---

## Test Rules

```
✅ Run all tests in TEST_MATRIX.md after any change to protected files
✅ Record honest pass/fail results in verification report
❌ Do not change test assertions to make tests pass
❌ Do not skip security boundary tests (deterministicCommandRouteTest Section 4)
❌ Do not claim a bug is fixed if only mock tests pass and live voice is not verified
```

---

## Git Rules

```
✅ Commit message must describe what changed and why
✅ Check git status before starting work
✅ Check git log --oneline -5 to know current history
❌ Do not force push without human approval
❌ Do not tag stable releases without live voice verification
❌ Do not commit partial/broken changes
```

---

## Naming Rules

```
✅ Keep existing file names — do not rename runtime files
✅ New tools go in skills/<name>/skill.ts with description.json
✅ New tests go in tests/ directory
❌ Do not create duplicate files alongside originals (e.g. orchestratorV2.ts)
❌ Do not use .bak extension for active code
```
