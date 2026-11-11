# Independent Reviews — an action that ends after JARVIS stopped waiting (B4)

Both reviewers were fresh read-only subagents. Each worked from the actual diff, ran its own commands, and kept its probes in a temporary copy outside the repository, which it removed afterwards.

## Review 1 (2026-11-11), tree `b2d92a917bdbe562`

**Verdict: CHANGES REQUIRED.**

The protected-file changes matched A1–A4, B1–B2, C and D. No path re-runs an unknown outcome: the registry, the task graph, the orchestrator's `recoverPhase` and replanning, the action queue and the goal runtime were all checked. No path mixes up call identities.

| ID | Severity | Finding | Outcome |
|---|---|---|---|
| V1 | Medium (regression) | The never-started text did not match the action queue's no-retry rule (`control/actionQueue.ts:20, 71-79`). The command was tried again, so approval was asked twice. If the queue's 10 s timer fired during approval, the definite wording was lost | Fixed: new wording; checks 5.1 and 5.2 |
| V2 | Low | `late_result` could be written before an overdue `outcome_unknown` line (`core/toolExecutionSandbox.ts`) | Fixed: it waits for the real write; check 5.3 |
| V3 | Low | After a replan, the quoted request included the planner's `[SYSTEM NOTE …]` (`core/reflectionEngine.ts`) | Fixed: the note is removed; check 5.4 |
| V4 | Low (records) | Agent wording, the agent-run goal limit, and `core/goalLifecycle.ts` not listed (`patch_plan.md`) | Corrected |
| V5 | Cosmetic | The failure message's comment was separated from its method | Fixed; check 5.5 |
| K25 timing | Windows risk | The Windows checks expected exact whole seconds | 4.6 accepts 2 or 3 seconds, 2.5 accepts 10 or 11 |

**Mutants:**
- K18 was judged equivalent: the override replaces the class and strategy for every input that actually occurs.
- 4.6 was judged able to catch K25 on Windows.

## Review 2, confirming (2026-11-11), tree `b63a88a1fe6f4732`, unchanged at the end

**Verdict: APPROVED — READY FOR COMMIT.**

**What the reviewer ran:**

| Check | Result |
|---|---|
| `pnpm -s typecheck` | TC=0 |
| `git diff --check` | clean |
| `git diff --name-only -- tests/` | empty |
| `git diff -- control/actionQueue.ts` | empty |
| `tests/lateOutcomeB4Test.ts` | **51 passed, 0 failed**: 5.1 one attempt; 5.2 one approval, logged `failure`; 5.3 3703 ms, `outcome_unknown` before `late_result`; 5.4 no note; 5.5 PASS |
| Related tests, read from evidence | 99 passed, 0 failed, 1 skipped |
| Full suite, read from evidence | 219 passed, 0 failed, 0 timed out, 1 blocked (`realTtsHandoffTest`), 9 skipped |
| Mutation evidence | round 3 **11/11 caught**; V1q **1/1 caught**; files restored |

**Probes,** in a copy (budget 1.2 s, grace 0.5 s):
- A: a write that never finishes. The result came back at 3712 ms; no `late_result` line.
- B: a write that fails. The result came back at 1704 ms; the failure was reported; only the `late_result` line was written.
- C: a tool that ends just after JARVIS gives up. The result came back at 1705 ms, with the lines in the right order.
- D: a log call that throws. It was caught.

None of the four produced an unhandled error.

**Per correction:**
- **V1:** all five callers use the same `runStoppable`. `started: false` occurs only on the already-aborted path. The definite wording does not carry the marker.
- **V2:** the `late_result` line waits for the `outcome_unknown` write attempt to settle, and the result never waits more than 2 s after JARVIS gives up.
  - **Successful write:** `late_result` follows the persisted `outcome_unknown` line.
  - **Failed write:** the failure is reported separately, and `late_result` may still be written once the failed write attempt has settled, with no `outcome_unknown` line before it (I2, probe B).
- **V3:** no other spoken B4 text quotes the request.
- **V4:** the records match the cited code.
- **V5:** the comment is back in place.
- **K25:** 4.6 still rejects a fixed 10, and a missing number cannot slip through 2.5.
- Existing assertions changed only where the approved V1 wording or the approved timing tolerance required it.

**Informational notes,** none needing a change:

| ID | Note |
|---|---|
| I1 | If an `outcome_unknown` write never finishes, the pending `late_result` step for that call stays in memory. It is bounded to one call, and the hang is already reported |
| I2 | If the `outcome_unknown` write fails, the `late_result` line is still written without the line it normally follows. The failure is reported on its own, and the outcome stays unknown |
| I3 | The definite never-started text is classed as an ordinary failure, where it was a network error before. Nothing ran, and no B4 safeguard depends on it |

## Still not verified

The Windows-only checks 2.5 and 4.6, and the K25 mutant on Windows, are **NOT VERIFIED** (see `change_log.md`). R3-1 remains open.
