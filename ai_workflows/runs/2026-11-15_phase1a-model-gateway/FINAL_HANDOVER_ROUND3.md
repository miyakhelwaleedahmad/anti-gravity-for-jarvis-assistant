# Final handover: Phase 1A, round 3

> Linux cloud container (Node 22, pnpm 10.33.0). Branch `claude/jarvis-repair`, base `c4ac909`. Nothing committed, pushed or merged. No Phase 1B work.
> A Linux pass is not a pass on the owner's Windows PC.

## 1. Result

The owner's priority, that JARVIS never reports a successful AI check after its assigned model failed, now holds in the agent tool loop:
- **QA's tool-loop work** (reviews, "run the type check") ends **FAILED**, with the full reason, when:
  - its model fails, whether or not it has its own setting;
  - its model returns an empty answer;
  - a QA worker part was not answered by its model.
- **A coding agent with its own setting** ends **FAILED** when its model fails, returns an empty answer or uses up its model-call budget. One exception remains: split requests (§5, P8).
- **Any agent** ends **FAILED** on a strict-route failure or a queue-wait time-out.
- **Every tool-loop result** carries `data.answeredBy`, which is `model`, `model_incomplete` or `keyword_rules`, so a keyword-rule answer can always be told apart from an AI answer.

Two independent reviews were done:
- **Round 3** (`INDEPENDENT_REVIEW_ROUND3.md`): APPROVE WITH CONDITIONS, with no High findings.
- **Follow-up on the fixes** (`INDEPENDENT_REVIEW_ROUND3_FIXES.md`): APPROVE WITH CONDITIONS.

I confirmed every finding from the reviewers' probe output before acting on it. Every code finding is fixed except M2, which needs your decision, and L7. The last fix (N1) came after the follow-up review and has not been independently reviewed.

## 2. Files changed in round 3

★ = protected, changed under your round-3 approval. No other protected file was touched in this round.

| File | Change |
|---|---|
| ★`core/agents/behaviors/toolLoop.ts` | **QA failure propagation:**<br>• QA, strict-route and queue-wait failures end the task (`endsTask` / `taskFailure`, reason kept).<br>• An empty QA answer ends the task (M1), and so does an empty answer from a strict-route agent (N1).<br>• A used-up budget ends the task on a strict route (L1).<br>• QA's worker check requires `answeredBy === 'model'`.<br>• `data.answeredBy` and `data.modelUsed` are set on every result.<br>• Other roles keep the reason up to 300 characters (was 100). |
| ★`bridge/modelRouter.ts` | **M-3:** every fallback attempt of a background call waits for the conversation, on the caller's signal, with the queue-wait limit applied to each wait. `categoryChat` pauses its time limit while it waits.<br>**M-2:** attempts are recorded per provider plus model. The same provider is asked again only after a model-specific failure (model, bad_request, bad_response). Any other failure, any refusal, or the route's own time-out (M3) excludes that provider for the rest of the call.<br>**Lease:** every send passes its `GuardTicket`. A cancellation, or a stream its consumer stopped (L4), frees a trial lease.<br>**L5:** a fallback-wait error keeps the route's failure as its `cause`. |
| `bridge/providerGuard.ts` | Ticket API (`check()` returns `GuardTicket`); only the trial's own ticket ends the trial. A cancelled trial, a trial that fails without a rate limit, or a trial that stalls past one open period frees the lease. Header comment corrected (L3) |
| `bridge/modelCategories.ts` | `agentIndependence()` compares the models each route really reaches: case-insensitive; `openai:<x>` resolves to the fallback model; the same provider with its fast model and two Claude models count as not independent. It now returns a `reason`.<br>`observedAgentIndependence()` takes an optional `correlationId`, and returns `null` when a side is missing or recorded as `(provider default)` (L6). |
| `.env.example` | Explains strict routes, the ordinary fallback (including when the same provider is asked again), what `answeredBy` means, that QA never uses keyword rules, and that QA's automatic check of other results is rule-based and not AI verification. It also says independence is neither checked nor enforced, explains the queue-wait scope, and names the split-request exception |
| New tests | `tests/qaModelFailureTest.ts`, `tests/modelRouteRound3Test.ts`, `tests/reviewRound3FixesTest.ts` |
| Docs | `change_log.md`, `verification.md` (round-3 sections), tracker rows MM-1A-15…20, P1, P8, this file; both review reports were written by the reviewers |

Files changed in earlier Phase 1A rounds, still uncommitted:
- **Tracked:** `bridge/anthropicProvider.ts`★, `bridge/groqProvider.ts`★, `bridge/llmTypes.ts`, `bridge/openaiProvider.ts`, `core/agents/agentManager.ts`★ (1 line), `.gitignore`, `ai_workflows/_config/SOURCES_OF_TRUTH.md`.
- **New:** `bridge/usageLedger.ts`, `docs/implementation/`, and five earlier programme tests.

## 3. Test results (Linux)

