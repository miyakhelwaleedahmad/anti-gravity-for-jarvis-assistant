# Diagnosis — an action that ends after JARVIS stopped waiting (B4)

Read-only, on `dbaa5b1`.

## Where an action ends "late"

1. The sandbox gives up on a tool that ignores its stop signal for its budget plus 5 s (`core/toolExecutionSandbox.ts:239-247`). It returns `Error: TIMEOUT: Tool "X" … JARVIS stopped waiting for it.`, and the tool can still act. Its `tool_audit.log` line, written when it ends, then says success (`:220-233`). Probe: the tool acted 1.2 s after JARVIS had reported the failure (`evidence/b4late_probe.txt`).
2. An admin command is stopped part way by the action queue's 10 s timer (`control/adminController.ts:46-50`, `control/actionQueue.ts:47-49`). `runProcess` returns only once the process has exited (`system/processRunner.ts:83`), so the stop is confirmed. A signal already aborted starts nothing (`:59-61`), which is a definite failure.

## What the owner is told

`core/reflectionEngine.ts:108` classifies every `TIMEOUT` as a network error. `buildFailureVoiceMessage` (`:766-778`) then says "I couldn't reach a service I needed, sir.", plus the error text when it fits in 120 characters.

## Automatic repeats

- Steps that change something are not re-run by the orchestrator (`core/orchestrator.ts:2356-2360`, `maxRetries 0`; only the orchestrator runs graphs). The action queue does not retry `TIMEOUT` (`control/actionQueue.ts:20`).
- Latent paths, found at Gate 1:
  - the registry tries a fallback tool with the same arguments after an error (`core/toolRegistryV2.ts:975-984`); no medium- or high-risk tool has a fallback today;
  - the task-graph engine retries a "transient" error when a graph keeps its default retries.
- Goal recovery: the gave-up text contains "budget", so `classifyFailure` calls it the goal's budget, and the task is made ready to run again (found by the regression test, check 3.2).

## The request a late line belongs to

The request id is one module-level value (`core/traceContext.ts:23`), replaced by the next request. The kernel reads it when the action ends (`control/pcControlKernel.ts:68-77, 120, 157`), so an action that ends after its request is logged with no request or with the next one (regression test, check 2.3).
