# Independent Review: round 3 fixes

**Reviewer:** an independent, read-only agent with no part in writing the fixes.
**Scope:** the fixes made after `INDEPENDENT_REVIEW_ROUND3.md` (M1, M3, L1, L4, L5, L6 in code; L2, L3 in docs), the new `tests/reviewRound3FixesTest.ts`, the `.env.example` section "What a task result means", and tracker rows MM-1A-18, MM-1A-20 and MM-1A-P8. Working tree on `claude/jarvis-repair` against `c4ac909`, all uncommitted.
**Method:** I read the current code, checked which files changed since the earlier review, ran the targeted tests and the typecheck, and wrote two probe scripts. I edited no repository file other than this one.

## 1. Verdict

**APPROVE WITH CONDITIONS.**

Each of the six code fixes does what its finding asked, and my probes found no new risk in the router changes: every guard ticket gets exactly one outcome, `withPriorCause` keeps the error's name and identity, the M3 exclusion hits the provider instance the route really asked, and strict, unrouted and cancelled calls behave as before.

One gap remains on the agent side, and the new `.env.example` text states the opposite of what the runtime does:

- A coding agent with its own model setting whose model returns empty text still ends COMPLETED through keyword rules (N1). The new doc text says this cannot happen for that agent.
- The doc also says a configured coding agent "ends FAILED … when its model fails or its model-call budget is used up". That holds for single-part requests only. A split request goes to workers (M2, not fixed by owner decision) and ends COMPLETED (N2).

Conditions:

1. Fix N1: apply the empty-answer rule to a configured coding agent too, with a test. Or correct `.env.example:95-99` so it no longer says a configured coding agent never ends on keyword rules.
2. Add the split-request exception (M2 / MM-1A-P8) to the `.env.example` coding_agent statement (N2).

## 2. Fixes

Line numbers are from the current files.

| Finding | Status | Where | Evidence |
|---|---|---|---|
| M1: QA empty answer | **Met** | `core/agents/behaviors/toolLoop.ts:120-127` | An empty or whitespace final answer from a `qa_agent` model throws `ModelUnavailableError`, with or without earlier tool calls. Other roles still return `answer: ''` and reach `runRules` (`:226-229`). The test (unconfigured coding agent) and probes A2, A3, A6 confirm this. QA now also fails when its model made tool calls and then gave empty text; before the fix, that case ended COMPLETED with "No answer." This is stricter, for QA only, and matches the owner's rule |
| L1: budget on a strict route | **Met (single-part)** | `toolLoop.ts:68-72` | `routeFor('planning', process.env, role).strict` is the same route the agent's calls use (`agentManager.ts:1248` sends `category: 'planning'`, `agentRole`), on the same `process.env` the router reads (`modelRouter.ts:335`). `routeFor` only reads env and `llmConfig`, so it cannot throw. There is no import cycle: `modelCategories` imports only `config/llmconfig` and `usageLedger` (`fs`, `path`, `core/workspaceRoot`). Probe A0 imports `toolLoop` first without error. An unconfigured coding agent and a configured browser agent keep keyword fallback (test; probe A4). Split requests are not covered (N2) |
| M3: route time-out is provider-wide | **Met** | `bridge/modelRouter.ts:420-425` | The lookup (`namedOnly` first, then `providers`, `default` → primary) is the same order `sendRoute` uses (`:439-445`). The exclusion is by instance, so another name for the same instance is skipped too. Probe R4a (named route, same instance also in the order), R4b (registered non-primary route) and R4c (primary also registered as an alias): the timed-out provider is asked once, and the next provider answers with the caller's model. A strict route still throws `StrictRouteError` before this code (`:419`; R4e). A 404 on the route model still allows the same-provider retry (R4d) |
| L4: stream stopped by its consumer | **Met** | `modelRouter.ts:681-696` (`streamFrom`), `:747-771` (`primaryStream`) | `reported` is set before `noteSuccess` and before `noteOutcomeFailure`, so the `finally` cannot call `noteCancelled` after either. It always uses the same `admitted.ticket`, and `noteCancelled` frees a lease only for the running trial's own ticket id (`providerGuard.ts:127-130`, `:146-148`), so a stale or ordinary ticket is a no-op. Probes R1a-R1d and R2a-R2b: one outcome per ticket in every case. After a routed trial stream is stopped, the next call is sent at once as the next single trial (R1d) |
| L5: prior cause on fallback waits | **Met** | `modelRouter.ts:80-83`, `:569-576` (chain), `:729-735` (stream fallback) | The cause is set only when `err.cause === undefined`, with `defineProperty` on the same object, so name, prototype and message are unchanged. Probe R3a: stream-route fallback gives `QueueWaitTimeoutError` with the route's stream error as cause. R3b: a caller who cancels during the fallback wait gets an `AbortError` (`instanceof Error`) with the route's error as cause. `categoryChat` passes no `priorError`, so it is unchanged |
| L6: "(provider default)" | **Met** | `bridge/modelCategories.ts:248-251`, `:255` | Returns `independent: null` with a reason. Note: `effectiveTarget` turns the placeholder into Claude's model for `anthropic` when Claude is the primary, and into `JARVIS_FALLBACK_MODEL` for `openai`, before the check runs. Those two cases are not reported as unknown, but they are not wrongly independent either: same provider gives "not independent", and different providers are different models. Nothing in the runtime calls this function |
| L2: `.env.example` strict roles | **Partly met** | `.env.example:91-99` | It now names the two strict settings and the browser-agent case correctly. It also adds statements that do not hold (N1, N2) |
| L3: guard header | **Met** | `bridge/providerGuard.ts:18-29` | It matches the code: other calls' non-rate-limit failures and cancellations leave the lease alone, a late 429 re-opens the breaker (`:161`), and a late success closes it (`:138-143`) |
| M2, L7, L8 | Not fixed, by decision | — | Recorded in `verification.md:140-142` and tracker MM-1A-P8 |

