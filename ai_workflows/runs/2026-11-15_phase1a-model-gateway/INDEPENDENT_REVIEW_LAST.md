# Independent Review: Phase 1A, last review

**Reviewer:** an independent, read-only agent with no part in writing the code or the earlier reviews.
**Scope:** the uncommitted Phase 1A work on `claude/jarvis-repair` against base `c4ac909`, after the final-review fixes. That is the 11 tracked files in `git diff HEAD`, the untracked `bridge/providerGuard.ts`, `bridge/usageLedger.ts`, the 10 new tests, `docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md` and this run folder.
**Method:** I read the code and `git diff HEAD`, ran the typecheck and the named tests, and ran three probe scripts of my own with stand-in providers and tools (no network, no provider calls, ledger off, scratch workspace). The author's run-folder docs and `INDEPENDENT_REVIEW_FINAL.md` were read as context only. This file is the only repository file I wrote. Line numbers are from the current files.

---

## 1. Verdicts

**(a) Correctness of what was implemented: correct for the cases the fixes target, with three Low residuals.**
- **M2:** `agentIndependence()` now takes an unconfigured agent at the model it really sends, and treats any two models on the Gemini/Groq client as possibly the same. Both scenarios from the final review now give `independent=false` (probe I1–I4). The earlier checks, including round-3 L6, still hold. Residual: a configuration-only check still ignores the failover chain of an unconfigured side (N2).
- **L1:** a forged `inheritModelRoute` on a root task is ignored for coding, QA and PC (probe B5a–d). Legitimate coding and QA helpers still inherit, and failures still propagate (B1–B4). Residual: the new `parentAgentId` test never rejects anything, so inheritance is tied to the helper's role, not to its real parent (N1). No in-tree path exploits this today.
- **M1** (GitHub research path of a configured coding agent) is unchanged and still reproduces (probe R1). It is now documented as a known gap.

**(b) Is independent QA enforced today: No.**
- `agentIndependence()` and `observedAgentIndependence()` still have no runtime caller.
- QA's model comes only from its own route (`bridge/modelRouter.ts:333-338`).
- The automatic check of another agent's result is rule-based (`core/agents/behaviors/verify.ts`).

**(c) Readiness to commit: READY WITH CONDITIONS.**
1. The owner explicitly accepts M1 (MM-1A-P9) and M3 (MM-1A-P3) as known, documented gaps for this commit, or approves those proposals first. Both are behaviour gaps against requirement A, not doc issues.
2. Correct or accept the two over-statements under N1 and N3: the `toolLoop.ts` comment and tracker row MM-1A-23 ("spawned by it"), and `.env.example:70` for `openai:<model>`.

There is no High finding and no new Medium finding. I found no change to the approval gate or the tool permission path.

---

## 2. Item-by-item

### 2.1 M2 and L1 fixes

