# Independent Review — B4 R3-1 (round 1)

- Reviewer: a fresh read-only subagent, 2026-11-09.
- Tree fingerprint: `{ git diff; cat tests/approvalBudgetR31Test.ts; } | sha256sum` → `b16fee1af311c9e3`, the same as the tree that was handed over.
- The reviewer changed nothing in the repository. Its probes ran on copies outside it (`/tmp/r31-review/repo`, `/tmp/r31-review/repo-m8`).

## Verdict: CHANGES REQUIRED

No path was found where a cancelled, expired or stale question approves its own action. One gate fails: typecheck (F1).

## What the reviewer ran

- `tests/approvalBudgetR31Test.ts`: 40 passed, 0 failed.
- `pnpm -s typecheck`: **TC=2**. Reproduced by the implementer on 2026-11-09:
  ```
  tests/approvalBudgetR31Test.ts(413,54): error TS2339: Property 'request' does not exist on type 'ApprovalRequest'.
  ```
- Probes P1–P9: concurrent scopes; listener count; a question asked after the call ended; a withdrawal followed by a yes; abort and then yes; the admin path; the registry-covered path; M8; background work.

## The 10 inspection points

| # | Point | Result | Evidence |
|---|---|---|---|
| 1 | Only the current call is paused | Yes. Caveat F3 | `toolExecutionSandbox.ts:200-202, 101-110`; `approvalGate.ts:199-201`; `actionQueue.ts:37`; `approvalScope.ts:56-58`; P1 |
| 2 | The exact remaining budget resumes | Yes. F5 (wall clock) | `toolExecutionSandbox.ts:129, 138-139`; test 901 ms where 0.9 s was left; M3 caught |
| 3 | Time used before the question is deducted, also across several questions | Yes | `toolExecutionSandbox.ts:128, 135, 138`; test 698 ms; M4 and M6 caught |
| 4 | Cancellation withdraws the question, releases the turn, removes the pending request and ends the voice wait | Yes. The TTY paths are untested (F8) | `approvalGate.ts:118-126, 207-208, 213, 369, 376-387, 411-417, 485, 505-506`; P2 (listener count stays at 1); M11 caught |
| 5 | A late approval cannot act on a cancelled call | Yes, in both orders | `approvalGate.ts:328`; M12 caught; P5 |
| 6 | Concurrent calls keep independent budgets | Yes | `toolExecutionSandbox.ts:183-202`; test §5 (1502 ms) |
| 7 | Registry and covered nested approvals are unchanged | Yes. Exception F3 | `toolRegistryV2.ts:813`; `approvalGate.ts:185-191`; test §6 |
| 8 | Timeout, stop grace, warning, audit, cap and security are intact | Yes | `toolExecutionSandbox.ts:124, 141-144, 175-179, 187, 191, 205-242` |
| 9 | Nothing is executed without a valid approval or after cancellation or expiry | No code path found. Human-side risk F2 | P4 |
| 10 | No unrelated or protected changes | Correct | `git diff --stat`: the 4 files, plus 2 untracked paths |

## Records checked against the evidence

These records match the evidence files:

- 40/40;
- 11 passed / 25 failed of 36 on the old code;
- mutation 13/14, tree restored;
- related tests: 42 passed, 1 skipped;
- full suites: 217/1/1/9, then 218/0/1/9.

These records do not hold:

- **TC=0.** It was recorded before the test's last edit. The typecheck evidence file was written at 16:51:36; the test file was last changed at 16:55:56.
- **M8 "equivalent".** It is equivalent in outcome only (F6).
- **"Deterministic timing".** The tests use real timers with ±150 ms margins.
- **"50/50" for `boundaryDoublesTest`.** The evidence shows only a PASS line.
- **The diagnosis's action-queue statement** (F4).

## Findings

