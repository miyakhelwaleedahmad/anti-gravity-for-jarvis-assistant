# Test results

All runs: Linux container, Node 22, Python 3.11, Chromium available, no Windows, no Redis, no `.venv`, no live LLM keys. Command: `npx tsx tests/runAll.ts --ci` (each test gets its own temporary `JARVIS_DATA_ROOT`; no real memory, goals or permission files are touched). Type check: `npx tsc --noEmit`.

Kinds of evidence, kept apart below:
- local Linux runs (this container);
- Windows CI (GitHub `windows-latest`, a clean VM);
- simulated providers (stand-in `fetch` or model, no network);
- live providers (none run in this follow-up: the live job is `workflow_dispatch` only).

**Not run on the owner's Windows PC.** See REMAINING_RISKS.md §1.

## Gates

| When | Passed | Failed | Skipped | tsc |
|---|---|---|---|---|
| Baseline `30605cf` | 124 | 0 | 9 | clean |
| After Phase 1 (`d352a8f`) | 127 | 0 | 9 | clean |
| After Phase 2 (`9ec6311`) | 142 | 0 | 9 | clean |
| After Phase 3 (`9a851eb`) | 148 | 0 | 9 | clean |
| Final (Phases 4–5), under c8 coverage | 150 | 0 | 9 | clean |
| Phase A part 2 (`c71b6f0`) | 151 | 0 | 9 | clean |
| Phase D (`eafc0d4`) | 152 | 0 | 9 | clean |
| Phase C (`0c41e7b`) | 154 | 0 | 9 | clean |
| Phases E, F, G (`2bc7075`, `7ff1866`) | 157 | 0 | 9 | clean |
| CI fixes (`ccc9e84`) | 157 | 0 | 9 | clean |
| PC fixes (`295c4f5`, `ee1c8c8`), non-CI mode, Redis running | 161 | 0 | 6 environment | clean |
| Second PC run fixes (this commit), CI mode, Redis running | 160 | 0 | 9 | clean |

The 9 skipped are the same tests as before (table below). None counts as a pass.

## The owner's Windows PC (`28b0d2b`, Windows 10, Node 22.14)

The first run of these changes on the owner's PC. The owner reported these results; they were not run from here.

| Run | Passed | Failed | Environment | Skipped |
|---|---|---|---|---|
| `pnpm run typecheck` | clean | | | |
| `pnpm test` | 160 | 3 | 3 | 0 |
| `pnpm verify:windows` | 11 | 1 | — | 5 |

- **Failed (real):**
  - `errorRecoveryTest`: PC-03, a test budget;
  - `goalRuntimeTest`: PC-01, a runtime race;
  - `scenarioIntegrationTest`: PC-02, a diagnosis race.
- **"Environment":**
  - `dashboardAccuracyTest`: really needs Redis and an LLM. Redis was running, so this was not an environment failure (PC-04);
  - `dashboardHealthSystemTest`;
  - `windowsScriptsTest`: PowerShell 7 is not installed.
- **Passed on the PC with its keys present:** `finalIntegrationSuiteTest` and `successfulExecutionLifecycleAuditTest`. Several of their commands are routed without the model, so this is partial live-provider evidence.
- **Control Center:** `controlCenterTest`, including its real-registry section, passed on the PC.
- **`verify:windows`:** the only failure is the unanswered approval. Notepad, window actions, Calculator, clipboard and the dev server were skipped, not passed.

### Second run (`ee1c8c8`)

The owner reported these results; they were not run from here. The approval was typed in the real approval box.

| Run | Passed | Failed | Environment |
|---|---|---|---|
| `pnpm test` | 162 | 4 | 1 |
| `pnpm verify:windows` | 16 | 1 | — |

- **Failed:**
  - `dashboardAccuracyTest`, `dashboardHealthSystemTest`: "llm=unknown" (PC-07); the second also had the 6.3 s poll (PC-08);
  - `vectorSupervisorDashboardTest`, `verifyAfterActTest`: the stale Redis cache (PC-06).