| Question | Answer | Evidence |
|---|---|---|
| M2 correct and complete? | Correct for both named scenarios; one residual (N2) | `bridge/modelCategories.ts:231` (`sent()`), `:204-214` (`sameModelPossible`). Probe I1: nothing set → both `groq llama-3.1-8b-instant`, not independent (the reason now names the model really sent). I2: `JARVIS_AGENT_MODEL=model-x` vs QA `groq:model-x` → not independent. I3/I4: two non-fast Groq models → not independent. I5: `JARVIS_MODEL_PLANNING` set and agents unset → both `plan-model`, which matches the router (an unconfigured agent then goes through the planning route, `modelRouter.ts:336`). I6: Claude vs Groq → independent. I7/I8/I11: two Claude models, two `openai:` names, and case/whitespace → not independent. `llmConfig.provider` is always `gemini` or `groq` (`config/llmconfig.ts:75-80`), so the third clause at `:210` adds nothing beyond the first two. That is harmless |
| L1 correct and complete? | Correct against every in-tree path I found; the `parentAgentId` clause is a no-op (N1) | `core/agents/behaviors/toolLoop.ts:72-79`. Root tasks can only target permanent specialists (`agentManager.ts` `startRootTask`, `NOT_A_SPECIALIST`; probe B6). `HELPER_OF` maps `coding_agent` to `code_analysis_worker` and `qa_agent` to `test_runner_worker`, so no specialist can match it. A2A data reaches only root-task input (`core/agents/a2a.ts:328`) |
| Can a legitimate helper fail to inherit? | No case found | `HELPER_OF` matches the `workerRole` wiring: `specialists.ts:90` (`code_analysis_worker`) and `:110` (`test_runner_worker`). Every spawned agent gets `parentAgentId` (`agentManager.ts:545`), and permanent specialists have `parentAgentId: 'jarvis'` (`:232`), so the clause never blocks. A retried child keeps its input (`agentManager.ts:1205-1209`). Probe B1/B2: both helpers of each parent ran on the parent's model. B3/B4: one helper's strict model failed, and the parent ended FAILED naming that helper, with no keyword tool run. B5d: a forged `qa_agent` key on a splitting coding task did not leak; both helpers ran on the coding model |
| Can a forged `inheritModelRoute` still move an agent onto another agent's model? | Not through any existing caller. Yes, if code spawns a `test_runner_worker` or `code_analysis_worker` with the key from a parent of another role (N1) | Probe B8: a permanent non-QA probe role spawned `test_runner_worker` with `inheritModelRoute: 'qa_agent'`, and the helper ran on QA's model (`checker:test_runner_worker`). `coding_agent` is allowed to spawn `test_runner_worker` (`specialists.ts:155`), but no behaviour does so with the key. Separately, the router honours `routeAs` from any request (`modelRouter.ts:336`; probe R4b), and only `toolLoop.ts:151` sets it |
| Did the independence change break an earlier check? | No | `reviewRound3FixesTest` (L6 included), `modelRouteRound3Test`, `modelRouteCorrectionsTest` and `modelRoleRoutingTest` pass. Their files are dated 09:41–16:00, before the final review (16:34), so they were not edited to fit. Probe O3: `(provider default)` on the primary still gives `null` |

### 2.2 Everything else still holds

| Area | Verdict | Evidence |
|---|---|---|
| Configured coding / QA helper inheritance and failure propagation | Holds | `strictHelperRoutingTest` PASS; probes B1–B4 |
| QA failure propagation | Holds | `qaModelFailureTest` PASS; B4; `toolLoop.ts:104-118`, `:159-170`, `:243-259` |
| Strict routes, M1–M4, M-2, M-3, N1, trial lease | Holds | `bridge/modelRouter.ts`, `bridge/providerGuard.ts` and `bridge/groqProvider.ts` were last changed before the final review (16:01, 15:19, 07:57), and the review-fix hashes list only `modelCategories.ts` and `toolLoop.ts`. `modelRouteCorrectionsTest`, `modelRouteRound3Test`, `reviewRound3FixesTest` and `providerIsolationTest` PASS. Probe R4: a failing strict QA route gives `StrictRouteError`, and only that provider was asked |
| Unrouted calls; foreground never delayed; cancellation | Holds | Probe R2: unrouted foreground call 1 ms, routed conversation call 1 ms, both during an active conversation. R3: cancelling an unrouted call and a strict `qa_agent` call both gave `AbortError`, with no fallback asked. The unrouted breaker change (earlier L2) is documented (`.env.example:140-144`) |
| Approval gate / tool permission path | Unchanged | `git diff --name-only HEAD` touches nothing under `security/`, `core/toolRegistryV2.ts`, `core/agents/permissions.ts`, `spawnPolicy.ts`, `toolExecutionSandbox.ts`, `commandSafety.ts` or `foregroundGate.ts`. The tool loop still calls `ctx.callTool` (`toolLoop.ts:178`). `agentManager.ts` only adds `agentRole` (`:1248`) |

### 2.3 Docs

| Check | Verdict | Evidence |
|---|---|---|
| `.env.example` matches the code | Mostly. One over-statement (N3) | Now correct: the in-adapter swaps for Gemini/Groq and Claude (`:70-73`); the research-path gap (`:108-112`); the rule-based verifier described as "not an AI verification", plus both verify gaps (`:117-121`); "nothing in JARVIS checks or enforces" independence (`:122-125`); BREAKER settings for ANTHROPIC/OPENAI only (`:140-146`, matches `groqProvider.ts:232` and `modelRouter.ts:297`). Still inaccurate: `:70` "sent to that provider and model" does not hold for `openai:<model>` |
| Tracker matches the code | Mostly. One over-statement (N1) | Fixed since the final review: MM-1A-06 (`:88`) and "Model integration status" (`:121-129`). MM-1A-P9 names M1 (`:118`). MM-1A-23 (`:103`) says "only a parent's own helper, spawned by it, inherits its route"; the code checks the helper's role, not which agent spawned it (N1) |
| No claim of independent QA enforcement, AI verification by the rule verifier, or strictness the runtime lacks | Holds in `.env.example` and the tracker | Tracker `:128` "NOT ENFORCED". QA's own role text still says "independently" (`specialists.ts:110`, `:171`); this predates 1A and is earlier L5 |
| Known gaps named | Yes, except N2 and the third swap case (N3) | M1 → P9; M3 → P3; independence → P4; verify → P7 |

