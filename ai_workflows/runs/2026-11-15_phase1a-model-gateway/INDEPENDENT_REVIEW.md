# Independent Review — Phase 1A (Stage 05b)

> Run `2026-11-15_phase1a-model-gateway` · branch `claude/jarvis-repair` · base `c4ac909` (HEAD) · changes uncommitted
> Reviewed 2026-11-15 in a Linux cloud container. This is not a human review, and nothing here was run on the owner's Windows PC.

## 1. Reviewer and method

I am a separate AI agent with a fresh context. I did not write or plan this change, and I treated `change_log.md` and `verification.md` as claims to check.

**Read:** `issue_brief.md`, `diagnosis.md`, `reproduction.md`, `patch_plan.md`, `change_log.md`, `verification.md`, every evidence file, the full diff of all ten modified files, the new files `bridge/providerGuard.ts`, `bridge/usageLedger.ts` and the four new tests, and the surrounding code: `core/foregroundGate.ts`, `bridge/llmStatus.ts` (`classifyLLMError`, `recordFallback`, `health`), `core/orchestrator.ts` call sites (1424, 1737, 1777–1820, 1974, 2008), `core/goalVerifier.ts:132-158`, `core/goalPlanner.ts:137-141`, `core/reflectionEngine.ts:206`, `core/codeRepair.ts:143-163`, `core/worktreeExecutor.ts:58-69`, `core/workspaceRoot.ts:59-62`, `core/agents/specialists.ts` (role names), `tests/runAll.ts:186-212`, the request-body builders in all three adapters, and the tracker rows for 1A.

**Ran (exact commands, results):**

| Command | Result |
|---|---|
| `git status --short`, `git diff --stat` | 10 modified files, 8 untracked paths; matches the expected list |
| `git diff --check` | exit 0 (no whitespace errors in tracked changes) |
| `grep -nE "[[:space:]]$"` on the 6 new code/test files | no trailing whitespace |
| `git diff --quiet HEAD -- pnpm-lock.yaml package.json` | exit 0 (unchanged) |
| `git diff --name-only -- tests` and `git diff HEAD --stat -- tests` | empty: no tracked test file modified |
| `pnpm run typecheck` | exit 0 |
| `pnpm test -- --only=` the 4 new tests + the 20-test existing group from the plan | 24 passed · 0 failed |
| Inline probe with `node node_modules/tsx/dist/cli.mjs -e "…"` (stub providers, no network, `JARVIS_DATA_ROOT`/`JARVIS_WORKSPACE_ROOT` set to my scratchpad, `JARVIS_USAGE_LEDGER=off`) | reproduced findings M1, M2, M3, L1 (output quoted below). `git status --short` hash identical before and after; no `data/usage/` created in the repo |

I did not run the full `pnpm test -- --ci`. The implementer's `after-ci.txt` covers it, and my targeted run covers every test that touches the router, providers, agents, code repair and redaction. I wrote two temporary verdict lists and the probe's empty data folder under my session scratchpad (outside the repository); no file in the repository other than this report was created or changed.

## 2. Overall verdict

The change does what the plan says in the cases the tests cover, and default routing with no new setting is behaviourally the same as before except for the new per-provider breaker (see R1). Protected files stay within the plan's scope, no test was weakened, and the lockfile is unchanged. The fail-before evidence is credible.

I found no Critical or High defect. I found four Medium issues. Two of them (M1, M2) mean a configured model can be skipped or replaced in ways the docs say cannot happen. The others are Low or test gaps.

## 3. Findings

### Critical
None.

### High
None.

### Medium

