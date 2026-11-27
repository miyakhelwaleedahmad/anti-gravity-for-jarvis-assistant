# Independent Review: Phase 1A gap closure (P3, P4, P7, P9, N1, N2)

**Reviewer:** an independent, read-only agent with no part in writing the code, the plan or the earlier reviews.
**Scope:** the final source of the uncommitted Phase 1A work on `claude/jarvis-repair` (base `c4ac909`), with emphasis on this cycle's changes: the 15 production files listed in `GAP_CLOSURE_PLAN.md` §1, `.env.example`, the four new tests and the D2 stand-in edits.
**Method:** I read `git diff HEAD`, diffed each changed file against its pre-cycle copy in the scratchpad, ran the typecheck and 27 named tests, ran the four new tests on the extracted `c4ac909` copy, and wrote five probe scripts (stand-in providers and tools, no network, scratch workspaces, so dotenv found no `.env`). The run folder's documents and earlier reviews were read as context only. This file is the only repository file I wrote; `git status` was identical before and after my runs, and every source hash in `evidence/gap-closure/source-hashes-at-review.txt` still matches.

---

## 1. Verdicts

**(a) Implementation correctness: correct for every approved item on the paths the plan names, with two Medium gaps in how model identity is compared.**
- P3: strict routes send `exactModel`; the Gemini/Groq client no longer swaps on a cooldown or a 429 (chat and stream); the cache key separates exact from non-exact requests; Claude's server-side fallbacks are off; all three adapters return the reported model (text and tool-call replies); the router confirms identity on `categoryChat`, named providers, the chain and routed chat; a strict stream is answered through `routedChat`; a strict `openai:<x>` for another model is refused before sending. Non-strict calls are unchanged.
- P9 + N1: inheritance now comes from the registry (`agentManager.ts:448`), a caller's `routeAs` is stripped and `agentRole` overwritten (`:1287-1289`), grandchildren inherit, `askJson` never falls back on a strict lineage, research propagates `MODEL_UNAVAILABLE` and does not retry it.
- N2 + P4: the router lists failover targets, QA fails closed before the first call when required and not independent, each reply is checked, `data.independence` is `independent` only when required, and the QA role text no longer says "independently".
- P7: every re-read that did not happen is `inconclusive`, the verdict and summary say so, goals wait for review, the speech and console mark it.
- The two Medium gaps (M-A, M-B below) are both in identity comparison: names are compared as strings, and one route-to-model mapping disagrees between two router methods.

**(b) Independent QA enforcement, as implemented: enforced, with one way to get a false "independent" label.** When required, QA work ends FAILED before any model call if the configured targets can overlap, and after any reply that reports no model or one of coding's target names. The label `independent` is reached only through those checks. It is still reachable when coding and QA name the same Claude model by two ids, an undated alias and its dated id (M-A, probe A). In the Claude-primary case in M-B the pre-call gate passes wrongly, but the reply check then fails the task, so no false label results there.

