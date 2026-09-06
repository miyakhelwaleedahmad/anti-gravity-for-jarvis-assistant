# `_legacy/` — quarantined, not deleted

These 57 modules are unreachable from the running system. Reachability was
computed from the real entry point (`jarvis.ts`) plus all 24 dynamically-loaded
skill entry points (`skills/*/skill.ts`), following static and dynamic imports,
and then checked a second time against every file in `tests/`.

Nothing here is imported by the live agent **or** by the test suite.

They are **moved, not deleted**, deliberately: `tsc --noEmit` and the test suite
passing without them is good evidence but not proof, and a single release should
not both change behaviour and destroy code. Delete them in a later release once
the system has run on real hardware without them.

`_legacy/` is excluded from `tsconfig.json`, so the quarantined files are not
typechecked — their relative imports no longer resolve from this directory.

## What is in here

| Group | Modules | Why it is dead |
|---|---|---|
| The parallel "brain" pipeline | `core/brain.ts`, `reasoning/*`, `perception/inputProcessor.ts`, `perception/intentAnalyzer.ts`, `execution/*`, `planner/*`, `autonomy/*` | A migration leftover. The real brain is `core/orchestrator.ts`; this entire messageBus pipeline is imported by nothing and cannot run. |
| Agent stubs | `agents/*` | Two-line placeholders. |
| Superseded infrastructure | `core/toolRegistry.ts`, `core/skillRegistry.ts`, `tools/dispatcher.ts`, `security/sandbox.ts` | Replaced by `core/toolRegistryV2.ts`. `tools/dispatcher.ts` is a mock that returns `success: true` for any input — dead today, dangerous if ever wired. |
| Unused subsystems | `system/*`, `learning/selfAudit.ts`, `simulation/worldModel.ts`, `conversation/contextManager.ts`, `memory/cacheManager.ts`, `memory/contextBuilder.ts` | Never referenced from the live path. |
| One-off scripts | `analyze.ts`, `count_modules.ts`, `debug_imports.ts`, `find_importers.ts`, `fix_*.ts`, `refactor_*.ts`, `stabilityTest.ts`, `stateMachineVerification.ts`, `test_*.ts` | Development throwaways committed at the repository root. |
| Duplicate entry point | `index.ts` | No script references it; `jarvis.ts` is the entry point. |

## Deliberately NOT quarantined

| Kept | Reason |
|---|---|
| `control/inputController.ts` | Unreachable at runtime but imported by `tests/inputControlTest.ts`. The audit flagged this one for verification specifically — it is superseded by `keyboardController`/`mouseController` in practice, but removing it would break a passing test. |
| `monitoring/resourceMonitor.ts` | Imported by `tests/resourceUsageAuditTest.ts`. |
| `system/backupRestore.ts` | Imported by the test suite. |
| `config/fs-extra.d.ts`, `config/ws.d.ts` | Ambient module declarations. Nothing imports them, so reachability cannot see them, but `tsconfig.json` includes them explicitly and the build uses them. |