### 2.4 Test integrity

| Check | Result |
|---|---|
| `git diff --name-only HEAD -- tests` | empty |
| `pnpm-lock.yaml`, `package.json` | no diff |
| `git diff --check HEAD` | clean |
| New tests fail on `c4ac909` | `evidence/final-review-fixes/new-tests-on-original-c4ac909.txt`: all 10 FAIL. I re-ran `finalReviewFixesTest` and `strictHelperRoutingTest` in the base copy. Its test files are byte-identical to the repo's, and its `modelCategories.ts`, `modelRouter.ts`, `toolLoop.ts`, `groqProvider.ts` and `agentManager.ts` match `git show c4ac909`. Both FAIL (`TypeError: categories.agentIndependence is not a function`; 7 passed / 15 failed). The author's fail-before against the pre-fix tree shows 2 passed / 8 failed |
| Per-test verdicts vs baseline | All 231 pre-existing tests have the same verdict in `evidence/final-review-fixes/after-ci.txt` as in `evidence/baseline-ci.txt` (221 PASS, 1 BLOCKED, 9 SKIP). The only additions are the 10 new tests, all PASS (231 passed in total). `after-ci.txt` (16:51:32 UTC) is newer than every changed source file (latest 16:38) |

---

## 3. Findings

### High

None.

### Medium (carried over, documented, not fixed)

**M1 (final review M1). A configured coding agent's GitHub research request ends COMPLETED by rules after its strict model failed.**
- **Where:** `core/agents/specialists.ts:85-91`, `core/agents/behaviors/common.ts` (`askJson`), `core/agents/behaviors/research.ts:324-333`. None of these is in the diff.
- **Scenario (probe R1):**
  1. `JARVIS_MODEL_AGENT_CODING_AGENT=codefail:code-model`, a provider that fails.
  2. The request is "Find TypeScript libraries for Chrome DevTools Protocol".
  3. The task ends `COMPLETED` with no `answeredBy`, and `github_search` runs twice.
  4. The limitation says "rules were used instead", and the reason is cut at 120 characters.
- **Fix:** MM-1A-P9 as proposed (`proposals/PROPOSALS_ITEMS_2_3.md:182-216`). One point on that proposal: a split research request would go to `code_analysis_worker`, which has no `github_search` or `github_repo` (`specialists.ts:236`). Those parts would be answered by the model without GitHub data. That is not a failure, but it is worth a test.

**M3 (final review M3). Strict routes can still be answered by another model inside the provider.**
- **Where:** the Gemini/Groq client's 429/cooldown swap (`bridge/groqProvider.ts:181-182`, `:388-396`) and Claude's server-side fallbacks.
- **Status:** now documented at `.env.example:70-73`. MM-1A-P3 is still awaiting approval.

### Low (new)

**N1. The `parentAgentId` clause in `inheritedRole` is a no-op, so a route is bound to the helper's role, not to the agent that spawned it.**
- **Where:**
  - `core/agents/behaviors/toolLoop.ts:77`;
  - the comment at `:66-71` ("spawned by an agent (not a root task) … task input can never move an agent onto another agent's model");
  - tracker `:103` ("spawned by it").
- **Scenario:**
  - Every non-JARVIS agent has a `parentAgentId`; a root specialist has `'jarvis'` (probe B7). So `!ctx.agent.parentAgentId` never rejects.
  - Root tasks are kept out by `NOT_A_SPECIALIST`, not by this clause.
  - Probe B8: a non-QA parent spawned `test_runner_worker` with `inheritModelRoute: 'qa_agent'`, and the helper ran on QA's model.
  - In-tree, no behaviour spawns a helper with the key except the tool loop for its own `workerRole`, so this is not reachable today. It becomes reachable if a later behaviour (for example `coding_agent`, which may spawn `test_runner_worker`) passes task input through to a child.