**M1 — A background call with an explicit route time limit can time out while waiting for the conversation, so the configured model is never asked and the default model answers. CONFIRMED (probe).**
- `bridge/modelRouter.ts:254-262`: the route timer starts before `send()`.
- `send()` → `sendRoute()` (`:241-251`) → `namedWaits()`/`chain()` → `backgroundWaits()` (`:320-326`), which waits up to `JARVIS_BACKGROUND_YIELD_MS` (`core/foregroundGate.ts:39-56`) on the timeout signal.
- When the timer fires during that wait, `backgroundWaits` throws "Request aborted before it was sent". `routedChat` (`:233`) checks only the caller's signal, so a non-strict route falls back to `chain()` (`:237`), which waits again.
- Probe (`JARVIS_MODEL_PLANNING=alt:m-alt`, `_TIMEOUT_MS=1000`, yield 3000 ms, conversation active, call inside `runAsAgent`): `answered by a | calls a:own | 4008 ms`. Provider `alt` was never called.
- Only happens when the owner sets `JARVIS_MODEL_<KIND>_TIMEOUT_MS` below the yield limit (default 20 s) and a background call runs during a conversation. For a strict kind (review through `goalVerifier`), the same sequence throws a timeout instead.

**M2 — "CODING and REVIEW fail as themselves" is false for a bare-model setting: failover answers with another provider. CONFIRMED (probe).**
- `.env.example:71` and `bridge/modelCategories.ts:62` claim strictness.
- A bare model (`JARVIS_MODEL_REVIEW=review-model`) gives provider `default`. `sendRoute` then calls `chain(request, undefined)` (`bridge/modelRouter.ts:250`), which runs the full failover order.
- Probe: `P2 strict review bare model: answered by b | calls a:review-model,b:review-model`.
- With the real OpenAI-compatible fallback, the reply comes from that provider's own model, because `bridge/openaiProvider.ts` sends `this.model` and ignores `request.model`. The usage record still says `review-model`.
- The same failover existed before in `categoryChat` (old `chat(routed, undefined)`), so code repair is unchanged. What is new is that `goalVerifier`'s review calls now take this path, and the docs now promise strictness. It is recorded as `fallbackUsed: true` and logged, so it is not fully silent.
- Related, pre-existing, not introduced by 1A: within a named route the adapters can answer with another model. The Gemini/Groq client drops to the fast model on a 429 (`bridge/groqProvider.ts:394`, `:509`) and during a cooldown (`:181`, `:365`). The Claude adapter enables server-side fallbacks by default (`bridge/anthropicProvider.ts:179,187`). In both cases the usage record shows the requested model, not the one that answered.

**M3 — When every provider fails on a bare-model, non-strict route, each provider is called twice. CONFIRMED (probe).**
- `sendRoute` → `chain(req, undefined)` tries the whole order with the route's model. `routedChat` then falls back to `chain(request, undefined, true)` (`bridge/modelRouter.ts:237`) and tries the whole order again with the caller's model.
- Probe (`JARVIS_MODEL_PLANNING=other-model`, both providers failing): `a:other-model,b:other-model,a:own,b:own`.
- During an outage or a quota storm this doubles requests and failure records, and it trips the new breakers faster. It matters most on a small free-tier quota (e.g. Gemini `RPM=5`).

**M4 — A failed `coding_agent` or `qa_agent` route is answered by the default model, which can quietly remove QA's independence. CONFIRMED (code reading); consistent with the plan, so this needs an owner decision.**
- Agent calls use `category: request.category ?? 'planning'` (`core/agents/agentManager.ts:1248`). `planning` is not in `STRICT_CATEGORIES` (`bridge/modelCategories.ts:62`), so a failing `JARVIS_MODEL_AGENT_QA_AGENT` provider falls back to the default chain (`bridge/modelRouter.ts:233-237`).
- If coding runs on the default model, QA then reviews on the same model. `agentIndependence()` (`bridge/modelCategories.ts:133-136`) reads configuration only, so it still reports `independent: true`.
- The fallback is logged and recorded (`fallbackUsed: true`), but nothing tells the agent or the owner that this particular QA verdict was not independent.
- The plan only made `coding`/`review` strict, so this is not a deviation from it. It does weaken the owner's stated aim ("QA checks the work independently", `.env.example` comment above line 76).

