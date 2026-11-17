# Independent Review: Phase 1A, round 3

**Reviewer:** an independent, read-only agent with no part in writing round 3.
**Scope:** the uncommitted working tree on `claude/jarvis-repair` against base `c4ac909`: `git diff HEAD -- bridge core .env.example`, the untracked `bridge/providerGuard.ts` and `bridge/usageLedger.ts`, the two new tests, the run-folder docs and `docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md`.
**Method:** I read the code, diffed `bridge/modelRouter.ts` and `core/agents/behaviors/toolLoop.ts` against the pre-round copies, ran the targeted tests and the typecheck, and wrote three probe scripts for the riskiest claims. I edited no repository file other than this one.

## 1. Verdict

**APPROVE WITH CONDITIONS.**

The router work (M-3 waits, M-2 deduplication, strict routes, ticket wiring) does what the owner approved. Each probe I ran on it matched the claims, with one exception: a route's own time-out (M3 below). The trial lease is correct for the trial's own ticket. No test was modified, no security or approval-gate file changed, and the per-test verdicts match the baseline.

Two gaps in `toolLoop.ts` work against what the owner asked for:

- QA can still end COMPLETED through keyword rules when its model returns blank text (M1).
- A configured coding agent's split requests are answered by workers on the default model, or by those workers' keyword rules, and the parent ends COMPLETED (M2).

Three docs state rules the runtime does not follow (M3, L2).

Conditions:

1. Fix M1. It is a small change in `toolLoop.ts`, with a test.
2. Fix M2, or have the owner accept it as a known limit next to L-3 and record it in `verification.md`.
3. Fix M3, or correct the `.env.example` and `change_log.md` wording.
4. Correct the doc statements listed under requirement 6.

