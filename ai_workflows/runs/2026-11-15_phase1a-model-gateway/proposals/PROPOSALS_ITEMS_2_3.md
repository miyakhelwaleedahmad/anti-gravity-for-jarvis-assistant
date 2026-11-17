# Proposals: independent QA enforcement (item 2) and inconclusive verification (item 3)

> Not implemented. Both need protected files (`core/agents/*`), so this file shows the exact changes for approval. Prepared 2026-11-15 on base `c4ac909` plus the uncommitted Phase 1A work.

---

## Item 3: a source re-read that could not run counts as passed (MM-1A-P7)

### Investigation

| Where | What happens today |
|---|---|
| `core/agents/behaviors/verify.ts` `verifyBehaviorRun`, the `source re-read` check | If the Evidence Check Worker did not complete, or the source was unreachable, the check is pushed as `ok: true` with the note "not checked: …". If spawning or waiting throws, the same happens with the message cut to 120 characters |
| `verdictOf` | `verified` when every check is `ok`, so a re-read that never ran still yields **"Verified: N checks passed."** |
| `core/goalVerifier.ts` criterion `verified` | `met` when no result has verdict `issues`, so `unverified` (and any future "not checked" verdict) **counts as met** |
| `core/goalExecutor.ts:189` | fails a goal task only on `issues`; records the verdict otherwise (correct once the verdict is honest) |
| `core/agents/jarvisAgents.ts` `verificationReport` | prints `✗` for every check that is not `ok` |

**Proof on the current code:** `proposals/verificationInconclusiveTest.ts.proposal` (copy to `tests/verificationInconclusiveTest.ts` to run), run through the runner (`evidence/final-cycle/verify-proposal-fail-before.txt`) gave 5 passed and 6 failed. With GitHub answering 503, the verdict was `verified`, the check was `ok: true` and the summary was "Verified: 8 checks passed.". A goal's `verified` criterion was `met` for `inconclusive` and for `unverified`. The file hashes of `verify.ts` and `goalVerifier.ts` were the same before and after the run. The test is kept out of `tests/` so the suite stays green until the fix is approved.

### Proposed behaviour

- Re-read succeeds and matches: the check passes (unchanged).
- Re-read contradicts the answer: `issues` (unchanged).
- Re-read could not run (unreachable, worker not finished, spawn or wait error): the check is **not ok** and is marked `inconclusive`. The verdict is `inconclusive`, never `verified`, and the full original reason is kept.
- Goal criterion `verified`: `issues` → unmet; `inconclusive` / `unverified` / "not verified" → **needs review** (no `met` value); all `verified` → met.

### Exact changes

`core/agents/behaviors/verify.ts` ★ (protected)

```diff
-export type Verdict = 'verified' | 'issues' | 'unverified';
+/** inconclusive: a check could not run (e.g. the source re-read); it needs review and is never "verified". */
+export type Verdict = 'verified' | 'issues' | 'unverified' | 'inconclusive';

-export interface VerificationCheck { name: string; ok: boolean; note: string }
+export interface VerificationCheck {
+  name: string;
+  ok: boolean;
+  note: string;
+  /** The check could not run: not passed, and not a defect found. */
+  inconclusive?: boolean;
+}
@@ verdictOf
   if (finished && !finished.ok) return 'unverified';
-  return checks.every((c) => c.ok) ? 'verified' : 'issues';
+  if (checks.some((c) => !c.ok && !c.inconclusive)) return 'issues';
+  return checks.some((c) => c.inconclusive) ? 'inconclusive' : 'verified';
 }
@@ verifyBehaviorRun, source re-read
-      if (r?.status !== 'COMPLETED' || !d.reachable) checks.push({ name: 'source re-read', ok: true, note: `not checked: ${r?.summary ?? 'the worker did not finish'}` });
+      if (r?.status !== 'COMPLETED' || !d.reachable) {
+        const why = r?.summary || r?.error?.message || 'the worker did not finish';
+        checks.push({ name: 'source re-read', ok: false, inconclusive: true, note: `not checked: ${why}${r?.error?.message && !why.includes(r.error.message) ? ` (${r.error.message})` : ''}` });
+      }
       else checks.push({ name: 'source re-read', ok: d.licenceOk !== false, note: r.summary });
     } catch (err) {
-      checks.push({ name: 'source re-read', ok: true, note: `not checked: ${(err as Error).message.slice(0, 120)}` });
+      checks.push({ name: 'source re-read', ok: false, inconclusive: true, note: `not checked: ${(err as Error).message}` });
     }
@@ verdict and summary
   const verdict = verdictOf(checks);
-  const issues = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.note}`);
+  const issues = checks.filter((c) => !c.ok && !c.inconclusive).map((c) => `${c.name}: ${c.note}`);
+  const unchecked = checks.filter((c) => c.inconclusive).map((c) => `${c.name}: ${c.note}`);
   const verification: Verification = { verdict, checks, issues, checkedBy: ctx.agent.agentId, at: Date.now() };