| ID | Sev | Finding | Evidence | Suggested fix |
|---|---|---|---|---|
| F1 | med | Typecheck fails, but the records say TC=0 | `tests/approvalBudgetR31Test.ts:413` | Use `approvalGate.pendingRequest()`; re-run typecheck and the test; correct `change_log.md` and `r31_typecheck.txt` |
| F2 | low | Introduced by this change: after a withdrawal, the next queued question is shown at once with no answer grace. A "yes" typed for the withdrawn question approves the next one (`ANSWER_GRACE_MS` applies only to goal questions, `approvalGate.ts:367`) | `approvalGate.ts:213, 367`; P4: `Delete B … taken: true … approved: true` | Apply the answer grace to the first question shown after a withdrawal |
| F3 | low (latent) | Introduced by this change: background work started inside a call (for example `goalRuntime.ts:270-276`) keeps the call's scope after the call ends. If the caller's signal aborts later, its questions are denied as `cancelled` and never shown | `toolExecutionSandbox.ts:96-98, 195`; `approvalGate.ts:200`; P3, P9 | Ignore ended calls in `currentToolCall()`, and/or remove the caller-signal listener when the call ends |
| F4 | low | Already there before this change: R3-1 remains for admin commands whose question the registry does not cover. The action queue's 10 s timer aborts the command | `pcControlKernel.ts:444-468`; `adminController.ts:98-103`; `actionQueue.ts:47-49`; P6 | Record it as a known limit and correct the diagnosis; fixing it is a separate phase |
| F5 | low | `remaining` is measured with `Date.now()` and has no upper cap, so a system clock change shifts the budget | `toolExecutionSandbox.ts:118, 129, 138` | `performance.now()` and `Math.min(budget, …)` |
| F6 | info | M8 is equivalent in outcome, not strictly: the TIMEOUT wording differs | P8 | Reword; optionally assert the wording |
| F7 | info | A question cancelled during `await import(nodeBridge)` is still spoken. A question cancelled mid-speech keeps playing, and nothing says it was withdrawn | `approvalGate.ts:469-481` | Skip `speakToClients` when the question is already settled |
| F8 | info | Missing tests: the TTY cancel paths; abort and then yes in the same tick; a question asked after the call ended; zero budget left at the pause | test §4, §7 | Add the cases |
| F9 | info | Record wording: "deterministic timing", "50/50", the diagnosis's action-queue statement | run folder | Correct the wording |

## Status after round 1 (2026-11-09)

Owner's decision: fix F1, F2, F3 and F5 with tests; correct the records for F4, F6 and F9; F7 and F8 at the implementer's judgement. A gap found by the F8 test (a question asked with no budget left was still shown) was fixed with the owner's approval. Details are in `change_log.md`, "Review round 1 follow-ups".