- **Environment:** `windowsScriptsTest`, no PowerShell 7 (PC-10).
- **`verify:windows`:** Calculator was minimised after the first press (PC-09). Notepad, window actions, clipboard, screenshot and the dev server passed. Their window lookups used the fresh-PowerShell fallback, since the session's queries timed out (PC-08).

Not yet rerun on the PC after the fixes below.

## Windows CI (`windows-latest`)

| Commit | Passed | Failed | Skipped | Failures |
|---|---|---|---|---|
| `9a1cc21` (first run) | 147 | 7 | 5 | windowsScriptsTest, windowControlTest (exit hang), browser tests (Chrome start), dashboardHealthSystemTest, retry timing |
| `0559814` | 151 | 2 | 6 | Chrome remote debugging (fake USERPROFILE), upload outside folders |
| `c71b6f0` | 153 | 1 | 6 | scenarioIntegrationTest: 2 checks (output cut off) |
| `0c41e7b`, `7ff1866` | 156, 159 | 1 | 6 | scenarioIntegrationTest: the crash diagnosis lost the server's log line behind npm's error lines |
| `ccc9e84` | 159 | 1 | 6 | scenarioIntegrationTest, 2 checks: the tab list was read before the pages had their titles (test timing; the setup now waits for titles), and the crash diagnosis still misses the log line: the npm-lines change did not fix it on Windows. The next run prints what JARVIS kept for the crashed server |
| `a5a126f` | 159 | 1 | 6 | the same check; the printed detail showed the cause: JARVIS caught **0 output lines** from the backend even while it ran (`start: running=true n=0`). A server started as a detached `cmd /c npm run …` wrote nowhere JARVIS could read. Fixed in `86ca10d` (not detached on Windows) |
| `86ca10d` | **160** | **0** | 6 | none: all three CI jobs pass |

Skipped on Windows CI (6):
- `dashboardAccuracyTest`: needs Redis;
- `dashboardHealthSystemTest`: needs Windows PowerShell, a reachable LLM API and Redis;
- `sttReliabilityTest`: needs the `.venv`;
- `startupPerformanceTest`: needs `JARVIS_BRIDGE_TOKEN`;
- `finalIntegrationSuiteTest` and `successfulExecutionLifecycleAuditTest`: live LLM, opt-in.

`processControlSafetyTest`, `windowControlTest` and `windowsScriptsTest` (skipped on Linux) run and pass on Windows CI. They ran in the CI VM's own session, not on the owner's desktop.

Linux CI (`build-and-test`) failed once on `eafc0d4`: `browserControlAgentTest` had an order-dependent check, fixed in `7678ed7`. `python-checks` failed once on `0c41e7b`: the fake encoder used Python's salted `hash()` and failed for about 3% of salts (10 of 300 seeds here). Fixed in `ccc9e84`. On `ccc9e84`, `build-and-test` (with coverage) and `python-checks` pass; `windows` fails only `scenarioIntegrationTest` (table above).

Python tests, final run:
- `test_vector_persistence`: 23/23
- `test_vector_service_startup`: 23/23
- `test_vector_access`: 33/33 (new)
- `test_tts_retry_delay`: 12/12

Coverage, final run (c8 10.1.3; only files the tests load; `tests/` excluded):

| Measure | Coverage |
|---|---|
| Lines | 85.46% |
| Statements | 85.46% |
| Functions | 81.96% |
| Branches | 76.76% |

## Skipped (9) and why

| Test | Needs |
|---|---|
| dashboardAccuracyTest | a running Redis |
| dashboardHealthSystemTest | Windows PowerShell |
| processControlSafetyTest | the Windows process table |
| windowControlTest | the Windows window manager |
| windowsScriptsTest | PowerShell 7 (`pwsh`) |
| sttReliabilityTest | the Python `.venv` |
| startupPerformanceTest | `JARVIS_BRIDGE_TOKEN` |
| finalIntegrationSuiteTest | a live LLM API (now opt-in: `JARVIS_LIVE_TESTS=1`) |
| successfulExecutionLifecycleAuditTest | a live LLM API (opt-in, as above) |

## New tests, and what each one showed on the old code

