# Phase 1A: review handover (after the corrections round)

> 2026-11-15 · branch `claude/jarvis-repair` · base `c4ac909` · nothing committed · Linux cloud container, not the owner's Windows PC.
> Independent review of the corrections: `INDEPENDENT_REVIEW_CORRECTIONS.md`, written by a separate agent with a fresh context. It is not a human review.

## 1. Verdict

The reviewer's recommendation is **APPROVE WITH CONDITIONS**. I re-checked its main findings against the code (§3).

**My own conclusion: not ready to commit.**
- M-3 is a regression I introduced in the corrections round.
- M-2 needs your decision.
- M4 is only partly met: a failed QA model can still end as a COMPLETED task (H-1).

## 2. M1–M4 status

| Item | Status | Basis |
|---|---|---|
| M1: the conversation wait does not use up the time limit; queue-wait limit; cancel while waiting | **Met on the tested paths.** One regression next to it: M-3 below | `modelRouteCorrectionsTest` M1 a–g; reviewer §3 |
| M2: strict coding, review (code repair, goalVerifier), coding_agent, qa_agent | **Met at the router.** A strict route fails with `StrictRouteError` and is never answered by another *provider*. **Not met inside the adapters** (M-4): the Gemini/Groq client can drop to its fast model, Claude's server-side fallbacks are on, and `openai:<model>` sends `JARVIS_FALLBACK_MODEL` | code; MM-1A-P3 |
| M3: each provider once per routed call; clear error at the end | **Met.** It caused M-2 | `modelRouteCorrectionsTest` M3 |
| M4: QA fails rather than falls back; reason kept; independence honest | **Partly met.** The router never gives QA's work to the coding model. But the QA **task** can still end COMPLETED through keyword rules, and the reason is cut to 100 characters (H-1). The independence checks can still report "independent" for the same model (M-1), and nothing uses them yet | `toolLoop.ts:76-82, 156-163`; §5 |

## 3. Findings I re-checked myself

| ID (reviewer) | Severity | I confirmed by | Note |
|---|---|---|---|
| H-1 QA/coding task ends COMPLETED after a strict model failure | High | reading `toolLoop.ts:76-82, 156-163`; `agentManager.ts:662-663` | Also: keyword-rule runs whose tools succeed get confidence **0.7** (`toolLoop.ts:162`), the same as a model answer |
| M-3 fallback after a failed named route skips the conversation wait | Medium, **regression from my corrections** | reading `modelRouter.ts`: the fallback `chain(…, { skipWait: true })` in `routedChat` and the routed-stream fallback. `waitForConversation()` returns at once for a named provider the conversation does not use, so no wait happened before the fallback reaches the primary | Breaks PERF-02 for background calls |
| M-2 a route on the primary's own provider lost its fallback | Medium | reading: `chain()` skips any provider instance already in `attempted`, including the primary asked with the route's model | Comes from your M3 rule ("even when different model aliases resolve to the same provider"), read as "per provider". It collides with "keep the existing fallback for conversation and planning". **Owner decision** (§7) |
| M-1 independence can be misreported | Medium | reading `modelCategories.ts` (`effectiveTarget`, `observedAgentIndependence`) | `openai:<x>` is not what is sent; names are case-sensitive; in-adapter swaps are invisible; the observed check pairs calls from different tasks. No consumer yet |
| M-4 / M-5 `.env.example` overclaims | Medium | reading `.env.example:70-95` | It says "the default model above answers" (false after M-2), that QA "checks the work independently" (the automatic check uses no model), and that the queue-wait limit covers all background calls (only configured routes and `categoryChat`) |
| L-1 an unrelated non-quota failure ends the trial lease | Low | reading `providerGuard.ts` `noteFailure` | — |
| L-6 `categoryChat` time-outs now report "timed out", also unconfigured | Low | reading `categoryChat` | A small change to the default path; the message is clearer |

The reviewer's other Low items (L-2 timeouts include the wait, L-3 QA workers on non-strict routes, L-4 dashboard text, L-5 weak abort check in `modelRoleRoutingTest`, L-7 review independence flag, L-8 timing-dependent checks) I accept as written. I did not re-run its probes.

## 4. The QA problem in `core/agents/behaviors/toolLoop.ts` (read only)

