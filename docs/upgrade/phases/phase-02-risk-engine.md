# Phase 2 — Permission and risk engine

## Goal
For every concrete tool call, one decision — allow, ask for approval, or
deny — from the tool's metadata (P1), its arguments, the session level and the
user's settings, enforced in the registry after all existing checks.

## Current system context
- Session levels in `control/permissionSession.ts`: current level 0 or 2;
  `checkPermission(required)`: ≥ 4 always false, ≥ 3 always false
  ("needs confirmation"), else `current ≥ required`.
- Tool floor `requiredLevel` checked first in `toolRegistryV2.execute`.
- Command classes in `security/permissionManager.ts` (SAFE_READ_ONLY,
  LOW_RISK, MEDIUM_RISK, HIGH_RISK, CRITICAL_RISK), used by
  `security/commandValidator.ts` for run_command.
- Controllers ask for approval themselves via `approvalGate.requestApproval`
  (process kill, services, shell, protected app close, sensitive tab close,
  Command Prompt, enabling full control).
- Level 1 actions (control_app open/focus, window focus, browser open_url) are
  refused at the default level 0.

## Required changes
1. `security/riskEngine.ts`: `assessRisk(call)` and `decide(assessment, ctx)`.
2. Argument classifiers that can only raise the level.
3. Policies per level; `JARVIS_LEVEL2_POLICY` (`session` | `ask`).
4. Registry integration after validation; approved scope so a controller does
   not prompt again for the same call.
5. Default session level 1 (`JARVIS_DEFAULT_PERMISSION_LEVEL`, default `1`).

## Implementation steps
1. `assessRisk({ tool, args, source })`:
   start with `toolRegistryV2.riskOf(tool, args)`; apply classifiers; return
   `{ level, reasons[], action, target }`.
2. Classifiers:
   - run_command `command`, control_system `shell`/`powershell` `target`:
     `permissionManager` class → 0..4;
   - control_file `delete` 3, `delete_folder` 3 (4 when the folder is an
     approved root itself); `write`/`copy`/`move`/`rename` outside `os.tmpdir()` ≥ 2;
   - control_process `kill`/`restart` 3; control_system services 3 (security
     services 4 — already refused by adminController);
   - open_app target needing approval (`resolveTargetUrl().requiresApproval`) 3;
   - enable_full_control_session 3.
3. `decide`: level 0–1 → allow (session ≥ 1 assumed by default);
   2 → `session`: allow if full control active else deny with the hint,
   `ask`: approve; 3 → approve (and the existing controller checks still run);
   4 → approve with `strong: true` (typed code, P3) unless a classifier marked
   it `refused` (blocklist) → deny.
4. Registry (`execute`): after `requiredLevel` gate and validation:
   `assessment = assessRisk(...)`, `decision = decide(...)`; deny → result
   `{ success: false, error: 'RISK_DENIED', output: reason }`; approve →
   `approvalGate.requestApproval(...)` (current presentation; P3 replaces it);
   refused → `APPROVAL_DENIED`; approved → run inside
   `approvalScope.run({ tool, args }, ...)` (AsyncLocalStorage).
5. `approvalGate.requestApproval`: if called inside an approved scope for the
   same tool call → return true, log "already approved", record it.
6. `permissionSession`: base level from `JARVIS_DEFAULT_PERMISSION_LEVEL`
   (0 or 1, default 1); `deactivateFullControl` returns to the base level.
7. `isPermissionDenial` and reflection patterns recognise `RISK_DENIED` /
   `APPROVAL_DENIED` (fatal, no retry, honest reply).

## Files to inspect
`control/permissionSession.ts`, `security/permissionManager.ts`,
`security/commandValidator.ts`, `security/approvalGate.ts`,
`core/toolRegistryV2.ts`, `control/*Controller.ts`, `skills/automation/skill.ts`,
`control/permissionDenial.ts`, `core/taskGraphEngine.ts`, `core/reflectionEngine.ts`,
tests: `dispatchAuthzTest`, `permissionSessionTest`, `securityGateUnitTest`,
`runCommandSafetyTest`, `adminControlTest`, `fileControlSafetyTest`,
`openAppSecurityTest`, `taskFailureHonestyTest`, `registryRepairHonestyTest`.

## Files that may be modified
`security/riskEngine.ts` (new), `security/approvalScope.ts` (new),
`core/toolRegistryV2.ts`, `security/approvalGate.ts`, `control/permissionSession.ts`,
`control/permissionDenial.ts`, `core/taskGraphEngine.ts`, `core/reflectionEngine.ts`,
`.env.example`, tests, docs.

## Dependencies
P1.

## Tests
`tests/riskEngineTest.ts`: table of ≥ 30 calls → level and decision for every
session/policy combination; classifiers with injection strings; through the
real registry: level-1 call runs at default level; level-2 refused without full
control (policy `session`), asks with `ask`; level-3 asks even in full control,
exactly one prompt (controller does not ask again); level-4 refused when
blocklisted; denied call never executes (spy). All existing permission and
security tests pass unchanged.

## Acceptance criteria (here)
Decisions match the table in PERMISSION_MODEL.md; no call that is refused today
becomes allowed except level-1 actions the specification marks automatic;
one approval prompt per call.

## Security requirements
Classifiers only raise; unknown → highest action risk; engine errors deny
(fail closed); approval scope is bound to one call and ends with it.

## Failure conditions
A blocklisted command reachable; a double prompt; a denied call executing; any
existing security test failing.

## Completion requirements
Gate passes; checklist, PHASE_STATUS, PERMISSION_MODEL updated; commit
`phase-02-risk-engine`; pushed; CI green.