### Low

- **L1 — The half-open breaker is not a single trial. CONFIRMED (probe).** `ProviderGuard.check` (`bridge/providerGuard.ts:75-81`) sets `openUntil = 0; trial = true` on the first check after the open period. Every later check passes until a result arrives. Probe: `checks passed right after the open period (no result yet): 5`. Concurrent calls (agents plus conversation) can all hit a still-limited provider. The comment at `:16-17` and plan Change 4 say "one trial call".
- **L2 — A non-rate-limit error does not reset the count.** `noteFailure` returns early for other kinds (`:98`), so 429, 503, 429 opens the breaker although the 429s were not consecutive. It is also never reset after an open period, so one 429 after the period reopens it even without the trial flag. CONFIRMED (code reading). This roughly matches the "another rate limit opens it again" intent, but "consecutive" is not accurate.
- **L3 — Synchronous ledger I/O sits on the reply path. SUSPECTED performance impact, not measured.** The first `recordUsage` reads the whole current ledger file, up to about 2 MB, with `readFileSync` (`bridge/usageLedger.ts:205`, via `bridge/modelCategories.ts:168-171`). Every call also does `mkdirSync`, `statSync` and `appendFileSync` (`bridge/usageLedger.ts:177-181`). For `chat()` this runs before the response is returned (`bridge/modelRouter.ts:374`), so it adds latency to the first planning or conversation reply after start. On the owner's HDD, with antivirus scanning, this could be noticeable. Only a PC measurement can say.
- **L4 — A restart reloads only the current file.** `readRecent` reads `this.path()` only (`bridge/usageLedger.ts:202-220`). Right after a rotation, a restart shows almost no history. Documented as a follow-up in the tracker. Two JARVIS processes rotating at the same moment would make the second `renameSync` fail; that record is lost and the warning prints only once (`:182-187`). SUSPECTED, not tested.
- **L5 — The dashboard can name the wrong provider after a route fallback.** `routedChat` records `recordFallback(route.provider, this.primary, …)` before the fallback has run (`bridge/modelRouter.ts:236`, same in the stream path at `:434`). `llmStatus.health()` prints `${primary} failed …; answered by ${to}` and ignores `from` (`bridge/llmStatus.ts:150-153`). If the fallback also fails, the dashboard shows something like "Gemini failed; answered by Gemini". It is overwritten by the next success (`lastOkAt`), so this is transient. SUSPECTED (code reading, not run).
- **L6 — Capabilities are only partly enforced.** `refusal()` checks only `imageInput` and `toolCalling` (`bridge/modelRouter.ts:182-194`). `audioInput`, `structuredOutput` and `webSearch` are declared but never checked. `hasImagePart` matches only `image`, `image_url` and `input_image` (`:53-56`). A `document`, `file` or audio part sent to Claude is still dropped silently by `textOf` (`bridge/anthropicProvider.ts:45-49`). Nothing sends such parts today. Direct provider calls outside the router are only health pings (`monitoring/healthManager.ts:237`, `self_healing/healthChecker.ts:187,190`, `self_healing/selfHealingManager.ts:291`), and those pings are not counted against any `RPM` limit.
- **L7 — `agentIndependence()` has no consumer outside tests,** so independence is "reported" nowhere. It also compares provider strings: coding unset (`default`, brain model) against QA `gemini:<the same brain model>` reads as independent. CONFIRMED (grep; code reading).
- **L8 — Usage records for refused calls are inconsistent.** `callNamed` records a refused call (`bridge/modelRouter.ts:143-147`); `streamFrom` throws its refusal without a record (`:443-444`). Minor.
- **L9 — A routed stream has no time limit** (`bridge/modelRouter.ts:416-428`). This is a documented deviation, and it is no worse than the default stream before 1A.
- **L10 — The tracker heading is stale.** `docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md:77` still says "plan awaiting approval; no source edits yet", while its rows say VERIFYING.