1. **How a provider error enters.** `runLoop` calls `ctx.llm()` (`:76`), which goes to `modelRouter.chat()` (`agentManager.ts:1248`). A strict route failure arrives as `StrictRouteError`, a queue-wait time-out as `QueueWaitTimeoutError`. The `catch` (`:77-82`) re-throws only `AbortError`. Every other error becomes a return value, `{ answer: '', note: 'the model was not available (<first 100 characters>)' }` (or "Stopped before a final answer…" after step 0).
2. **How keyword fallback starts.** In `toolLoopBehavior.run`, `if (!loop.answer && !loop.calls)` (`:158`) runs `runRules`. Those are the role's fallback rules (QA: `QA_RULES`, e.g. `dev_status`, `dev:run`), which run real tools through `ctx.callTool`, and so through the registry and the approval gate.
3. **How the status becomes COMPLETED.** The behaviour returns normally (`:160-165`), and the manager sets `status = 'COMPLETED'` (`agentManager.ts:662-663`). Confidence is 0.3 with no tool calls, but **0.7 when the keyword tools succeed** (`:162`).
4. **Can failed QA look like a successful verification?** Yes, for `qa_agent` work that runs through the tool loop (reviews, "run the type check", "check this"). The result is COMPLETED with up to 0.7 confidence. A goal's `tasks_completed` and `min_confidence` checks (`core/goalVerifier.ts:70-91`) would accept it. QA's workers (`test_runner_worker`) behave the same way, and their COMPLETED results count towards QA's own confidence (`:146-150`).
   - The automatic "Verification agent" check of other results (`jarvisAgents.ts` `verifyRootResult` → `verify.ts` `verifyBehaviorRun`) uses **no model**: rules plus one GitHub re-read. A QA model failure cannot affect it.
   - But it counts a re-read that could not run as passed (`verify.ts:147`, `ok: true, note: 'not checked'`). That is a separate honesty issue (§8, P7).
5. **Does the reason reach the final result?** Only as a limitation, cut to 100 characters (`:79`, `:157`). The `StrictRouteError` prefix is about 100 characters long, so the provider's own reason is usually cut off.

## 5. Proposed `toolLoop.ts` correction (MM-1A-P1). Not implemented; protected file; needs your approval

**Behaviour after the change:**
- A strict route failure or a queue-wait time-out, for any role: the task ends **FAILED**, with the full original message.
- Any model failure of **`qa_agent`**, configured or not: **FAILED**. Keyword rules never stand in for QA.
- QA with workers: a worker part answered by keyword rules or not completed makes QA **FAILED**.
- Other roles with no configured model: unchanged. They keep the keyword fallback (`agentSpecialistsTest` requires this for `coding_agent`). The reason is kept up to 300 characters instead of 100.
- Cancellation, approval gates, tool scope and successful runs: unchanged.

**Exact modifications:**