## 2. Owner requirements

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | toolLoop: strict / queue-wait failures end the task FAILED | **Met** | `toolLoop.ts:65-68`, `:111`; `qaModelFailureTest` §1, §5, §7 |
| 1 | Configured coding agent gets no keyword fallback | **Partly met** | Single-part path met (`:111`, test §5). Split path: workers `code_analysis_worker` (`specialists.ts:90`) call the model as their own role (`agentManager.ts:1248`), so they use the non-strict planning route and keep keyword fallback; the parent has no worker check for coding (`toolLoop.ts:185`). Probe Q2a/Q2b. A used-up model-call budget also gives keyword fallback (probe Q3) |
| 1 | QA fails whenever its model fails; never COMPLETED merely because keyword tools succeeded | **Partly met** | Every model *error* ends QA FAILED (`:111`, tests §1-§3). A model that answers with blank text and no tool calls gives `answer: ''` (`:116`), so `runRules` runs (`:213-216`) and QA ends COMPLETED with `answeredBy: 'keyword_rules'`. Probe Q1 |
| 1 | Failed or keyword-answered QA worker part makes QA FAILED | **Met** | `toolLoop.ts:184-198`; test §4 |
| 1 | Original error kept, not truncated | **Met** | `taskFailure` keeps the whole message (`:71-78`); the manager keeps `err.message` (`agentManager.ts:132-134`, `:679`); test §1 uses a 160-character reason. Minor: L5 |
| 1 | Unconfigured coding_agent keeps keyword fallback | **Met** | test §6; `agentSpecialistsTest` passes |
| 1 | Cancellation, approvals, tool scope, successful runs unchanged | **Met** | `isAbort` is still checked first (`:110`); the manager checks `signal.aborted` before the error type (`agentManager.ts:665`); `callTool`/`runRules` unchanged; no diff under `security/`, `core/toolRegistryV2.ts`, `core/codeRepair.ts`; test §8-§9; agent test files pass |
| 1 | Fallback answer distinguishable, not presented as AI verification | **Met** | `data.answeredBy` / `data.modelUsed` (`:205`, `:223`), and a limitation says "keyword rules were used" (`:212`). The automatic verification path (`verify.ts`) uses rules, not a model, and `.env.example:100-101` says so (probe Q5) |
| 2 | M-3: every background attempt, fallbacks included, waits; cancellation; bounded queue wait; foreground not delayed; no unbounded wait | **Met** | Per-attempt wait: `modelRouter.ts:555-562` (chain), `:710` (stream fallback), `:651`/`:418` (route fallbacks). Wait itself: `:364-386`, bounded by the yield limit (≤120 s, `foregroundGate.ts:25-29`) or `JARVIS_MODEL_QUEUE_WAIT_MS`; the timer is cleared in `finally` (`:380`). Foreground returns at once (`foregroundGate.ts:40`). Probes P2, P3; round-3 test M-3 |
| 3 | M-2: one same-provider fallback with the default model; dedupe by provider identity + model; no retry after provider-wide failures; order kept; strict never falls back | **Partly met** | Dedupe: `:309-322` (per instance via `WeakMap`, case-insensitive, `openai` as one pair). Provider-wide exclusion: `:298-302`, `:565-569`. Order: `:546`. Strict: `:413`, `:646`, `:433` (named provider only). Probes P4, P5, P7. Gap: a route's own time limit is not counted as provider-wide (M3, probe P1) |
| 3 | The author's narrower rule (model, bad_request, bad_response only) | **Acceptable and safe** | It retries in fewer cases than the owner allowed, never more. `bad_request` covers any other 4xx (`llmStatus.ts:53`), including context-length or tool-schema refusals; a retry with the default model there costs one extra call at most and cannot repeat a pair |
| 4 | Independence by effective target; aliases not independent; no false claim from missing info; runtime doesn't use it; docs don't claim enforcement | **Met** | `modelCategories.ts:173-252`; no caller outside tests (grep); `.env.example:99-101`, tracker rows 93/99, `verification.md` "Not verified". Minor: L6 |
| 5 | Trial lease: one trial; cancelled/failed trial frees it; stall expires; concurrency-safe; breaker kept | **Met** | `providerGuard.ts:92-163`; every send site passes its ticket (`modelRouter.ts:252`, `:256`, `:575`, `:586`, `:669`, `:673`, `:726`, `:731`); probe P6c (10 checks → 1 trial). The header comment overstates (L3); a stream stopped by its consumer holds the lease until it expires (L4) |
| 6 | Docs distinguish strict / ordinary fallback / keyword fallback / AI success / independent QA; no false enforcement claims | **Partly met** | Independence and the verifier's rules are described honestly. Inaccurate: `.env.example:96` "QA never falls back to keyword rules" and tracker row 100 "QA never ends COMPLETED without its model" (M1); `.env.example:79-82` and `change_log.md` "time-out ... not asked again" (M3); `.env.example:93-95` "only for an agent with no model setting of its own" (L2) |
| — | No test modified or weakened | **Met** | `git diff --name-only HEAD -- tests` is empty. The five earlier programme tests have mtimes 07:55-09:42, before round 3 began. `modelRouteCorrectionsTest` is still at 09:42:21, as the corrections review recorded. Mtimes are the only evidence for untracked files |
| — | No security / approval-gate weakening | **Met** | No diff in `security/`, `core/toolRegistryV2.ts`, `jarvis.ts`, `core/codeRepair.ts`; `toolLoop.ts` tool path unchanged; `code_analysis_worker` is read-only, maxRisk 0 (`specialists.ts:235-237`) |

Production files changed this round, from hashes against `evidence/round3/production-hashes-before.txt`: `.env.example`, `bridge/modelCategories.ts`, `bridge/modelRouter.ts`, `bridge/providerGuard.ts`, `core/agents/behaviors/toolLoop.ts`. Unchanged: `anthropicProvider`, `groqProvider`, `llmStatus`, `llmTypes`, `nodeBridge`, `openaiProvider`, `usageLedger`, `agentManager`. The two scratchpad "before" copies match their lines in that file, and the toolLoop copy is identical to `HEAD`.

## 3. Findings

### High

None.

### Medium