- **Fix:**
  - Replace the clause with `ctx.agent.parentAgentId !== parent`. Permanent specialists' agent id is their role (`agentManager.ts:230-232`), and a specialist always runs as that record (`:535-536`).
  - Add a B8-style case to `finalReviewFixesTest`.
  - Alternatively, correct the comment and the tracker row to say the binding is by helper role.

**N2. `agentIndependence()` ignores the failover chain of an unconfigured side.**
- **Where:** `bridge/modelCategories.ts:225-240`.
- **Scenario:**
  - Probe I9: coding unset, QA strict on `openai:…`. The result is `independent=true` ("coding uses groq llama-3.1-8b-instant, QA uses openai gpt-4o-mini").
  - But an unconfigured coding agent's call is not strict and fails over to other configured providers (`modelRouter.ts:501-516`). When the fallback is configured, coding can be answered by the same `openai` model as QA.
  - Probe I10 is the mirror case. With Claude as the primary, the same applies to Claude failing over to Groq.
  - `observedAgentIndependence` catches it from the records (probe O6: `not independent`).
- **Impact:** none at runtime, because there is no consumer. Proposal item 2 would enforce on this function before the call. Its test 2 ("QA unset … as coding does") assumes coding is also unset.
- **Fix:**
  - Report `independent: true` only when both sides are strict (configured) routes.
  - Otherwise, report "not independent" when the other side's provider is in the unconfigured side's failover order.
  - Add I9/I10 to a test.

**N3. `.env.example:70` says a configured kind "is sent to that provider and model", but `openai:<model>` sends `JARVIS_FALLBACK_MODEL`.**
- **Where:** `bridge/openaiProvider.ts:29`, `:71-74`. This is the third exception named in final-review M3; the text now names only the other two.
- **Scenario:**
  - `JARVIS_MODEL_AGENT_QA_AGENT=openai:gpt-5` is sent as `gpt-4o-mini` when `JARVIS_FALLBACK_MODEL` is unset.
  - `effectiveTarget` already models this (`modelCategories.ts:192`), so independence is not affected.
- **Fix:** add "(for `openai:`, the model is always `JARVIS_FALLBACK_MODEL`)" to `.env.example:70`.

### Info