-  ctx.addFinding({ text: `Verification: ${verdict}${issues.length ? ` — ${issues.join('; ')}` : ''}`, confidence: 0.9, tags: ['verification'], data: { verdict } });
+  ctx.addFinding({ text: `Verification: ${verdict}${[...issues, ...unchecked].length ? ` — ${[...issues, ...unchecked].join('; ')}` : ''}`, confidence: 0.9, tags: ['verification'], data: { verdict } });
   return {
-    summary: verdict === 'verified' ? `Verified: ${checks.length} checks passed.` : verdict === 'unverified' ? `Not verified: ${issues.join('; ')}` : `Issues found: ${issues.join('; ')}`,
+    summary: verdict === 'verified' ? `Verified: ${checks.length} checks passed.`
+      : verdict === 'inconclusive' ? `Not fully verified; needs review: ${unchecked.join('; ')}`
+      : verdict === 'unverified' ? `Not verified: ${issues.join('; ')}` : `Issues found: ${issues.join('; ')}`,
```

`core/agents/jarvisAgents.ts` ★ (protected), console report only

```diff
-    ...v.checks.filter((c) => !c.ok).map((c) => `  ✗ ${c.name}: ${c.note}`)];
+    ...v.checks.filter((c) => !c.ok).map((c) => `  ${c.inconclusive ? '?' : '✗'} ${c.name}: ${c.note}`)];
```

`core/goalVerifier.ts` (not protected; outside the files approved so far)

```diff
       case 'verified': {
         const checked = results.filter((r) => r.verification);
         const issues = checked.filter((r) => r.verification!.verdict === 'issues');
+        // Anything but "verified" or "issues" (inconclusive, unverified, not verified) is not a pass: it waits for review.
+        const open = checked.filter((r) => r.verification!.verdict !== 'verified' && r.verification!.verdict !== 'issues');
         check = {
-          id: c.id, description: c.description, met: checked.length > 0 && !issues.length,
+          id: c.id, description: c.description,
+          ...(!checked.length || issues.length ? { met: false } : open.length ? {} : { met: true }),
           evidence: !checked.length ? 'no result was checked by the Verification agent'
-            : issues.length ? `the Verification agent found issues in ${issues.length} result(s)` : `${checked.length} result(s) verified`,
+            : issues.length ? `the Verification agent found issues in ${issues.length} result(s)`
+            : open.length ? `${open.length} result(s) not fully verified (${[...new Set(open.map((r) => r.verification!.verdict))].join(', ')}); waiting for your review`
+            : `${checked.length} result(s) verified`,
         };
```

No change to `goalExecutor.ts`: it already fails only on `issues` and records any other verdict.

### Tests

- New: `proposals/verificationInconclusiveTest.ts.proposal` (copy to `tests/verificationInconclusiveTest.ts` to run) (moved into `tests/` once approved). It covers re-read success, contradiction, unreachable (verdict, `ok`, the full reason, summary) and the goal criterion for `verified`, `issues`, `inconclusive` and `unverified`.
- Existing tests to re-run: `sevenAgentTest` (Phase 5 verification), `jarvisAgentIntegrationTest`, `goalAgentIntegrationTest`, `selfHealingHonestyTest`, `backgroundResearchTest`, `replyGoldenTest`.

### Risks

- A goal whose only open point is an unreachable GitHub source now waits for review instead of finishing as met. This is the intended stricter behaviour.
- `promoteToMemory` (`jarvisAgents.ts:298`) still stores a result whose verification is `inconclusive`; it skips only `issues`. Left unchanged: storing is not a verification claim. Say if you want it to skip `inconclusive` too.

---

## Item 2: independent QA is not enforced (MM-1A-P4)

### Investigation: the runtime path

1. **Nothing consumes the independence checks.** `agentIndependence()` and `observedAgentIndependence()` (`bridge/modelCategories.ts`) are called only by tests (`grep` over the repository).
2. **QA's model is chosen by its route alone.** With `JARVIS_MODEL_AGENT_QA_AGENT` set, QA uses that provider and model, strictly. With nothing set, QA uses the planning route, which is the same default model coding uses. No step compares the two.
3. **What a QA "check" is today:**
   - (a) A tool-loop task ("review this", "run the type check"), answered by QA's model.
   - (b) The automatic Verification agent (`verify.ts`): fixed rules plus a GitHub re-read, with no model at all.
   Neither records which model coding used for the work being checked.
4. **The usage records can't link QA to the coding work it checks.** A record has `agentRole` and `correlationId`. The `correlationId` comes from `getTraceId()` (`core/traceContext.ts`), the module-level id of the current foreground request, not of the agent task. There is no `rootTaskId` or `taskId`. So `observedAgentIndependence({ correlationId })` can't reliably find "the coding call this QA call checked".
5. **Independence claims in the runtime:**
   - `core/agents/specialists.ts:110`: QA's system prompt says it checks results "independently".
   - `core/agents/specialists.ts:171`: QA's role description says "Independently checks results".
   - `verify.ts:142`: a spawn reason says "independent re-read of a cited source". This one is accurate, since it is a separate read of the source, not a model.

   No result field says "independent QA", but the role text does.
6. **In-adapter model swaps (MM-1A-P3)** can change the model inside a provider: Gemini/Groq move to the fast model, and Claude uses server fallbacks. A configuration-level comparison therefore can't prove which model really answered. Only the usage record of the actual call can.

### Proposed behaviour

- **New setting `JARVIS_QA_REQUIRE_INDEPENDENT=1`** (default off; nothing changes when unset).
  - When it is on, a QA tool-loop task runs only if its effective target and the coding agent's effective target are different models. The comparison uses `agentIndependence(env)`, which already handles case, `default`, `openai:<x>`, the fast model and Claude fallbacks.
  - Otherwise the QA task ends **FAILED** with code `INDEPENDENT_QA_UNAVAILABLE`: "independent QA unavailable: <reason>; needs review". It is not sent to any model, and QA does not run on the same model.
- **Every QA tool-loop result carries `data.independence = { status, reason, coding?, qa? }`.** `status` is one of:
  - `'independent'`: only when the setting is on, the configured targets differ, and every model call QA made in this task was recorded with a known model distinct from coding's;
  - `'not_independent'`;
  - `'unknown'`.

  An unknown model, a missing record, or the setting being off gives `unknown`, never `independent`.
- **Usage records gain `rootTaskId` and `taskId`.** The router reads them from `currentAgentScope()` in `noteUsage`, so `agentManager.ts` doesn't change. That lets QA's own calls be found exactly.
- **Wording:** QA's role text changes from "independently checks" to "checks". The word "independent" is used only where `data.independence.status === 'independent'`.

### Exact changes (proposed)

| File | Change |
|---|---|
| `bridge/modelCategories.ts` | `UsageRecord` gains optional `rootTaskId`, `taskId`. New `qaIndependence(env, recs, taskId)` returns `{ status: 'independent' \| 'not_independent' \| 'unknown', reason, coding?, qa? }`. It compares the configured `codingTarget` with every successful record of that QA task (effective target, case-insensitive). `(provider default)`, a missing record or the setting off gives `unknown`. New `requireIndependentQa(env)` |
| ★`bridge/modelRouter.ts` | `noteUsage` adds `rootTaskId` and `taskId` from `currentAgentScope()`. Before a `qa_agent` call (or a helper inheriting QA's route): if `requireIndependentQa()` is on and `agentIndependence().independent` is false, throw `IndependentQaUnavailableError` (name) with the reason. It is not sent and has no fallback |
| ★`core/agents/behaviors/toolLoop.ts` | `IndependentQaUnavailableError` ends the task (as `StrictRouteError` does). A QA result adds `data.independence = qaIndependence(process.env, usageLog(), ctx.task.taskId)` |
| ★`core/agents/specialists.ts` | QA prompt and description: "independently" → "separately", the only wording change |
| `.env.example` | document `JARVIS_QA_REQUIRE_INDEPENDENT` and what `data.independence` means |

### Tests (proposed new file `tests/independentQaTest.ts`, written and shown failing first)

1. Setting off: QA runs as today; `data.independence.status === 'unknown'`, never `independent`.
2. Setting on, QA unset: QA uses the default model, as coding does, so the task is FAILED with `INDEPENDENT_QA_UNAVAILABLE`, and no model was asked.
3. Setting on, QA set to the same model under another alias or case (`gemini:Model-X` vs `gemini:model-x`): FAILED, as in test 2.
4. Setting on, QA on a different provider and model: COMPLETED; `status === 'independent'`; `qa` names the model really used.
5. Setting on, configured different, but the QA call is recorded as `(provider default)`: `unknown`, not `independent`.
6. Setting on, QA's provider swaps to the same model as coding inside the adapter (simulated by a stand-in reporting that model): `not_independent`.
7. The usage records carry `rootTaskId` and `taskId` for agent calls and none for the owner's own calls.
8. Existing agent, routing and ledger tests pass unchanged.

### Risks and limits

- This enforces independence of **configuration** before the call, and reports independence of the **recorded** model after it. It can't see inside a provider: a server that answers with another model than the one it reports would be missed.
- The automatic rule-based Verification agent (item 3) is not model-based and will never be labelled independent QA.
- Turning the setting on with QA unconfigured makes every QA task fail. That is intended: there is no second model to use.

---

## Additions after the final independent review (`INDEPENDENT_REVIEW_FINAL.md`)

### Item 1 gap (review M1): GitHub research by a configured coding agent. Proposal; protected file

**Found.**
- `core/agents/specialists.ts:85-91` sends a coding request that looks like GitHub research ("find … libraries / repos / projects") to `githubResearchAgent` instead of the tool loop.
- That flow calls the model through `askJson` (`core/agents/behaviors/common.ts:59-84`). `askJson` catches every non-abort error, including `StrictRouteError`, keeps 120 characters of it, and answers by rules.
- Its research workers don't inherit the coding route.

So a configured coding agent whose model fails can still end COMPLETED for such a request (reviewer probe P6). This breaks requirement A for that path; `.env.example` now names the gap.

**Proposed minimal change** (`core/agents/specialists.ts` ★):

```diff
+import { routeFor } from '../../bridge/modelCategories.js';
@@ engineeringSpecialist
 const engineeringSpecialist: AgentBehavior = {
   run(ctx) {
-    return /\b(find|search|best|compare|recommend|alternatives?|which)\b/i.test(ctx.task.description)
+    // A coding_agent with its own (strict) model setting answers GitHub research in its
+    // tool loop (github_search, github_repo): strict, no rule fallback, helpers inherit
+    // its model. The research flow below falls back to rules and its workers do not.
+    const strict = routeFor('planning', process.env, 'coding_agent').strict;
+    return !strict && /\b(find|search|best|compare|recommend|alternatives?|which)\b/i.test(ctx.task.description)
       && /\b(git ?hub|repositor(?:y|ies)|repos|librar(?:y|ies)|projects?|packages?|frameworks?)\b/i.test(ctx.task.description)
       ? githubResearchAgent.run(ctx)
       : loop(ENGINEERING_PURPOSE, [...CODING_RULES, ...GITHUB_RULES], 'code_analysis_worker').run(ctx);
```

**Trade-off.**
- With a coding model set, GitHub research loses the research flow's ranking and its sourced report format. It becomes a tool-loop answer using `github_search` and `github_repo`.
- The alternative keeps the flow but makes it strict-aware: `askJson` rethrows `StrictRouteError` / `QueueWaitTimeoutError`, and the research workers inherit the route. That touches `common.ts`, `research.ts` and `github.ts`, so it is a larger change.

**Tests** (new, shown failing first):
- Configured coding model failing, request "Find TypeScript libraries for Chrome DevTools Protocol": FAILED, no rules, the default model not asked.
- Configured coding model working: answered by the coding model.
- Unconfigured: the research flow runs as today (existing `sevenAgentTest` GitHub research checks unchanged).

### Item 3 additions (review L4)

The diff in item 3 is correct for what it covers but incomplete. Proposed additions:

1. **A source that states no licence**
   - **Today:** `evidenceCheckWorker` returns `licenceOk: true` when the answer claims a licence and the repository states none (`verify.ts:121`).
   - **Proposed:** return `licenceKnown: false`. The re-read check is then `inconclusive` with the note "the source states no licence; the answer's licence could not be confirmed".
2. **The spoken completion**
   - **Today:** `completionSpeech` (`jarvisAgents.ts:202`) mentions only `issues`.
   - **Proposed:** for `inconclusive`, add " The Verification Agent could not check everything; it needs your review."
3. **More tests in `verificationInconclusiveTest`**:
   - a goal result whose verification is the string `not verified` needs review;
   - a re-read spawn that throws (depth limit reached) is `inconclusive` with the reason;
   - a re-read worker that times out or is cancelled is `inconclusive`, never `verified`;
   - a source with no licence against an answer stating one is `inconclusive`.

### Item 2 addition (review M2, fixed in this cycle)

`agentIndependence()` / `observedAgentIndependence()` now:
- take an unconfigured agent at the model agents really send (`JARVIS_AGENT_MODEL`, else the fast model);
- count any two models on the Gemini/Groq client as possibly the same model.

They are still unused by the runtime. The enforcement proposal above would build on them.
