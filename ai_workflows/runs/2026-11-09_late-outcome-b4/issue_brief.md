# Issue Brief — an action that ends after JARVIS stopped waiting (B4)

Tracker item (B4, `docs/audit/TOOL_REPAIR_PHASES.md:152`): "An action that ends after the registry timeout is reported as 'may have happened', not 'failed'". Deferred from A6 (`2026-11-06_diagnostics-a6/patch_plan.md:14`).

The owner asked to move on from R3-1 on 2026-11-09 (R3-1's PC test, a 120 s runner timeout of `approvalBudgetR31Test` on the owner's PC, and its live checks stay open). Gate 0 (read-only diagnosis) and Gate 1 (scope, wording, test plan and protected changes) were approved on 2026-11-09.

Base commit: `dbaa5b1`.
