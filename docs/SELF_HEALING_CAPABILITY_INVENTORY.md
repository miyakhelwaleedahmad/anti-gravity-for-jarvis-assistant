# Self-healing: inventory of existing capabilities and regression evidence

The self-healing work (Phases 1–3 so far) is an addition to JARVIS. This file lists what JARVIS already does, where it lives, which tests cover it, and the result of those tests on the code **before** any self-healing change and on the current code. It says what was not verified here.

## How it was checked

- **Before:** commit `4cc0f67`, the last commit before any self-healing change, checked out in a separate git worktree.
- **After:** the current branch. Phase 2 was compared first (the table below), then Phase 3 again (its own section).
- **Suite:** `npx tsx tests/runAll.ts --ci` on Linux, with Redis on 127.0.0.1 and a Python environment for the real speech test (`JARVIS_TEST_PYTHON`). Every test runs in its own empty data folder (`JARVIS_DATA_ROOT`), so no real memory, goals or permissions were touched.
- **Registry snapshot:** a script loaded every tool and skill exactly as JARVIS does at startup (`registerAllTools()` plus the skill loader), then dumped:
  - each tool's name, risk level, metadata, input fields, fallbacks, retry policy and verifier;
  - all specialist and worker roles, with their tools, maximum risk, child roles and behaviour;
  - the base permission level and the level-2 policy;
  - the risk engine's decision for sample calls (open an app, a blocked `del /s`, a browser click, closing a window, writing into `C:\Windows`, a web search, typing text).

  It ran on both trees and the two outputs were compared byte for byte.

| | Before (`4cc0f67`) | After (current) |
|---|---|---|
| Test files | 185 | 187 (+ `healthLedgerTest`, `issueStoreTest`) |
| Passed | 176 | 178 |
| Failed / timed out / blocked | 0 / 0 / 0 | 0 / 0 / 0 |
| Skipped (environment) | 9 | 9 (the same 9) |
| Tests whose result changed | — | none |
| Registry snapshot | 75 tools, 7 specialists, 16 workers | **identical** (byte-for-byte) |

### Phase 3 (read-only self-check) compared again

- **Registry snapshot:** no tool removed or changed; one tool added (`self_check`, risk 0, read-only). Specialists, workers, base permission level, level-2 policy and the sample risk decisions are identical.
- **Routing:** 276 phrases taken from the routing tests, each tried with the "try again?" offer open and closed, were run through the router on the baseline and on Phase 3. Only phrases that had no route before changed, and only to one of the four new routes. "system check" and "status" still mean the PC's status, and "fix my app" is still the app diagnosis. "what are the open issues" is deliberately not taken, since it may mean a repository's issues.
- **Golden fixtures:** `routeGoldenTest` and `replyGoldenTest` failed once, because the capability replies now say "I have 76 tools" instead of 75. The fixtures were re-recorded with `--record`; with 76 mapped back to 75 they are byte-identical to before.
- **Known limit:** every new request stops the foreground request in flight (`core/orchestrator.ts`, existing behaviour), and "why are you stuck?" is a request. It reads what was running *before* that happens, and says that asking stopped it; background goals and agents are not stopped. Answering without stopping it would mean changing how the orchestrator serialises requests, and that was not done.

## Capabilities

"Linux CI" means the tests ran here, on Linux, against real components where the test says so (a real headless Chromium for the browser tests). It is not your Windows PC.