**M1. QA ends COMPLETED through keyword rules when its model answers with blank text.** `core/agents/behaviors/toolLoop.ts:116`, `:213-216`.
- Scenario: `qa_agent`, configured or not. The model returns `content: "   "` or `""` with no tool calls. This is not an error. The Gemini/Groq client returns empty content with `finish_reason: "stop"` without throwing (`groqProvider.ts:446-456`), and `openaiProvider.ts:95` passes `''` through. `runLoop` returns `{ answer: '', calls: 0, modelAnswered: true }`, so `!loop.answer && !loop.calls` runs `QA_RULES` (`dev_status`, `diagnose_app`).
- Result: the QA task is COMPLETED with confidence 0.7 and `answeredBy: 'keyword_rules'`. Probe Q1 reproduced it. A goal's `tasks_completed` check would count it.
- Fix: in `toolLoopBehavior.run`, when `ctx.agent.role === 'qa_agent'`, never call `runRules`. Throw a `ModelUnavailableError` ("QA's model gave no answer") instead. Add the case to `qaModelFailureTest`.

**M2. A configured coding agent's split request is not held to its route.** `toolLoop.ts:162-206`; `specialists.ts:90`, `:235-237`; `agentManager.ts:1248`.
- Scenario: `JARVIS_MODEL_AGENT_CODING_AGENT` is set, and a request has independent parts, e.g. "Explain the router code; then explain the agent manager code". The parts go to `code_analysis_worker` children. They call the model as their own role, so they use the non-strict planning route (the default model), and they keep keyword fallback.
- Probe Q2b: the configured coding provider is down. It is never asked. The parent ends COMPLETED with `answeredBy: 'model'`, and the answer comes from the default model.
- Probe Q2a: the default model is down too. The workers answer by keyword rules ("No rule matched…"), and the parent ends COMPLETED (`model_incomplete`).
- Probe Q2c: the configured coding model works. It is still not used for the parts.
- This is the coding counterpart of the known QA L-3, which `verification.md` records for QA only. Workers are read-only, so no write path is affected.
- Fix (owner decision):
  - (a) for a role with a strict configured route, apply the same worker check QA has (`byModel`), so a part that is not the model's answer fails the task; or
  - (b) make workers spawned by a strict-route agent use the parent's route; or
  - (c) do not split for a strict-route agent.

  At minimum, add the limit to `verification.md`.

**M3. A route's own time limit is not treated as provider-wide.** `bridge/modelRouter.ts:298-299`, `:441-457`, `:411-418`.
- Scenario: `JARVIS_MODEL_PLANNING=slow-model` with `JARVIS_MODEL_PLANNING_TIMEOUT_MS=1000`, and the provider hangs. `withRouteTimeout` aborts the call through its own signal. `noteOutcomeFailure` sees `signal.aborted` and returns before it adds the provider to `attempted.wide`. The fallback then asks the same provider again with the default model, and without any time limit.
- Probe P1: attempts `a:slow-model,a:own`.
- This contradicts `.env.example:79-82` ("After a … time-out failure … that provider is not asked again in that call") and the change log ("Any other failure (… time-out …) excludes the provider"). A provider's own time-out (`LLM_TIMEOUT`, classified `timeout`) is excluded correctly. Only the route's time limit is affected.
- Fix: in `withRouteTimeout`'s catch, when the route's timer fired, add the route's provider to `attempted.wide`. The provider instance is available there, or can be passed in. Add a test. Alternatively, change the docs to say a route time-out allows one fallback on the same provider.

### Low

**L1. A configured coding agent whose model-call budget is used up runs keyword rules.** `toolLoop.ts:111-113`.
- `BudgetExceededError` is not in `endsTask` for roles other than QA.
- Probe Q3: COMPLETED via `git_overview`, `answeredBy: 'keyword_rules'`.
- This is not a model failure, but it is a keyword fallback for a configured coding agent.
- Fix: end the task when `routeFor('planning', process.env, role).strict` is true, or accept it and document it.

**L2. `.env.example:93-95` says keyword rules run "only for an agent with no model setting of its own, other than QA".**
- Only `coding_agent` and `qa_agent` settings are strict (`modelCategories.ts` `STRICT_AGENT_ROLES`).
- Probe Q4: `JARVIS_MODEL_AGENT_BROWSER_AGENT` set, both models down → COMPLETED by keyword rules.
- Fix the sentence to name the two strict roles. L1 is a further exception.