### Checked and found sound

- **`agentRole` never reaches a request body.** Groq `buildBody` (`bridge/groqProvider.ts:337-345`), Anthropic `params` (`bridge/anthropicProvider.ts:173-189`) and OpenAI (`bridge/openaiProvider.ts`, body built field by field) each build their body field by field. The Groq cache key `hashRequest` excludes it.
- **Cancellation is never answered by another model.** `routedChat:233`, `streamChat:431`, `primaryStream:504` and `chain:381` all check the signal. Aborted calls are not counted against a breaker (`:154`, `:378`, `:453`, `:500`).
- **Timers and listeners are cleaned up** (`withRouteTimeout` `finally` at `:263-266`; `categoryChat` at `:134-137`).
- **No double routing.** `categoryChat` now calls `chain()` instead of `chat()` (`:133`), so a category route is not applied twice. `codeRepair` keeps its default time limit and token cap.
- **Refused calls are not sent and not counted.** Capability checks run before `guard.check()`. A request-per-minute slot is taken only when the call goes out. A refused error never reaches `noteFailure`.
- **The Groq state shim is wired correctly.** Getters and setters forward to the statics, so `this.state.consecutive429s++` reads and writes the class field. Tests that reset `GroqProvider.*` still work (`providerIsolationTest` §2; `llmClientBehaviourTest` and `providerHealthTest` pass). Isolated instances get their own maps and cache.
- **No circular import at runtime.** `bridge/usageLedger.ts` imports only a type from `modelCategories`, and `core/workspaceRoot.ts` imports only `fs`, `path` and `url`. The ledger reads nothing at import.
- **No new type hole hides a mismatch.** The `as never` casts are in tests and in pre-existing `goalVerifier`/`goalPlanner` lines. In production, the only new cast is `streamFrom`'s duck-typed `streamChat` (`:445`), which mirrors the existing `primaryStream` cast.

## 4. Security concerns

- **No credential or message text in usage records.** A record holds category, provider, model, correlation id, latency, flags, token counts, cost, agent role and error. `error` passes through `redact()` and is cut to 200 characters (`bridge/modelRouter.ts:285`); `usageLedgerTest` §1 and §3 check this. `model` is not redacted. It comes from configuration, so it is a risk only if a key were pasted into a `JARVIS_MODEL_*` value by mistake (Low).
- **Logging.** The new `console.warn` lines in `routedChat` and `streamChat` redact the reason (`:235`, `:433`). The pre-existing chain warning (`:371`, `:383`) does not, which is unchanged. The new guard and ledger warnings contain no request data.
- **Approval gate untouched.** `security/*`, `core/toolRegistryV2.ts` and `core/codeRepair.ts` have no diff.
- **Code repair can still edit routing and breaker code.** `core/worktreeExecutor.ts:58-69` (`FORBIDDEN_PATHS`) does not cover `bridge/`, `core/agents/` or `tests/`. This is pre-existing (G0-09, Phase 3) and 1A did not change it. 1A adds routing and breaker policy to files that are not on the protected list: `bridge/modelCategories.ts` (`STRICT_CATEGORIES`, `routeFor`) and the new `bridge/providerGuard.ts` and `bridge/usageLedger.ts`. The exposure is slightly wider, not materially worse. Recommend adding these files to `RUNTIME_PROTECTED_FILES.md` and covering them in Phase 3.

## 5. Regression risks

