# LL-1A — the same fact asked at the same moment (save_relation)

> Owner approval: R10, 2026-11-23. Scope: `core/tools/memoryTool.ts` and the new `tests/saveRelationConcurrentAskTest.ts`.
> Status: **implemented and Linux-verified.** Not complete: the Windows check is not authorized yet (R8 restrictions in force).
> Branch `claude/jarvis-repair` at `040cd5e`. Nothing committed or pushed; no Git command was run. Tracker not updated (owner instruction).

## Finding

`INDEPENDENT_REVIEW_FINAL_LOWS.md` LL-1, scenario A: two `save_relation` calls for the same fact that start together in one request or one agent root task (two parallel graph nodes, two workers) both asked the owner. On "yes" the fact was stored twice; on "no" the owner had to say no twice.

**Root cause.** `memoryTool.ts` read the answer record (`keptAnswer`), then awaited the question (`ownerConfirms`), and wrote the answer (`keepAnswer`) only after the question returned. A second call that started while the first question was open found no answer and asked again.

Scenario B (the planner and a delegated agent in one request) is out of scope: the fix needs protected `core/agents` files. It stays a documented limit.

## Change (`core/tools/memoryTool.ts`, 68 lines added, 21 removed; `evidence/memoryTool.diff`)

- `inFlight`: one entry per key (root task or request, plus the exact fact) while a call handles it. `answered` settles when that call's question is over; `done` when the call has finished, its store included. Both always settle (`finally`); the entry is removed by the call that set it.
- A call that finds an entry waits, then reads the kept answer as before: "Already kept" after a stored "yes", `APPROVAL_DENIED` after "no", a store retry without asking after a failed store, or its own question when the first call was stopped before an answer counted.
- The wait for the other call's question runs inside `whileOwnerAnswers` (exported by `core/toolExecutionSandbox.ts`, protected, not changed), so the waiting call's budget is paused as the asking call's is. The wait for the other call's store is not paused. A waiting call whose own request is stopped returns the existing "stopped" message and stores nothing.
- The "stopped" text moved into a constant (`STOPPED`), word for word. No other wording, the key, the one-hour and 500-entry limits, and the no-request path (no key: nothing asked, nothing kept) are unchanged.

## Budget trace (before coding)

A low-risk tool that asks the owner runs in a sandbox call with a pausable budget (30 s; `JARVIS_TOOL_BUDGET_LOW_MS`). The approval gate pauses it while it asks (`approvalGate.ts:216`, `whileOwnerAnswers`). A call that only waited for another call's question would not be paused, so it could be stopped by its own budget while the owner answers. Case 7 of the new test checks it with a 1.5 s budget and a 2.5 s answer through the real approval gate.

## Evidence

| Stage | Result | File |
|---|---|---|
| Baseline typecheck | exit 0 | `evidence/baseline/typecheck.txt` |
| Baseline, 7 saveRelation tests | 7 passed | `evidence/baseline/saveRelation-7.txt` |
| Baseline full CI | 261 files: 251 passed, 0 failed, 1 blocked (`realTtsHandoffTest`, no pygame), 9 skipped | `evidence/baseline/ci.txt` |
| New test on unchanged code | 10 passed, 10 failed: every "asked once / stored once" check fails; the behaviour-preserving checks pass | `evidence/fail-before/concurrent-test.txt` (the draft run with a wrong case-4 marker, `agentIds` instead of `rootTaskId`, is kept as `concurrent-test.first-draft.txt`) |
| Typecheck after | exit 0 | `evidence/after/typecheck.txt` |
| New test after | 20 passed, 0 failed | `evidence/after/concurrent-test.txt` |
| 7 existing + new saveRelation tests after | 8 passed | `evidence/after/saveRelation-8.txt` |
| Full CI after | 262 files: 252 passed, 0 failed, 1 blocked (same), 9 skipped; the only changed verdict is the new test (PASS) | `evidence/after/ci.txt` |
| Hashes | before / after | `evidence/baseline/hashes-before.txt`, `evidence/after/hashes-after.txt` |

