# Patch Plan — diagnostics (phase A6)

| # | Change | Files (protected in **bold**) |
|---|---|---|
| P1 | The action log line carries the request: `traceId`, and `userCommand` = the owner's request text (redacted and cut short, as the log already redacts), or the action name when there is no request. It also carries the real `riskLevel` the kernel computed. It says `verified: "pending"` instead of only "success": the effect has not been checked yet. The fixed `rollbackAvailable: true` and `confirmationRequired: false` are dropped, because they are not known there. | **`control/pcControlKernel.ts`**, `control/actionAuditLog.ts` (the entry type) |
| P2 | After the registry checks a call's effect, the result (verified or failed, with the evidence) is written to the request trace and to the action log as a `verification` line with the same `traceId`. After a VERIFICATION_FAILED, the two logs agree. | **`core/toolRegistryV2.ts`** (one listener call in `verifyResult`), `monitoring/traceWiring.ts`, `control/actionAuditLog.ts` |
| P3 | The test helper ends Chrome's whole process tree on Windows (`taskkill /PID <pid> /T /F`). Elsewhere it ends the process as before. Windows CI should then show no "Terminate orphan process … (chrome)". | `tests/chromeHelper.ts` |
| T | New `tests/diagnosticsA6Test.ts`: a kernel action with its trace id and request in the action log; a passed check and a failed check in both logs, with the same trace id. Written first; it must fail on the current code. P3 is checked by Windows CI (the orphan lines) and by a test of the helper's stop command on each OS. | tests |

Owner choices for A6:
- Q1. Which check results go into the logs: **every check that ran, verified or failed** (recommended: "the verified outcome", as the audit asks; needs one listener call in the protected registry), or failed checks only (the registry stays unchanged; a passed check is still only on the console).
- Q2. The action log's `rollbackAvailable` and `confirmationRequired`: **drop them** (recommended: they were fixed values, not facts), or keep them as they are.

Not in A6: B4's other items (an action that ends after the registry's time limit is reported as "may have happened"; a tool's question inside its time budget). They change timing behaviour and are a separate phase.

Gate 1 for A6: **approved** by the owner on 2026-11-06:
- "Approve A6 (Recommended)", with the protected files `control/pcControlKernel.ts` and `core/toolRegistryV2.ts` (one listener call in `verifyResult`);
- Q1: "Every check that ran (Recommended)";
- Q2: "Drop them (Recommended)".