| Capability | Where | Tests | Before | After | Needs your Windows PC |
|---|---|---|---|---|---|
| Browser observation over CDP (tabs, page text, structure, untrusted-text wrapper) | `control/browserController.ts`, `control/browserAgent.ts` | `browserObservationTest` (real headless Chromium), `browserControlTest`, `chromeStateSmokeTest` | pass | pass | Your own Chrome profile and real sites |
| Browser control (navigate, tabs, click, type, select, scroll, screenshot, download, upload) | `control/browserAgent.ts`, `security/browserPolicy.ts` | `browserControlAgentTest` (real Chromium via the registry, risk engine and approval), `navigationPolicyTest`, `scenarioIntegrationTest` | pass | pass | Same |
| Desktop control through the browser (YouTube search/play) | `control/youtubeControl.ts` | `desktopControlTest`, `voiceYouTubeIntegrationTest` | pass | pass | Real YouTube in your Chrome |
| Windows/PC control: apps, windows, processes, input, system | `control/*Controller.ts`, `control/pcControlKernel.ts`, `control/win_automate.ps1`, `control/uia.ps1` | `appControlTest`, `inputControlTest`, `mouseKeyboardControlTest`, `pcControlKernelTest`, `systemControlSafetyTest`, `openAppSecurityTest`, `openAppSmokeTest`, `closeAppRouteTest`, `windowsToolsTest` (parsers and command building), `windowsStateFreshnessTest`, `windowsStateSessionTest` | pass | pass | **Yes.** `windowControlTest`, `processControlSafetyTest` and `windowsScriptsTest` are skipped on Linux (no Windows window manager, process table or PowerShell 7). Run `pnpm verify:windows` and `pnpm test` on your PC |
| Files and development tools (fs, git, tests/builds, dev servers) | `control/fileController.ts`, `core/tools/*` | `filesAndDevToolsTest`, `fileControlSafetyTest`, `fileToolWorkspaceSafetyTest`, `projectScriptPolicyTest`, `runCommandSafetyTest` | pass | pass | Windows paths and shells |
| Seven specialist agents: research, browser, pc, coding, data, qa, memory (plus 16 workers) | `core/agents/specialists.ts`, `core/agents/*` | `sevenAgentTest`, `agentSpecialistsTest`, `agentRuntimeTest`, `a2aProtocolTest`, `delegationRoutingTest`, `jarvisAgentIntegrationTest`, `recursiveResearchExampleTest`, `backgroundResearchTest` | pass | pass; role definitions identical in the snapshot | Live model runs (`pnpm test:live`) |
| Task graph and its repair | `core/taskGraphEngine.ts` | `taskGraphRepairTest`, `toolGapAndReplanGuardTest`, `parallelizationTimeoutAuditTest` | pass | pass | — |
| Orchestrator, routing, planning, reflection | `core/orchestrator.ts`, `core/deterministicRoutes.ts`, `core/reflectionEngine.ts` | `routeGoldenTest`, `replyGoldenTest`, `deterministicCommandRouteTest`, `plannerDecisionAuditTest`, `taskFailureHonestyTest`, `errorRecoveryTest`, `supersededRequestTest`, `fullSystemIntegrationTest` | pass | pass | — |
| Tool registry: metadata, verification after acting, retries, fallbacks, timeouts | `core/toolRegistryV2.ts`, `core/verifiers.ts` | `toolRegistryMetadataTest`, `verifyAfterActTest`, `retryPolicyTest`, `fallbackToolStrategyTest`, `toolTimeoutTest`, `toolExecutionPipelineVerificationTest`, `registryRepairHonestyTest`, `toolNameListsTest` | pass | pass; 75 tools identical in the snapshot | — |
| Skills: loading order, trust | `core/skillLoader.ts`, `skills/` | `skillLoadOrderTest`, `skillTrustTest` | pass | pass; skill tools included in the snapshot | — |
| Memory: facts, episodes, vector store, documents (RAG), forgetting | `memory/*` | `episodicPersistenceTest`, `memoryForgetTest`, `memoryCacheTest`, `noThinkMemoryTest`, `ragPipelineTest`, `vectorAuthTest`, `vectorReadinessTest`, `vectorStartupGateTest` | pass | pass | Your real memory files (never touched by tests) |
| Goals: lifecycle, runtime, recovery, learning, approval | `core/goal*.ts` | `goalLifecycleTest`, `goalRuntimeTest`, `goalRecoveryTest`, `goalLearningTest`, `goalApprovalTest`, `goalAgentIntegrationTest`, `goalRuntimeMigrationTest` | pass | pass | — |
| Voice: wake word, STT, TTS, barge-in, echo filter, spoken approval | `voice/*.py`, `bridge/nodeBridge.ts`, `core/voiceInput.ts` | `realTtsHandoffTest` (real `voice/tts.py`), `voiceApprovalTest`, `ttsDeliveryLifecycleTest`, `speechOutcomeHealthTest`, `bargeInEchoTest`, `echoFilter*Test`, `voiceQueueAntiDeadlockTest`, Python tests in CI | pass | pass | **Yes:** a real microphone and speakers. `sttReliabilityTest` is skipped here (needs the `.venv` with faster-whisper) |
| Permissions: session levels, full-control limits, risk engine | `control/permissionSession.ts`, `security/riskEngine.ts` | `permissionSessionTest`, `riskEngineTest`, `fullControlLimitTest`, `policyOwnershipTest`, `dispatchAuthzTest` | pass | pass; base level, level-2 policy and sample decisions identical in the snapshot | — |
| Approval gates | `security/approvalGate.ts`, `security/approvalScope.ts` | `approvalGateStructuredTest`, `approvalPathsTest`, `nestedApprovalTest`, `securityBypassTest`, `approvalTypeAheadTest`, `promptInjectionFlowTest` | pass | pass | Answering a real prompt on your PC |
| Redaction and secrets | `security/redactor.ts`, `security/secretFiles.ts` | `redactionTest`, `secretSinksTest`, `secretFileTest` | pass | pass | — |
| Health dashboard and watchdogs | `monitoring/healthManager.ts`, `self_healing/*` | `healthStatusTest`, `providerHealthTest`, `watchdogUnitTest`, `selfHealInstallTest` | pass | pass | `dashboardAccuracyTest`, `dashboardHealthSystemTest` are skipped here (need a reachable LLM API and Windows PowerShell) |
| **Obsidian connection** | **Not in this repository.** No code, configuration or MCP server refers to Obsidian; `.obsidian/` is only listed in `.gitignore`. | — | — | — | If you connect to Obsidian through something on your PC (Claude Desktop MCP, an Obsidian plugin), it was not visible here and was not tested. Phase 2's note mirror is **off** unless `JARVIS_OBSIDIAN_VAULT` is set, and then writes only under `<vault>/JARVIS/Repairs/` |