**L3. The `providerGuard.ts:22-23` header says another call's result "never ends the running trial's lease".** Two cases contradict it:
- Probe P6a: a late 429 from a call sent before the breaker opened re-opens the breaker during the trial. `consecutiveRateLimits` is still at or over the threshold (`:154-161`). This is conservative.
- Probe P6b: a late success from such a call closes an open breaker early (`noteSuccess` ignores its ticket, `:134-139`). Earlier rounds behaved the same.
- Fix: correct the comment. Optionally, ignore a success whose ticket was issued before the breaker opened.

**L4. A stream stopped by its consumer reports no outcome.** `modelRouter.ts:667-676`, `:721-739`.
- If the caller stops iterating (`return()`, e.g. barge-in) while chunks are still flowing, neither `noteSuccess` nor `noteCancelled` runs. A trial ticket then holds the lease until it expires after one open period (60 s by default). This is bounded.
- Fix: track settlement and call `noteCancelled(ticket)` in a `finally`.

**L5. The route's own failure is dropped when a fallback wait ends the call.** `modelRouter.ts:558`, `:710`.
- A `QueueWaitTimeoutError` or `AbortError` from a fallback attempt's wait carries no `cause`. The route's failure survives only in the console warning (`:415`).
- Fix: attach `opts.priorError` as `cause` to the queue-wait error thrown from a fallback wait.

**L6. `observedAgentIndependence` treats the placeholder model `(provider default)` as a real model.** `modelCategories.ts:236-243`; `modelRouter.ts:466`.
- Probe I4: `groq (provider default)` vs `groq qwen-2.5-32b` → `independent: true`.
- Agent calls always send a model (`agentModel()`, `common.ts:20-22`), and nothing consumes the function. Not reachable today.
- Fix: return `null` when either model is the placeholder.

**L7. QA's own parts in the split path are held to a weaker standard than its workers.** `toolLoop.ts:177-182`, `:205`.
- An own part that hits the step limit leaves QA COMPLETED (`model_incomplete`). A worker part in the same state makes QA FAILED.
- Fix: for QA, apply the same rule to own parts.

