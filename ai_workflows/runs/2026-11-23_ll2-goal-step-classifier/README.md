# LL-2 — which Memory-agent goal steps "ask to keep a fact"

> Owner approval 2026-11-24 (R13 scope; decisions D-1 to D-4; `.env.example:163-169` docs correction).
> Status: **implemented and Linux-verified.** Not complete: the phrasings the real goal planner writes with live models are not verified (live-provider verification pending).
> Branch `claude/jarvis-repair` at `040cd5e`. Nothing committed or pushed; Git used read-only (`--no-optional-locks` branch, rev-parse, status). Tracker not updated.

## Finding

`INDEPENDENT_REVIEW_FINAL_LOWS.md` LL-2. Inside a goal nothing is stored, so a Memory-agent step that asks to keep a fact ends `MEMORY_NOT_STORED` and waits for the owner's review (`goalRecovery.ts:205-209`). `isRememberStep()` decides it from the step's English phrasing. Before this change it was wrong for 31 phrasings of the review: 4 regressions ("Remember who …: Sara"), 13 keep steps missed, 14 steps held although they keep nothing. Logic only: the `MEMORY_NOT_STORED` message, codes, recovery and the `save_relation`-refused check are unchanged.

## Change

| File | Lines (new file) | What |
|---|---|---|
| `core/goalExecutor.ts` | hunk 228–260 (+24 −8; 257 → 273 lines) | `STEP_START` (optional "First,/Then/Next,/Finally,/Also/And", "please"); `RECALL_STEP` unless a colon gives a value (`GIVES_VALUE`, D-3); `KEEP_STEP`: "remember"/"don't/do not forget" not followed by "to", no "keep in mind", adds make sure to remember, log that, write down, learn that, persist, keep track of; "add/record/store/save" only with that, the user's/owner's, my/our/this/these/it/fact(s), or "the/a … : value"; `IN_MEMORY_STEP` and `PROFILE_STEP` only at the start (profile: update/set/change (the) (user's/owner's/my) profile/preference(s)/memory). "Note that …" stays a keep step (D-1). Comments only for these. |
| `.env.example` | 163–169 (7 lines replaced by 7; line 170 unchanged; 565 lines) | the documented limit, rewritten to match |
| `tests/goalStepClassifierTest.ts` | new | 49 checks, groups A–F |

Diffs: `evidence/goalExecutor.diff`, `evidence/env-example.diff`.

## Commands and results

| Step | Command | Exit | Result | Evidence |
|---|---|---|---|---|
| Branch / tree (read-only) | `git --no-optional-locks branch --show-current; rev-parse HEAD; status --porcelain` | 0 | `claude/jarvis-repair`, `040cd5e`; only LL-1A changes uncommitted | `evidence/baseline/git-state.txt` |
| Fail-before | `pnpm exec tsx tests/goalStepClassifierTest.ts` (unchanged `goalExecutor.ts` `305db5b5…`) | 1 | 19 passed, 30 failed: B 0/4, C 0/12, D 0/13, F 4/5 (archived regression); A 11/11, E 4/4 | `evidence/fail-before/` |
| Typecheck | `pnpm run typecheck` | 0 | — | `evidence/after/typecheck.txt` |
| Pass-after | `pnpm exec tsx tests/goalStepClassifierTest.ts` | 0 | 49 passed, 0 failed: A 11, B 4, C 12, D 13, E 4, F 5 | `evidence/after/test.txt` |
| Targeted suites | `pnpm exec tsx tests/runAll.ts --ci --only=goalStepClassifierTest,saveRelationLowFixesTest,saveRelationConfirmReviewTest,goalAgentIntegrationTest,mixedFailureCausesTest,errorClassificationTest,lowReviewFixesTest,saveRelationConfirmTest,saveRelationProvenanceTest,docsHygieneTest` | 0 | 10 passed, 0 failed | `evidence/after/targeted.txt` |
| Full CI | `pnpm run test:ci` | 1 (by design: a blocked test is never a pass) | 263 files: 253 passed, 0 failed, 1 blocked (`realTtsHandoffTest`, no pygame), 9 skipped. Against the R12 run (262 files): only change is the new test, PASS | `evidence/after/ci.txt` |

Groups: A the 11 phrasings of the existing tests (unchanged outcome); B the 4 regressions; C 12 other keep steps; D 13 steps that keep nothing; E documented limits ("Note that …" held, D-1; a request in the middle and Spanish not read, D-2, D-4); F controls (a browser-agent step is not held for its wording; a refused `save_relation` still holds a step whatever its wording; archived `inspectPrevious`: a keep step is not taken back, a recall step and another specialist's step are).

## Integrity

Tree manifest before → after (excluding `node_modules`, `.git`, this folder): only `.env.example` (`12463225…` → `a7ded1a0…`), `core/goalExecutor.ts` (`305db5b5…` → `69f94d34…`) and the new test (`65a3d8d8…`). Unchanged: `core/goalRecovery.ts`, `core/tools/memoryTool.ts` (LL-1A), `core/toolRegistryV2.ts`, `core/toolExecutionSandbox.ts`, `security/approvalGate.ts`, `RUNTIME_PROTECTED_FILES.md`, and the existing tests listed in `evidence/baseline/hashes-before.txt`.

## Limits

- An English heuristic read from the step's start: requests in the middle of a step and other languages are not recognised (D-2, D-4); "Note that …" can be held although it stores nothing (D-1).
- Which phrasings the real goal planner writes is untested (live models, PENDING). The classifier itself is platform-independent string logic.
- Fail-before ran against the unchanged file; no separate baseline full CI was run for LL-2: the R12 full CI is the baseline (the tree then differed only by this new test, per the manifests).
