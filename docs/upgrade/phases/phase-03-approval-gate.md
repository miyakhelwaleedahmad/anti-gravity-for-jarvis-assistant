# Phase 3 — Human approval gate

## Goal
When the risk engine asks for approval, JARVIS shows ACTION, WHY, TARGET,
EXPECTED EFFECT, RISK and REVERSIBILITY, asks "Do you approve this action?",
accepts only an explicit answer to that displayed request, and records it.

## Current system context
- `security/approvalGate.ts`: console box with action, command, risk, source,
  reason; accepts YES/APPROVE/CONFIRM; non-TTY stdin → deny; voice path speaks
  "Approval required to …" and races `nodeBridge.waitForTextConfirmation`
  (accepts confirm, yes, approve, approved, proceed, do it) with console input.
- After P2: registry calls `requestApproval`; approved calls run in an
  approved scope.

## Required changes
1. `ApprovalRequest` model and builder.
2. New presentation (console and spoken).
3. Answer rules bound to the pending request; level 4 typed code.
4. Recording on the task node, goal and audit log; approval history.

## Implementation steps
1. `security/approvalRequest.ts`: `{ id, tool, action, why, target,
   expectedEffect, risk, reversibility, source, strong, code?, createdAt }`
   (as built; the display window lives in the gate's pending request); `buildApprovalRequest(assessment, meta, context)` — WHY from
   the user's request text (trimmed, redacted), TARGET from arguments, EFFECT
   and REVERSIBILITY from metadata (action level first).
2. `approvalGate.requestStructured(request)`: prints the six-line block and the
   question; level 4 prints `Type: APPROVE <code>` (random 4 characters);
   speaks a short version for voice.
3. Pending-request registry: one pending request at a time; answers are
   matched to it by time window (30 s console, 10 s voice); answers arriving
   when nothing is pending are ignored and logged.
4. Accepted answers: console `APPROVE`, `YES`, `CONFIRM`; voice `approve`,
   `confirm`, and `yes` only within the window; level 4: console
   `APPROVE <code>` only. Everything else denies. (As built: the voice window
   starts when JARVIS has finished speaking; answers are consumed so they do
   not also run as commands — the CLI loop and the speech handler in
   `jarvis.ts` pass them to the gate first.)
5. Record `{ requestId, decision, by, at, risk }` on the `TaskNode`
   (`node.approval`), on the goal (`goalManager` metadata) and in
   `securityAuditLogger` (with the six fields, redacted).
6. Keep `requestApproval(...)` working for existing callers by building a
   request from its arguments.

## Files to inspect
`security/approvalGate.ts`, `bridge/nodeBridge.ts` (`waitForTextConfirmation`),
`core/toolRegistryV2.ts`, `core/taskGraphEngine.ts` (TaskNode), `core/goalManager.ts`,
`security/securityAuditLogger.ts`, tests touching approvals.

## Files that may be modified
`security/approvalRequest.ts` (new), `security/approvalGate.ts`,
`bridge/nodeBridge.ts` (confirmation matching), `core/toolRegistryV2.ts`,
`core/taskGraphEngine.ts`, `core/orchestrator.ts`, `security/securityAuditLogger.ts`,
tests, docs.

## Dependencies
P2.

## Tests
`tests/approvalGateStructuredTest.ts`: block contains the six fields and the
question; console answers (simulated stdin) approve/deny; voice answers
(simulated confirmation stream) approve within the window and are rejected
after it; "yes" with no pending request → ignored; level 4: `APPROVE` alone
denies, `APPROVE <code>` approves, voice cannot approve; timeout denies;
decision present on the task node, goal and audit log; existing callers still work.

## Acceptance criteria (here)
All tests above through the real registry and orchestrator.

## Security requirements
Default deny; one answer approves one call; codes are random per request;
the request text is redacted before printing and logging.

## Failure conditions
Any path approving without a displayed request; level 4 approved by voice;
decision missing from the record.

## Completion requirements
Gate; checklist; PHASE_STATUS; PERMISSION_MODEL; commit
`phase-03-approval-gate`; pushed; CI green.