**L8. Behaviour changes outside routed calls, all bounded and documented.**
- `categoryChat` now waits before each failover attempt even when the category is not configured (code repair's coding/review calls, `codeRepair.ts:144`, `:163`). `.env.example:109-111` documents this.
- An agent holds its LLM slot (`agentManager.ts:810-817`) through each of those waits. With several fallback providers, that is up to one yield limit per attempt (`verification.md` notes the per-attempt bound).
- Plain `chat()` without a configured route is unchanged (probe P5).

## 4. Test quality

`qaModelFailureTest`: §1-§3 and §5-§7 fail on the old code with assertion failures (`fail-before.txt`, 8 passed / 18 failed) and pass now. They prove the single-part QA and configured-coding failures, full-reason retention, and the queue-wait FAILED status. §4 proves the worker check. §6, §8 and §9 are regression guards (they passed before, as expected).

Its gaps:
- It replaces `failoverOrder` with a single provider, so "no other model asked" is shown only for that setup. Strict routing across providers is covered by the round-3 router test and my probe P4.
- Two tests proposed in `REVIEW_HANDOVER.md` §5 are missing: no. 8 (QA budget exhausted → FAILED; probe Q3b confirms the behaviour) and no. 10 (a goal whose QA task FAILED does not meet `tasks_completed`).
- There is no test for a blank QA answer (M1) or a split coding request (M2).

`modelRouteRound3Test`: 23 of 43 checks fail on the old code with plausible old values (e.g. `elsewhere:m:chat,a:own:chat`; `b:other-model answered`).

- **M-3 chat:** real regression proof.
- **M-3 stream:** structural; it passes on the old code because the conversation route makes the first wait block. The author says so in `verification.md`. My probe P2 (a named planning route the conversation does not use, streamed) shows the stream fallback really waits.
- **M-2:** the 401/network/429/503 checks of "not asked again" also passed before. They are regression guards; the paired "next provider answers with the caller's model" checks are the proof.
- **Lease and independence:** the checks are real.

Gaps:
- no route time-out case (M3);
- no `categoryChat` pause/resume case (my probe P3 covers it: a 1000 ms limit survived a 1400 ms wait);
- no case for a stream stopped by its consumer (L4).

Weakened tests: none found. Tracked tests are untouched. For the untracked earlier programme tests, the only evidence is mtimes from before round 3.

Baseline comparison: per-test verdicts in `evidence/round3/after-ci.txt` equal `evidence/baseline-ci.txt` for all 231 pre-existing files. The only additions are the 7 programme tests, all PASS. Baseline: 221 passed, 1 blocked, 9 skipped. After: 228 passed, the same 1 blocked and 9 skipped.

## 5. What I ran

| Command | Result |
|---|---|
| `pnpm test -- --only=qaModelFailureTest,modelRouteRound3Test,modelRoleRoutingTest,modelRouteCorrectionsTest,providerIsolationTest,providerCapabilitiesTest,usageLedgerTest` | 7/7 PASS |
| `pnpm test -- --only=agentSpecialistsTest,agentRuntimeTest,sevenAgentTest,modelRoutingTest,llmCancellationTest,goalAgentIntegrationTest,jarvisAgentIntegrationTest,llmTimingTest` | 8/8 PASS |
| `pnpm run typecheck` | exit 0, no output |
| `git diff --name-only HEAD -- tests` | empty |
| `git diff --check HEAD`; `git diff --quiet HEAD -- package.json pnpm-lock.yaml` | clean; unchanged |
| `sha256sum` of production files vs `production-hashes-before.txt` | see §2 |
| `git status --short` before and after the probes | identical |

Probes. They are in the scratchpad `review3/` folder, run with `pnpm exec tsx`, use stand-in providers and tools, and set the data root to a temp directory with the ledger off.

| Probe | What it checks | Result |
|---|---|---|
| `probe_router.mts` P1 | route time-out, then fallback | same provider asked again (M3) |
| P2 | background routed stream, named route the conversation does not use | fallback waited until the conversation ended (400 ms) |
| P3 | `categoryChat` failover while a conversation starts mid-call, 1000 ms limit | second provider waited, then answered after 1451 ms; no time-out |
| P4 | 15 strict cases: QA/coding/review streams, `categoryChat` coding/review; bare model, primary-named and named provider | all `StrictRouteError`, one attempt each, no other provider or model |
| P5 | category with no setting | unchanged failover `a:own,b:own` |
| P6 | guard: late 429 / late success / 10 concurrent checks | L3 a and b; exactly 1 trial |
| P7 | route and caller model differing only by case and space | one attempt |
| `probe_agents.mts` Q1 | QA model returns blank text | COMPLETED by keyword rules (M1) |
| Q2a-c | configured coding agent, split request | workers on the default model or keyword rules; parent COMPLETED (M2) |
| Q3 / Q3b | model-call budget 0, configured coding / QA | keyword rules (L1) / FAILED with budget code |
| Q4 | browser_agent with its own setting, both down | keyword rules (L2) |
| Q5 | QA verify path | COMPLETED with no model call (rules, as documented) |
| `probe_indep.mts` I1-I6 | independence | correct, except I4 (L6) |

## 6. Only verifiable on the owner's PC or with live providers

- Which errors real Gemini, Groq, Claude and OpenAI-compatible servers return for a missing model, a bad request or a garbled reply, and so whether the same-provider retry triggers when intended. It relies on `classifyLLMError` reading status codes and message text.
- How often a live model returns blank content (M1's trigger), and whether in-adapter fast-model swaps (MM-1A-P3) change which model answered a strict route.
- Real conversation timing: `conversationBus` start and end events from voice, and whether per-attempt waits with an LLM slot held slow other agents noticeably.
- Windows-only and skipped suites (`windowsScriptsTest`, `processControlSafetyTest`, `windowControlTest`, live-provider tests) and `realTtsHandoffTest` (blocked here, as in the baseline).
- The usage ledger and lease timing under the Windows file system and clock.
