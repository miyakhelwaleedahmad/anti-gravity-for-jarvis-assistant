# Patch Plan — honest capability (phase A5), in five sub-phases

A5 touches about 20 files, 6 of them protected. It is split so that each part is small enough to test, review and check on the PC on its own. Each sub-phase follows the full workflow: Gate 1 approval, tests first, fix, related tests, suite, mutation check, independent review, records, then commit and push only with approval.

| Sub-phase | What changes for the owner | Main files (protected in **bold**) |
|---|---|---|
| **A5a** read tools (TRA-07) | "Is YouTube open?" with JARVIS's Chrome down says "My Chrome is not running, sir, so I can't see its tabs." instead of "No". "What's running?" with PowerShell failing says it can't read the windows instead of listing nothing. Tab questions read Chrome live, not a 12 s-old snapshot. | `perception/windowsState.ts`, the 5 read skills, `perception/chromeState.ts`, **`core/orchestrator.ts`** (the `is_tab_open` / `whats_running` / `get_browser_tabs` replies) |
| **A5b** self_check (TRA-08, B3) | `self_check` reports Chrome (CDP), PowerShell and the permission level. Redis on its fallback shows as degraded, not VERIFIED. "Tools" means a real check, not "the last tool that ran". | `core/selfCheck.ts`, `monitoring/healthManager.ts`, `monitoring/healthLedger.ts` (maybe **`memory/redisCache.ts`**) |
| **A5c** kernel (TRA-10, B1 item) | When an app, window or process action fails without throwing ("Permission denied.", "No running window found…"), JARVIS says it failed instead of claiming success. The audit log records the real result. | **`control/pcControlKernel.ts`**, `control/appController.ts`, `control/windowController.ts`, `control/systemController.ts`, `control/processController.ts` |
| **A5d** open_app (TRA-19) | `open_app` waits for the opener to start (a spawn failure is a failure). An unchecked open is said as "opened, not checked", never as checked. Windows-only targets are refused, with the reason, off Windows. | **`skills/automation/skill.ts`**, `core/verifiers.ts`, **`core/toolRegistryV2.ts`**, `security/openAppPolicy.ts`; protected test `openAppSmokeTest` |
| **A5e** capability model (TRA-09) | Each tool states where it can run (platform, Chrome, PowerShell). The planner offers only tools that can run, and `list_capabilities` shows availability. | **`core/toolRegistryV2.ts`**, **`core/toolCatalog.ts`**, **`core/skillLoader.ts`**, `core/planningToolSelection.ts`, `core/tools/capabilityTool.ts`; `fixtures/route-golden.json` |

Order: A5a first, because its symptom (a false "No") is what the owner hears. Then A5c and A5d, which stop false successes. Then A5b, then A5e, which is the largest and depends on the others.

## A5a in detail (the first Gate 1)

| # | Change | Files |
|---|---|---|
| P1 | `windowsState` results say whether they could be read: an `unavailable` reason alongside the (empty) data, never a silent empty result. The safety rule from `windowsStateFreshnessTest` stays: no stale window is acted on. | `perception/windowsState.ts` |
| P2 | The read skills (`get_open_apps`, `get_active_window`, `is_app_open`, `is_tab_open`, `get_browser_tabs`) return `{ success:false, error, spoken }` with the reason when their source failed. Empty means really empty. | the 5 `skills/*/skill.ts` |
| P3 | Tab questions (`is_tab_open`, `get_browser_tabs`) read JARVIS's Chrome live, not the 12 s snapshot. With Chrome down, they reuse A4's reply: "My Chrome is not running, sir, so I can't see its tabs." | the two skills, `perception/chromeState.ts` |
| P4 | The routes speak the unavailable reason instead of "No…" or an empty list. | **`core/orchestrator.ts`** (`is_tab_open`, `whats_running`, `get_browser_tabs` handlers) |
| T | New `tests/honestReadToolsA5aTest.ts`, with a fake CDP and a fake PowerShell: Chrome down → `is_tab_open` is not "No"; PowerShell failing → `get_open_apps` is not `[]`; really-empty stays empty and successful; live tabs, not stale ones. Change `windowsStateFreshnessTest` only where it asserts the silent empty result. The DO_NOT_BREAK tests stay green. | tests |

