# Test results

All runs: Linux container, Node 22, Python 3.11, Chromium available, no Windows, no Redis, no `.venv`, no live LLM keys. Command: `npx tsx tests/runAll.ts --ci` (each test gets its own temporary `JARVIS_DATA_ROOT`; no real memory, goals or permission files are touched). Type check: `npx tsc --noEmit`.

**Not run on Windows.** See REMAINING_RISKS.md §1.

## Gates

| When | Passed | Failed | Skipped | tsc |
|---|---|---|---|---|
| Baseline `30605cf` | 124 | 0 | 9 | clean |
| After Phase 1 (`d352a8f`) | 127 | 0 | 9 | clean |
| After Phase 2 (`9ec6311`) | 142 | 0 | 9 | clean |
| After Phase 3 (`9a851eb`) | 148 | 0 | 9 | clean |
| Final (Phases 4–5), under c8 coverage | 150 | 0 | 9 | clean |

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

## Measurement (ARCH-09 / PERF-04)

`writeFileSync` of one 2.1 MB agent archive JSON blocks the event loop 28.8 ms here; five in a row block it 106.6 ms. This was measured on a container SSD, and a slow PC disk will be slower.
