# Diagnosis — diagnostics (phase A6)

Checked at `82a1df5`.

## TRA-13: the action log

`control/pcControlKernel.ts` (protected) writes one line per PC action to `data/logs/jarvis-actions.jsonl` (`control/actionAuditLog.ts`). Nothing in the code reads that file.

- `userCommand` and `normalizedIntent` are both the action name (`control_window maximize`…), never the owner's request.
- There is no request or trace id, so a line cannot be joined to the request trace (`data/logs/jarvis.*.jsonl`, `monitoring/traceWiring.ts`), which is keyed by the trace id.
- `result: 'success'` is written when the controller returns, before the registry checks the effect (`core/toolRegistryV2.ts` `verifyResult`). When that check fails (VERIFICATION_FAILED), the trace records a failed `tool_call`, but the action log still says "success".
- `riskLevel` is the fixed value `'medium'` for every action that is not read-only. The kernel computes a level from the permission level (`riskLevel`, line 74) and does not use it.
- `rollbackAvailable` is always `true` and `confirmationRequired` always `false`. Neither is known there (A5c recorded the first as a known limit).
- Neither log records a successful check. The trace has a `tool_call` per attempt and, after a failed check, a second one with `VERIFICATION_FAILED`. A check that passed (or could not be run) appears only on the console.

## TRA-15: test Chrome left running on Windows

`tests/chromeHelper.ts` `startChromium().stop()` (and the not-started path) calls `proc.kill()`. On Windows that ends the parent `chrome.exe` only, so Chrome's child processes likely keep running (the audit rates this LIKELY; review F4). Other possible sources: `jarvisChromeTest` ends a real Chrome with `kill()` too, and the test runner kills a test that runs past its limit without its Chrome.

The latest Windows CI run (run 42212811009, `82a1df5`, job `windows`) still ends with:

    Cleaning up orphan processes
    Terminate orphan process: pid (2436) (chrome)
    Terminate orphan process: pid (8012) (chrome)

(`evidence/a6_ci_orphans_82a1df5.txt`.)
