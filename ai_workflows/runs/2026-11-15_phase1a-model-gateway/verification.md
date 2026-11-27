# Verification — Phase 1A

> Stage: 05_verification · Machine: Linux cloud container (Node 22.23.4, pnpm 10.33.0) · base `c4ac909`, changes uncommitted
> A Linux pass is not a pass on the owner's PC.

## Fail-before (unchanged production code; `git diff --quiet -- bridge core` checked first)

Command: `pnpm test -- --only=modelRoleRoutingTest,providerIsolationTest,providerCapabilitiesTest,usageLedgerTest`

| Test | Result on the old code | Evidence |
|---|---|---|
| modelRoleRoutingTest | FAIL: 13 passed, 19 failed (routes ignored by `chat`/`streamChat`, agents on the default, no `agentIndependence`, orchestrator planning on `qwen-2.5-32b`, background named call not held) | `evidence/fail-before.txt` |
| providerCapabilitiesTest | FAIL: 2 passed, 15 failed (no `capabilities()`; image sent to Claude as text only) | `evidence/fail-before.txt` |
| providerIsolationTest | FAIL: 9 passed, 10 failed (A's breaker stopped B and the default; shared cache; no router breaker or limit) | `evidence/fail-before-providerIsolation-rerun.txt` (first run in `fail-before.txt` stopped at an unwrapped call in the test; see `change_log.md`) |
| usageLedgerTest | FAIL: 7 passed, 9 failed (no file; nothing after a restart) | `evidence/fail-before.txt` |
| `pnpm run typecheck` | 1 error: `tests/usageLedgerTest.ts` imports `bridge/usageLedger.ts`, which did not exist | `evidence/fail-before-typecheck.txt` |

## Pass-after (same tests, same command)

| Test | Result | Evidence |
|---|---|---|
| modelRoleRoutingTest | PASS | `evidence/pass-after.txt` |
| providerCapabilitiesTest | PASS | same |
| providerIsolationTest | PASS | same |
| usageLedgerTest | PASS | same |

## Existing tests

| Command | Before | After |
|---|---|---|
| `pnpm run typecheck` | clean | clean (`evidence/typecheck-after.txt`) |
| `pnpm test -- --ci` | 231 files: 221 passed · 0 failed · 1 blocked · 9 skipped (`evidence/baseline-ci.txt`) | 235 files: 225 passed · 0 failed · 1 blocked · 9 skipped (`evidence/after-ci.txt`) |
| Voice-core group (`TEST_MATRIX.md`) | in the baseline | 6/6 passed (`evidence/voice-core-after.txt`) |

Every pre-existing test has the same verdict before and after. The only differences are the four new tests (now PASS).
- Blocked both times: `realTtsHandoffTest` (no Python with pygame here).
- Skipped both times: Windows, PowerShell 7, Redis, `.venv`, bridge-token and live-provider tests.

`pnpm-lock.yaml` and `package.json`: SHA-256 unchanged after the install and after the work.

## Not verified

- **The owner's PC:** not run. See the live checks in `patch_plan.md`.
- **A live provider (Gemini, Groq, Claude, OpenAI):** no API call was made.
- **Independent review (05b):** not done.

---

# Corrections round: verification

> Linux cloud container. Evidence in `evidence/corrections/`. A Linux pass is not a pass on the owner's PC.

## Fail-before (the reviewed Phase 1A code; production file hashes checked before and after the run)

| Test | Result | Evidence |
|---|---|---|
| modelRouteCorrectionsTest (new) | FAIL: 21 passed, 23 failed. Failing checks: wait used up the time limit (default answered); no queue-wait limit; bare-model review, coding and categoryChat answered by another provider; failing qa_agent/coding_agent routes answered by the default model; goalVerifier reported "met" from the fallback provider; each provider asked twice; alias asked twice; routed stream asked the same provider three times; independence true for identical targets; no observed check | `fail-before.txt`, `fail-before-rerun.txt` |
| providerIsolationTest (§6 added) | FAIL: 23 passed, 3 failed (five trial calls at once; no single-trial lease) | `fail-before.txt` |
| usageLedgerTest (§8–9 added) | FAIL: 21 passed, 1 failed (restart after a rotation saw 6 records). §9, the failed rotation, passed: it was already safe | `fail-before.txt` |
| modelRoleRoutingTest (abort during a pending call added) | PASS: the old code already handled the case; this closes a test gap and is not a regression proof | `fail-before.txt` |

## Pass-after and full checks

| Command | Result | Evidence |
|---|---|---|
| the 5 programme tests | 5/5 PASS | `pass-after.txt` |
| `pnpm run typecheck` | exit 0 | `typecheck-after.txt` |
| voice-core group | 6/6 PASS | `voice-core-after.txt` |
| `pnpm test -- --ci` | 236 files: 226 passed · 0 failed · 1 blocked · 9 skipped | `after-ci.txt` |
| per-test verdicts vs the original baseline (`../baseline-ci.txt`) | identical for all 231 pre-existing tests; the only difference is the 5 programme tests (PASS) | — |
| `git diff --check` | clean | — |
| `git diff --quiet HEAD -- pnpm-lock.yaml package.json` | unchanged | — |
| `git diff --name-only HEAD -- tests` | empty: no tracked (pre-existing) test file modified | — |
| L3 timing (scratch script, not a test) | first read of a full 2 MB ledger 6.54 ms (file in the OS cache), repeat 2.90 ms, append 0.011 ms | `ledger-timing-linux.txt` |

## Not verified

- **On the owner's PC:** nothing; that includes a cold ledger read on the hard disk.
- **Against a live provider:** nothing.
- **Agent tasks after a strict QA failure:** they still end `COMPLETED`, through the keyword-rule fallback (proposal MM-1A-P1, not done).
- **In-adapter model swaps:** not prevented (MM-1A-P3).
- **Independent review of this round:** see `INDEPENDENT_REVIEW_CORRECTIONS.md`.

---

# Round 3: verification

> Linux cloud container. Evidence in `evidence/round3/`. A Linux pass is not a pass on the owner's PC.

## Fail-before (unchanged code; production file hashes the same before and after the run)

| Test | Result on the old code | Evidence |
|---|---|---|
| qaModelFailureTest (new) | FAIL: 8 passed, 18 failed. QA and coding tasks ended COMPLETED through keyword rules after their model failed; reasons cut short; no `answeredBy` | `fail-before.txt` |
| modelRouteRound3Test (new) | FAIL: 20 passed, 23 failed. Fallback after a failed named route sent at once during the conversation; no same-provider retry with the default model; unrelated failures ended the trial lease; independence true for the same model under other names or case | `fail-before.txt` |

The stream variant of the M-3 check passed on the old code too: it is a structural check, not a regression proof.

## Pass-after and full checks

| Command | Result | Evidence |
|---|---|---|
| the 7 programme tests (2 new, 5 from earlier rounds, none edited this round) | 7/7 PASS | `pass-after.txt` |
| `pnpm run typecheck` | exit 0 | `typecheck-after.txt` |
| voice-core group | 6/6 PASS | `voice-core-after.txt` |
| `pnpm test -- --ci` | 238 files: 228 passed · 0 failed · 1 blocked · 9 skipped | `after-ci.txt` |
| per-test verdicts vs the original baseline (`../baseline-ci.txt`) | identical for all 231 pre-existing tests; the only differences are the 7 programme tests (PASS) | — |
| `git diff --check` | clean | — |
| `git diff --quiet HEAD -- pnpm-lock.yaml package.json` | unchanged | — |
| `git diff --name-only HEAD -- tests` | empty | — |

Blocked as in the baseline: `realTtsHandoffTest` (no Python with pygame here). Skipped as in the baseline: Windows, PowerShell 7, Redis, `.venv`, bridge-token and live-provider tests.

## Not verified

- **On the owner's PC:** nothing from this round.
- **Against a live provider:** nothing. Which errors real Gemini, Groq, Claude and OpenAI-compatible servers return (and so which ones allow a same-provider retry) is taken from `classifyLLMError`, not observed.
- **Independence:** still not used by the runtime (MM-1A-P4). Nothing checks or enforces that QA ran on another model.
- **Automatic Verification agent:** still counts a source re-read that could not run as passed (`verify.ts:147`, MM-1A-P7).
- **In-adapter model swaps on strict routes:** still possible (MM-1A-P3).
- **QA workers (`test_runner_worker`) on non-strict routes:** a worker can still fall back to the default model; QA rejects only parts answered by keyword rules or not finished by a model (review L-3).
- **Waiting:** a background fallback can wait once per attempt, each up to `JARVIS_BACKGROUND_YIELD_MS` (at most 120 s), so a call with several fallback providers can wait several times. Bounded, but not one overall limit.
- **Independent review of round 3:** see `INDEPENDENT_REVIEW_ROUND3.md`.

## Round 3: after the review fixes

Evidence in `evidence/round3-review-fixes/`.

| Command | Result | Evidence |
|---|---|---|
| reviewRound3FixesTest (new), on the unfixed code | FAIL: 4 passed, 13 failed (M1, L1, M3, L4, L5, L6 checks); the 4 passing checks are the "unchanged" ones. Production hashes unchanged by the run | `fail-before.txt`, `production-hashes-before.txt` |
| 20 targeted tests (8 programme tests, router, provider, agent, code-repair, Claude, cancellation, docs) | 20/20 PASS | `pass-after.txt` |
| `pnpm run typecheck` | exit 0 | `typecheck-after.txt` |
| voice-core group | 6/6 PASS | `voice-core-after.txt` |
| `pnpm test -- --ci` | 239 files: 229 passed · 0 failed · 1 blocked · 9 skipped | `after-ci.txt` |
| per-test verdicts vs the original baseline | identical for all 231 pre-existing tests; the only differences are the 8 programme tests (PASS) | — |
| `git diff --check`; lockfile and `package.json`; `git diff --name-only HEAD -- tests` | clean; unchanged; empty | — |

Still not verified, in addition to the list above:
- **M2 (MM-1A-P8):** a configured coding agent's split request goes to workers on the planning route and never asks the configured coding model. Not fixed; owner decision.
- **L7:** QA's own parts in a split request that stop at the step limit are accepted; only worker parts must be answered by the model.
- **The empty-answer rule applies to QA and to an agent with its own strict setting (a configured coding_agent)** (follow-up review N1, fixed after that review; `evidence/round3-review-fixes/n1-fail-before.txt` 17 passed / 3 failed). Other agents still fall back to keyword rules on an empty model answer, and the result is marked `answeredBy: keyword_rules`.
- **The N1 fix was made after the follow-up review** (`INDEPENDENT_REVIEW_ROUND3_FIXES.md`) and has not been independently reviewed. It reuses the strict-route check of the L1 fix.