Unrelated paths I checked: an unconfigured agent keeps keyword fallback (test; A4). Non-QA empty answers are unchanged (test). Foreground calls are not delayed: the waits were not changed in this round, and `yieldToForeground` returns at once for foreground calls. Strict routes never fall back (R4e). The unrouted path is unchanged: R4f shows `u1`, then `u2:own`. Cancellation is still an `AbortError` with no fallback (R4g, R3b).

## 3. New findings

### High

None.

### Medium

**N1. A configured coding agent whose model returns empty text ends COMPLETED through keyword rules.** `toolLoop.ts:122` (the rule is limited to `qa_agent`), `:226-229`.
- Scenario: `JARVIS_MODEL_AGENT_CODING_AGENT=provider:model`. The configured model answers with `content: ""` and no tool calls, which the Gemini/Groq and OpenAI clients pass through without an error (earlier review, M1). `runLoop` returns `answer: ''`, and `runRules` runs `git_overview`.
- Probe A1: `COMPLETED answeredBy=keyword_rules tools=[git_overview]`, with no limitation saying the model gave no answer.
- This contradicts the owner requirement "configured coding agent gets no keyword fallback". It also contradicts the new `.env.example:95-97`: "It can happen for every agent except QA and a coding_agent with its own setting". `verification.md:142` says the opposite ("The empty-answer rule applies to QA only"), so the two documents disagree.
- The earlier review did not raise this case. It is the coding counterpart of M1.
- Fix: in `runLoop`, throw for an empty answer when `ctx.agent.role === 'qa_agent' || routeFor('planning', process.env, ctx.agent.role).strict`. The `endsTask` fix already uses that expression. Add the case to `reviewRound3FixesTest`. Or, if the owner prefers, correct `.env.example:95-97` to say an empty answer from a configured coding model still uses keyword rules.

### Low

**N2. The `.env.example` coding_agent statement leaves out split requests.** `.env.example:98-99`.
- The text says a coding_agent with its own setting "ends FAILED, with the reason, when its model fails or its model-call budget is used up".
- With a two-part request the parts go to `code_analysis_worker` (M2). Probe A5, with budget 0 and "Explain the router code; then explain the agent manager code", gave `COMPLETED answeredBy=model_incomplete`. The summary was "No rule matched a tool for this request without the model." twice, and the limitations said "keyword rules were used".
- The earlier review's probes Q2a/Q2b showed the same for model failures.
- The tracker (MM-1A-P8) and `verification.md:140` record M2, but the user-facing doc does not.
- Fix: add "for a request it handles itself; a request split into parts goes to workers that do not use its setting (MM-1A-P8)".

### Info

- `taskFailure` (`toolLoop.ts:75-82`) and the new empty-answer error keep the full message. Nothing new swallows or truncates an error. The fallback warning's 120-character slice (`modelRouter.ts:427`) is older code and is only a log line.
- A prior cause with a `code` (e.g. `ECONNREFUSED`) now sits under a `QueueWaitTimeoutError`. `classifyLLMError` reads `cause.code` (`llmStatus.ts:44`), so such an error would classify as `network` rather than `unknown`. No current caller classifies a queue-wait error: the guard and the attempt log see only sent calls. This has no effect today.
- Routed streams still have no route time limit. This is the known L9 (`change_log.md:43`, `:98`). `.env.example:84-86` does not mention it.

