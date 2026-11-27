# JARVIS repair checklist (audit `jarvis-audit-2026-10`)

Source: the owner's audit ZIP `jarvis-audit-2026-10.zip`: the 54-finding `MASTER_FINDINGS_REGISTER.md` and its detailed write-ups, diagrams and probes, written against `claude/jarvis-repair` @ `30605cf`. This pass started at `0f1f84a`. Earlier repair work on this branch (`docs/remediation/REMEDIATION_TRACKER.md`) had the register only; the detailed write-ups and probes were read here for the first time, and every finding was checked again against the code at `0f1f84a`.

How each finding was checked in this pass:
- **Probes.** The audit's five reproductions were run against the current code (copied out of the ZIP; loopback and temporary folders only). Results are in the rows below.
- **Tests.** Each finding's regression test was run on its own, in a fresh data folder (as `tests/runAll.ts` does), with Redis running: `npx tsx tests/<name>.ts`. All 44 passed.
- **Code.** The locations the write-ups name were read again where the earlier evidence did not cover them (SEC-04, SEC-07, SEC-16, REL-01, ARCH-06, ARCH-08, TEST-01).

Statuses: **Fixed** (in this repair, with a regression test) · **Already Fixed** (before this repair; evidence from this pass) · **Not Reproducible** (measured; not a problem worth a change) · **Blocked** (needs the owner's PC, live keys or an owner action) · **Accepted Risk** · **Open** · **In Progress**.

Final gate for this pass (Linux, Node 22, Redis running, `npx tsx tests/runAll.ts --ci`): **166 passed, 0 failed, 9 skipped** (each skip needs Windows, a live LLM key, a `.venv`, a bridge token or PowerShell 7; see `docs/remediation/TEST_RESULTS.md`). Python checks 23/23, 23/23, 33/33, 12/12; `tsc --noEmit` clean.

"Passed" below means run here on Linux (Node 22), and on Windows CI where noted. None of it is a run on the owner's PC.

## Probes against the current code

| Probe | Finding | At `30605cf` (audit) | Now (`0f1f84a` + this repair) |
|---|---|---|---|
| `bridgeOriginProbe.mts`, dev mode, no token | SEC-01 | `stt_result` delivered | refused, nothing delivered |
| `bridgeOriginProbe.mts`, token mode with the token, foreign Origin | SEC-01 | accepted | refused, nothing delivered |
| `vector_clear_probe.py` | SEC-18 | `POST /clear` 200, count 3 → 0; `/docs` 200 | `POST /clear` 403 ("Requests from web pages are not accepted"); `/docs` 401; `/stats` needs the token |
| `serialQueueProbe.mts` | REL-01 | quick call waited 39.8 s (not done within 25 s) | quick call done after 19.8 s: the 15 s budget plus the 5 s stop grace (`JARVIS_TOOL_STOP_GRACE_MS`); the hung call returns TIMEOUT |
| `dependentResetProbe.mts` | BUG-01 | B "failed: Deadlock", graph failed, B never ran | B ran, graph completed; round-1 label "Did not run: it depends on "A", which failed." |
| `errorRecoveryFaithfulSpeak.mts` (state-faithful `speak`) | BUG-02 | 12 passed, 3 failed, `ILLEGAL TRANSITION` ×5 | 15 passed, 0 failed, 0 illegal transitions, 0 "unexpected error" (the probe's stub also records `announce()`, which progress messages now use) |
| `toolCount.mts` | ARCH-06 | 74 tools | 75 (49 built-in + 26 skills), each with a catalogue entry |
| `scc.mjs` | — | 0 static cycles | 0 static cycles (217 files) |
| `reach.mjs` | ARCH-08 | 193/199 reachable | 211/219; the rest are entry scripts, type shims, `backup.ts` and the test-only `control/inputController.ts` |

## Findings

Severity as in the register. Test results are from this pass unless stated.

### High

| ID | Sev. | Original claim | Verified now (evidence) | Root cause | Fix | Regression test | Validation (this pass) | Final status |
|---|---|---|---|---|---|---|---|---|
| BUG-02 | High | Speaking mid-loop leaves SPEAKING; the next transition throws; repairs end in "unexpected error" | All three mid-loop callers the write-up names now use `announce()` (no state change): replan `orchestrator.ts:831`, repair `:1118`, mid-execution abort `:1450`; `speak()` only for the reply | `speak()` moved the state machine synchronously during the loop | `announce()` for progress; playback start moves the state only from IDLE/INTERRUPTED | `errorRecoveryTest` (real `speak()`, `fakeTts`), `speechStateTest` | probe 15/0; `errorRecoveryTest` 18/18; `speechStateTest` 10/10 | Already Fixed |
| REL-01 | High | A hung risky tool blocks all later risky calls; shell has no timeout | Probe: released at budget + grace. `system/processRunner.ts` stops the whole process tree on abort/timeout; signal reaches `adminController` | Budget enforced only through a signal the tool could ignore; `execa` without timeout or signal | Process-tree stop; sandbox stops waiting after budget + grace | `toolTimeoutTest` (its shell check runs on Windows CI) | `toolTimeoutTest` 14/14; probe above; with `JARVIS_TOOL_STOP_GRACE_MS=1000` the quick call is through at 15.8 s, within the audit's budget + 1 s. The 5 s default lets a stopped command end before the queue moves on | Already Fixed |
| SEC-01 | High (dev mode) | Bridge never checks Origin | Probe: refused in both modes | No `verifyClient` | Any browser Origin refused unless allow-listed | `bridgeSecurityTest` (real server, both modes) | both modes passed; `bridgeAuthUnitTest` 5/5 | Already Fixed |

### Medium

| ID | Sev. | Original claim | Verified now (evidence) | Root cause | Fix | Regression test | Validation (this pass) | Final status |
|---|---|---|---|---|---|---|---|---|
| SEC-02 | Med | Any voice or media can approve level ≤3 | `voiceApprovalMaxRisk()` default 2 | Any "yes" accepted | Level 3 by voice leaves the request pending | `voiceApprovalTest` | 35/35 | Already Fixed |
| SEC-03 | Med | Tool output in the synthesis **system** message; replies replayed in planning | `<untrusted_context>` user messages; `from_tool_output` history tag | Tool text at system trust | `security/untrustedText.ts` | `promptInjectionFlowTest`, `promptInjectionHardeningTest` | 10/10, 13/13 | Already Fixed |
| SEC-04 | Med | Injected agents keep risk-1 egress (navigate to `https://attacker.test/?q=<finding>`) | `browserPolicy.ts:93-95`: an agent opening a site its task does not name is level 2, over its limit of 1, on all three navigation paths (`riskEngine.ts:231, 260, 268`). Searches go only to the configured provider. The earlier tracker cited only the private-address part; the public-site case is in the code and test | Navigation level by scheme only | `navigationLevel()` | `navigationPolicyTest` §3 (`attacker.example/?q=secret` → 2, also via new tab and `open_url`) | 15/15; `browserControlAgentTest` 72/72 | Already Fixed |
| SEC-05 | Med | Facts have no provenance | `LongTermFact.origin`; planning labels facts; `forget_memory` | No origin field | Additive field (existing facts load) | `memoryForgetTest` | 16/16 | Already Fixed |
| SEC-06 | Med | Children inherit every secret | `system/childEnv.ts` on every spawn path | `{...process.env}` | Allow-listed environment | `childEnvTest` (real children print their env) | 8/8 | Already Fixed |
| SEC-07 | Med | Project scripts run without approval, including from agents | **Partly open at `0f1f84a`:** agents in other projects were level 2, but the owner's own request ran another project's script at level 1 with no question (`riskEngine.ts` dev case). The audit asks for approval for any project other than JARVIS. See its own section below | A script's text is that project's code; only agents were checked | see below | `projectScriptPolicyTest` | see below | Fixed |
| SEC-18 | Med | Vector service: unauthenticated state changes; cross-site `POST /clear` | Probe: 403; `/docs` 401 | No auth, no Origin check, `/docs` on | `X-JARVIS-Token` on every route but `/liveness`; Origin refused; JSON-only; `/docs` off | `tests/python/test_vector_access.py`, `vectorAuthTest` | `vectorAuthTest` 14/14; `test_vector_access.py` 33/33 (also `test_vector_persistence` 23/23, `test_vector_service_startup` 23/23, `test_tts_retry_delay` 12/12) | Already Fixed |
| BUG-01 | Med | After a repair, dependents stay "failed: Deadlock" | Probe: B runs, graph completes | `resetFailedNodes` reset only the given ids | Transitive reset; "Did not run: it depends on …" | `taskGraphRepairTest` | 9/9 | Already Fixed |
| REL-02 | Med | Uncaught errors only logged | `system/crashPolicy.ts`; `pnpm dev:supervised` | Handlers only logged | Shutdown and exit 1; supervisor restarts | `crashPolicyTest` (real children) | 8/8; supervisor not run on the PC | Already Fixed |
| REL-08 | Med | Self-heal `pip` into system Python | Only `.venv`'s Python; nothing without a `.venv` | Wrong interpreter | With SEC-15 | `selfHealInstallTest` §2–3 | 10/10 | Already Fixed |
| REL-09 | Med | Current code unverified on Windows | Windows CI green at `12c6925`/`0f1f84a` (163 passed, 0 failed, 6 skipped). Owner's PC ran `28b0d2b` and `ee1c8c8`; their failures were fixed (PC-01 to PC-12), not yet re-run on the PC | — | — | Windows CI job | CI only | Blocked (owner's PC) |
| HYP-01 | Med (prov.) | Background approval prompt moves foreground state | Confirmed earlier and fixed with BUG-02 | Playback start moved REFLECTING → SPEAKING | `speechStartMovesState` | `speechStateTest` §3 | 10/10 | Already Fixed |
| PERF-03 | Med | 15 s watchdog vs 3 × 10 s retries | `config/llmTiming.ts`; invalid values warned (PC-11) | Two separate numbers | One source; watchdog derived | `llmTimingTest` | 20/20 | Already Fixed |
| ARCH-01 | Med | `orchestrator.ts` too large | 2,849 lines at the start of this pass. The three seams the write-up names are now modules: planning tool selection (`core/planningToolSelection.ts`), spoken replies (`core/replyText.ts`), the deterministic router (`core/deterministicRoutes.ts`); earlier: `core/voiceInput.ts`, `core/agentRouting.ts`. Now 2,243 lines (see its section) | One class, many jobs | Behaviour-preserving moves behind golden tests | `routeGoldenTest`, `replyGoldenTest` | 441/441 (before the moves: 365 of 367, then 439 of 441), 32/32 (before: 30 of 32) | Fixed (the named seams); the stateful coordinator stays (Accepted Risk, see its section) |
| ARCH-02 | Med | Overlapping health, event, memory subsystems | **Health:** the two systems disagreed on Redis; the self-healing probe never reached it (see its section). The other services already read one source each (LLM `llmStatus`, vector `vectorMemorySupervisor`, the tool registry). **Events:** one transport; agent events are published on `messageBus` (`core/agents/events.ts`), and `conversationBus` is the busy/idle signal, a different job. **Conversation memory:** not reproducible: `agentMemory`'s conversation methods delegate to `memoryManager`, the only message store. **Two `recoveryPlanner.ts`:** renamed | Each health system probed Redis its own way | One Redis probe (`redisCache.probeRedis`); `core/stepRecovery.ts` | `redisHealthAgreementTest`, `sourceFileNamesTest` | 11/11 (old: 5/11), 4/4 (old: 2/4) | Fixed (health, naming); events and memory checked, no change |
| ARCH-03 | Med | Mutable singletons; request state split | Plan outcome and stage timings in the request's ALS scope | Fields on a shared instance | ALS | `requestScopeTest` | 9/9 | Already Fixed |
| ARCH-06 | Med | Hard-coded tool-name lists drift | Two lists fixed earlier (`core/toolNameLists.ts`). `selectPlanningToolNames()` (then `orchestrator.ts:2179`, now `core/planningToolSelection.ts`): all 61 quoted names it can return are registered, and `toolNameListsTest` already checks every name the selection asks for. The `jarvis.ts` and orchestrator *verb* lists are not tool names: they decide whether speech heard during playback counts as a command (echo filter) or is small talk. They stay separate on purpose: adding verbs such as "delete" to the echo filter would let JARVIS act on its own spoken question. The orchestrator's verb guard in `isSimpleConversationalInput` is redundant (only exact greetings return true) but harmless | Hand-kept lists | Lists from registered names | `toolNameListsTest` | 4/4; names checked against the 75 registered tools | Already Fixed |
| ARCH-07 | Med | Unstructured logs; empty catches around transitions | Empty catches on transitions and shutdown fixed earlier. The roadmap's bar ("a single request is reconstructable from one log file") was **not met**: the structured log carried the trace id for task-graph events only (see its section) | State changes, security events and tool calls went to three other places | Joined into the structured log under the trace id | `requestTraceLogTest`, `transitionLoggingTest`, `shutdownStepsTest` | 8/8, 5/5, 12/12 | Fixed |
| TEST-01 | Med | No Windows job, coverage, live job | All four CI jobs exist and run. **Leftover found and fixed:** `test:voice-core`, `test:pc-control`, `test:latency` ran test files directly, outside the runner's per-test data folders, so they wrote into JARVIS's real memory and goals (see its section) | — | Scripts run through `tests/runAll.ts --only=…` | `testScriptIsolationTest` | 4/4; CI green | Fixed |
| TEST-02 | Med | State-free `speak` stubs hid BUG-02 | 9 tests use `tests/fakeTts.ts` | — | Fake TTS | the converted tests | pass in the suite | Already Fixed |
| OPS-02 | Med | No remote-access model | Groundwork only (`security/remoteAccess.ts`, `REMOTE_ACCESS.md`); all listeners loopback. Exposing JARVIS is out of scope for this repair by the owner's instruction | — | Deny-by-default policy | `remoteAccessTest` | 30/30 | Already Fixed (groundwork) |
| OPS-03 | Med | No way to forget a fact | `forget_memory` (risk 2) | No caller of `forgetFact` | Registry tool | `memoryForgetTest` | 16/16 | Already Fixed |

### Low

| ID | Sev. | Original claim | Verified now (evidence) | Fix | Regression test | Validation (this pass) | Final status |
|---|---|---|---|---|---|---|---|
| SEC-08 | Low | Nested approvals auto-pass | Scope matches tool, action, target | Scoped approvals | `nestedApprovalTest` | 16/16 | Already Fixed |
| SEC-09 | Low | Fallbacks skip their own checks | Riskier fallback registration throws. Each fallback attempt is recorded in the call history under its own name (and medium/high ones in the sandbox's audit log, as primaries are) | Registry rule | `fallbackPolicyTest` (new check: the history records the fallback after the failed primary) | 14/14 | Already Fixed (test added, `6dc14e6`) |
| SEC-10 | Low | Substring blocklist | `security/commandObfuscation.ts` | Refuse obfuscation; show plain form | `commandObfuscationTest` | 53/53 | Already Fixed |
| SEC-11 | Low | `===` token compare, no `maxPayload`, `/health` detail | Constant-time, 16 MB cap, `/health` status only | — | `bridgeSecurityTest` | both modes passed | Already Fixed |
| SEC-12 | Low | 30 min documented, 120 allowed | `MAX_SESSION_MINUTES = 30` everywhere | — | `fullControlLimitTest` §1–3 | 23/23 | Already Fixed |
| SEC-13 | Low | Recurring goals without approval | `askOwner` for permanent/recurring/desktop goals | — | `goalApprovalTest` | 12/12 | Already Fixed |
| SEC-14 | Low | Token file readable by tools | `security/secretFiles.ts` refuses it everywhere. Moving the token into `.env` and deleting the file is the owner's step | — | `secretFileTest` | 32/32 | Already Fixed (code); owner step Blocked |
| SEC-15 | Low | Unapproved, unpinned `pip install` | Owner asked; pinned; `.venv` only; `difflib` removed | — | `selfHealInstallTest` | 10/10 | Already Fixed |
| SEC-16 | Low | Any `skills/*` folder loads | `skills/trusted-skills.json` hashes; unknown/changed folders not loaded. The write-up also suggests refusing skills with no catalogue entry: kept as derived metadata (never risk 0, not reversible, "high" asks). The skill must already be trusted by hash, and refusing would break the documented way to add an owner skill (`scripts/trustSkills.ts`) | — | `skillTrustTest` | 10/10 | Already Fixed |
| SEC-17 | Low | Loopback/LAN navigation at level ≤1 | `navigationLevel()` | — | `navigationPolicyTest` | 15/15 | Already Fixed |
| SEC-19 | Low | Restored full control without a cap | Refuses expiry > 30 min away etc. | — | `fullControlLimitTest` §4 | 23/23 | Already Fixed |
| SEC-20 | Low | `%VAR%` expansion under cmd.exe | `^`, `!`, `%NAME%`, `%NAME:~` refused by the allow-list (cmd.exe itself not exercised on real Windows) | — | `cmdMetacharTest` | 19/19 | Already Fixed |
| REL-03 | Low | Drain lock is a no-op | Flag removed (`jarvis.ts:189` is a comment saying why) | — | voice queue tests in the suite | suite | Already Fixed |
| REL-04 | Low | One `activeGoal` for overlapping requests | `activeGoals` by request id | — | `requestScopeTest` §1 | 9/9 | Already Fixed |
| REL-05 | Low | LLM calls use the newest abort controller | Per-caller signals at the provider | — | `llmCancellationTest`, `requestScopeTest` §2 | 10/10, 9/9 | Already Fixed |
| REL-06 | Low | Retry by risk tier by accident | `safeToRepeat()` | — | `retryPolicyTest` | 4/4 | Already Fixed |
| REL-07 | Low | Rollback advertised, never called | Hook removed; 0 callers of `.rollback(`; README claim gone | — | — (no behaviour) | grep | Already Fixed |
| HYP-02 | Low (prov.) | Early requests miss skill tools | `process()` waits for skill load (≤ 10 s) | — | `skillLoadOrderTest` | 3/3 | Already Fixed |
| ARCH-04 | Low | Policy imports the modules it governs | The policy lists moved earlier (`security/protectedTargets.ts`). Two fixed rules still lived in the modules they govern: open_app's allow-list in `skills/automation/skill.ts` (a skill folder is trusted by its description's hash, not its code) and run_command's allow-list in `tools/terminalTool.ts`. Both moved (see its section) | Policy defined in the tool or skill | Moved into `security/`, verbatim | `policyOwnershipTest` | 11/11 (7/11 before) | Fixed |
| ARCH-05 | Low | No ownership table | Table in `REMEDIATION_REPORT.md`; model-chosen `source` fixed | — | `fullControlLimitTest`, `policyOwnershipTest` | 23/23, 7/7 | Already Fixed |
| ARCH-08 | Low | Stale docs and leftovers | Were still present at `0f1f84a`: `W:\` Chrome hints, `requirements.txt` naming a missing file, README counts, 9 dead Python stubs, 20 pre-September root reports. Fixed (see its section). `data/goals.json` deliberately kept | — | `docsHygieneTest` | 7/7 | Fixed |
| ARCH-09 | Low | 139 sync fs calls | Measured (PERF-04) | — | — | measurements in TEST_RESULTS.md | Not Reproducible |
| PERF-02 | Low (prov.) | Background calls take the owner's quota | `core/foregroundGate.ts` | — | `foregroundPriorityTest` | 9/9 (simulated provider) | Already Fixed (live provider not measured) |
| PERF-04 | Low | Sync writes cause voice jitter | 2.1 MB archive: stringify 11–15 ms, write 2–20 ms, off the voice path | — | — | measurements | Not Reproducible |
| PERF-05 | Low | Agent concurrency vs old CPU | Resource monitor runs, readings in the Control Center; budgets need PC readings | — | — | — | Blocked (owner's PC) |
| PERF-07 | Low | Linear fact scan | 50k facts: median 19 ms, p95 33 ms (`scripts/benchMemoryLookup.ts`) | — | — | benchmark | Not Reproducible |
| TEST-03 | Low | Injection tests read source text only | Behavioural test through synthesis and the next plan | — | `promptInjectionFlowTest` | 10/10 | Already Fixed |
| TEST-04 | Low | "unexpected error" replies pass | `tests/replyChecks.ts` | — | `errorRecoveryTest`, `scenarioIntegrationTest` | 18/18, 36/36 | Already Fixed |
| OPS-01 | Low | No management UI | `system/controlCenter.ts` (off by default, loopback, token, CSRF) | — | `controlCenterTest` | 34/34 (not used on the PC) | Already Fixed |

Also in the write-ups but not register findings: **PERF-06** (pollers; "reasonable") and **PERF-08** (agent verification up to 20 s; deliberate, `JARVIS_AGENT_VERIFY`). No change.

## Work in this repair, one finding at a time

### SEC-07: a script of another project ran at the owner's request without a question

| | |
|---|---|
| **Verify** | `security/riskEngine.ts` dev case: only `getAgentPath()` raised the level. The owner's own request to run a script of a project outside the JARVIS folder stayed level 1: no question, under any policy. Its text is that project's code (a cloned repository, say), and a plan steered by text from it could pick it. |
| **Test first** | `tests/projectScriptPolicyTest.ts` rewritten for the owner path: first run asks (level 2, also without full control), shows the command; "no" → not run; "yes" → runs; the same unchanged script runs again without asking; changed text asks again; JARVIS's own scripts level 1; the agent checks kept. On the old code: **5 passed, 8 failed**, and the script ran although the stand-in owner said no (nothing asked). |
| **Fix** | `tools/devTools.ts`: a session record of scripts of other projects that ran (project, script name and its text). `security/riskEngine.ts`: the owner's first run of such a script is level 2 with `askOwner` (asks without full control; voice can approve at level 2 by default). JARVIS's own folder unchanged; agents unchanged. Nothing persisted: after a restart each script asks once again. |
| **Changed workflow** | A dev server or test script of one of the owner's other projects now asks the first time each session, including the automatic repair that starts it. `pnpm verify:windows` is unaffected: its test project is inside the JARVIS folder (`data\verify-windows-…`). |
| **Tests adjusted** | `tests/childEnvTest.ts`: the owner answers yes, and the test checks the question was asked showing the command. `tests/scenarioIntegrationTest.ts`: the setup's "earlier this morning" starts are approved once through the real gate, and a new check confirms each first start asked, showing its command. No assertion was removed. |
| **Validation** | `npx tsc --noEmit` clean. `projectScriptPolicyTest` 13/13. `childEnvTest` 8/8, `scenarioIntegrationTest` 36/36, `errorRecoveryTest` 18/18, `filesAndDevToolsTest` 52/52, `serverExitRaceTest` 4/4, `riskEngineTest` 127/127, `securityBypassTest` 54/54, `diagnosisRulesTest` 18/18, `approvalGateStructuredTest` 66/66, `dispatchAuthzTest` 32/32. |
| **Remaining** | Not run on the owner's PC. |

### TEST-01 (leftover): legacy test scripts wrote into JARVIS's real data

| | |
|---|---|
| **Verify** | `package.json` `test:voice-core`, `test:pc-control` (and so `test:all`) and `test:latency` ran `npx tsx tests/<name>.ts` directly. None of those 29 tests sets its own data folder, and many load the orchestrator, memory, goals or the permission session. `ai_workflows/_config/TEST_MATRIX.md` told agents to run `pnpm test:voice-core`, or tests one by one. |
| **Reproduction** | In this container's checkout (no owner data): `noThinkMemoryTest` run as the chain runs it wrote `memory/jarvis_memory.json`, `data/runtime/goals.json` and `data/episodes.jsonl` in the JARVIS folder. On the owner's PC those are the real memory and goals. |
| **Test first** | New `tests/testScriptIsolationTest.ts`: no package.json script runs a test file directly; `runAll --only=a,b` runs exactly those; an unknown name is an error. On the old code: **0 passed, 4 failed** (three scripts named; the runner ignored `--only` and started the whole suite until the 240 s limit). |
| **Fix** | `tests/runAll.ts`: `--only=a,b` (exact names, unknown name → exit 1). The scripts keep their names and run through the runner, so each test gets its own empty data folder. `TEST_MATRIX.md` points at the runner. |
| **Difference** | The old chains also ran `openAppSmokeTest notepad`, `openAppSmokeTest cmd` and `latencySmokeTest "open YouTube for me"`; the runner runs each file once with its defaults, as `pnpm test` and CI always did. |
| **Validation** | `npx tsc --noEmit` clean. `testScriptIsolationTest` 4/4. `pnpm test:voice-core`: 12 passed, 0 failed. `pnpm test:pc-control`: no unexpected failures (`processControlSafetyTest` needs Windows). Files written into the repository's own `memory/`, `data/`, `logs/` by both runs: none. |
| **Remaining** | Not run on the owner's PC. |

### ARCH-08: stale documentation and leftovers

| | |
|---|---|
| **Verify** | At `0f1f84a`: `--user-data-dir="W:\\jarvis-chrome-profile"` in `control/browserController.ts:41` and `perception/chromeState.ts:70` (the owner's old drive); `requirements.txt` listed `requests` "for reflectionEngine.py" (no such file; nothing imports `requests`); README said 33 tools (75 register) and "119 TS / 14 Python" files (217 / 5); 9 Python stubs referred to only by `scaffold.ps1`; 20 pre-September reports at the root. |
| **Test first** | New `tests/docsHygieneTest.ts` (each item above). On the old tree: **0 passed, 7 failed**. |
| **Fix** | Hints say `%USERPROFILE%\\jarvis-chrome-profile` (as `.env.example`). The stale `requests` section removed (`sentence-transformers` still pulls it in). README counts measured. Stubs and `scaffold.ps1` moved into `_legacy/` (moved, not deleted; `_legacy/README.md` says why). Reports moved into `docs/history/` with a README; `ai_workflows/_config/ROOT_FILE_AUDIT_GUIDE.md` updated. |
| **Kept on purpose** | `data/goals.json` stays. It is still the one-time seed of `data/runtime/goals.json` (`goalRuntimeMigrationTest`), and before that migration the app wrote the owner's live goals into it. Removing it from git would delete the owner's local copy at the next `git pull`. |
| **Validation** | `npx tsc --noEmit` clean; `docsHygieneTest` 7/7; `workspaceRootPortabilityTest` 26/26; `dependencyImportCheck`, `chromeStateSmokeTest` 7/7, `browserControlTest` 10/10, `browserObservationTest` 43/43, `skillTrustTest` 10/10, `toolNameListsTest` 4/4; `python -m compileall memory voice vision bridge` clean. |

### ARCH-07: one request in one log file

| | |
|---|---|
| **Verify** | `monitoring/traceWiring.ts` joined only task-graph events into `data/logs/jarvis.*.jsonl` with the trace id. State changes went to the console, approvals and refusals to `security_audit.log`, tool calls to the registry's memory (and `tool_audit.log` for medium/high risk). The roadmap's "done" was one file per request. |
| **Test first** | New `tests/requestTraceLogTest.ts`: one traced request with a state change, a tool call, a call approved at the console (real gate), a command the policy refuses; the log must hold each under the trace id, with no argument text and no console echo. On the old code: **2 passed, 5 failed** (only the "no argument text" and setup checks passed). |
| **Fix** | `security/securityAuditLogger.ts`: `onEvent()` gets each event after redaction (a listener error never stops the audit record). `core/toolRegistryV2.ts`: `onCall()` gets each recorded attempt without its arguments. `monitoring/traceWiring.ts` subscribes to those and to the state machine's `transition`/`watchdog_reset`. `monitoring/structuredLogger.ts`: `fileOnly()`, so these entries do not add console lines (the console already says these things). Command and target text are left out of the trace, as for task-graph nodes; `security_audit.log` keeps its full redacted record. |
| **Not changed** | The 739 `console.*` calls stay: the console is the owner's live view, and the bar is met by the file. |
| **Validation** | `npx tsc --noEmit` clean; static import cycles 0 (`scc.mjs`). `requestTraceLogTest` 8/8; `executionTraceTest` 13/13, `transitionLoggingTest` 5/5, `shutdownStepsTest` 12/12, `approvalGateStructuredTest` 66/66, `securityBypassTest` 54/54, `secretSinksTest` 23/23, `redactionTest` 51/51, `toolRegistryMetadataTest` 36/36, `toolPerformanceBenchmarkTest`, `errorRecoveryTest` 18/18, `speechStateTest` 10/10, `fallbackPolicyTest` 14/14. |

### ARCH-04: two security rules lived in the modules they govern

| | |
|---|---|
| **Verify** | `security/riskEngine.ts` imported `resolveTargetUrl` (open_app's website and app allow-lists, approval-only apps, refused paths, file types and shell characters) from `skills/automation/skill.ts`, and `validateDeveloperCommand` (the run_command allow-list) from `tools/terminalTool.ts`. The trusted-skills list hashes each skill's `description.json`, so a change to the skill's code changed a security decision without being flagged. |
| **Test first** | `tests/policyOwnershipTest.ts`: no security module imports from a skill; open_app's and run_command's allow-lists are defined in `security/`, and the skill and tool use those same functions; the risk engine takes both from there. On the old code: **7 passed, 4 failed**. |
| **Fix** | New `security/openAppPolicy.ts` and `security/developerCommands.ts`, with the code moved byte for byte (checked against the previous commit). The skill and the tool import from there and re-export, so their importers are unchanged. |
| **Kept where they are** | The risk engine still reads *state* that its own module keeps: element references (`perception/browserRefs.ts`, `control/uiRefs.ts`), the dev servers JARVIS started and project scripts (`tools/devTools.ts`), a repository's push target (`tools/gitTools.ts`). These are lookups of live state, not rules, and belong with that state. |
| **Validation** | `npx tsc --noEmit` clean; static import cycles 0. `policyOwnershipTest` 11/11, `openAppSecurityTest` 15/15, `openAppSmokeTest`, `cmdMetacharTest` 19/19, `runCommandSafetyTest` 11/11, `riskEngineTest` 127/127, `securityBypassTest` 54/54, `commandObfuscationTest` 53/53, `dangerousCommandMatchTest` 23/23, `skillTrustTest` 10/10, `toolRegistryMetadataTest` 36/36, `deterministicCommandRouteTest`, `appControlTest` 11/11. |

### ARCH-02: two answers to "is Redis up", and two files with one name

| | |
|---|---|
| **Verify** | Graphify (`graphify_file_neighbors` on both health modules) and grep, then each probe read side by side. `self_healing/healthChecker.ts` called `pingRedis`, which `memory/redisCache.ts` never exported; an `as any` cast hid that from the compiler, so the probe never reached Redis and always said ok. `monitoring/healthManager.ts` wrote and read one fixed key with no time limit. |
| **Reproduce** | A fake Redis server (the pattern of `redisReadyRaceTest`). Writes refused: the healer said ok; the dashboard said "round-trip OK", reading back the previous probe's value. Not answering: the healer said ok; the dashboard probe never returned. |
| **Test first** | `tests/redisHealthAgreementTest.ts`: answers, refuses writes, stops answering, goes away; both probes are asked each time. On the old code: **5 passed, 6 failed**. The first fix still failed once: run together, the two probes shared the key and read each other's value, so each probe now uses its own key. |
| **Fix** | `redisCache.probeRedis()`: a write and read of a fresh value under its own key (expires in 10 s), within 2 s; never throws. Both health systems call it. Not connected stays the in-memory fallback (ok / online), as before. |
| **Naming** | `core/recoveryPlanner.ts` (failed task steps) and `self_healing/recoveryPlanner.ts` (failed services). The step one is now `core/stepRecovery.ts` (`git mv`; imports and doc references updated; `docs/history` left as written). `tests/sourceFileNamesTest.ts`: no two source files share a name apart from `index.ts` and `skill.ts`; old code 2/4. |
| **Checked, no change** | Events: agent events are a filter over `messageBus` (one transport); `conversationBus` answers "is JARVIS busy", which autonomous jobs check before acting. Conversation memory: `agentMemory.addConversationMessage` and `getConversationHistory` call `memoryManager`; `agentMemory`'s own layers are task context and episodes. The two health loops stay: the dashboard keeps a snapshot, the healer records pipeline results; they now read the same source for each service. |
| **Validation** | `npx tsc --noEmit` clean. `redisHealthAgreementTest` 11/11, `sourceFileNamesTest` 4/4, `redisReadyRaceTest` 4/4, `healthStatusTest` 10/10, `providerHealthTest` 55/55, `vectorReadinessTest` 20/20, `vectorSupervisorDashboardTest`, `errorRecoveryTest` 18/18, `diagnosisRulesTest` 18/18, `goalRecoveryTest` 38/38, `actionQueueRecoveryTest` 11/11, `scenarioIntegrationTest` 36/36, `docsHygieneTest` 7/7, `selfHealInstallTest` 10/10. `dashboardAccuracyTest` and `dashboardHealthSystemTest` fail here with and without this change (no LLM key in this sandbox: "llm=offline"). |
| **Remaining risk** | A Redis failure is recorded on the `memory_to_context` pipeline, whose repair re-runs `memoryManager.init()`. That is a no-op once memory is loaded, so the pipeline is marked healed while Redis stays broken; the dashboard and the alert still show the failure. Behaviour on the owner's PC not checked. |

### ARCH-01: the orchestrator split along its seams

| | |
|---|---|
| **Verify** | `core/orchestrator.ts`: 2,849 lines. Each candidate block checked for instance state (`this.`), its callers and the constants only it uses. |
| **Test first** | Golden tests recorded from the code before each move: `tests/routeGoldenTest.ts` (route, normalised text, tools offered, heavy-context flag; 91 phrases, plus yes/no answers with the "try again?" offer open and expired) and the new `tests/replyGoldenTest.ts` (29 replies for fixed inputs). Each step also adds a check that the code lives in its new module, which failed before the step. |
| **Step 2** (`f1de430`) | `selectPlanningToolNames`, `shouldUseHeavyContext` and the 16 patterns only they use → `core/planningToolSelection.ts`. No instance state; class methods dedented, otherwise byte for byte. 2,849 → 2,629 lines. |
| **Step 3** (`589d4a5`) | The spoken-reply formatters (desktop/YouTube, trending, system and server status, command results, repairs, capabilities) → `core/replyText.ts`, byte for byte. 2,629 → 2,499. |
| **Step 4** (`e97739c`) | `matchDeterministicCommand` and its route phrases → `core/deterministicRoutes.ts`. One line changed: whether the "Shall I try it again?" offer holds is passed in instead of read from `this`. 2,499 → 2,243. |
| **Kept as is** | The orchestrator keeps one-line delegates and re-exports, so every caller and test is unchanged. Moves were checked line by line against the previous commit; static import cycles 0. |
| **Validation** | `npx tsc --noEmit` clean. `routeGoldenTest` 441/441, `replyGoldenTest` 32/32, and all 47 test files that import the orchestrator pass (each in its own data folder), among them `scenarioIntegrationTest` 36/36, `browserControlAgentTest` 72/72, `windowsToolsTest` 68/68, `desktopControlTest` 31/31, `backgroundResearchTest` 27/27, `registryRepairHonestyTest` 34/34. |
| **Accepted Risk (what remains)** | Request lifecycle (`process`, `runAgentLoop`), planning prompt assembly (`planPhase`), synthesis and streaming, speech, barge-in, watchdog and recovery stay in the orchestrator. They share the request's abort signal, plan state and speech queue, and run through the LLM; the golden tests cannot pin them down without a scripted model for every path. Moving them in this repair would risk behaviour for no fix. The audit's own advice keeps `runAgentLoop` as the coordinator. |

## The owner's PC run at `b81aeac` (171 passed, 2 failed, 2 environment)

### PC-13: `docsHygieneTest` timed out after 120 s

| | |
|---|---|
| **Seen** | `TIMEOUT docsHygieneTest 120115ms`, last line `PASS: no live source suggests a W:\ folder`: the second check never finished. |
| **Root cause** | The `requirements.txt` check looked up each named `.py` file with `fs.readdirSync(repo, { recursive: true })`: the whole folder, once per name (4 names). That read `node_modules`, `.git`, a Python `.venv` and `data`. Measured here: 70,020 entries without a `.venv` (0.7 s); 314,832 with a stand-in `.venv` of 60,000 files (2.5 s). On the owner's PC (a real `.venv`, Windows file system, on-access scanning) that ran past the 120 s limit. A test bug, not a JARVIS bug. |
| **Fix** | One walk of JARVIS's own files, skipping dependency, cache, build and data folders and not following links; both checks use it. The `.py` lookup is stricter than before: it no longer counts copies under `_legacy/` or `node_modules`. A new check asserts the walk read none of those folders and fewer than 5,000 files (578 here). |
| **Proof** | With the stand-in `.venv`: whole test 3.4 s, 578 files read (before: 4 walks, 314,832 entries). Five runs without it: 1.8–2.1 s, 8/8. Mutations: a `.ts` file containing `'W:\\jarvis-chrome-profile'` → that check fails; a `requirements.txt` comment naming `no_such_file.py` → that check fails. `runAll --only=docsHygieneTest,sourceFileNamesTest,testScriptIsolationTest` 3 passed; `tsc --noEmit` clean. Not yet rerun on the owner's PC. |

### PC-14: `parallelizationTimeoutAuditTest`: "Health probe took > 300ms (855.0ms)"

| | |
|---|---|
| **Seen** | One `healthManager.probe()` timed against a fixed 300 ms: 855 ms on the owner's PC. Passes on CI and here, where no LLM key is set. |
| **Traced** | Graphify (`graphify_find probe`, `graphify_callers` on `HealthManager.probe`) and the branch code: `probe()` runs its five service probes with one `Promise.all`; `jarvis.ts` starts the first probe without waiting for it (`.then`); the dashboard refresh and tests wait for it. |
| **Root cause** | Not a sequential wait. With a key set, the first probe waits for the first LLM reachability check (a request to the provider's `/models`, up to 6 s; done on purpose so the dashboard does not show "unknown" at start). Reproduced with a stand-in provider answering in 800 ms: whole probe 819 ms, LLM 818 ms, every other service ≤ 24 ms, a second probe 4 ms. The old test then fails exactly as on the PC (816.7 ms). The test held a network round trip to a 300 ms budget and did not test parallelism at all. Production code unchanged. |
| **Fix (test)** | Each service probe is timed. Local work keeps the 300 ms budget per service; the first LLM check is reported and bounded at 6.5 s; the whole probe may not exceed its slowest service by more than 100 ms; with every service made 200 ms slower the probe must finish under 500 ms (in sequence it takes ≥ 1,000 ms), on any machine, key or not; a later probe (dashboard poll) must stay under 300 ms. |
| **Proof** | No key: first probe 25–35 ms, five slowed services 205–207 ms, later probe ~4 ms, 5/5 runs. Stand-in 800 ms provider: first probe 819 ms, passes. Mutation (`probe()` awaits each service in turn): 1,020 ms, fails. Neighbours `healthStatusTest`, `redisHealthAgreementTest`, `redisReadyRaceTest`, `providerHealthTest`, `vectorSupervisorDashboardTest`, `toolTimeoutTest`, `vectorReadinessTest` pass; `tsc --noEmit` clean. Not yet rerun on the owner's PC. |

### PC-15: `finalIntegrationSuiteTest` timed out at 120 s ("needs a reachable LLM API")

| | |
|---|---|
| **Seen** | `TIMEOUT … 120393ms`, reported as "failed for a missing prerequisite". On the same run `dashboardAccuracyTest`, which needs the LLM, passed, so the provider was reachable: the label was attached without a check. |
| **Root cause** | (1) Not a real test: a command passed whenever `orchestrator.process()` returned, which it always does. Run here without a key: 4 commands logged "Planning failed … Goal marked FAILED" and the suite still said "12 PASSED"; `expectedTool` was never compared. (2) It ran in every ordinary `pnpm test` (only `--ci` skipped it), with the real provider and real desktop actions (opening WhatsApp, Chrome, Calculator, VS Code, YouTube, Downloads, Settings, a screenshot, "Close Chrome"); voice-sourced approvals wait 20 s each. (3) Its expectation for "Search Google …" was stale (routed to `site_search`, not `web_search`). |
| **Fix** | `tests/livePreflight.ts`: no key, or the provider not usable → `BLOCKED: <reason>`, exit 3, within seconds (key never printed); used by both live tests. The test now passes a command only if its expected tool was called (registry call record, plus task-graph steps refused before they run); every approval is answered "deny" at once and recorded, so nothing needing approval runs. Runner: live-provider tests are skipped in every run unless `--live` (`pnpm test:live`); a new **blocked** verdict (exit 3 + `BLOCKED:` line), never a pass, makes the run exit non-zero; the summary counts passed · failed · timed out · blocked · environment · skipped, and lists why each skipped test was skipped. |
| **Proof** | Ordinary run: both live tests SKIP with the reason, 2 s. `--live` without a key: both BLOCKED in ~1.5 s, exit 1. Unreachable provider: BLOCKED ("network: fetch failed"). Simulated provider (stand-in `fetch`, no network): 12/12, with "Close Chrome" → `control_app` refused "needs full control mode (risk level 2)"; wrong-tool mutation: 4 FAIL. Forced timeout → TIMEOUT; mutated test → FAIL. `tsc --noEmit` clean. **Live run against the real provider: not done here** (no key; this sandbox cannot reach the provider); the owner runs `pnpm test:live`. |
| **Remaining** | `successfulExecutionLifecycleAuditTest` now blocks without a provider, but several of its checks are still weak (`assert(true, …)` for deterministic commands); left as is. |

### PC-16: `windowsScriptsTest` needs PowerShell 7

| | |
|---|---|
| **Seen** | `FAIL windowsScriptsTest 1876ms (expected here: needs PowerShell 7, pwsh (JARVIS_TEST_PWSH))`: the runner ran a test whose prerequisite its own check had already found missing, and the test said so by failing. |
| **Fix** | Run directly without PowerShell 7, the test prints `BLOCKED: <how to install>` and exits 3 (blocked, not a failure of the scripts). The runner skips, in every mode, a test whose host-checked prerequisite is missing (PowerShell 7, Chromium), with the reason and the install steps; previously only `--ci` did. Nothing is installed or changed on the PC. |
| **Proof** | Direct run without pwsh: BLOCKED with the install steps, exit 3; with `JARVIS_TEST_PWSH` naming a missing file: BLOCKED naming it. Runner without pwsh: SKIP with the reason. **With real PowerShell 7.4.6 here (`JARVIS_TEST_PWSH`): PASS (26 s).** Windows CI (`windows-latest`, pwsh preinstalled) passed it at `b81aeac`. Not run on the owner's PC: PowerShell 7 is not installed there. |

### PC-17: PowerShell 7 installed, but the tests still found none

| | |
|---|---|
| **Seen** | After `winget install --id Microsoft.PowerShell`, `pwsh -v` answered `PowerShell 7.6.7`, yet in the same CMD window the runner skipped `windowsScriptsTest` with "No PowerShell 7 (pwsh) found". (`pnpm test:live` passed 2/2 against the real provider in the same run: `finalIntegrationSuiteTest` 104 s, `successfulExecutionLifecycleAuditTest` 17 s.) |
| **Cause (confirmed on the PC)** | `findPwsh()` only accepted a file that `fs.existsSync` reports. On the owner's PC `where pwsh` gives `C:\Users\imac\AppData\Local\Microsoft\WindowsApps\pwsh.exe`: a Windows app execution alias, which CMD starts but `fs.existsSync` reports missing. |
| **Fix** | After the PATH and Program Files checks, ask the system to start `pwsh` and accept it only if it reports version 7 or later; the result is cached. |
| **Proof** | Here: on PATH, found (1 ms); absent, none (4 ms); on PATH but hidden from `fs.existsSync` (the alias case, simulated): found by the new step, and `windowsScriptsTest` passes through the runner (22.8 s). `tsc --noEmit` clean; `windowsStateSessionTest`, `browserObservationTest`, `browserControlAgentTest`, `desktopControlTest`, `errorRecoveryTest` pass. **On the owner's PC at `881ff63`: `windowsScriptsTest` PASS (88.6 s), PowerShell 7.6.7.** |

### The owner's PC after PC-13 to PC-17

| Run | Result |
|---|---|
| `pnpm test` at `1d9fc19` | 172 passed · 0 failed · 0 timed out · 0 blocked · 0 environment · 3 skipped (the two live tests, not asked for; PowerShell 7 not yet installed) |
| `pnpm test:live` at `1d9fc19`, real provider | 2 passed: `finalIntegrationSuiteTest` 104 s, `successfulExecutionLifecycleAuditTest` 17 s |
| `windowsScriptsTest` at `881ff63`, PowerShell 7.6.7 | PASS, 88.6 s |

Near the runner's 120 s limit on this PC: `finalIntegrationSuiteTest` (104 s) and `windowsScriptsTest` (88.6 s). A slower day could show them as TIMEOUT without a defect.


## Coverage check of the audit ZIP (second upload, `a11f1450-jarvis-audit-2026-10.zip`)

Byte-for-byte the same ZIP as the first upload (SHA-256 `24b97444…f147`, 44 files: 13 reports, 18 diagrams, 13 probe files).

| Check | Result |
|---|---|
| Every finding ID named in any of the 44 files has a row above | Yes, except three: **PERF-01** (the register's own alias for REL-01, fixed); **PERF-06** (background pollers; the audit already calls it mitigated: Graphify `graphify_file_neighbors` on `perception/systemStateObserver.ts` and the branch code show the pollers still go through the one persistent PowerShell session, intervals configurable); **PERF-08** (agent verification delay, a documented choice; `JARVIS_AGENT_VERIFY=0` and `JARVIS_AGENT_VERIFY_TIMEOUT_MS` still control it, `sevenAgentTest`). Neither PERF-06 nor PERF-08 is among the register's 54 findings |
| Probes run against today's code | All of them. The two not in the table at the top: `perfProbe.mts`: registry overhead 0.26 / 0.14 / 0.05 ms per call (low sequential / medium sequential / medium parallel), same order as the audit's 0.12–0.18 / 0.04–0.07 / 0.03; `checkRefs.py`: 477 citations, 19 no longer resolve, all explained: 14 by this repair's own moves (orchestrator shortened, ARCH-01; `core/recoveryPlanner.ts` → `core/stepRecovery.ts`, ARCH-02; Python stubs → `_legacy/`, ARCH-08; `tools/terminalTool.ts` rules → `security/developerCommands.ts`, ARCH-04), 5 by files that did not exist at `30605cf` either (the audit names them as already removed or as a suggestion) |