**(c) Readiness to commit: READY WITH CONDITIONS.**
1. Fix M-A and M-B, or have the owner accept them explicitly. The owner's rule in `GAP_CLOSURE_PLAN.md` §0 is that High and Medium findings are resolved before commit, so as the code stands that rule is not met.
2. Update `FINAL_APPROVAL_REPORT.md`, `change_log.md` and the tracker, which still describe the pre-gap-closure state (L4).
3. Re-review any source change made for 1 and 2 (also the owner's rule).

There is no High finding.

---

## 2. Item-by-item

### 2.1 P3: strict model identity

| Check | Result | Evidence |
|---|---|---|
| Gemini/Groq cooldown start | Fixed | `groqProvider.ts:181-183`; `startModel(…, exact)` returns the requested model |
| Gemini/Groq 429 swap | Fixed, chat and stream | `:396`, `:512` |
| Cache / in-flight reuse across strict and non-strict | Fixed | `hashRequest` adds `exact` (`:241-242`); in-flight dedupe uses the same key (`:284-301`) |
| Claude server-side fallbacks | Off when `exactModel` | `anthropicProvider.ts:196-197` |
| Reported model on replies | Text and tool-call replies, all three adapters; never copied from the request | `groqProvider.ts:446`, `:462`; `anthropicProvider.ts:111-112`; `openaiProvider.ts:96-97` |
| Router confirms identity | `categoryChat` named and chain paths (`modelRouter.ts:232-247`), `routedChat` (`:516-519`, covers `callNamed` and the chain via `sendRoute`), streams (`:736-742`) | A failed check is raised inside the existing `try`, so it becomes `StrictRouteError` with no fallback |
| No report / other model | StrictRouteError | `:490-497`; test cases 150-160 |
| Requested model as evidence | Not used: `confirmIdentity` reads only `res.model` | `:494` |
| Strict `openai:<x>` ≠ its model | Refused before sending | `:473-482`; test case 200 |
| Empty replies | Unchanged: the Groq client retries the same model; an empty strict reply still has to report its model; the tool loop then fails it as before | `groqProvider.ts:448-457` |
| Non-strict paths | Unchanged: `exactModel` is added only when `route.strict` and is never set by any other caller (repo-wide grep); request bodies are built field by field, so the flag is never sent | `groqProvider.ts:340-349`, `openaiProvider.ts:70-82`, `anthropicProvider.ts:198-206` |

Gaps: M-B (a bare model under Claude primary is mapped by `modelFor` and the mapped model is what gets confirmed). The plan's `noteUsage` change (record `servedModel`, plan §3) was not made: usage records still store the requested model (`modelRouter.ts:581`). Nothing in the runtime enforcement reads those records, so this is Low (L4).

### 2.2 P9 + N1: lineage

- `strictRouteRole` walks parent links from the registry, stops at JARVIS, guards against cycles, and only counts a `permanent` specialist with a strict configured route (`agentManager.ts:448-455`). Only JARVIS can spawn a specialist (`:494-495`), so a temporary agent cannot carry the `coding_agent` or `qa_agent` role.
- `TaskContext.llm` drops a caller's `routeAs` and overwrites `agentRole` (`:1287-1289`). Probe B1: a behaviour that passed `routeAs: 'coding_agent', agentRole: 'coding_agent'` was answered by the default provider.
- Grandchildren inherit: the existing test and probe B2 (helpers under a strict coding agent used `codeok`).
- `askJson` on a strict lineage rethrows `StrictRouteError`, `QueueWaitTimeoutError`, `BudgetExceededError` and `ModelUnavailableError`, and turns any other error or an unusable answer into `ModelUnavailableError` with the full message (`common.ts:97-110`). It differs from the plan's diff in one way: it does not add `ctx.agent.role === 'qa_agent'`. No QA path calls `askJson`, so behaviour is the same.
- Every `askJson` call site (`research.ts:179`, `:318`, `:515`, `:644`) behaves exactly as before when `strictRouteRole` is undefined; `:515` and `:644` belong to `research_agent`, which is never below a coding or QA specialist.
- Research: `waitWithRetry` skips `MODEL_UNAVAILABLE` (`research.ts:93`); `failOnModelFailure` fails the parent at both waits (`:258`, `:349`). The chain deep-analysis worker → code-analysis worker → coding agent ends FAILED, as the test shows.
- Through spawn rejection: when the deep-analysis grandchild cannot be spawned, no model call happens for it, and the strict research flow ends COMPLETED on the deterministic ranking with a limitation (probe B3). Nothing falls back to rules in place of a model call, but no model judged any repository (L3).
- Performance: 3.22 µs per `strictRouteRole` call on a depth-9 lineage (probe B4), called once or twice per model call.

### 2.3 N2 + P4: independence

- `possibleTargets` lists a strict route's one exact target, or the configured target plus each provider in the failover order with the model it would send (`modelRouter.ts:430-453`). Test case 158 (coding unset, QA on the failover model) is not independent.
- `qaIndependenceRequired` implements D1 (`modelCategories.ts`, after `targetsIndependent`).
- The gate runs in `runLoop` and on the split path before any helper starts (`toolLoop.ts:111-116`, `:259`). `isQaWork` uses registry lineage, not input.
- `checkServed` runs on every reply, tool-call replies included (`toolLoop.ts:193-196`).
- `independenceOf` and `combinedIndependence` never return `independent` when not required (`:135-152`).
- Gaps: M-A (names, not identities, are compared), M-B (the target list disagrees with the model sent under Claude primary), L1 (coding helpers' own routes are not in coding's targets).

### 2.4 P7: verification

- Not allowed to spawn, spawn error, worker not completed, worker not reachable, and no licence to compare all give `ok: false, inconclusive: true` with the untruncated reason (`verify.ts:152-171`). `verdictOf` gives `inconclusive` only when nothing failed outright, and a failed `finished` still gives `unverified` (probe D).
- The goal criterion is met only when every checked result is `verified` (`goalVerifier.ts:93-104`; probe D: `[verified, inconclusive]` gives needs review).
- Speech (`jarvisAgents.ts:202-203`) and console `?` marker (`:292-293`) are in place.
- Nowhere else turns an inconclusive verdict into "verified". One consumer still treats it like a pass: memory promotion (L2).
- Pre-existing and unchanged: a goal task result with no verification record at all does not block the criterion (probe D, `[verified, (none)]` gives met). That is outside P7's wording.

### 2.5 Scope

The 15 production files whose hashes changed since `evidence/gap-closure/production-hashes-before.txt` are exactly the plan's §1 list. No change touches the approval gate, risk engine, tool registry or `core/agents/permissions.ts` (none is in `git diff HEAD`), and the tool-permission path in `agentManager.ts` (`spawnChild` checks, `deriveChildScope`) is unchanged. Two cosmetic leftovers are noted in L7.

### 2.6 Regression risk

- **Unrouted and foreground calls:** the paths are unchanged (`chain`, `primaryStream`). CONVERSATION is not strict.
- **Cancellation:** every new `throw` sits after the existing `signal.aborted` checks or inside the same `try` blocks, and the `isAbort` paths in `askJson` and `runLoop` come first. `llmCancellationTest` passes.
- **Trial lease:** guard tickets are untouched. An identity failure is raised after `noteSuccess`, so it does not count against the provider.
- **Earlier corrections:** `modelRouteCorrectionsTest`, `modelRouteRound3Test`, `reviewRound3FixesTest`, `finalReviewFixesTest`, `providerIsolationTest` and `modelRoleRoutingTest` all pass.
- **Error codes for non-strict agents:** `StrictRouteError`, `QueueWaitTimeoutError` and `ModelUnavailableError` are now recorded as `MODEL_UNAVAILABLE` instead of `AGENT_ERROR` for every agent (`agentManager.ts:709`) (L5).

---

## 3. Findings

### High

None.

### Medium

**M-A. An undated alias and its dated id of one Claude model count as independent, and QA is labelled `independent`.**
- **Where:** `bridge/modelCategories.ts:211` (two exact targets on one provider are always distinct); `core/agents/behaviors/toolLoop.ts:115` and `:123-128` (`checkServed` compares the reply with coding's target names); `bridge/modelRouter.ts:430-453` (targets are names; `modelIdentities` is not consulted).
- **Scenario (probe A):**
  - Settings: `JARVIS_MODEL_AGENT_CODING_AGENT=anthropic:claude-opus-5-5` and `JARVIS_MODEL_AGENT_QA_AGENT=anthropic:<dated id of that model>`.
  - The stand-in behaves like `AnthropicProvider` after `models.retrieve`, so both replies report the dated id. The router accepts both.
  - The config check says `independent: true`, QA ends COMPLETED, and `data.independence.status` is `"independent"`.
  - So QA was labelled independent although coding and QA were served by the same model id.
- **Fix:** compare identities rather than names:
  - resolve each exact Claude target through the provider (`validateModel`, then `modelIdentities`) before the gate, and treat two targets as the same model when their identity sets intersect;
  - in `checkServed`, compare the reported model with the identity sets of coding's targets, not only their names;
  - until then, treat two exact Claude targets as possibly the same unless both resolve to different canonical ids.
- **Tests:** add the alias/dated pair to `independentQaTest`.

**M-B. Under Claude as primary, a strict route given as a bare non-Claude model is sent and "confirmed" as Claude's brain model, and the independence gate sees another model.**
- **Where:**
  - `bridge/modelRouter.ts:40-50` (`modelFor` maps every non-Claude name to `claude.model`), used by `strictTarget` (`:414-421`) and `chain`, so the identity is confirmed against the mapped model;
  - `possibleTargets` (`:432-437`) skips that mapping because `anthropic` is always in `namedOnly`, so it reports the configured name.
- **Scenario (probe E):**
  - Settings: `JARVIS_LLM_PROVIDER=anthropic`, `JARVIS_MODEL_AGENT_QA_AGENT=gpt-5-mini` (bare).
  - The strict QA call is sent as `claude-opus-5-5` and accepted, so the configured model was replaced silently on a strict route.
  - `possibleTargets('qa_agent')` reports `anthropic gpt-5-mini`.
  - With coding on `anthropic:claude-opus-5-5`, the config check says `independent: true`. The QA task then makes one model call, and the reply check fails it ("QA was answered by claude-opus-5-5…").
  - The fail-closed reply check prevents a false label, but the plan's "before any model call" does not hold here, and the strict route's model is not the configured one.
- **Fix:**
  - in `refuseUnservableStrict`, refuse a strict route when `modelFor(name, route.model)` differs from `route.model`, as is already done for `openai`;
  - build `possibleTargets`' strict target from `strictTarget` so both methods agree;
  - add a test with Claude as primary.

### Low

**L1. Coding's targets leave out its helpers' own routes.**
- **Where:** `modelRouter.ts:430-453`.
- **Scenario (probe A2):**
  - Settings: coding unset, `JARVIS_MODEL_AGENT_CODE_ANALYSIS_WORKER` on the same model as QA.
  - The config check says independent, and coding targets list only the default target, although coding's helpers answer on QA's model.
- **Fix:** when coding is not strict, add the configured routes of coding's allowed child roles (and research worker roles) to its targets, or document that per-helper settings are outside the check.

**L2. An inconclusive result is stored in long-term memory as fact.**
- **Where:** `core/agents/jarvisAgents.ts:296-301`. Only `issues` blocks promotion, so a research answer whose source re-read did not happen is remembered like a verified one.
- **Fix:** also skip, or mark as unconfirmed, `inconclusive` and `unverified`. This is outside the approved P7 list, so it needs the owner's decision.

**L3. On a strict coding lineage, research can end COMPLETED with no model judgement of any repository.**
- **Where:** `research.ts:246`, `:254`, `:264`. When the deep-analysis grandchild cannot be spawned (probe B3, depth limit), or ends FAILED with `BUDGET_EXCEEDED` (which `failOnModelFailure` does not propagate), the ranking is the deterministic `quickScore`, with a limitation.
- **Effect:** no rules replace a model answer, so this is within the approved wording, but the plan's line "a model failure, an unusable answer or a used-up budget ends the task FAILED" holds only for the worker, not its parent.
- **Fix:** propagate `BUDGET_EXCEEDED` too in `failOnModelFailure`, or state the behaviour in `.env.example`.

**L4. Docs are behind the code, and one plan item was not made.**
- Tracker and approval report:
  - The tracker still lists MM-1A-P3, P4, P7, P9 and N1N2 as READY_FOR_APPROVAL and "Independent QA: NOT ENFORCED" (`docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md:113-120`, `:129`). Row P4 also mentions "task ids in usage records", which is not in the approved plan.
  - `FINAL_APPROVAL_REPORT.md:11-12` and `change_log.md` predate the cycle.
  - These understate the runtime, which is safe, but they must be updated before commit (plan step 7).
- Code comments and `.env.example`:
  - `bridge/modelCategories.ts:260` still says "nothing in JARVIS enforces it yet (MM-1A-P4)".
  - `.env.example:77` says "a cached reply of another call is not reused". A strict call can reuse the cached reply of an identical earlier strict call; that reply is re-checked, so this is a wording point only.
  - `.env.example:133` says two Claude models count as the same "unless both are strict", which is the rule that produces M-A.
- Not implemented: plan §3 `noteUsage` recording `servedModel`. Usage records, and so `observedAgentIndependence`, still carry the requested model.

**L5. A non-strict agent's model failure now has the code `MODEL_UNAVAILABLE`.**
- **Where:** `agentManager.ts:709` and `research.ts:93`.
- **Effect:** before this cycle such a failure was `AGENT_ERROR`. This applies, for example, to a `QueueWaitTimeoutError` under a configured non-strict PLANNING route, or to QA's existing `ModelUnavailableError`.
  - Goal failure signatures include the code (`goalRecovery.ts:40-47`), so learning will not match such failures with older ones.
  - Classification does not change, because no pattern matches either code.
  - Non-strict research workers never fail with these errors, because `askJson` catches them, so the no-retry change does not reach them in practice.
- **Fix:** none needed; record it in the change log.

**L6. Test gaps.**
- `verificationInconclusiveTest` simulates the worker "time-out" with a crash, so the TIMED_OUT and CANCELLED statuses are covered only by the shared `status !== 'COMPLETED'` branch.
- No test checks the reported model on a Gemini/Groq tool-call reply or the strict guard in `_streamInternal`, and no test covers M-A or M-B.

**L7. Cosmetic.**
- `agentManager.ts:438-441`: `spawnChild`'s JSDoc now sits above `strictRouteRole`'s.
- `research.ts:75`: `waitWithRetry`'s JSDoc now sits above `failOnModelFailure`'s.

### Info

`modelRouter.ts:348` still honours `request.routeAs` from any caller (earlier Info item). The only caller that sets it is `TaskContext.llm`, which derives it from lineage and strips the caller's value, so no in-tree path can forge it.

---

## 4. Earlier findings still open

| Finding | Status now |
|---|---|
| Final M1 (research path answered by rules) | Fixed (P9); residual L3 |
| Final M3 / Corrections M-4 (in-adapter swaps) | Fixed (P3); live behaviour still to verify; residual M-B |
| Last N1 (inheritance by helper role, forgeable) | Fixed (registry lineage; `routeAs` stripped) |
| Last N2 (failover ignored) | Fixed; residuals M-A, M-B, L1 |
| Last N3 (`openai:` wording) | Fixed: strict mismatch refused and documented |
| Final L5 (QA text "independently") | Fixed (`specialists.ts:110`, `:171`) |
| Final L2 (unrouted breaker) | Accepted earlier; unchanged |
| MM-1A-P2, P5, P6 | Still proposals, not in this cycle |
| Info: router honours `routeAs` from any caller | Mitigated (see Info) |

---

## 5. What I ran

**Integrity**
- `git diff --name-only HEAD -- tests`: empty.
- `git diff --name-only HEAD -- pnpm-lock.yaml package.json`: empty.
- `sha256sum -c evidence/gap-closure/source-hashes-at-review.txt`: all OK.
- Of the files in `production-hashes-before.txt`, the 15 files listed in the plan changed and no others did.

**D2**
- The diff of `d2-before/*.ts` against the current tests shows only `model: req.model` added to stand-in return values, plus comments, in `modelRoleRoutingTest`, `modelRouteCorrectionsTest`, `reviewRound3FixesTest` and `strictHelperRoutingTest`.
- The `ok(` counts are unchanged (39, 47, 21, 23), and no assertion line differs.
- `evidence/gap-closure/d2-stand-in-changes.diff` matches this.

**Typecheck:** `pnpm run typecheck` exit 0.

**Tests through the runner**
- The ten named in the brief: 10 passed, 0 failed.
- Further regression set: `modelRouteCorrectionsTest`, `modelRouteRound3Test`, `reviewRound3FixesTest`, `finalReviewFixesTest`, `modelRoleRoutingTest`, `providerIsolationTest`, `providerCapabilitiesTest`, `usageLedgerTest`, `claudeProviderTest`, `providerHealthTest`, `llmCancellationTest`, `agentRuntimeTest`, `jarvisAgentIntegrationTest`, `goalAgentIntegrationTest`, `backgroundResearchTest`, `selfHealingHonestyTest`, `replyGoldenTest`. Result: 17 passed, 0 failed.

**New tests on `c4ac909`**
- I first confirmed that the extracted copy matches `c4ac909` for `bridge/`, `core/agents/`, `core/goalVerifier.ts` and `tests/` (0 differing files), and that its four test files are byte-identical to the current ones.
- Run through its runner: 0 passed, 4 failed.
  - `independentQaTest` crashes on `r.qaIndependence is not a function` after 11 failed checks.
  - `lineageInheritanceTest`: 5 passed, 12 failed.
  - `strictModelIdentityTest`: 8 passed, 15 failed.
  - `verificationInconclusiveTest`: 6 passed, 12 failed.

**Per-test verdicts against the baseline**
- `evidence/baseline-ci.txt`: 231 files, 221 passed, 1 blocked, 9 skipped.
- `evidence/gap-closure/after-ci.txt`: 245 files, 235 passed, the same 1 blocked and 9 skipped.
- Joined per test, every pre-existing test has the same verdict. The 14 extra tests are the untracked Phase 1A tests, all PASS.
- I did not run `--ci`, as instructed.

**Probes** (in `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review-gap/`, run with `pnpm exec tsx <path>` from the repo root):

`probeA_alias_independence.mts`, which reproduces M-A and L1. The dated id is illustrative, not a real model id:
```
A. config check: {"required":true,"independent":true,"reason":"independent: coding may use anthropic claude-opus-5-5; QA may use anthropic claude-opus-5-5-20261101"}
A. calls (agentRole:model sent): coding_agent:claude-opus-5-5, qa_agent:claude-opus-5-5-20261101
A. coding status: COMPLETED | QA status: COMPLETED | QA independence: {"status":"independent","required":true,"qaModels":["claude-opus-5-5-20261101"],...}
A2. coding helper on QA model, config check: {"required":true,"independent":true,"codingTargets":[{"provider":"groq","model":"llama-3.1-8b-instant","exact":false}]}
```
(The coding reply also reported `claude-opus-5-5-20261101`.)

`probeB_lineage_forgery.mts`:
```
B1. forged routeAs/agentRole in ctx.llm -> COMPLETED calls: default:forger_agent
B2. strict coding split into helpers -> COMPLETED calls: codeok:code_analysis_worker, codeok:code_analysis_worker
B3. strict coding research, max depth 2 -> COMPLETED calls: codeok:coding_agent
B3. limitations: ["acme/cdp-kit was not read in depth: at the depth limit: this agent may not create children, and the agent lacks the capability"]
B4. strictRouteRole on a depth-9 lineage -> coding_agent; 3.22 µs per call (100000 calls)
```

`probeC_identity_and_verify.mts` uses the real `OpenAICompatibleProvider` with its HTTP client replaced:
```
C. endpoint reports "gpt-4o-mini-2024-07-18": StrictRouteError: JARVIS_MODEL_REVIEW (openai, model gpt-4o-mini) failed; ... model identity not confirmed: openai answered with gpt-4o-mini-2024-07-18, not gpt-4o-mini; sent gpt-4o-mini
C. endpoint reports "gpt-4o-mini": answered (model gpt-4o-mini); sent gpt-4o-mini
D. verdicts [verified, (none)] -> met=true (1 result(s) verified); goal met
D. verdicts [verified, inconclusive] -> met=undefined (1 result(s) not fully verified (inconclusive); waiting for your review); goal needs_review
D. verdicts [verified, verified] -> met=true (2 result(s) verified); goal met
D. verdicts [(none), (none)] -> met=false (no result was checked by the Verification agent); goal unmet
D. verdictOf(finished failed + inconclusive) -> unverified
D. verdictOf(issue + inconclusive) -> issues
```

`probeE_claude_primary_bare.mts` uses Claude as primary, a stand-in Claude and a dummy key; nothing was sent. It reproduces M-B:
```
E. primary: anthropic | Claude brain model: claude-opus-5-5
E. strict QA route "gpt-5-mini" (bare): answered; model sent claude-opus-5-5; reported claude-opus-5-5
E. possibleTargets(qa_agent): [{"provider":"anthropic","model":"gpt-5-mini","exact":true}]
E2. config check: {"required":true,"independent":true,"reason":"independent: coding may use anthropic claude-opus-5-5; QA may use anthropic gpt-5-mini"}
E2. QA task: FAILED | model calls made: 1 claude-opus-5-5 | independent QA unavailable: QA was answered by claude-opus-5-5, a model coding may also use; human review required
```

Full outputs: `probeA.out`, `probeB.out`, `probeC.out` and `probeE.out` in the same folder, with `typecheck.txt`, `tests.txt`, `tests2.txt` and `base-newtests.txt`.

---

## 6. What only the owner's Windows PC or live providers can verify

- **The exact `model` string each provider reports for each configured route.** Strict routes fail closed on any other form.
  - OpenAI's API is known to report a dated snapshot id for an undated alias (for example `gpt-4o-mini-2024-07-18`). Probe C shows that a strict `openai:gpt-4o-mini` would then always fail.
  - Gemini's OpenAI-compatible endpoint and Groq need the same check; whether they report the id as asked, with `models/`, or resolved is not known here.
  - Claude: whether `models.retrieve(alias)` returns the same dated id that `messages.create` reports.
- **Live behaviour without the old fallbacks.**
  - The Gemini/Groq 429 and cooldown behaviour on the owner's quota, now that strict routes fail instead of swapping.
  - Claude without server-side fallbacks: how often a strict call is now refused.
- **End-to-end runs with real models.**
  - One strict coding run, one strict QA run, a GitHub research request under a strict coding agent, and QA independence with real models in each D1 setting.
  - How often a real QA reply arrives without a model field, which now ends QA FAILED when independence is required.
- **The tests skipped or blocked on Linux.** These are the Windows/PowerShell, Redis, `.venv`, bridge-token, live-provider and TTS tests listed in `after-ci.txt`.