## 4. Test quality

`fail-before.txt` shows 4 passed and 13 failed. The 13 failing checks cover every code fix: M1 (3), L1 (3), M3 (3), L4 (1), L5 (1), L6 (2). The 4 passing checks are the "unchanged" guards plus two preconditions. The hashes in `evidence/round3-review-fixes/production-hashes-before.txt` equal the earlier reviewer's `review3/hashes-now.txt`, so the fail-before run was on the code that review saw. Since that review, exactly `.env.example`, `modelCategories.ts`, `modelRouter.ts`, `providerGuard.ts` and `toolLoop.ts` changed, and `tests/reviewRound3FixesTest.ts` is the only new file (`git status` diff).

Weak or missing checks:
- **M1:** only QA with no tool calls. There is no case of tool calls followed by an empty answer (probe A2 covers it), and none for a configured coding agent (N1).
- **M3:** only the `default` route on the primary. Named and registered non-primary routes are untested (probes R4a-R4c). The no-other-provider check asserts only that the call failed and `a:own` was not sent, not what the error says.
- **L4:** only the unrouted `primaryStream`. The routed `streamFrom` `finally` is untested (probes R1c, R1d).
- **L5:** only the chat fallback. The stream fallback wait is untested (probe R3a). No check that an existing `cause` is kept, though line 81 makes that plain.
- **L6:** only the coding side as the placeholder.

`git diff --name-only HEAD -- tests` is empty. The earlier programme tests have mtimes from 14:37-14:38, before the earlier review's 15:06 hashes, so they were not changed in this round. Mtimes are the only evidence for untracked files.

## 5. What I ran

| Command | Result |
|---|---|
| `pnpm test -- --only=reviewRound3FixesTest,qaModelFailureTest,modelRouteRound3Test,modelRouteCorrectionsTest,modelRoleRoutingTest,providerIsolationTest,agentSpecialistsTest` | 7/7 PASS |
| `pnpm run typecheck` | exit 0, no output |
| `git diff --name-only HEAD -- tests` | empty |
| `sha256sum -c` against the earlier reviewer's `review3/hashes-now.txt` | only the five files above differ |
| `git status --short` compared with the earlier review's snapshot | only `tests/reviewRound3FixesTest.ts` added |

I did not run `--ci`. Its output is `evidence/round3-review-fixes/after-ci.txt`, which ends "No failures, but the blocked tests above were not verified" (realTtsHandoffTest blocked, as in the baseline).

Probes, in the scratchpad folder `review3-fixes/`, run with `pnpm exec tsx` from the repo root. They use stand-in providers and tools, a temp data root with the ledger off, and a temp working directory, so no `.env` is loaded.

| Probe | What it checks | Result |
|---|---|---|
| `probe_router.mts` R1a-c | routed stream: full, failing then fallback, stopped after one piece; guard outcomes per ticket | one outcome per ticket; stop → `noteCancelled` |
| R1d | routed trial stream stopped, then the next call | sent at once as the next trial, answered |
| R2a-b | unrouted stream fails, chain answers; consumer breaks, or `return()` is queued while the chain runs | one outcome per ticket; `next` gets the chain's answer, `return` completes; no stray `noteCancelled` |
| R3a-b | stream-route fallback wait (queue wait); caller cancels during a fallback wait | `QueueWaitTimeoutError` and `AbortError`, each with the route's error as cause, `instanceof Error` |
| R4a-c | route time-out: named provider (same instance also in the order), registered non-primary, primary with an alias | the timed-out instance is not asked again under any name |
| R4d-g | 404 retry; strict time-out; unrouted chat; caller cancels during the route attempt | unchanged retry; `StrictRouteError`, one attempt; normal failover; `AbortError`, no fallback |
| `probe_agents.mts` A0 | `toolLoop` imported first | no cycle, loads |
| A1 | configured coding agent, empty answer | COMPLETED by keyword rules (N1) |
| A2 / A3 | QA: tool call then empty answer / configured QA, empty answer | FAILED with a clear reason |
| A4 | configured browser agent, budget 0 | keyword rules, as documented |
| A5 | configured coding agent, budget 0, two-part request | COMPLETED `model_incomplete` (N2) |
| A6 | QA normal answer | COMPLETED, `answeredBy: model` |