- **R1 — The default path is not byte-for-byte identical.** With no new setting, each call now runs `refusal()` (capability check and guard) and a synchronous ledger write. With `JARVIS_LLM_PROVIDER=anthropic`, two Claude 429s in a row now skip Claude for 60 s and let Gemini/Groq answer. Before 1A every call tried Claude first. This is the plan's intended behaviour, but it is a change to default behaviour, and the owner should expect it. A stream refused by the guard is now answered once, not streamed (`bridge/modelRouter.ts:482-489`).
- **R2 — Existing `JARVIS_MODEL_*` lines in the owner's `.env` start working.** In particular, a `JARVIS_MODEL_REVIEW` set for code repair now also handles `goalVerifier` judgements: it costs money, and it is strict, so a failure gives `needs_review` (`core/goalVerifier.ts:153-155` catches the error). The plan's `findstr` check before deploying covers this.
- **R3 — Tests that replace `modelRouter.chat`** (`agentRuntimeTest`, `sevenAgentTest`) still pass. The stream fallback now calls `chain()`, not `chat()`, so a stand-in for `chat` no longer intercepts stream fallbacks. No current test relies on that.
- **R4 — Background calls can now wait twice** (route attempt plus fallback chain), each up to the yield limit, at most 120 s each. This is bounded, and foreground calls never wait, so I found no deadlock path.
- **R5 — Timing.** The voice-core group and `latencySmokeTest` pass on Linux. The HDD cost of L3 is unmeasured.

## 6. Missing tests

1. An abort *during* a routed call. The current test (`tests/modelRoleRoutingTest.ts:157-161`) uses a signal that is already aborted, so it would also pass on the old code. It does not exercise the abort check at `routedChat:233`: removing that check would not make it fail. It also does not assert `AbortError`, which plan item 7 asks for.
2. An explicit route time limit (plan item 9). Only `_MAX_TOKENS` is tested; `_TIMEOUT_MS` is not, including the M1 case.
3. A strict route with a bare model (M2), and the double-call case (M3).
4. A `qa_agent` route failure: what it falls back to and what is recorded (M4).
5. Capability or guard refusals on the stream paths (`primaryStream:482-489`, `streamFrom:443-444`). Only `chain` and `callNamed` are covered.
6. A network error not opening the breaker (plan item: "A 503 or network error"); only 503 is tested. Also concurrent calls in the half-open state (L1).
7. The ledger read on first use from a large (~2 MB) file, and rotation followed by a restart.

## 7. Discrepancies with `patch_plan.md`

| Plan | Implementation | In `change_log.md`? |
|---|---|---|
| 6b/6a: a background call to a named provider always waits | waits only if that provider is the primary or the conversation route (`bridge/modelRouter.ts:210-216`); G0-07 stays open for the common case (Claude coding while Gemini handles the conversation) | Yes |
| 6a: `fallbackFromRoute` request field | private `fromRoute` parameter | Yes (the plan predicted it) |
| 6a: route time limit | chat only, not streams | Yes |
| 6d: routed stream waits only for a named provider | also waits (`backgroundWaits`) for a registered provider (`:423-424`) | No (more conservative; harmless) |
| 6a: `recordFallback(route.provider, 'default', …)` | `recordFallback(route.provider, this.primary, …)` | No (minor) |
| 6d: `primaryStream` "moved without changes except the check" | a refusal now answers once through `chain()` without streaming (`:482-489`) | Not explicitly |
| Change 4: `ProviderUnavailableError` has `kind = 'rate_limit'` | no `kind` field; classified by its message instead (`bridge/providerGuard.ts:25-30`) | No (behaviour equivalent; tested) |
| Change 4: "one trial call" | several concurrent trial calls (L1) | No |
| Tests: abort test with `AbortError`; time-limit test; network error | not implemented as specified (§6) | No |

No change outside the plan's file list. The four protected files change only within their planned scope: `agentManager.ts` changes one line, and `anthropicProvider.ts` only gains `capabilities()`.

## 8. Evidence verification