## What the self-healing changes touch in existing code

Each change only adds behaviour; no existing branch was removed. Recording a failure is wrapped so that a failure to record never changes the caller's result.

| File | Change |
|---|---|
| `core/toolRegistryV2.ts` | A faulty call (crash, time-out, failed check) is also written to the issue store; `lastFault(tool)` added. Results, retries, approvals and refusals unchanged. |
| `core/reflectionEngine.ts` | `ReflectionResult.failureSignatures` added (optional). Classes and strategies unchanged. |
| `core/goalRecovery.ts`, `core/goalRuntime.ts` | `RecoveryDecision.signature` added; a transient or unrecoverable task failure is recorded with its goal/task ids. Decisions unchanged. |
| `self_healing/failureClassifier.ts`, `failureDetector.ts` | `ClassifiedFailure.signature` added; service failures are recorded. Events unchanged. |
| `core/orchestrator.ts` | An unexpected error (not a rate limit, time-out, network error or abort) is recorded. The reply is unchanged. |
| `monitoring/healthLedger.ts` | Phase 1. `isToolFault` now counts `VERIFICATION_FAILED` as a tool fault, so a tool whose effect was missing shows as degraded instead of being ignored. |
| `jarvis.ts` | `startIssueRecording(healthLedger)` at startup. |
| `core/deterministicRoutes.ts` | Phase 3: four routes for questions about JARVIS itself, checked after every existing route except help. |
| `core/orchestrator.ts` | Phase 3: one branch for those routes, through the registry's `self_check` tool; before "why are you stuck?" supersedes the request in flight, it reads that request's state. |
| `core/planningToolSelection.ts` | Phase 3: offers `self_check` to the model only for questions that name JARVIS ("yourself", "your health", "self check"). |
| `core/tools/index.ts`, `core/toolCatalog.ts`, `README.md` | Phase 3: `self_check` registered with risk-0 metadata; README count 75 → 76. |

New files are written only under `data/repairs/` (git-ignored) and, if enabled, the vault folder above.
