# Legacy Architecture Import Report

Generated during Step 3. No legacy files were deleted, moved, or archived.

## Checked Areas

- `core/messageBus.ts`
- `core/brain.ts`
- `reasoning/`
- `planner/`
- `autonomy/`
- `execution/`

## Classification

| Path | Status | Evidence |
| --- | --- | --- |
| `core/messageBus.ts` | active | Imported by `core/brainLoop.ts`, `perception/inputProcessor.ts`, and `perception/visionIntentManager.ts`. |
| `core/brain.ts` | maybe active | Imports legacy reasoning/planning/execution layers, but no active main-route import was found. `self_healing/fsWatcher.ts` still references it for pipeline mapping. |
| `reasoning/` | maybe active | Imported by `core/brain.ts`; not proven active through `jarvis.ts`. |
| `planner/` | maybe active | Imported by `core/brain.ts`; not proven active through `jarvis.ts`. |
| `autonomy/` | maybe active | Imported by `core/brain.ts`; `jarvis.ts` uses `core/brainLoop.ts` for the current loop. |
| `execution/` | maybe active | Imported by `core/brain.ts`; current execution path uses `core/taskGraphEngine.ts` and `core/toolRegistryV2.ts`. |

## Decision

No cleanup was performed. The legacy folders are not proven safe to remove because some are reachable through `core/brain.ts`, and `messageBus` is still actively used.

## Safe Next Step

Add runtime instrumentation or an import graph script that starts from `jarvis.ts`, `index.ts`, and package scripts, then records modules loaded during `test:voice-core` and `test:pc-control`. Archive only files with zero static imports and zero observed runtime loads.