| Check | Result | Evidence |
|---|---|---|
| Fail-before, unchanged code | `qaModelFailureTest`: 8 passed, 18 failed<br>`modelRouteRound3Test`: 20 passed, 23 failed<br>`reviewRound3FixesTest`: 4 passed, 13 failed; then, for N1, 17 passed, 3 failed<br>Production hashes unchanged by each run | `evidence/round3/`, `evidence/round3-review-fixes/` |
| 20 targeted tests | 20/20 PASS | `evidence/round3-review-fixes/pass-after.txt` |
| `pnpm run typecheck` | exit 0 | `typecheck-after.txt` |
| Voice-core group | 6/6 PASS | `voice-core-after.txt` |
| `pnpm test -- --ci` (final, after N1) | 239 files: 229 passed · 0 failed · 1 blocked · 9 skipped | `evidence/round3-review-fixes/after-ci.txt` |
| Compared with the original baseline (221 passed · 1 blocked · 9 skipped) | All 231 pre-existing tests have the same verdict. The only differences are the 8 programme tests (PASS) | `evidence/baseline-ci.txt` |
| `git diff --check`; lockfile and `package.json`; tracked tests changed | clean; unchanged; none | — |

The run was blocked or skipped the same tests as the baseline:
- **Blocked:** `realTtsHandoffTest` (no Python with pygame here).
- **Skipped:** Windows, PowerShell 7, Redis, `.venv`, bridge-token and live-provider tests.

## 4. Cloud-only results vs the owner's PC

| Verified here (Linux, stand-in providers) | Needs the owner's Windows PC or live providers |
|---|---|
| Routing, fallback, de-duplication, waits, queue-wait, lease, QA/coding failure outcomes, independence functions, the full suite | The Windows/PowerShell/Redis/`.venv` tests the suite skipped; `realTtsHandoffTest`; voice with a real conversation |
| | Which errors real Gemini, Groq, Claude and OpenAI-compatible servers return, and so when a same-provider retry happens |
| | How often a live model returns an empty answer |
| | A cold usage-ledger read on the PC's disk (L3 from the first review) |

## 5. Remaining risks and open items

| ID | Item | Status |
|---|---|---|
| **MM-1A-P8 (M2)** | A configured coding agent's **split** request goes to `code_analysis_worker` on the planning route. Its model is never asked, and the workers can still end on keyword rules (COMPLETED). Documented in `.env.example` | **Your decision:** workers inherit the parent's route, or a configured coding agent does not split |
| L7 | QA's own parts in a split request are accepted after reaching the step limit; worker parts must be answered by the model | Recorded; not fixed |
| L8 | Unconfigured `categoryChat` calls (code repair) wait before each failover attempt; a background call can wait once per attempt (each ≤ `JARVIS_BACKGROUND_YIELD_MS`, max 120 s) | Accepted; bounded, documented |
| N1 fix | Made after the follow-up review; test-proven but not independently reviewed | Optional re-review |
| MM-1A-P4 | Independence is not used anywhere in the runtime; nothing enforces that QA runs on another model | Phase 3 |
| MM-1A-P7 | The rule-based Verification agent counts a source re-read that could not run as passed (`verify.ts:147`) | Phase 3 decision |
| MM-1A-P3 | In-adapter model swaps on strict routes (Gemini/Groq fast model, Claude server fallbacks) | Awaiting approval (protected files) |
| Review L-3 | QA workers on non-strict routes can be answered by the default model; QA rejects only keyword-rule or unfinished parts | Recorded |
| Other agents | An agent without a strict setting (e.g. a browser agent with its own setting) can still end on keyword rules, marked `answeredBy: keyword_rules` | By design; documented |
| MM-1A-P2, P5, P6 | goalVerifier reason, router follow-ups, protected-file list | Awaiting approval |

## 6. Reviewer verdicts

- **`INDEPENDENT_REVIEW_ROUND3.md`: APPROVE WITH CONDITIONS.** 0 High, 3 Medium, 8 Low.
  - Fixed: M1, M3, L1, L4, L5, L6; doc fixes L2, L3.
  - M2 needs your decision (P8).
  - L7 recorded; L8 accepted.
- **`INDEPENDENT_REVIEW_ROUND3_FIXES.md`: APPROVE WITH CONDITIONS.**
  - All six code fixes confirmed, and no risk found in the new code.
  - New: N1 (Medium) and N2 (Low). Both are fixed; N1 has a test and showed fail-before.

## 7. Git status

- Branch `claude/jarvis-repair` at `c4ac909`, the same as `origin/claude/jarvis-repair`. Nothing committed, pushed or merged.
- There is no local `main` branch; `main` was never checked out or changed.
- 11 tracked files modified, all uncommitted:
  - `.env.example`, `.gitignore`, `ai_workflows/_config/SOURCES_OF_TRUTH.md`
  - `bridge/anthropicProvider.ts`, `bridge/groqProvider.ts`, `bridge/llmTypes.ts`, `bridge/modelCategories.ts`, `bridge/modelRouter.ts`, `bridge/openaiProvider.ts`
  - `core/agents/agentManager.ts`, `core/agents/behaviors/toolLoop.ts`
- Untracked: `bridge/providerGuard.ts`, `bridge/usageLedger.ts`, `docs/implementation/`, the run folder, and 8 test files (`modelRoleRoutingTest`, `modelRouteCorrectionsTest`, `modelRouteRound3Test`, `providerCapabilitiesTest`, `providerIsolationTest`, `qaModelFailureTest`, `reviewRound3FixesTest`, `usageLedgerTest`).

## 8. Decisions needed

1. **Commit:** approve a commit of this work on `claude/jarvis-repair`, or ask for changes first.
2. **M2 / MM-1A-P8:** choose how a configured coding agent's split requests should behave.
3. **Optional:** an independent re-review of the N1 fix.
4. **Phase 1B:** not started; it waits for your approval.