| ID | Status |
|---|---|
| F1 | Fixed: line 413 uses `approvalGate.pendingRequest()`; typecheck TC=0; records corrected |
| F2 | Fixed: `approvalGate.ts:151, 388-389, 405, 419` (line numbers on the final tree, after the round-3 fixes); tests in §8 (the reviewer's P4, the deadline, a fresh yes, no withdrawal) |
| F3 | Fixed: `toolExecutionSandbox.ts:88, 102-105, 109, 211-214, 222`; tests in §8 (after the call ended; inside an active call). Covers questions asked **after** the call ended; a question opened while the call ran and still open after it ended stays tied to the call's signal (round 2, S4: known limit) |
| F4 | Recorded: `diagnosis.md` corrected; known limit in `change_log.md`; not fixed in R3-1 |
| F5 | Fixed: `toolExecutionSandbox.ts:126, 137, 149` (`performance.now()`, capped at the budget); tests in §8 (clock back and forward 10 s) |
| F6 | Recorded: the M8 row now says it is equivalent in outcome, with the wording difference |
| F7 | Partly fixed: `approvalGate.ts:507` (a withdrawn question is not said), with a test. Mid-speech playback recorded as a known limit (needs the TTS bridge) |
| F8 | Tests added (cancel then yes; after the call ended; no budget left). The no-budget gap was fixed at `toolExecutionSandbox.ts:139-141`. The TTY paths are recorded as untested here |
| F9 | Recorded: `patch_plan.md` (real timers, ±150 ms), the `boundaryDoublesTest` row, `diagnosis.md` |

A second independent review is still to be done.

---

# Independent Review — round 2 (2026-11-09)

- Reviewer: a fresh read-only subagent. Tree fingerprint `5dbbaeff6d7b5989`, the same at the start and the end.
- The reviewer ran fresh on the final tree:
  - R3-1 test: 55 passed, 0 failed;
  - typecheck: TC=0;
  - related tests: 42 passed, 0 failed, 1 skipped;
  - full suite: 218 passed, 0 failed, 0 timed out, 1 blocked, 9 skipped;
  - `git diff --check`: clean.
- `realTtsHandoffTest` is blocked by the environment: no `.venv`, and neither pygame nor websockets is installed.
- No path to an action without a valid approval was found.

## Verdict: CHANGES REQUIRED

| ID | Sev | Finding | Status |
|---|---|---|---|
| S1 | med (regression, fails closed) | A non-numeric `JARVIS_APPROVAL_GRACE_MS` made `afterWithdrawal` NaN for every question, so every question was denied as `timeout` within about 1 ms | Fixed: `approvalGate.ts:86-99` (`approvalGraceMs`: a finite number ≥ 0, else 1500; since round 3 also at most 60 000) and `:388` (held to 0..grace). Tests in §9: 10 values directly, 6 in child processes started with the setting |
| S2 | low (fails closed) | The withdrawal grace used `Date.now()` with no limit, so a clock moved back lengthened it, and the deadline, by as much | Fixed: `approvalGate.ts:388, 405` (`performance.now()`, held to 0..grace). Tests in §9: system clock back and forward an hour (typed), a controlled monotonic clock that goes back, and a spoken question |
| S3 | info | Goal code reports a `cancelled` decision as "the user declined" (`goalExecutor.ts:160-168`, `goalRecovery.ts:126-135`); reachable only for a registry question asked inside another sandboxed call | Recorded as a known limit; not fixed in R3-1 |
| S4 | info | A question opened while a call was running and still open after it ended stays tied to the call's signal (`toolExecutionSandbox.ts:206`) | F3 wording corrected; recorded as a known limit |
| S5 | info | Record wording: F5's line 146; "questions outside a tool are unchanged"; `approvalRequest.ts` not marked protected; the boundary-doubles reason; `docs/GOAL_RUNTIME.md:303` | Corrected |
| S6 | info | The test left its `jarvis-r31-*` workspace in the temp folder | Fixed: removed in `finally`, as `toolTimeoutTest`; a watchdog also removes it if the test overruns 300 s |

N8 (`Math.min` in the budget clock) was confirmed equivalent in production: `deadline − now ≤ remaining ≤ budget` holds by induction on every assignment, given a monotonic clock. A probe with a backwards `performance.now()` showed the cap works (1001 ms with it, 10802 ms without).

---

# Independent Review — round 3 (2026-11-09)

- Reviewer: a fresh read-only subagent. Tree fingerprint `5c57d890861e166c`, the same at the start and the end.
- The reviewer ran fresh:
  - R3-1 test: 72 passed, 0 failed, 0 folders left;
  - typecheck: TC=0;
  - related tests: 42 passed, 0 failed, 1 skipped;
  - `git diff --check`: clean.
- The full suite was not re-run by the reviewer.
- S1, S2 and S6 were confirmed correct. No security regression was found.

## Verdict: CHANGES REQUIRED

| ID | Sev | Finding | Status |
|---|---|---|---|
| T1 | low (test) | The F5 "clock back" question appeared inside the grace after the F3 case's withdrawal. Its "yes" was swallowed and the question timed out after 31 s, but the check passed because it never asserted the approval. It also cost about 31 s of the test's 99 s, against runAll's 120 s per-test limit | Fixed: the F5 questions wait until the grace after the last withdrawal is over, and the test asserts `approved === true` and `by === 'console'`. Runtime is now about 71 s |
| T2 | low (fails closed) | No upper limit on `JARVIS_APPROVAL_GRACE_MS`. About 24.8 days or more overflowed Node's timer, so a question after a withdrawal was denied in about 2 ms; 1e7 held a question for 2.8 h | Fixed (owner's approval): values above 60 000 ms give 1500 (`approvalGate.ts:86-99`). Tests: the parser for 15 values; child processes with 60000, 60001, 1e7 and 2147483647, each with a real withdrawal |
| T3 | info (record) | The change log claimed the clamp keeps NaN out; only the parser does | Corrected in `change_log.md` |
| T4 | info (record) | The clock-change limit covered only a clock moved back | Corrected in `change_log.md` (back and forward; known limit; no code changed) |
| T5 | info (test) | The test read `JARVIS_APPROVAL_GRACE_MS` from the shell; the header said "0..1.5 s" | Fixed: removed at the start; the header says "0..grace". With `JARVIS_APPROVAL_GRACE_MS=abc` in the shell the test passes, and mutant Q5 (shell 5000, not removed) fails it |
| T6 | info (S6 edge) | On Node's exit code 13 (an unsettled top-level await) `finally` is skipped | Fixed: `process.on('exit')` removes the workspace. The one removal function is shared by `finally`, the watchdog and the exit handler, and runs once. A probe that exits with code 13 left 0 folders |

---

# Independent Review — round 4, confirming T1–T6 (2026-11-09)

- Reviewer: a fresh read-only subagent. Tree fingerprint `d4736c9cd22ce14c`, the same at the start and the end.
- Fresh runs:
  - with `JARVIS_APPROVAL_GRACE_MS=5000` in the shell, the R3-1 test gave 78 passed, 0 failed;
  - typecheck: TC=0;
  - `git diff --check`: clean;
  - 0 `jarvis-r31-*` folders before and after;
  - no processes left.
- T1, T2, T3, T5 and T6 were confirmed, with no security regression. The round-3 change to `approvalGate.ts` is the parser only.

## Verdict: CHANGES REQUIRED (records only)

| ID | Sev | Finding | Status |
|---|---|---|---|
| U1 | low (record accuracy, T4) | The "Moved forward" known limit claimed a forward jump only refuses answers early, "never accepted wrongly". That is false. The grace's length is monotonic, but it is enforced on the system clock (`consoleFrom`, `approvalGate.ts:243-245, 396`), so a forward jump during the grace ends it early and a stale "yes" is taken. The same applies to the goal grace and the echo tail (`:273`). Probe: `{"graceLeftBeforeJumpMs":1448,"msSinceWithdrawal":51,"taken":true,"approved":true}` | Corrected in `change_log.md` (known limits). No code changed, as the owner's T4 decision is to record only |

Cosmetic: the T1 runtime in this file said 72 s against 71 s in the change log; now 71 s. The line citations in round 1's rows are historical (that tree).
