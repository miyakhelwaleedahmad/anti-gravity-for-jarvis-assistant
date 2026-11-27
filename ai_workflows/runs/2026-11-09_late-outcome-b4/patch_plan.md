# Patch Plan — an action that ends after JARVIS stopped waiting (B4)

Tests first, on the current code; then the change; mutation checks, related tests, typecheck, full suite, the diff and protected-file review, an independent review. Commit and push only with the owner's approval.

## Gate 1 (owner, 2026-11-09)

Approved:
- **Scope:** the sandbox's gave-up timeout and the stopped admin command.
- **Late completion:** logged only; no extra spoken message. The original timeout line is kept, and the late result is attached to the original call and request id, with its real completion time.
- **Wording:**
  - sandbox: "I stopped waiting for [action] after [duration], sir. It may still finish, so check before asking me to try again." [action] is the owner's request in quotes for a one-step request; for several steps, the exact tool and action step. [duration] is the real elapsed wall-clock time in whole seconds, singular or plural;
  - admin: "The command was stopped after [N] seconds, sir. Part of it may already have run, so please check before trying again." N is the measured seconds;
  - a command that never started is a definite failure;
  - the internal marker is `TIMEOUT (outcome unknown)`.
- **Safety:** no automatic retry or fallback for an unknown outcome; safe network reads keep their retries; call identity is captured at the start and never changed; the audit history is append-only; budgets, concurrency limits, approval clocks and audit behaviour are unchanged.

| ID | Change | File |
|---|---|---|
| A1–A4 | Call identity at `run()` start (call id, request id or agent path, the owner's words); the gave-up text `Error: TIMEOUT (outcome unknown): …` with the waited seconds; an `outcome_unknown` line when giving up; a `late_result` line, with the same identity, when the tool ends | `core/toolExecutionSandbox.ts` (protected) |
| B1–B2 | The request identity captured when an action starts; a failure carrying the marker logged as `unknown` | `control/pcControlKernel.ts` (protected) |
| C | An output carrying the marker is returned at once: no retry, no fallback | `core/toolRegistryV2.ts` (protected) |
| D | The marker is a fatal error: never re-run | `core/taskGraphEngine.ts` (protected) |
| U1 | The marker and `isOutcomeUnknown()` | `core/outcomeUnknown.ts` (new) |
| U2 | Class `outcome_unknown` (before the network `TIMEOUT` pattern), strategy abort, the owner's sentences | `core/reflectionEngine.ts` |
| U3 | `stoppedCommandError(r, elapsedMs)`: the unknown-outcome text for a started command, the definite text for one that never started | `control/adminController.ts` |
| U4 | `RunResult.started` | `system/processRunner.ts` |
| U5 | Result `unknown`; `outcome_unknown` and `late_result` lines | `control/actionAuditLog.ts` |
| U6 | An unknown outcome goes to needs-review, never retried (classified before the budget and transient patterns); its own failure class `outcome_unknown`, counted apart from `interrupted` (owner's approval at Stage 2) | `core/goalRecovery.ts`, `core/goalLifecycle.ts` |
| T | Regression test | `tests/lateOutcomeB4Test.ts` |

Known limits to record:
- **Background agents and repeats.** An agent's model decides for itself whether to call a tool again. The text it receives (`core/toolExecutionSandbox.ts`, the gave-up text) says only "It may still finish."; it does not ask the agent to check first, and nothing in code stops a second call (`core/agents/behaviors/toolLoop.ts:84-94`). *Corrected after the second review (V4a); the earlier wording said the text asked agents to check first.*
- **Goal tasks run by an agent do not reach needs-review.** The agent's tool loop turns a failed call, an unknown outcome included, into a limitation (`core/agents/behaviors/toolLoop.ts:159`). The agent then completes, and `core/goalExecutor.ts:194` returns `ok: true`, so the goal task is `completed`. The needs-review routing in `core/goalRecovery.ts` applies only when the attempt itself fails with the unknown-outcome text (review V4b). Not changed in B4.
- `taskkill /T` does not reach a process that detached from its tree.

## Stage 2 and 3 decisions (owner, 2026-11-09 to 2026-11-11)

- **Stage 2:**
  - the `outcome_unknown` line is written and awaited before the result is returned, for at most 2 s (`OUTCOME_LOG_WAIT_MS`);
  - a failed or overdue write is reported separately, the outcome stays unknown and nothing is retried;
  - the goal runtime gets its own class `outcome_unknown` (`core/goalLifecycle.ts`).
- **Stage 3, mutation:**
  - six checks added for the surviving mutants K3, K8, K11, K16, K19 and K25;
  - K18 accepted as equivalent;
  - K25 is verified only on Windows (check 4.6).
- **Second independent review, corrections approved:**
  - **V1:** the never-started wording is "… was not started: the request was stopped before it began.", which the action queue treats as final, so it is not retried and approval is not asked twice;
  - **V2:** a `late_result` line waits for the `outcome_unknown` write itself, while the result keeps its 2 s limit;
  - **V3:** the planner's `[SYSTEM NOTE …]` is removed from the quoted request;
  - **V4:** these records;
  - **V5:** the failure message's comment is back above its method;
  - **K25 tolerance:** check 4.6 accepts 2 or 3 seconds (still rejecting a fixed 10), and check 2.5 accepts 10 or 11.