`memoryTool.ts`: `1c79a0ab…b67a` → `bbb16d50…7f5f`. New test: `c32e792b…30b9`.
A whole-tree SHA-256 manifest (excluding `node_modules`, `.git` and this folder) before and after differs only in these two files. Protected `core/toolRegistryV2.ts`, `core/toolExecutionSandbox.ts`, `security/approvalGate.ts`, the seven existing saveRelation tests and `RUNTIME_PROTECTED_FILES.md` are unchanged.

## Limits

- Linux, stand-in owner and store. Not run on the owner's Windows PC, by voice or with live models (PENDING; needs separate authorization, after a fresh memory backup).
- Case 7 shows a waiting call is not stopped by its budget with the fix. A run without the pause, to show it would be stopped, was not made.
- Same-process only: the record is in memory, as the answer record already is.
- LL-1 scenario B is not changed.

---

## R12 — test coverage and evidence (owner approval R12, 2026-11-23)

Scope: `tests/saveRelationConcurrentAskTest.ts` and this folder only. `core/tools/memoryTool.ts` not changed (`bbb16d50…7f5f`). Earlier evidence kept; R12 evidence is in `evidence/r12/`.

| Item | What changed in the test |
|---|---|
| T-1 | Cases 1, 2 and 6 hold the owner's answer until every call is inside `save_relation` (the registered tool object records entry) and exactly one question is open; then check, after 100 ms more, that no call has returned and nothing more was asked; then answer and check every call returned after the answer. A helper answers any further question, so a regression fails instead of hanging. |
| T-2 | Case 8: three calls at once. Case 9: only the waiting call stopped while the question is open. Case 10: the question throws; the registry does not retry (`save_relation` risk 1, not safe to repeat: `toolRegistryV2.ts:945`), the waiting call then asks the owner itself (nothing was answered, as before), and a later call returns "already kept" within 3 s (no leftover entry). |
| T-3 | Case 7 checks the owner took 2.4–4 s, both calls were inside while the question was open, and the waiting call returned ≥ 2.4 s after the start (past its 1.5 s budget) without being stopped. Control: the same budget stops a single call whose store runs 4 s ("ran past its 2 s budget", returned in about 2.5 s). |

| Run | Result | File |
|---|---|---|
| Strengthened test on the fixed code | 43 passed, 0 failed (10 cases) | `evidence/r12/after/concurrent-test.txt` (an earlier run of the same test without the non-hanging helper, also 43/43: `concurrent-test.draft-without-settle.txt`) |
| Strengthened test on the pre-fix `memoryTool.ts` (`1c79a0ab…`), in a scratch copy of the repository outside it | 12 passed, 31 failed; completed (no hang). The 12 are the behaviour-preserving checks | `evidence/r12/fail-before/` |
| Typecheck | exit 0 | `evidence/r12/after/typecheck.txt` |
| 7 existing + this test | 8 passed | `evidence/r12/after/saveRelation-8.txt` |
| Full CI | 262 files: 252 passed, 0 failed, 1 blocked (`realTtsHandoffTest`, no pygame), 9 skipped; no verdict changed against the R10 run | `evidence/r12/after/ci.txt` |
| Test diff R10 → R12 | 216 lines added, 44 removed | `evidence/r12/test-r10-to-r12.diff` |
| E-1 | baseline `memoryTool.ts` hash `1c79a0ab…b67a` | `evidence/r12/E1-baseline-memoryTool-hash.txt` |
| E-2 | tree manifests: before implementation, after implementation (R10), after tests (R12). R10-after → R12-after: only the test changed. Before → R12-after: only `memoryTool.ts` and the new test | `evidence/r12/manifests/` |
| Hashes | test `c32e792b…` → `b155af97…714c`; production, protected and existing-test hashes identical | `evidence/r12/before/hashes-r12-before.txt`, `evidence/r12/after/hashes-r12-after.txt` |

Status unchanged: implemented and Linux-verified; not complete until the Windows check is authorized and done.