"On the old code": the same test run against the file(s) before the fix, or "by code" where the old behaviour was confirmed by reading it rather than by running the test.

| Test | Finding | Final | On the old code |
|---|---|---|---|
| errorRecoveryTest (converted) | BUG-02 | 18/18 | 11 pass / 4 fail (illegal transition, "unexpected error") |
| speechStateTest | BUG-02, HYP-01 | 10/10 | new test; the bug itself was reproduced by errorRecoveryTest |
| toolTimeoutTest | REL-01 | 14/14 | quick call waited 39.8 s behind a stuck one |
| bridgeSecurityTest | SEC-01, SEC-11 | dev 7/7, token 13/13 | by code: no Origin check, `===` token compare, no size cap |
| voiceApprovalTest (extended) | SEC-02 | 35/35 | by code: a spoken yes approved level 3 |
| promptInjectionFlowTest | SEC-03, TEST-03 | 10/10 | by code: tool text in the synthesis system message; replies replayed unmarked |
| navigationPolicyTest | SEC-04, SEC-17 | 15/15 | by code: local addresses at level 1, no redirect check |
| memoryForgetTest | SEC-05, OPS-03 | 16/16 | no forget tool existed |
| childEnvTest | SEC-06 | 7/7 | by code: children got `{...process.env}` |
| projectScriptPolicyTest | SEC-07 | 6/6 | by code: `run_script` level 1 in any project |
| tests/python/test_vector_access.py | SEC-18 | 33/33 | a cross-site text/plain POST /clear with no token emptied the store (2 → 0) |
| vectorAuthTest | SEC-18 | 14/14 | (new token code) |
| nestedApprovalTest | SEC-08 | 16/16 | 7/16: inner level-3 tool ran unasked |
| fallbackPolicyTest | SEC-09 | 13/13 | 6/13: level-3 fallback ran for a level-1 call |
| commandObfuscationTest | SEC-10 | 53/53 | `bcd^edit` level 3 instead of 4; `shut^down`, `spsv windefend` passed the blocklist |
| fullControlLimitTest | SEC-12, SEC-19 | 20/20 | 120 min granted; file "until 2099" restored (~38 million min) |
| goalApprovalTest | SEC-13 | 12/12 | 3/12: recurring goal recorded without a question |
| secretFileTest | SEC-14 | 32/32 | 25/32: `read_file` returned the token file's text and `.env` |
| selfHealInstallTest | SEC-15, REL-08 | 10/10 | not run (it would install `difflib` from PyPI); confirmed by reading |
| skillTrustTest | SEC-16 | 10/10 | planted skill registered |
| cmdMetacharTest | SEC-20 | 19/19 | 8/19: `%OPENAI_API_KEY%`, `%PATH:~0,20%`, `HEAD^`, `!TEMP!` allowed |
| taskGraphRepairTest | BUG-01 | 9/9 | 4/9: B and C never ran after the repair |
| crashPolicyTest | REL-02 | 8/8 | by code: handlers only logged |
| requestScopeTest | REL-04, REL-05 | 6/6 | 5/6: running goal no longer tracked; signals already correct (REL-05 not reproduced) |
| retryPolicyTest | REL-06 | 4/4 | 3/4: effectful call ran 3 times |
| skillLoadOrderTest | HYP-02 | 3/3 | 1/3: first plan had 3 tools, no skills |
| llmTimingTest | PERF-03 | 13/13 | by code: watchdog 15 s < 32 s retry budget; the test shows a short watchdog resetting PLANNING |
| toolNameListsTest | ARCH-06 | 4/4 | 13/28 and 29/36 listed names were not tools |
| transitionLoggingTest | ARCH-07 | 5/5 | 5 empty catches around transitions |
| llmCancellationTest | REL-05 | 10/10 | 8/10: the second identical request failed when the first was cancelled (simulated provider) |
| shutdownStepsTest | ARCH-07 | 12/12 | by construction: the old jarvis.ts had empty catches and always said "shut down cleanly" |
| fullControlLimitTest (extended) | ARCH-05 | 23/23 | 20/23: asked and recorded "auto"; forged audit line; open_app asked by voice |
| routeGoldenTest | ARCH-01 | 143/143 | recorded from the code before the move |
| policyOwnershipTest | ARCH-04, ARCH-05 | 7/7 | would fail on the old skills (model-chosen source) |
| requestScopeTest (extended) | ARCH-03 | 9/9 | 3 new checks; the old fields did not produce a wrong outcome in this test |
| foregroundPriorityTest | PERF-02 | 9/9 | 2/9: background calls took the quota; the owner got a 429 (simulated provider) |
| controlCenterTest | OPS-01 | 34/34 | new feature |
| remoteAccessTest | OPS-02 | 30/30 | new groundwork |
| diagnosisRulesTest (extended) | REL-09 (Windows CI) | 18/18 | the new check fails with the old 6-line window; this did not fix the Windows CI case (the `ccc9e84` commit message says 19/19 by mistake) |
| browserControlAgentTest (fixed check) | TEST-01 | 72/72, three runs | the check could edit the other `/app` tab |
| goalRuntimeTest (extended) | PC-01 | 63/63 | 60/63: `paused/running`, executor started, `pending` |
| serverExitRaceTest | PC-02 | 4/4 | 2/4: "runs but does not answer" in the gap |
| approvalGateStructuredTest (extended) | PC-05 | 66/66 | new setting |
| memoryCacheTest | PC-06 | 9/9 | 4/9: a stale cached answer, another store's answer, "(empty)" after a write |
| vectorSupervisorDashboardTest, verifyAfterActTest | PC-06 | 8/8 and 23/23, each twice in a row with Redis | the second run failed |
| healthStatusTest | PC-07 | 10/10 | 7/10: "unknown … not checked yet" on the first probe; 0 tools read "online" |
| windowsStateSessionTest (extended) | PC-08 | 17/17, with real PowerShell 7.4.6 | stops at the first query over several lines: "PS query timed out after 300ms" |
| windowsStateFreshnessTest | PC-08 | 17/17 | its stand-in only took the old end line (6 failed until it accepted the one-line form) |
| windowsScriptsTest | PC-10 | 47/47, with real PowerShell 7.4.6 | — |
| llmTimingTest (extended) | PC-11 | 20/20 | 16/20: "abc", "-5", "0", "30s" fell back without a warning |
| tests/python (fake encoder) | TEST-01 | 23, 23, 33, 12 | old encoder failed 10 of 300 `PYTHONHASHSEED` values |

