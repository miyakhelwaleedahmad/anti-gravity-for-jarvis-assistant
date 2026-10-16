# JARVIS repair checklist (audit `jarvis-audit-2026-10`)

Source: the owner's audit ZIP `jarvis-audit-2026-10.zip`: the 54-finding `MASTER_FINDINGS_REGISTER.md` and its detailed write-ups, diagrams and probes, written against `claude/jarvis-repair` @ `30605cf`. This pass started at `0f1f84a`. Earlier repair work on this branch (`docs/remediation/REMEDIATION_TRACKER.md`) had the register only; the detailed write-ups and probes were read here for the first time, and every finding was checked again against the code at `0f1f84a`.

How each finding was checked in this pass:
- **Probes.** The audit's five reproductions were run against the current code (copied out of the ZIP; loopback and temporary folders only). Results are in the rows below.
- **Tests.** Each finding's regression test was run on its own, in a fresh data folder (as `tests/runAll.ts` does), with Redis running: `npx tsx tests/<name>.ts`. All 44 passed.
- **Code.** The locations the write-ups name were read again where the earlier evidence did not cover them (SEC-04, SEC-07, SEC-16, REL-01, ARCH-06, ARCH-08, TEST-01).

Statuses: **Fixed** (in this repair, with a regression test) · **Already Fixed** (before this repair; evidence from this pass) · **Not Reproducible** (measured; not a problem worth a change) · **Blocked** (needs the owner's PC, live keys or an owner action) · **Accepted Risk** · **Open** · **In Progress**.

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
| REL-01 | High | A hung risky tool blocks all later risky calls; shell has no timeout | Probe: released at budget + grace. `system/processRunner.ts` stops the whole process tree on abort/timeout; signal reaches `adminController` | Budget enforced only through a signal the tool could ignore; `execa` without timeout or signal | Process-tree stop; sandbox stops waiting after budget + grace | `toolTimeoutTest` (its shell check runs on Windows CI) | `toolTimeoutTest` 14/14; probe above | Already Fixed (grace setting re-checked below) |
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
| SEC-18 | Med | Vector service: unauthenticated state changes; cross-site `POST /clear` | Probe: 403; `/docs` 401 | No auth, no Origin check, `/docs` on | `X-JARVIS-Token` on every route but `/liveness`; Origin refused; JSON-only; `/docs` off | `tests/python/test_vector_access.py`, `vectorAuthTest` | `vectorAuthTest` 14/14; Python test re-checked below | Already Fixed |
| BUG-01 | Med | After a repair, dependents stay "failed: Deadlock" | Probe: B runs, graph completes | `resetFailedNodes` reset only the given ids | Transitive reset; "Did not run: it depends on …" | `taskGraphRepairTest` | 9/9 | Already Fixed |
| REL-02 | Med | Uncaught errors only logged | `system/crashPolicy.ts`; `pnpm dev:supervised` | Handlers only logged | Shutdown and exit 1; supervisor restarts | `crashPolicyTest` (real children) | 8/8; supervisor not run on the PC | Already Fixed |
| REL-08 | Med | Self-heal `pip` into system Python | Only `.venv`'s Python; nothing without a `.venv` | Wrong interpreter | With SEC-15 | `selfHealInstallTest` §2–3 | 10/10 | Already Fixed |
| REL-09 | Med | Current code unverified on Windows | Windows CI green at `12c6925`/`0f1f84a` (163 passed, 0 failed, 6 skipped). Owner's PC ran `28b0d2b` and `ee1c8c8`; their failures were fixed (PC-01 to PC-12), not yet re-run on the PC | — | — | Windows CI job | CI only | Blocked (owner's PC) |
| HYP-01 | Med (prov.) | Background approval prompt moves foreground state | Confirmed earlier and fixed with BUG-02 | Playback start moved REFLECTING → SPEAKING | `speechStartMovesState` | `speechStateTest` §3 | 10/10 | Already Fixed |
| PERF-03 | Med | 15 s watchdog vs 3 × 10 s retries | `config/llmTiming.ts`; invalid values warned (PC-11) | Two separate numbers | One source; watchdog derived | `llmTimingTest` | 20/20 | Already Fixed |
| ARCH-01 | Med | `orchestrator.ts` too large | 2,849 lines; routing helpers moved out earlier (`core/voiceInput.ts`, `core/agentRouting.ts`) behind a golden test | One class, many jobs | First steps only | `routeGoldenTest` | 143/143 | Open (see its section) |
| ARCH-02 | Med | Overlapping health, event, memory subsystems | Still two health systems, three buses, two conversation stores; two files named `recoveryPlanner.ts` | — | — | — | — | Open (see its section) |
| ARCH-03 | Med | Mutable singletons; request state split | Plan outcome and stage timings in the request's ALS scope | Fields on a shared instance | ALS | `requestScopeTest` | 9/9 | Already Fixed |
| ARCH-06 | Med | Hard-coded tool-name lists drift | Two lists fixed earlier (`core/toolNameLists.ts`). The write-up also names `selectPlanningToolNames()` and the verb/alias lists in `jarvis.ts`, not yet checked | Hand-kept lists | — | `toolNameListsTest` | 4/4 | Open (rest of the lists) |
| ARCH-07 | Med | Unstructured logs; empty catches around transitions | Empty catches on transitions and shutdown fixed. The roadmap's bar ("one request reconstructable from one log file") not checked | — | — | `transitionLoggingTest`, `shutdownStepsTest` | 5/5, 12/12 | Open (logging bar) |
| TEST-01 | Med | No Windows job, coverage, live job | All four CI jobs exist and run. Legacy `test:voice-core`, `test:pc-control`, `test:all` chains still in `package.json` | — | — | CI | CI green | Open (legacy scripts) |
| TEST-02 | Med | State-free `speak` stubs hid BUG-02 | 9 tests use `tests/fakeTts.ts` | — | Fake TTS | the converted tests | pass in the suite | Already Fixed |
| OPS-02 | Med | No remote-access model | Groundwork only (`security/remoteAccess.ts`, `REMOTE_ACCESS.md`); all listeners loopback. Exposing JARVIS is out of scope for this repair by the owner's instruction | — | Deny-by-default policy | `remoteAccessTest` | 30/30 | Already Fixed (groundwork) |
| OPS-03 | Med | No way to forget a fact | `forget_memory` (risk 2) | No caller of `forgetFact` | Registry tool | `memoryForgetTest` | 16/16 | Already Fixed |

