# Independent Review: Phase 1A, final cycle

**Reviewer:** an independent, read-only agent with no part in writing the code or the earlier reviews.
**Scope:** all uncommitted Phase 1A work on `claude/jarvis-repair` against base `c4ac909`: the 11 tracked files in `git diff HEAD`, the untracked `bridge/providerGuard.ts`, `bridge/usageLedger.ts`, the 9 new tests, `docs/implementation/JARVIS_IMPLEMENTATION_TRACKER.md` and this run folder.
**Method:** I read the diff and the code it calls, ran the typecheck and the nine named tests, and ran six probe scripts with stand-in providers and tools (no network, no provider calls). The author's `change_log.md`, `verification.md`, handovers and earlier reviews were read as context only. This file is the only repository file I wrote. Line numbers are from the current files.

---

## 1. Verdicts

**(a) Implementation correctness: correct on the paths it changed, with one gap.**
The router (strict routes, attempt log, waits, queue-wait limit, guard tickets) and the tool-loop split path behave as the owner asked. A configured coding agent whose helper fails ends FAILED, and so does a QA agent whose worker was answered by keyword rules. The gap is the coding agent's other request path. A GitHub research request ("find/compare … libraries") goes to `githubResearchAgent`, not the tool loop. There, a `StrictRouteError` is swallowed and keyword rules are used, the task ends COMPLETED, and its research workers do not inherit the coding route (finding M1). A second, smaller defect: the route-inheritance input key is accepted from any task input, so an A2A caller can move coding onto QA's model or QA onto coding's (L1).

**(b) Independent QA enforced today: No.**
- `agentIndependence()` and `observedAgentIndependence()` are referenced only by four tests (`grep` over `*.ts`: `tests/modelRoleRoutingTest.ts`, `modelRouteCorrectionsTest.ts`, `modelRouteRound3Test.ts`, `reviewRound3FixesTest.ts`).
- No runtime code compares QA's model with coding's. QA's model comes from its own route alone (`bridge/modelRouter.ts:333-338`).
- The automatic check of another agent's result (`core/agents/behaviors/verify.ts:132-163`) uses rules and no model.
- The two functions can also report "independent" for calls the same model may have answered (M2).