Owner choices for A5a, with my recommendations:
- Q1. JARVIS's Chrome is not running and you ask "is YouTube open?": **say so, and do not start Chrome** (recommended), or start Chrome to check (it would open Chrome unasked, and then nothing is open anyway).
- Q2. Tab questions: **read Chrome live** (recommended; a few hundred ms slower, never stale), or keep the 12 s snapshot.

Gate 1 for A5a: **approved** by the owner on 2026-11-03, with:
- the split: "Approve A5a (Recommended)";
- the protected file `core/orchestrator.ts`;
- Q1: "Say so, don't start it (Recommended)";
- Q2: "Read Chrome live (Recommended)".

The other sub-phases each need their own Gate 1.

## A5c in detail (kernel: TRA-10 and the B1 item)

Diagnosis D3, checked again at `735c0a2`. The kernel (`control/pcControlKernel.ts:55-87`) counts any returned value as success, and only a thrown error as failure. Controllers return failures as text in 11 places:

| Controller | Place | Returned as success today |
|---|---|---|
| `appController` | `focusApp` (:190, :197) | "Permission denied.", "No running window found for app …" |
| `windowController` | `focusWindow` (:79, :85) | "Permission denied.", and any error turned into text |
| `browserController` | `listTabs` (:63, :70); `closeTab` (:127) | "Permission denied.", an error as text, "Tab matching … is not open." (nothing closed) |
| `systemController` | disk info, startup tasks (:54, :70) | `{"error": …}`; also PowerShell's non-zero exit is ignored, so an empty answer counts as success |
| `processController` | `listProcesses` (:92) | `[]` when the list could not be read |
| `fileController` | `readFile` (:99, :103) | "Error reading file: …" |

The Windows window script (`control/win_automate.ps1`) already throws on a failed window action (since A1), so `minimize`, `maximize`, `close`, `move` and `resize` are fine.

| # | Change | Files (protected in **bold**) |
|---|---|---|
| P1 | Each of those 11 places throws an error with the same reason instead of returning it as text. PowerShell's non-zero exit in `systemController` is a failure. | `control/appController.ts`, `windowController.ts`, `browserController.ts`, `systemController.ts`, `processController.ts`, `fileController.ts` |
| P2 | Defence in depth in the kernel: a returned JSON object with `success: false` or a top-level `error` is a failure, with that reason. Plain text stays a success, as today, so there is no guessing from words. The audit log records the real result (already true once failures throw). | **`control/pcControlKernel.ts`** |
| T | New `tests/kernelOutcomeA5cTest.ts`: each failure path, with the controllers' dependencies stood in (permission refused, no window, PowerShell error, list failure), gives `success:false` with the reason through the kernel and through the tool the planner calls. Successful actions stay successes. The B1 item ("a controller failure returned without throwing … reported as a failure through the kernel, with a test") is covered. | tests |

Not in A5c (recorded):
- verifying keyboard, mouse, process and system actions after the fact (TRA-10's second part) is for A5d/A5e, with the verifiers;
- the audit log's fixed `rollbackAvailable: true`;
- `get_pc_state` and `windowController.listOpenWindows` turning an unread window list into `[]`. These now see A5a's `unavailable` field; making them fail on it is a one-line change each, and is included in P1 if the owner agrees (Q3 below).

Owner choices for A5c:
- Q1. `control_browser close` for a tab that is not open: **a failure, "nothing was closed"** (recommended), or a success as today.
- Q2. `systemController` disk and startup lists when PowerShell fails: **a failure with the reason** (recommended), or the empty answer as today.
- Q3. `get_pc_state` / `list_open_windows` when the window list was not read (A5a's reason): **a failure with the reason** (recommended), or `[]` as today.

Gate 1 for A5c: **approved** by the owner on 2026-11-03:
- "Approve A5c (Recommended)", with the protected file `control/pcControlKernel.ts`;
- Q1: "A failure: nothing closed (Recommended)";
- Q2 and Q3: "A failure with the reason (Recommended)".