```diff
@@ imports
 import { BudgetExceededError, SpawnRejectedError } from '../agentContextApi.js';
 import { parseEntry } from '../permissions.js';
 import { agentModel, UNTRUSTED_RULE, untrusted } from './common.js';
@@ after isAbort() (line 54)
+/**
+ * A model failure that must end the task instead of being covered by keyword
+ * rules (owner, 2026-11-15): a strict route that failed (StrictRouteError) or
+ * was not sent (QueueWaitTimeoutError), and any model failure of the QA
+ * agent, whose result must come from its model.
+ */
+function endsTask(err: unknown, role: string): boolean {
+  const name = (err as Error | null)?.name;
+  return name === 'StrictRouteError' || name === 'QueueWaitTimeoutError' || role === 'qa_agent';
+}
+
+/** The error the task ends with: the original one when it already says why, else a clear one keeping it as `cause`. */
+function taskFailure(err: unknown, role: string): Error {
+  if (err instanceof BudgetExceededError) return err;   // the manager records its own code for it
+  const name = (err as Error | null)?.name;
+  if (name === 'StrictRouteError' || name === 'QueueWaitTimeoutError') return err as Error;
+  const e = new Error(`The ${role === 'qa_agent' ? 'QA' : role} agent's model was not available, so nothing was checked: ${String((err as Error | null)?.message ?? err)}`, { cause: err });
+  e.name = 'ModelUnavailableError';
+  return e;
+}
@@ runLoop: return type gains modelAnswered
-export async function runLoop(ctx: AgentContext, task: string, opts: ToolLoopOptions): Promise<{ answer: string; calls: number; failures: string[]; note?: string }> {
+export async function runLoop(ctx: AgentContext, task: string, opts: ToolLoopOptions): Promise<{ answer: string; calls: number; failures: string[]; note?: string; modelAnswered?: boolean }> {
@@ runLoop catch (lines 77-82)
     } catch (err) {
       if (isAbort(err)) throw err;
-      const why = err instanceof BudgetExceededError ? 'the model-call budget was used up' : `the model was not available (${(err as Error).message.slice(0, 100)})`;
+      if (endsTask(err, ctx.agent.role)) throw taskFailure(err, ctx.agent.role);
+      const why = err instanceof BudgetExceededError ? 'the model-call budget was used up' : `the model was not available (${(err as Error).message.slice(0, 300)})`;
       if (step === 0) return { answer: '', calls, failures, note: why };
       return { answer: 'Stopped before a final answer: ' + why, calls, failures, note: why };
     }
-    if (!res.tool_calls?.length) return { answer: (res.content ?? '').trim(), calls, failures };
+    if (!res.tool_calls?.length) return { answer: (res.content ?? '').trim(), calls, failures, modelAnswered: true };
@@ split path, after `const results = await ctx.wait(handles);` (line 145)
+          if (ctx.agent.role === 'qa_agent') {
+            // QA counts a part as checked only when it completed and its model answered it (never keyword rules).
+            const unchecked = results.filter((r) => r.status !== 'COMPLETED' || r.data?.['modelUsed'] === false);
+            if (unchecked.length) {
+              const e = new Error(`QA could not check every part: ${unchecked.map((r) => `${r.agentId}: ${r.status === 'COMPLETED' ? 'answered by keyword rules, not its model' : `${r.status.toLowerCase()} — ${r.error?.message ?? ''}`}`).join('; ')}`);
+              e.name = 'ModelUnavailableError';
+              throw e;
+            }
+          }
@@ outcome (lines 160-165)
       return {
         summary: loop.answer || 'No answer.',
         confidence: loop.calls && !loop.failures.length ? 0.7 : loop.calls ? 0.5 : 0.3,
         limitations,
-        data: { toolCalls: loop.calls },
+        // modelUsed: false when keyword rules produced this answer (QA does not count such a part as checked).
+        data: { toolCalls: loop.calls, modelUsed: loop.modelAnswered === true || (!!loop.calls && !loop.note) },
       };
```

**Behaviour changes to accept:**
- `qa_agent` with **no** configured model, when the default model is down, now ends FAILED instead of running `QA_RULES`.
- Confidence for other roles' keyword answers is unchanged at up to 0.7. Lowering it would change ordinary behaviour; I'm not proposing it.

**To confirm before coding:** that `r.data` on `ctx.wait()` results carries the child outcome's `data`. `verify.ts:146` reads `r?.data`, which suggests it does. I would check `agentContextApi.ts` and `agentManager.ts` first.

**Tests to add (new file, e.g. `tests/qaModelFailureTest.ts`), written first and shown failing on the current code:**
1. A configured `JARVIS_MODEL_AGENT_QA_AGENT` that fails, through the real `qa_agent` specialist: root result **FAILED**; the error contains the full `StrictRouteError` text with the provider's reason; no keyword tool (`dev_status`, `dev:run`) was called; the default/coding model was never asked.
2. `qa_agent`, nothing configured, default model down: **FAILED** (`ModelUnavailableError`, reason kept); no keyword rules.
3. `qa_agent` model fails at step 2, after one tool call: **FAILED**, not "Stopped before a final answer" COMPLETED.
4. QA split across workers where one worker is answered by keyword rules (or did not complete): QA **FAILED**, naming that worker.
5. A configured `JARVIS_MODEL_AGENT_CODING_AGENT` that fails: **FAILED**, no keyword rules.
6. `coding_agent` with nothing configured and the model down: still COMPLETED via keyword rules, as `agentSpecialistsTest` expects (unchanged).
7. `QueueWaitTimeoutError` for any role: **FAILED**.
8. `qa_agent` budget exhausted: FAILED with the budget code (the manager's own branch).
9. Cancellation: CANCELLED (unchanged). A successful QA run: COMPLETED, same confidence (unchanged).
10. A goal whose QA task FAILED: `tasks_completed` is not met (`core/goalVerifier.ts`).
11. Existing `agentSpecialistsTest`, `sevenAgentTest`, `agentRuntimeTest`, `jarvisAgentIntegrationTest`, `goalAgentIntegrationTest`: pass unchanged.

## 6. Verification of the current state (Linux container)

| Check | Result | Evidence |
|---|---|---|
| The 5 programme tests | 5/5 pass | `evidence/corrections/pass-after.txt` |
| `pnpm run typecheck` | exit 0 | `evidence/corrections/typecheck-after.txt` |
| Voice-core group | 6/6 pass | `evidence/corrections/voice-core-after.txt` |
| `pnpm test -- --ci` | 236 files: 226 passed · 0 failed · 1 blocked (`realTtsHandoffTest`, no Python with pygame here) · 9 skipped (Windows, PowerShell 7, Redis, `.venv`, live provider) | `evidence/corrections/after-ci.txt` |
| Pre-existing tests | same verdict for all 231 as the original baseline; `git diff --name-only HEAD -- tests` empty | — |
| Production files changed in the corrections round | `bridge/modelRouter.ts` (M1–M3 only), `bridge/modelCategories.ts`, `bridge/providerGuard.ts`, `bridge/usageLedger.ts`; no other protected file (the reviewer checked hashes) | `evidence/corrections/production-hashes-before.txt` |
| `pnpm-lock.yaml`, `package.json` | unchanged vs HEAD | — |
| `git diff --check` | clean | — |

**Windows PC:** nothing has been run there. Voice, the ledger on the hard disk, real providers and any timing on the PC are unverified.

## 7. Outstanding issues and decisions needed

| ID | What | Needs |
|---|---|---|
| H-1 / MM-1A-P1 | QA task can end COMPLETED after its model failed | your approval of §5 (protected `core/agents/behaviors/toolLoop.ts`) |
| M-3 | background fallback skips the conversation wait (my regression) | approval to fix in `bridge/modelRouter.ts`: wait before the fallback when no wait happened yet. A test: a background call whose named route fails during a conversation is held before the default model is asked |
| M-2 | a route on the primary's own provider has no fallback | your decision: (a) de-duplicate by provider **and** model, so the primary may be asked once more with the default model, or (b) keep "per provider" and correct `.env.example` |
| M-4 / MM-1A-P3 | in-adapter model swaps on strict routes | approval for protected `groqProvider.ts` / `anthropicProvider.ts`; and `openai:<model>` sending `JARVIS_FALLBACK_MODEL` |
| M-1 | independence checks can misreport | fix in `bridge/modelCategories.ts` (unprotected); a consumer in Phase 3 (MM-1A-P4) |
| M-5 | `.env.example` overclaims | doc fix |
| L-1 | trial lease ended by an unrelated failure | small fix in `bridge/providerGuard.ts` |
| L5, L6, L8, L9 (first review) | router follow-ups | MM-1A-P5 |
| L-2, L-3, L-4, L-5, L-6, L-7, L-8 (second review) | Low; recorded | — |
| P7 (new) | the rule-based Verification agent counts a source re-read that could not run as passed (`verify.ts:147`) | Phase 3 decision |
| L2, L3 (first review) | accepted: count reset rule; synchronous ledger I/O measured on Linux, PC measurement pending | — |

## 8. Files currently changed (uncommitted)

Modified (tracked):
- `.env.example`
- `.gitignore`
- `ai_workflows/_config/SOURCES_OF_TRUTH.md`
- `bridge/anthropicProvider.ts` ★
- `bridge/groqProvider.ts` ★
- `bridge/llmTypes.ts`
- `bridge/modelCategories.ts`
- `bridge/modelRouter.ts` ★
- `bridge/openaiProvider.ts`
- `core/agents/agentManager.ts` ★

New (untracked):
- `bridge/providerGuard.ts`
- `bridge/usageLedger.ts`
- `docs/implementation/` (the tracker)
- `ai_workflows/runs/2026-11-15_phase1a-model-gateway/` (run record, evidence, both reviews, this handover)
- `tests/modelRoleRoutingTest.ts`
- `tests/modelRouteCorrectionsTest.ts`
- `tests/providerCapabilitiesTest.ts`
- `tests/providerIsolationTest.ts`
- `tests/usageLedgerTest.ts`

★ protected, changed under your approvals.