**(c) Readiness to commit: READY WITH CONDITIONS.**
1. Fix M1 (rethrow strict and queue-wait failures in `askJson`, and pass the route to research workers or route a configured coding agent's research through the tool loop). Alternatively, record it in `.env.example` and the tracker as a known exception, so the doc no longer says a configured coding agent cannot end on keyword rules.
2. Correct the docs listed under H: `.env.example:70` ("really answers with that model"), the breaker settings for GEMINI/GROQ, and the stale tracker rows.
3. The owner should know that M2 must be fixed before proposal item 2 builds enforcement on `agentIndependence()`.

No High finding. No security weakening found.

---

## 2. Requirements A–I

| Req | Verdict | Evidence |
|---|---|---|
| **A** Configured coding-agent split | **Partly met** | **Met on the tool-loop split path.** The parent passes its strict role to each helper (`core/agents/behaviors/toolLoop.ts:217`, `:221`). The helper sends it as `routeAs` (`:138`, `:144`). The router uses it only when it is a configured strict route (`bridge/modelCategories.ts:119-123`, `bridge/modelRouter.ts:336`). A strict failure ends the helper (`toolLoop.ts:97-101`, `:147`). An empty answer also ends it (`:155-163`). The parent fails unless every part completed with `answeredBy === 'model'`, its own parts included (`:229-252`). Probe P1: one helper failed and the other succeeded; the parent was FAILED, named the failed helper with the strict error, and no keyword tool ran. An unconfigured coding agent keeps the old split (test §4). **Not met on the GitHub research path** (`core/agents/specialists.ts:87-90` → `research.ts:301-351`). It falls back to rules after a strict failure (`core/agents/behaviors/common.ts:65-84`) and ends COMPLETED (probe P6). Its workers do not inherit the coding route (`research.ts:324-333`). QA helpers of a configured QA inherit its route (test §5) |
| **B** QA failure propagation | **Met** | Any QA model failure ends the task (`toolLoop.ts:99`, `:103-110`); the original error is kept as `cause` or as the error itself. An empty QA answer fails (`:155-163`). Worker parts answered by keyword rules or left unfinished fail QA (`:236-252`). Probe P4: unconfigured QA with the model down was FAILED, split and unsplit, with the 503 reason in the message |
| **C** Independence | **Partly met** | The author's two points are confirmed: the runtime does not enforce independence, and only a proposal exists (§1b). No result field claims independence: `answeredBy` is documented as "None of these is an independent check" (`toolLoop.ts:113-119`), and `.env.example:114-116` says nothing enforces it. Two problems remain. QA's role text still says "independently" (`specialists.ts:110`, `:171`); this predates 1A and is in proposal item 2. The functions can report `independent: true` where the same effective model may answer (M2). They correctly return `null` for an unknown model, for a side with no successful call, and for a failed-only QA (probe I1) |
| **D** Automatic verification | **Both points confirmed; the proposal is correct for what it covers, but incomplete** | `verify.ts:147` and `:150` push `ok: true` when the re-read did not run. Probe V1: with `github_repo` failing (503), the verdict was `verified` and the summary "Verified: 8 checks passed.". `core/goalVerifier.ts:92-100` counts every verdict except `issues` as met. Probe V2: `unverified`, `not verified` (the string `goalExecutor.ts:188` stores) and `inconclusive` all gave `met=true`, with evidence "1 result(s) verified". On the proposal: see §3 L4 |
| **E** Earlier corrections | **Met (no regression found)** | **M1:** `categoryChat` waits before its timer (`modelRouter.ts:213`). `routedChat` waits before `withRouteTimeout` (`:415-417`). `waitForTurn` applies `JARVIS_MODEL_QUEUE_WAIT_MS`. **M2:** a strict bare model asks only the primary (`chainTarget`, `:396-399`; `failoverOrder` returns `[name]`). **M3:** the attempt log keys on provider instance plus model (`pairKey`); an explicit route time-out is provider-wide (`:421-426`). **M4:** a strict QA route throws `StrictRouteError` (`:420`). **M-2:** a same-provider retry happens only after `model`, `bad_request` or `bad_response` (`:93`, `noteOutcomeFailure`). **M-3:** every fallback attempt waits (`waitEach`, `:431`, `:666`). **Trial lease:** ticketed (`providerGuard.ts:96-170`). **Round-3 M1/N1:** empty-answer rule (`toolLoop.ts:155`). **L1:** budget on a strict route (`:100`). **L4:** the `reported` flag in both stream paths. **L5:** `withPriorCause`. **L6:** `UNKNOWN_MODEL` returns `null`. **Round-3 L7** (QA's own parts after the step limit) is now closed: own parts need `modelAnswered === true` (`:232`). The covering tests pass (§4) |
| **F** Open Medium/High from earlier reviews | — | See the table after this one |
| **G** Regression risk | **Met, with one documented behaviour change** | **Unrouted calls:** `chat()` goes to `chain()` exactly as before when no route is configured (`modelRouter.ts:537-541`). One difference is new: every provider without its own breaker (Claude, OpenAI-compatible) now has the router's breaker. Probe U1: after two 429s the third unrouted call skipped Claude, where `c4ac909` asked it again (L2). **Foreground:** probe U2 took 0 ms during an active conversation; `yieldToForeground` returns 0 outside an agent scope. **Cancellation:** probe U3 gave `AbortError` with no fallback; routed paths rethrow on `signal.aborted` before any strict wrapping (`:419`, `:660`). **Approval and tool path:** `git diff HEAD` is empty for `core/toolRegistryV2.ts`, `security/`, `core/agents/permissions.ts`, `core/agents/spawnPolicy.ts`, `core/toolExecutionSandbox.ts`, `core/commandSafety.ts` and `core/foregroundGate.ts`. The tool loop still calls `ctx.callTool`. The `agentManager.ts` change only adds `agentRole` (`:1248`). **Security:** redaction still runs on every send path (`callNamed`, `chain`, `streamFrom`, `primaryStream`). The route key is removed from the model's context (`toolLoop.ts:127`). No weakening found |
| **H** Docs accuracy | **Partly met** | **Correct:** the retry policy is documented as implemented (`.env.example:76-83`; tracker MM-1A-22). The queue-wait scope and the helper inheritance are also documented. **Inaccurate:** `.env.example:70` "A kind set here really answers with that model" (in-adapter swaps; earlier M-4, still open). `.env.example:95-99`: "a coding_agent with its own setting ends FAILED … when its model fails" does not hold for research requests (M1). `.env.example:128-134`: the BREAKER_429S/BREAKER_MS settings have no effect for GEMINI/GROQ, because that client declares `ownBreaker: true` (`groqProvider.ts:232`) and the guard then skips its breaker (`modelRouter.ts:297`). Tracker: "Model integration status" says Claude coding/review "agents not routed" and Gemini conversation "not routed" (`JARVIS_IMPLEMENTATION_TRACKER.md:119-126`), but agents and conversation can now be routed; MM-1A-06 says "independence reported" (`:88`), but nothing reports it (L3) |
| **I** Test integrity | **Met** | `git diff --name-only HEAD -- tests` is empty. `pnpm-lock.yaml` and `package.json` have no diff. `git diff --check` is clean. `evidence/final-cycle/new-tests-on-original-c4ac909.txt` shows all 9 new tests FAIL on `c4ac909`. I re-ran `strictHelperRoutingTest` and `qaModelFailureTest` in the base copy, whose copies are byte-identical to the repo's: 7/15 and 6/20 passed/failed. Per-test verdicts: all 231 pre-existing tests in `evidence/final-cycle/after-ci.txt` have the same verdict as in `evidence/baseline-ci.txt` (221 PASS + `dependencyImportCheck` PASS, 1 BLOCKED, 9 SKIP). The only additions are the 9 new tests, all PASS. `after-ci.txt` (16:19 UTC) is newer than every changed source file (latest 16:05) |

### F. Medium/High findings from earlier reviews

| Finding | Status now |
|---|---|
| Review 1 M1–M3 (wait vs time limit, bare-model strictness, double attempts) | Fixed |
| Review 1 M4 / Corrections H-1 (strict QA/coding failure ends COMPLETED) | Fixed for the tool loop. Still open for the coding agent's research path (M1 below) |
| Corrections M-1 (independence can be reported for the same model) | **Partly open.** Case, `default` and `openai:` aliases are fixed. The fast-model swap of two non-fast models, and the unconfigured-agent target, are not (M2 below). Without `correlationId`, `observedAgentIndependence` still pairs the latest calls across tasks; there is no consumer yet |
| Corrections M-2 (fallback on the primary's provider) | Resolved by owner decision: de-duplicate on provider plus model, and retry only after a model-specific failure |
| Corrections M-3 (fallback did not wait) | Fixed |
| Corrections M-4 (a strict route can still be answered by another model; the docs say not) | **Open.** The in-adapter swaps are MM-1A-P3 (awaiting approval), and `.env.example:70-75` still promises the configured model |
| Corrections M-5 (`.env.example` wording) | Mostly fixed; see H |
| Round 3 M1, M3; follow-up N1 | Fixed |
| Round 3 M2 (split requests of a configured coding agent) | Fixed for the tool-loop split (MM-1A-21). Not for the research path (M1) |

---

## 3. Findings

### High

None.

### Medium

**M1. A configured coding agent ends COMPLETED through rules after its strict model failed, when the request is GitHub research.**
- **Where:** `core/agents/specialists.ts:87-90`, `core/agents/behaviors/common.ts:65-84` (`askJson` catches every non-abort error), `core/agents/behaviors/research.ts:301-351` (workers spawned at `:324-333` with no route key).
- **Scenario:**
  1. `JARVIS_MODEL_AGENT_CODING_AGENT=provider:model`, and that provider is down.
  2. The request is "Find TypeScript libraries for Chrome DevTools Protocol", one of `coding_agent`'s own examples (`specialists.ts:156`).
  3. `askJson` turns the `StrictRouteError` into rule-built queries. `github_search` runs, and the task ends COMPLETED.
- **Probe P6:** `status=COMPLETED`, `modelCalls: codefail:coding_agent`, `toolCalls: github_search,github_search`. The limitation keeps only 120 characters of the error, so the reason is cut ("…so no other model answered: c").
- **Other effects:**
  - With a working coding model, the discovery and code-analysis workers still call on the planning/default route.
  - The result carries no `data.answeredBy`.
- **Contradicts:** requirement A ("no keyword fallback after a strict failure"; "never COMPLETED if … done without the required model") and `.env.example:95-99`.
- **Fix (protected files):**
  - In `askJson`, rethrow when `err.name` is `StrictRouteError` or `QueueWaitTimeoutError`, as `toolLoop.ts:97-110` does. Rethrow a `BudgetExceededError` too when the agent is on a strict route.
  - Pass `inheritModelRoute` to the research workers, or send a configured coding agent's research through the tool loop.
  - Add a test for a configured coding agent with a failing model and a research request.
  - If the owner defers this, document it as an exception in `.env.example` and the tracker.

**M2. `agentIndependence()` and `observedAgentIndependence()` can report `independent: true` when the same model may have answered both.**
- **Where:** `bridge/modelCategories.ts:204-213` (`sameModelPossible`), `:224-235`.
- **Scenario 1: fast-model swap.**
  - Coding is `groq:model-a` and QA is `groq:model-b` (both on the primary Gemini/Groq client, neither of them its fast model).
  - The client moves any model to its fast model on a 429 or during a cooldown (`groqProvider.ts` `startModel` and the 429 branch). So both can be answered by `llama-3.1-8b-instant`.
  - The check only catches this when one side *is* the fast model.
  - Probe I1: `agentIndependence` gave `independent=true`, and `observedAgentIndependence` gave `independent=true | different models answered`.
- **Scenario 2: unconfigured coding target.**
  - An unconfigured agent sends `agentModel()` (`JARVIS_AGENT_MODEL` or the fast model, `common.ts:20-22`), but `agentIndependence` takes the planning default `llmConfig.model`.
  - Probe I2: with `JARVIS_AGENT_MODEL=model-x` and `JARVIS_MODEL_AGENT_QA_AGENT=groq:model-x`, both agents send `groq model-x`. The result was `independent=true … coding uses groq qwen-2.5-32b, QA uses groq model-x`.
  - With nothing set, the verdict is right but the reason names the wrong model ("both use groq qwen-2.5-32b"; both actually send `llama-3.1-8b-instant`).
- **Impact:** none at runtime today, because there is no consumer. It breaks requirement C and the functions' own doc comments. Proposal item 2 would enforce with `agentIndependence(env)`, so the defect would become live.
- **Fix:**
  - Treat two models on the Gemini/Groq client as "not independent" whenever the fast-model swap is possible, i.e. always unless MM-1A-P3 disables it on strict routes.
  - For an unconfigured agent route, take the model the agent really sends: `agentModel()` when the route's source is `default`.
  - Add both cases to a test.

**M3 (carried over, earlier M-4). Strict routes can still be answered by another model, and `.env.example:70` says they cannot.**
- **Where:** `groqProvider.ts` 429/cooldown swap; Claude server-side fallbacks; `openai:<model>` sends `JARVIS_FALLBACK_MODEL` (`openaiProvider.ts`).
- **Scenario:** `JARVIS_MODEL_AGENT_QA_AGENT=gemini:<pro model>`, and Gemini answers 429. The client retries with the fast model, which answers. QA ends COMPLETED with `answeredBy: 'model'`, and the usage record names the pro model.
- **Fix:** approve MM-1A-P3, or add one sentence to `.env.example:70-75` naming these three exceptions.

### Low

**L1. The route-inheritance key is accepted from any task input, so it can move a coding or QA task onto the other's model.**
- **Where:** `toolLoop.ts:66-79`, `:138`. The comment at `:60-65` says it "can only make a helper stricter, never move it elsewhere".
- **Scenario:** an A2A caller's data part is copied into the root task's input (`core/agents/a2a.ts:328`). That requires the opt-in A2A HTTP endpoint and its token (`jarvisAgents.ts:109-122`); no in-process caller sets the key. Probe P2:
  - `inheritModelRoute: 'qa_agent'` on a coding task sent the coding work to QA's model (`qaok:coding_agent`);
  - `'coding_agent'` on a QA task sent QA to the coding model (`codeok:qa_agent`);
  - `'coding_agent'` on `pc_agent` made the PC agent strict on the coding model.
- **Effect:** QA silently uses the coding model. The proposed independence check (item 2) would compare configuration, not the route actually taken.
- **Fix:**
  - Honour the key only when the task's agent is the named parent's worker role (`code_analysis_worker` for `coding_agent`, `test_runner_worker` for `qa_agent`), and only when the task's parent task belongs to that role. Better, let the manager set it from the parent, not from `input`.
  - Strip it from root-task input in `startRootTask`.

**L2. Unrouted calls to providers without their own breaker now pause after two 429s.**
- **Where:** `modelRouter.ts:290-301` (`admit`, called from `chain` and `primaryStream`).
- **Scenario:** `JARVIS_LLM_PROVIDER=anthropic`, no `JARVIS_MODEL_*` set. After two 429s, Claude is skipped for 60 s (probe U1, against `c4ac909`). With no second provider, the owner's own call fails at once with "anthropic rate-limited locally".
- **Status:** intended (MM-1A-03) and documented in `.env.example:128-131`. It is still a change to unrouted behaviour.
- **Fix:** none needed if accepted. Otherwise, apply the router breaker only to background calls, or only to routed calls.

**L3. Doc inaccuracies (H).**
- `.env.example:128-134` presents BREAKER_429S/BREAKER_MS for GEMINI and GROQ; they do nothing for that client (`ownBreaker: true`).
- Tracker `:119-126` "Model integration status" is stale.
- Tracker `:88` (MM-1A-06) says "independence reported".
- `.env.example:112` names only the re-read gap, not that the goal criterion counts `unverified` as met.
- **Fix:** edit the text.

**L4. Proposal item 3 is correct for the cases it covers but incomplete.**
- **Correct:**
  - The verdict order (`unverified` → `issues` → `inconclusive` → `verified`).
  - The two re-read branches now keep the full reason.
  - The goal criterion treats every verdict except `verified` and `issues` as needs-review, which also covers the `not verified` string from `goalExecutor.ts:188`.
- **Not covered:**
  1. `evidenceCheckWorker` reports "matches the answer" when GitHub returns no licence but the answer states one (`verify.ts:122`). Probe V1 `ok-no-licence`: "acme/widget exists; matches the answer", verdict `verified`.
  2. The spoken completion (`jarvisAgents.ts:202`) mentions only `issues`, so an `inconclusive` result is announced without "needs review".
  3. The proposed test does not cover `not verified`, a spawn that throws, or a worker that was CANCELLED or timed out.
  4. A research answer with only non-GitHub sources gets no re-read and can still be "Verified".
- **Fix:** treat `licence === null` with a stated licence as `inconclusive`; add the spoken note; extend the test.

**L5. Pre-existing: QA's role text claims independence** (`specialists.ts:110`, `:171`). Covered by proposal item 2.

### Info
- With an unconfigured QA and the model down, the split helpers still run keyword tools (`dev_status` twice, probe P4) before QA ends FAILED. They are read-only. The result is correct.
- `route.independent` for `review` (`modelCategories.ts:152-160`) is unchanged from `c4ac909`, still compares raw strings, and has no consumer.
- The owner-decision row in the tracker mentions `FINAL_APPROVAL_REPORT.md`; no such file exists in the run folder yet.

---

## 4. What I ran

| Command (from the repo root unless noted) | Result |
|---|---|
| `pnpm run typecheck` | exit 0, no output from `tsc --noEmit` |
| `pnpm test -- --only=strictHelperRoutingTest,qaModelFailureTest,reviewRound3FixesTest,modelRouteRound3Test,modelRouteCorrectionsTest,modelRoleRoutingTest,providerIsolationTest,agentSpecialistsTest,sevenAgentTest` | 9 passed · 0 failed · 0 timed out · 0 blocked |
| In the base copy: `pnpm test -- --only=strictHelperRoutingTest,qaModelFailureTest` | both FAIL (7 passed/15 failed; 6 passed/20 failed) |
| `git diff --name-only HEAD -- tests`; `git diff HEAD -- pnpm-lock.yaml package.json`; `git diff --check HEAD` | empty; empty; clean |
| Per-test verdict diff of `baseline-ci.txt` vs `final-cycle/after-ci.txt` | only the 9 new tests added (all PASS); no changed verdict |
| `git status --short` after the probes | unchanged (11 modified, the same untracked files) |

The probes are in `/tmp/claude-0/-home-user-pm-claude-skills/3f3c860d-f160-54b3-98e3-1d95ccd1bf66/scratchpad/review-final/`, each run with `pnpm exec tsx <path>`. Their outputs are the `.out` files there. All use stand-in providers and tools, the usage ledger set to off, and a scratch workspace.

**`probeAgents.mts`** (real `AgentManager`, real `modelRouter`):
```
P1 configured coding split, one helper fails, one succeeds
  status=FAILED error=The coding_agent agent could not complete every part with its configured model:
  code_analysis_worker-2 (code_analysis_worker): failed — JARVIS_MODEL_AGENT_CODING_AGENT (codehalf, model code-model) failed;
  this route is strict, so no other model answered: codeh…   [my print cut at 260 chars]
  modelCalls: codehalf:code_analysis_worker,codehalf:code_analysis_worker   toolCalls: (none)
P2a forged inheritModelRoute=qa_agent on coding_agent   → COMPLETED, modelCalls: qaok:coding_agent
P2b forged inheritModelRoute=coding_agent on qa_agent   → COMPLETED, modelCalls: codeok:qa_agent
P2c forged inheritModelRoute=coding_agent on pc_agent   → COMPLETED, modelCalls: codeok:pc_agent
P2d forged inheritModelRoute=browser_agent (not strict) → ignored, modelCalls: default:coding_agent
P3 helper with forged key via runLoop: routeAs sent: qa_agent; key not in the model's message; answered by qaok
P4 QA split, QA unconfigured: default up → COMPLETED answeredBy=model;
   default down → FAILED "QA could not check every part: … answered by keyword rules, not its model" (toolCalls dev_status,dev_status);
   default down, no split → FAILED "The QA agent's model was not available, so nothing was checked: default model is down (503)"
P5 coding configured, QA unconfigured split → helpers on default, COMPLETED (no cross-inheritance)
P6 configured coding (failing), GitHub research request → status=COMPLETED, summary "No GitHub candidates were found.",
   limitation "Search queries: the model was not available (…strict, so no other model answered: c); rules were used instead."
   modelCalls: codefail:coding_agent  toolCalls: github_search,github_search
```

**`probeVerify.mts`** (verify.ts on the current code, goalVerifier):
```
github_repo=down:          verdict=verified summary="Verified: 8 checks passed." re-read ok:true "not checked: could not re-read acme/widget: HTTP 503"
github_repo=ok-no-licence: verdict=verified re-read ok:true "acme/widget exists; matches the answer"   (answer says Apache-2.0)
github_repo=ok-mit:        verdict=issues  "acme/widget exists, licence MIT; the answer says Apache-2.0"
goal criterion verified: verified→met; issues→unmet; unverified→met; "not verified"→met; inconclusive→met  (evidence "1 result(s) verified")
```

**`probeIndependence.mts` / `probeIndependence2.mts`** (llmConfig here: provider groq, model qwen-2.5-32b, fast llama-3.1-8b-instant):
```
nothing set:                 independent=false "both use groq qwen-2.5-32b"   (agents actually send llama-3.1-8b-instant)
same model, case / default vs primary / two openai names / two Claude models: independent=false
two non-fast models on groq: independent=true     (both can be moved to the fast model)
observed: no records / failed-only QA / unknown model / helper-only records / other correlation id → null
observed: two non-fast on groq → true "different models answered"
JARVIS_AGENT_MODEL=model-x, QA=groq:model-x, coding unset → independent=true "coding uses groq qwen-2.5-32b, QA uses groq model-x"
```

**`probeUnrouted.mts`** (current tree vs the base copy):
```
U1 Claude-like provider (no own breaker) 429 ×3, unrouted:
   current: call 3 asked=backup only      base c4ac909: call 3 asked=claude,backup
U2 foreground unrouted call during an active conversation: 0 ms (both)
U3 caller cancels an unrouted call: AbortError, no fallback asked (both)
```

---

## 5. What only the owner's Windows PC or live providers can verify

- Which errors real Gemini, Groq, Claude and OpenAI-compatible servers return (404, 400, 429, 5xx bodies), and so when a same-provider retry or a breaker opening really happens.
- How often a live model returns empty text, and whether Groq/Gemini really move a strict route to the fast model under the owner's quota (M3).
- Claude's server-side fallbacks on a strict route, and what model it reports.
- The cold usage-ledger read and the appends on the PC's disk with antivirus.
- The tests skipped or blocked here (Windows/PowerShell, Redis, `.venv`, bridge token, live providers, `realTtsHandoffTest`), and voice behaviour during a real conversation while a background agent waits.
- The A2A HTTP endpoint, if the owner enables it (L1).
