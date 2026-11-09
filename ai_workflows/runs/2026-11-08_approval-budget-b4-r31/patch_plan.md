# Patch Plan — approval wait inside a tool's budget (B4 R3-1)

Tests first, run on the current code; then the change; focused tests, related tests, typecheck, full suite, mutation check, independent review. Commit and push only with the owner's approval.

| ID | Change | Files |
|---|---|---|
| P1 | A per-call budget scope (AsyncLocalStorage) around `tool.execute`; `whileOwnerAnswers()` pauses the budget while a question is open (counted, for nested questions) and resumes it with exactly the time that was left; nothing restarts after the call ended or was cancelled | `core/toolExecutionSandbox.ts` (protected) |
| P2 | `requestApproval` pauses the budget around its turn wait and the question; a call already cancelled is not asked; a call cancelled while waiting for its turn or while its question is open is denied: the question is withdrawn at once, the turn released, the pending request removed, the voice wait stopped; an approving answer that arrives as the call is cancelled is denied | `security/approvalGate.ts` (protected) |
| P3 | `'cancelled'` in the decision record | `security/approvalRequest.ts` (protected) |
| T | New test of every case in the Gate 1 plan | `tests/approvalBudgetR31Test.ts` |
| T2 (owner's approval after the first full suite) | The new test listed as replacing `speakToClients`, with its reason (repository rule, `tests/boundaryDoublesTest.ts`) | `tests/boundary-doubles.json` |

Not changed: `core/toolRegistryV2.ts`, the controllers, the risk engine, the permission session, the approval words, the approval deadlines.

## Gate 1 (owner, 2026-11-08)

Approved, with: a central fix for every tool that asks while it runs; a cancelled call's question withdrawn at once, as a denial; the approval deadlines kept (spoken 20 s after JARVIS finishes, typed 30 s, the speech wait limit); `cancelled` added to the record; the approval words unchanged. Two added safeguards:
1. Cancellation cleanup: the question withdrawn, the turn released, the pending request removed, the voice wait stopped, the budget not resumed; tested that no stale approval can act afterwards.
2. Remaining-budget accuracy: time used before the question is deducted; after the answer only the exact remaining time is available, never the full budget; tested with deterministic timing and a margin around the deadline. *Note after the independent review (F9):* the tests use real timers with margins of about ±150 ms, not fake (deterministic) timers.

## Review round 1 (owner, 2026-11-09)

The independent review returned CHANGES REQUIRED (`review.md`). Approved:
- fix F1 (typecheck), F2 (grace after a withdrawal), F3 (an ended call is not the current call) and F5 (monotonic budget clock), with tests;
- correct the records for F4, F6 and F9;
- F7 and F8 at the implementer's judgement: F7's "not yet spoken" case fixed, mid-speech recorded; F8's tests added.

A gap found by the F8 test (a question asked with no budget left was still shown) was reported before editing; the owner approved "Fix in pause()". Files: the same three protected and changed files, and the test. F4 is not fixed in R3-1.

## Review round 2 (owner, 2026-11-09)

The second independent review returned CHANGES REQUIRED (`review.md`, round 2). Approved:
- S1: parse `JARVIS_APPROVAL_GRACE_MS` defensively, so NaN can never reach a deadline;
- S2: measure the withdrawal grace with `performance.now()` and hold it to 0..grace;
- S6: the test removes its temporary folder;
- S5: wording corrections, `docs/GOAL_RUNTIME.md:303` included;
- S3 and S4 recorded as known limits.

Files: `security/approvalGate.ts` (protected), `tests/approvalBudgetR31Test.ts`, `tests/boundary-doubles.json`, `docs/GOAL_RUNTIME.md` and the run folder.

## Review round 3 (owner, 2026-11-09)

The third independent review returned CHANGES REQUIRED (`review.md`, round 3). Approved:
- T1: fix the F5 test, so that its questions appear after the withdrawal grace and must be approved;
- T2: cap `JARVIS_APPROVAL_GRACE_MS` at 60 000 ms (larger values give 1500);
- T3, T4: record corrections;
- T5: the test removes `JARVIS_APPROVAL_GRACE_MS` at its start;
- T6: an exit handler removes the test's workspace.

Files: `security/approvalGate.ts` (protected), `tests/approvalBudgetR31Test.ts`, `docs/GOAL_RUNTIME.md` (the same line as S5, updated for the 60 000 ms limit) and the run folder.
