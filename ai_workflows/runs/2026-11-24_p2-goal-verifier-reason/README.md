# MM-1A-P2 — a goal check that could not run says why

> Owner authorization 2026-11-24 (next independent engineering problem; unprotected files only).
> Status: **implemented and Linux-verified.** Branch `claude/jarvis-repair` at `040cd5e`; nothing committed or pushed; Git used read-only (`--no-optional-locks`). Tracker not updated (`docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md` still lists MM-1A-P2 as READY_FOR_APPROVAL).

## Why this problem

Selected from the open items: the remediation and audit trackers have no open code bug (their open items need the owner's PC). LL-3 and LL-4 are in `core/tools/memoryTool.ts`, the LL-1A file waiting for transfer, so they are not eligible until LL-1A is committed. LL-1B, L-A, answer grace and MM-1A-P5 need protected files. MM-1A-P2 is documented (`ai_workflows/runs/2026-11-15_phase1a-model-gateway/change_log.md:106`, tracker row MM-1A-P2), independent of LL-1A, LL-2, R7, R8 and Defender, and in an unprotected file.

## Finding and root cause

A goal's `judge` criterion is checked by the review model (`modelJudge`). When the model fails (a refused strict route, an unconfirmed identity, a rate limit, a network error) or answers out of form, `modelJudge` caught the error and returned `undefined`, and `verifyCriteria` recorded `the check could not run (model unavailable); waiting for your review` for every cause. The goal correctly waited for review, but the owner could not see why.

## Change (`core/goalVerifier.ts` only; +20 −6; 161 → 176 lines; `evidence/goalVerifier.diff`)

- `JudgeInput` gets an optional `onFailure(reason)`.
- `modelJudge` still returns `undefined` on failure (contract kept: `tests/modelRouteCorrectionsTest.ts:257-258` asserts it) and passes the reason to `onFailure`: the error message, or "the review model's answer was not in the expected form".
- `verifyCriteria` gives the judge an `onFailure`, also catches a judge that throws, and writes `the check could not run (<reason>); waiting for your review`. The reason is redacted with `security/redactor.ts` (imported, not changed), made one line and cut to 240 characters. With no reason the old wording is kept.
- Unchanged: a failed check is still not met and still waits for review; verdicts that are reached are unchanged.

## Commands, exit codes, results (SHA-256 captured immediately before and after each command)

| Step | Command | Exit | Result | Hashes before = after | Evidence |
|---|---|---|---|---|---|
| Baseline typecheck | `pnpm run typecheck` | 0 | — | yes | `evidence/baseline/typecheck.txt`, `hashes.txt` |
| Baseline judge suites | `pnpm exec tsx tests/runAll.ts --ci --only=modelRouteCorrectionsTest,verificationInconclusiveTest,goalRuntimeTest` | 0 | 3 passed | yes | `evidence/baseline/targeted.txt` |
| Fail-before | `pnpm exec tsx tests/goalVerifierReasonTest.ts` (`goalVerifier.ts` `6d644f4a…`) | 1 | 7 passed, 6 failed (every "reason" check) | yes | `evidence/fail-before/` |
| Typecheck after | `pnpm run typecheck` | 0 | — | yes | `evidence/after/typecheck.txt` |
| Pass-after | `pnpm exec tsx tests/goalVerifierReasonTest.ts` (`goalVerifier.ts` `4ba3e0e2…`) | 0 | 13 passed, 0 failed | yes | `evidence/after/test.txt` |
| Judge suites after | `pnpm exec tsx tests/runAll.ts --ci --only=goalVerifierReasonTest,modelRouteCorrectionsTest,verificationInconclusiveTest,goalRuntimeTest,goalLifecycleTest` | 0 | 5 passed | yes | `evidence/after/targeted.txt` |
| Full CI | `pnpm run test:ci` | 1 (by design: a blocked test is never a pass) | 264 files: 254 passed, 0 failed, 1 blocked (`realTtsHandoffTest`, no pygame; same as before), 9 skipped. Against the LL-2 run (263 files): only change is the new test, PASS | yes | `evidence/after/ci.txt`, `evidence/after/hashes.txt` |

The baseline full CI is the LL-2 run: the tree outside the run folders was identical to it (`evidence/baseline/tree-manifest-before.txt`). `evidence/baseline/hashes.aborted-attempt.txt` is a first baseline attempt in which neither command ran (the hash helper stopped the command chain); it is kept, not used.

## Integrity

Tree manifest before → after (excluding `node_modules`, `.git` and the run folders): only `core/goalVerifier.ts` (`6d644f4a…` → `4ba3e0e2…`) and the new `tests/goalVerifierReasonTest.ts` (`a9424e80…`). LL-1A (`memoryTool.ts`, its test), LL-2 (`goalExecutor.ts`, `.env.example`, its test), `security/redactor.ts`, `bridge/modelRouter.ts`, `core/goalRuntime.ts`, `core/goalService.ts`, the existing tests and `RUNTIME_PROTECTED_FILES.md` are unchanged in every hash capture.

## Limits

- The reason is what the provider or router says; its wording is not controlled here. Secrets are redacted with the shared redactor; anything it does not recognise as a secret is shown (cut to 240 characters).
- Linux, stand-in model. How a real provider's error reads in the goal record is not checked live; no Windows-specific behaviour is involved (pure string handling).
- Not committed; the tracker row stays READY_FOR_APPROVAL until the owner decides.
