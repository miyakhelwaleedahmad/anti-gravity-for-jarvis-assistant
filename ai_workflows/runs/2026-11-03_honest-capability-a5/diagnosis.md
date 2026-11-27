# Diagnosis — honest capability (phase A5)

Read-only, at `62f0a99`, by a search agent and checked against the audit (`docs/audit/JARVIS_TOOL_RELIABILITY_AUDIT_2026-10-25.md` §§ C, I). All five findings are **still true**. Phases A1–A4 fixed parts:
- web pages and Chrome now open in JARVIS's Chrome and are checked;
- process kill checks that the process is gone.

| ID | Finding (still true) | Evidence |
|---|---|---|
| D1 (TRA-07) | When PowerShell or Chrome cannot be read, the read tools answer empty or `false` with success. `windowsState` returns `EMPTY_RESULT` on any failure, and its result type has no "unavailable" field. The read skills use a snapshot (tabs polled every 12 s) and ignore its `chrome.error`. The route `is_tab_open` then says "No, the youtube tab is not open, sir." when Chrome is down. `whats_running` treats a failed read as no apps. `get_browser_tabs` reads live first, but may fall back to stale snapshot tabs. | `perception/windowsState.ts:51-54, 334, 408-410, 445, 481`; `skills/{get_open_apps,get_active_window,is_app_open,is_tab_open,get_browser_tabs}/skill.ts`; `perception/chromeState.ts:66-73`; `perception/systemStateObserver.ts:34`; `core/orchestrator.ts:724-745` |
| D2 (TRA-08) | `self_check`'s "tools" item is the last tool that ran. `tool_registry` is a count. "online" shows as VERIFIED. Redis on its in-memory fallback counts as online. There is no item for Chrome (CDP), PowerShell, the desktop session or the permission level. | `core/toolRegistryV2.ts:1121`; `monitoring/healthLedger.ts:35-41, 152`; `monitoring/healthManager.ts:96-108, 262-267, 351-364`; `core/selfCheck.ts:85` |
| D3 (TRA-10, B1 item) | The kernel counts any returned text as success, and its audit log always says success. Controllers return failures as text without throwing: "Permission denied.", "No running window found…", an `{ error }` JSON, an empty list. `control_keyboard/mouse/process/system` are not verified on any OS. | `control/pcControlKernel.ts:55-87`; `control/appController.ts:190,197`; `control/windowController.ts:79,84-85`; `control/systemController.ts:53-54`; `control/processController.ts:91-92`; `core/verifiers.ts:439-442` |
| D4 (TRA-19) | `open_app` reports success 50 ms after spawning the opener, with no exit check. Its check returns "unverifiable" off Windows (and for `ms-settings:` on Windows), and "unverifiable" counts as success. The allow-list uses Windows names. | `skills/automation/skill.ts:97-107`; `core/verifiers.ts:378-384`; `core/toolRegistryV2.ts:1157-1159`; `security/openAppPolicy.ts:34-53` |
| D5 (TRA-09) | There is no capability model. Tool metadata has no platform or requirement; `list_capabilities`, the skill loader and the planner's tool list never check the OS or whether a tool can run. | `core/toolRegistryV2.ts:70-91, 496-524`; `core/skillLoader.ts:254`; `core/planningToolSelection.ts:74-76, 234-243` |
| D6 (TRA-12) | Settled in A4: one permission rule for closing any tab (A4 P5, owner Q2). | `ai_workflows/runs/2026-11-01_safe-tab-targeting-a4/patch_plan.md` |

**Conventions to reuse:**
- the tool error codes read by `failureReply` (`orchestrator.ts:667-675`);
- `ChromeNotAvailableError` / `CdpUnavailableError` and the reply "My Chrome is not running, sir…" (`control/tabClose.ts:66-69`);
- JSON `{ success:false, error, spoken }` read as a failure by `reportedFailure` (`toolRegistryV2.ts:230-240`);
- the verification statuses `verified | failed | unverifiable`;
- the self-check states `VERIFIED | FAILING | BLOCKED | NOT_VERIFIED | SKIPPED`.

**Protected files involved:** `core/orchestrator.ts`, `core/toolRegistryV2.ts`, `core/toolCatalog.ts`, `core/skillLoader.ts`, `skills/automation/skill.ts`, `control/pcControlKernel.ts`, possibly `memory/redisCache.ts`. The protected tests `openAppSmokeTest`, `voiceRouteMockTest` and `deterministicCommandRouteTest` assert some of the old behaviour.

**Tests that assert the old behaviour (they change with A5):**
- `windowsStateFreshnessTest:119-120, 136-137` (no window when the read fails);
- `windowsToolsTest:152-158` and `verifyAfterActTest:137, 154, 163` (unverifiable = success);
- `openAppSmokeTest:3-12, 34-41` (Windows names on Linux);
- `fixtures/route-golden.json` (the planner tool lists, if tools are filtered by OS).