- `modelRouter.ts:336` honours `request.routeAs` from any caller (probe R4b: a `pc_agent` request with `routeAs: 'qa_agent'` went to QA's strict route). Only `toolLoop.ts:151` sets it, after the `inheritedRole` checks. A check in the router that `agentRole` is `HELPER_OF[routeAs]` would put the guard where the route is chosen.
- `.env.example:97-99` says `keyword_rules` "can happen for every agent except QA and a coding_agent with its own setting". On the research path a configured coding agent can be answered by rules, but its result carries no `answeredBy`, so the sentence is literally true. The gap is named two bullets later.
- Tracker notation: MM-1A-23 "FAIL (2/8)" means 2 passed, 8 failed. MM-1A-01 still cites `--ci 225/0`; the latest run is 231 passed. `FINAL_APPROVAL_REPORT.md` (tracker `:158`) does not exist yet.

---

## 4. Earlier findings still open

| Finding | Status |
|---|---|
| Final M1 (research path) | **Open**, documented (`.env.example:108-112`, MM-1A-P9) |
| Final M2 (independence false positives) | **Fixed** for the two scenarios; residual N2 |
| Final M3 / Corrections M-4 (in-adapter swaps) | **Open**, documented (MM-1A-P3); `openai:` wording, N3 |
| Final L1 (forged route key) | **Fixed** for all in-tree paths; residual N1 |
| Final L2 (unrouted breaker) | Accepted and documented |
| Final L3 (doc inaccuracies) | **Fixed** |
| Final L4 (item 3 incomplete) | Proposal extended (`PROPOSALS_ITEMS_2_3.md:218-232`); not implemented, as intended |
| Final L5 (QA role text "independently") | **Open**, pre-existing; part of proposal item 2 |
| Independence enforcement (MM-1A-P4), verify inconclusive (MM-1A-P7), MM-1A-P2, P5, P6 | Proposals; not implemented |

---

## 5. What I ran

| Command (repo root unless noted) | Result |
|---|---|
| `pnpm run typecheck` | exit 0 |
| `pnpm test -- --only=finalReviewFixesTest,strictHelperRoutingTest,qaModelFailureTest,reviewRound3FixesTest,modelRouteRound3Test,modelRouteCorrectionsTest,modelRoleRoutingTest,agentSpecialistsTest,sevenAgentTest` | 9 passed · 0 failed · 0 timed out · 0 blocked |
| `pnpm test -- --only=providerIsolationTest` | 1 passed |
| Base copy: `pnpm test -- --only=finalReviewFixesTest,strictHelperRoutingTest` | both FAIL |
| `git diff --name-only HEAD -- tests`; `git diff HEAD -- pnpm-lock.yaml package.json`; `git diff --check HEAD` | empty; empty; clean |
| Per-test verdicts, `baseline-ci.txt` vs `final-review-fixes/after-ci.txt` | only the 10 new tests added, all PASS |
| `git status --short` before and after the probes | identical |

The probes are in `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review-last/`, each run with `pnpm exec tsx <path>`. Their outputs are in the `.out` files there.

**`probeL1.mts`** (real `AgentManager`, real router, stand-in providers and tools):
```
B1 coding split, both configured        COMPLETED model; coder:code_analysis_worker ×2
B2 QA split, both configured            COMPLETED model; checker:test_runner_worker ×2
B3 coding split, one part's model fails FAILED "The coding_agent agent could not complete every part … strict …"; tools: none
B4 QA split, one part's model fails     FAILED "QA could not check every part: … strict …"; tools: none
B5a root coding_agent, key=qa_agent     coder:coding_agent      (ignored)
B5b root qa_agent, key=coding_agent     checker:qa_agent        (ignored)
B5c root pc_agent, key=coding_agent     default:pc_agent        (ignored)
B5d root coding split, key=qa_agent     coder:code_analysis_worker ×2
B6 root task at test_runner_worker      rejected NOT_A_SPECIALIST
B7 root specialist parentAgentId        "jarvis"
B8 non-QA parent → test_runner_worker, key=qa_agent      checker:test_runner_worker  (inherits QA's model)
B8b same parent, key=coding_agent                         default:test_runner_worker  (ignored)
```

**`probeM2.mts`** (configuration only; llmConfig here: primary groq, model qwen-2.5-32b, fast llama-3.1-8b-instant):
```
I1 nothing set                       false  both use groq llama-3.1-8b-instant
I2 AGENT_MODEL=model-x, QA groq:model-x  false
I3 groq:model-a vs groq:model-b      false  (fast-model swap)
I4 bare model-a vs groq:model-b      false
I5 PLANNING set, agents unset        false  both plan-model
I6 anthropic:claude-a vs groq        true
I7 two Claude / I8 two openai / I11 case   false
I9 coding unset, QA openai:…         true   (coding can fail over to openai)  → N2
I10 QA unset, coding openai:…        true                                     → N2
O1/O2/O7/O8 no / failed-only / helper-only / other correlation id → null
O3 (provider default) on primary     null (L6 holds)
O4 two non-fast on groq              false
O6 both answered by openai           false
```

**`probeRegress.mts`:**
```
R1 configured failing coding, research request: COMPLETED, answeredBy none, tools github_search ×2, "rules were used instead"
R2 foreground during conversation: unrouted 1 ms; routed conversation 1 ms
R3 cancel: unrouted AbortError (asked p only); strict qa_agent AbortError (asked strictp only)
R4 strict QA failure: StrictRouteError, asked qadown only
R4b routeAs=qa_agent on a pc_agent request at the router: sent to QA's route
```

---

## 6. What needs the owner's Windows PC or live providers

- Whether live Gemini/Groq really move a strict route to the fast model under the owner's quota, and whether Claude's server-side fallbacks answer a strict route (M3).
- The real error bodies and status codes of each provider, and so when a same-provider retry or a breaker opening happens.
- How often a live model returns an empty answer, which ends a configured coding or QA task FAILED.
- The cold usage-ledger read and appends on the PC's disk with antivirus.
- The tests skipped or blocked on Linux (Windows/PowerShell, Redis, `.venv`, bridge token, live providers), and voice behaviour while a background agent waits during a real conversation.
- The A2A HTTP endpoint, if the owner enables it. I found no path from it to helper input, but I did not run it.
