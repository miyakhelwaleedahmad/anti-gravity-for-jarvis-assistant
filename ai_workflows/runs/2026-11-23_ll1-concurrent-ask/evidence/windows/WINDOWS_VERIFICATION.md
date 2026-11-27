# LL-1A — Windows and live-model verification record

> Opened 2026-11-24. Corrected 2026-11-24 with the owner's authorization: the first version said five tests had passed on Windows without saying that they ran on the code before LL-1A. Earlier evidence in this folder is not changed.
> Statuses are kept separate: implementation COMPLETE · Linux PASSED · Windows PENDING · live-model PENDING · Defender check and full scan PENDING / DEFERRED.

## Preconditions found (repository side, read-only)

| Item | Finding |
|---|---|
| Code on the owner's PC | **Not there yet.** The PC is at `040cd5e` (checked 2026-11-24, below). LL-1A (`core/tools/memoryTool.ts` SHA-256 `bbb16d50…7f5f`, Git blob `f7bae9be…`; `tests/saveRelationConcurrentAskTest.ts` SHA-256 `b155af97…714c`, blob `3d9789d5…`) is uncommitted in the cloud checkout. Delivery needs the owner's authorization for a commit and push (proposed: LL-1A files only, the tree verified at R12; LL-2 excluded). |
| Tests for Windows | **All eight** saveRelation tests must run on the LL-1A code: AskOnce, ConcurrentAsk, ConfirmReview, Confirm, LowFixes, Provenance, Replies, TimeBudget. Earlier Windows passes ran on the code before LL-1A, which changes `memoryTool.ts`, so they do not count (see Results). |
| PowerShell (R8) | Static trace only, not run-time proof: every PowerShell start in JARVIS is inside a function (`perception/windowsProbe.ts:57` runs the project's `.ps1` files; `perception/windowsState.ts`, `core/selfCheck.ts:158`). The tests that drive the orchestrator (AskOnce, Replies) replace `worldState.refresh`, the path to `windowsState`. A process list taken after a test cannot show a PowerShell process that started and ended during it. Commands for the owner use CMD only. |
| Memory data | The test runner points every test at its own temporary folder (`%USERPROFILE%\.jarvis-test-tmp` on this PC), so the tests do not touch the owner's memory files. AskOnce connects to Redis when it is running; its messages go under a random session id of the temporary store and expire within 2 hours. A live JARVIS run uses the real memory; it should wait for a fresh memory backup. |
| Hashes across machines | The PC's `memoryTool.ts` has the same SHA-256 as the cloud copy of the same version (`1c79a0ab…`), so certutil SHA-256 values can be compared with the cloud values directly. |

## Procedure (owner's PC, CMD only; one step at a time)

| Step | What | Status |
|---|---|---|
| M1 | Read-only state check: branch, HEAD, tracked changes, untracked count, PowerShell processes running | Baseline done 2026-11-24 (passed); repeat after delivery |
| M2 | After an authorized push: `git fetch` and `git merge --ff-only` to the LL-1A commit; re-check | PENDING (needs commit/push authorization) |
| M3 | Blob ids and SHA-256 of the LL-1A files and the 7 existing tests, before the run | PENDING on LL-1A code |
| M4 | `pnpm run typecheck`, exit code | PENDING on LL-1A code |
| M5 | The 8 saveRelation tests, one at a time, stop at the first failure, exit codes | PENDING on LL-1A code |
| M6 | Hashes after; tracked changes; PowerShell process count; Defender protection history: no new detection | PENDING on LL-1A code |
| Defender | Protection history inspection; full scan result | PENDING / DEFERRED (owner started a full scan 2026-11-24; not reviewed) |

Live-model checks are defined after M1–M6 pass on the LL-1A code. They need a fresh memory backup, the provider keys on the PC and a running JARVIS. Two calls for the same fact at the same moment cannot be forced with live models, so the live check covers the real save_relation path (asked once, stored once). The scope is the owner's decision.

## Results

### Windows baseline, 2026-11-24 (code before LL-1A; not an LL-1A result)

Run by the owner on `W:\anti gravity for jarvis assistant`, Windows 10.0.19045.7846, CMD. The LL-1A commit had not been pushed, so every step ran on `040cd5e`.

| Step | Owner's result |
|---|---|
| M1 (run twice, identical) | branch `claude/jarvis-repair`; HEAD `040cd5e2920ab52ca11b336044ffe893b12ad607`; no tracked changes; 20 untracked items; no PowerShell process running; JARVIS not running |
| M2a | fetch completed; no incoming commits (nothing had been pushed) |
| M2b (run three times) | `Already up to date`; HEAD `040cd5e…`; no tracked changes |
| M3 | `memoryTool.ts` blob `06c71be7…` and SHA-256 `1c79a0ab…`: the version before LL-1A, equal to the cloud record. `tests\saveRelationConcurrentAskTest.ts`: not present ("could not open … No such file"). No PowerShell process running. |
| M4 | `pnpm run typecheck`: exit 0 (code before LL-1A) |
| M5 | `saveRelationAskOnceTest`: PASS, 43492 ms (code before LL-1A; its first Windows run). `saveRelationConcurrentAskTest`: "No test file named…", exit 1; M5 stopped there as designed. The other six were not run in this pass. |
| M6 | `memoryTool.ts` SHA-256 unchanged (`1c79a0ab…`); no tracked changes; 20 untracked items; no PowerShell process running |

### Historical Windows results (owner's report, 2026-11-17, B2; code before LL-1A)

`saveRelationLowFixesTest`, `saveRelationConfirmTest`, `saveRelationConfirmReviewTest`, `saveRelationProvenanceTest`, `saveRelationTimeBudgetTest` passed in the 13-test B2 run at `040cd5e`. Recorded in the conversation, not in repository evidence.

### LL-1A Windows result

None yet. **None of the results above counts as an LL-1A Windows pass**: they ran on the code before LL-1A. Defender verification and the full scan are PENDING / DEFERRED; no claim is made about them.