Converted to the real speech path (TEST-02), all passing:
- approvalGateStructuredTest
- registryRepairHonestyTest
- riskEngineTest
- secretSinksTest
- systemObservationTest
- taskFailureHonestyTest
- toolRegistryMetadataTest
- verifyAfterActTest
- worldStateTest

`voiceApprovalTest` keeps its own speaker model; the reason is in the file.

## Measurements

All on this Linux container (SSD). A slower PC disk or CPU will give larger numbers.

**ARCH-09 / PERF-04 (sync writes).** In Phase 5, one `writeFileSync` of a 2.1 MB agent archive blocked the event loop 28.8 ms (five: 106.6 ms). Measured again in the follow-up, split by step:

| Step | Time |
|---|---|
| `JSON.stringify` of the archive | 11–15 ms (synchronous in either write style) |
| `writeFileSync` | 2–20 ms |
| Audit log `appendFileSync` | 0.006 ms per line |
| Permission log rewrite | 0.56 ms |

No change. The archive write is not on the voice path, and the audit log stays synchronous so a record survives a crash.

**PERF-07 (memory lookup, vector service down)**, `npx tsx scripts/benchMemoryLookup.ts`, 40 lookups per size:

| Facts | Median ms | p95 ms | Max ms |
|---|---|---|---|
| 1,000 | 0.37 | 2.13 | 2.15 |
| 5,000 | 1.24 | 3.52 | 3.91 |
| 20,000 | 8.45 | 13.96 | 16.87 |
| 50,000 | 19.30 | 32.88 | 52.48 |

No index added.