| File | What it shows | What it cannot prove |
|---|---|---|
| `baseline-ci.txt` | 231 files: 221 pass, 1 blocked, 9 skipped. I extracted per-test verdicts: all 231 lines match `after-ci.txt` except the 4 added tests. | That it ran on `c4ac909` unmodified (mtime 07:55:47, before every production edit). |
| `fail-before.txt` | All 4 new tests fail on **assertions** with plausible old-code values (e.g. `default:qwen-2.5-32b`, `primary:own-model`, `sent [{"role":"user","content":"What is in this picture?"}]`). `providerIsolationTest` crashed partway. Its stack trace cites `groqProvider.ts:206` (`throw` in `checkCircuit`) and `:226` (`chat`). Those match the **HEAD** version of that file, and the current file has other code on those lines. This is good evidence that the run used the unchanged Gemini/Groq client. | That every other production file was unchanged. The "production code unchanged: yes" line is the implementer's own text. |
| `fail-before-providerIsolation-rerun.txt` | After `settle()` was added to line 96 (test file mtime 07:56:31, before any production edit at 07:56:57), the run completes: 9 passed, 10 failed on assertions. The cache-isolation assertion fails because of the shared breaker, not because of the shared cache, so this evidence does not show that the cache check on its own detects the problem (it would, on reading). | Timing beyond mtimes, which can be changed. |
| `fail-before-typecheck.txt` | TS2307 at `tests/usageLedgerTest.ts(34,35)`, which matches the current file's dynamic import line. | — |
| `pass-after.txt` | 4/4 pass. I reproduced this. | — |
| `voice-core-after.txt` | 6/6 pass. My targeted run did not include this group; I did not re-run it. | Behaviour on Windows or with real audio. |
| `typecheck-after.txt` | exit 0. I reproduced this. | — |
| `after-ci.txt` | 235 files: 225 pass, 1 blocked, 9 skipped, 0 failed. Its mtime (08:13) is after the last production edit (07:59:49). | That the 9 skipped (Windows, live provider, Redis…) and 1 blocked test would pass. |
| `change_log.md` / `verification.md` | Accurate on the order of work, files, counts, the test correction and three deviations. They omit the smaller deviations in §7. | — |

The modification times are consistent with the required order: tests at 07:55:56, fail-before at 07:56:15–07:56:47, production edits from 07:56:57, pass-after at 08:00:43. Modification times can be changed, so this is plausibility, not proof.

## 9. Required corrections

1. **M1:** a route's time limit must not expire while the call is still waiting for the conversation. Either start the timer after the foreground wait, or treat a timeout during the wait as "not sent" and send to the configured provider. Add a test.
2. **M2:** make the strict claim true or make the docs accurate. Either a strict category with provider `default` uses only the primary (no failover), or `.env.example:71` and `bridge/modelCategories.ts:56-62` say that strictness applies only when a provider is named. Add a test.
3. **M3:** when the route's provider is `default` and its chain has already tried every provider, do not run the same chain again as the "fallback". At most, retry with the caller's model on the primary.
4. **M4:** the owner decides whether `qa_agent`/`coding_agent` routes are strict. If they stay non-strict, record in the usage record or task result that the answer came from the fallback, so a QA verdict that was not independent can be seen.
5. **Tests:** replace the pre-aborted test with an abort during the call that asserts `AbortError` and no fallback; add the route time-limit test. These are additions to the new test files only.
6. **Docs:** update the tracker heading (L10) and list the §7 deviations not yet in `change_log.md`.

L1–L9 can wait for a later phase if the owner accepts them. Record them as follow-ups.

## 10. Final recommendation

**APPROVE WITH CONDITIONS.**

1. Fix M1, M2 (in code or docs) and M3, with tests for each, before commit.
2. The owner decides on M4 before relying on QA independence.
3. Add the missing abort and time-limit tests (§6, items 1–2).
4. Keep the owner's PC check from `patch_plan.md` (no new settings: "hello", "open notepad", `dir data\usage`, restart). Run `findstr /B "JARVIS_MODEL_" .env` before deploying (R2). If possible, time the first reply after start on the HDD (L3).
5. No commit, push or merge until the owner approves.