### Low

| ID | Sev. | Original claim | Verified now (evidence) | Fix | Regression test | Validation (this pass) | Final status |
|---|---|---|---|---|---|---|---|
| SEC-08 | Low | Nested approvals auto-pass | Scope matches tool, action, target | Scoped approvals | `nestedApprovalTest` | 16/16 | Already Fixed |
| SEC-09 | Low | Fallbacks skip their own checks | Riskier fallback registration throws | Registry rule | `fallbackPolicyTest` | 13/13; the write-up's "fallback call in the audit log" is re-checked below | Already Fixed (log re-checked below) |
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
| ARCH-04 | Low | Policy imports the modules it governs | Policy lists in `security/protectedTargets.ts`; the risk engine still imports validators from `tools/terminalTool.ts`, `tools/gitTools.ts`, `tools/devTools.ts`, `skills/automation/skill.ts`, `control/uiRefs.ts`, `perception/browserRefs.ts` | — | `policyOwnershipTest` | 7/7 | Open (see its section) |
| ARCH-05 | Low | No ownership table | Table in `REMEDIATION_REPORT.md`; model-chosen `source` fixed | — | `fullControlLimitTest`, `policyOwnershipTest` | 23/23, 7/7 | Already Fixed |
| ARCH-08 | Low | Stale docs and leftovers | Still present: `W:\jarvis-chrome-profile` hints (`control/browserController.ts:41`, `perception/chromeState.ts:70`); `requirements.txt:25` names `reflectionEngine.py` (no such file); tracked stale `data/goals.json`; 17 pre-September root reports; README counts | — | — | — | Open |
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
