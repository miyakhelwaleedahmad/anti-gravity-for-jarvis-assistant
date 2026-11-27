# Low-finding closure plan (stage 03, Gate 1): L1, L2, L5, R1, R2, R3, R4

> Plan only; no source file has been edited for it. Base: the final reviewed source (`evidence/gap-review-fixes/source-hashes-final.txt`).
> Rules re-read: `ai_workflows/CLAUDE.md` (Gate 1 before stage 04; every protected-file edit needs approval), `_config/RUNTIME_PROTECTED_FILES.md` (`bridge/modelRouter.ts` and all of `core/agents/*` are protected).

## 1. Files (★ = protected; needs your approval)

| File | L1 | L2 | L5 | R1 | R2 | R3 | R4 |
|---|---|---|---|---|---|---|---|
| `bridge/modelCategories.ts` | ✔ | | | | ✔ | | |
| ★`bridge/modelRouter.ts` | ✔ | | ✔ | ✔ | ✔ | | ✔ |
| ★`core/agents/types.ts` | | | | | | ✔ | |
| ★`core/agents/agentManager.ts` | | | ✔ | | | ✔ | |
| ★`core/agents/behaviors/common.ts` | | | ✔ | | | ✔ | |
| ★`core/agents/behaviors/research.ts` | | | ✔ | | | ✔ | |
| ★`core/agents/behaviors/toolLoop.ts` | | | ✔ | | ✔ | | ✔ |
| ★`core/agents/jarvisAgents.ts` | | ✔ | | | | | |
| `core/goalExecutor.ts` | | | ✔ | | | ✔ | |
| `core/goalRecovery.ts`, `core/goalLifecycle.ts` | | | ✔ | | | | |
| `.env.example`, tracker, run record | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |

Not touched: the approval gate, risk engine, tool registry, permissions, `pnpm-lock.yaml`, `package.json`, every tracked test.

## 2. The four error conditions, end to end

| Condition | Where it starts | Agent task `error.code` | Goal `FailureInfo.code` | Goal class → recovery |
|---|---|---|---|---|
| **MODEL_UNAVAILABLE**: the required model did not answer | StrictRouteError (not identity), QueueWaitTimeoutError, ModelUnavailableError, IndependentQaUnavailableError (no distinct model) | `MODEL_UNAVAILABLE` (as now) | same | **`dependency`**: retry later with the longer back-off, waiting for the service; bounded attempts. Today the class is chosen by the message text, so the result is unpredictable |
| **MODEL_IDENTITY_UNCONFIRMED**: the provider didn't report the model, or reported another | the router's identity check (new error name `ModelIdentityError`, wrapped by StrictRouteError); the QA reply check when the reply reports no model | **`MODEL_IDENTITY_UNCONFIRMED`** (new) | same | **new class `configuration`**: task `blocked`, goal blocked; action "blocked: the model the provider reported does not confirm the configured one; check the model setting". Not retried, because retrying can't fix a setting |
| **TOOL_BUDGET_EXHAUSTED**: tool calls used up | `BudgetExceededError` kind `toolCalls` | `BUDGET_EXCEEDED` (kept, because tracked `agentRuntimeTest:503` asserts it) plus new `error.budget = 'toolCalls'` | **`TOOL_BUDGET_EXHAUSTED`** (`goalExecutor` maps it from `budget`) | `budget` (as today for budgets) |
| **VERIFICATION_INCONCLUSIVE**: a verification check did not happen | `verify.ts` verdict `inconclusive`, or the verification did not finish | (agent task COMPLETED) | **`VERIFICATION_INCONCLUSIVE`** (`goalExecutor`: today such a task ends ok) | **new class `inconclusive`**: task `needs_review`, goal waits for review; never retried automatically |

A used-up **model-call** budget stays `BUDGET_EXCEEDED` with `budget: 'llmCalls' | 'tokens'`, mapped to the `budget` class.

**Downstream, checked:**
- `goalRecovery.classifyFailure` gets an explicit code map before the text patterns. `decide` handles the two new classes; `goalLifecycle.FailureClass` adds `'configuration' | 'inconclusive'`.
- `goalRuntime` already treats `needs_review` / `blocked` tasks as "goal waits for review" (`goalRuntime.ts:798-831`); no change needed there.
- `goalLearning` stores the class name only and needs no change.
- `failureSignature` includes the code, so the four conditions get four distinct signatures. Old `AGENT_ERROR` signatures will no longer match these failures; that is intended (L5).
- `reflectionEngine` has its own unrelated `FailureClass`.
- Existing assertions are kept: `goalRecoveryTest` (`BUDGET_EXCEEDED → budget`) and `agentRuntimeTest:503`.

## 3. Exact changes

### R3: tool budget vs model failure
- ★`types.ts`: `ChildResult.error` and the task record's `error` become `{ code: string; message: string; budget?: 'llmCalls' | 'toolCalls' | 'tokens' }`.
- ★`agentManager.ts` catch:
  ```diff
   } else if (err instanceof BudgetExceededError) {
     status = 'FAILED';
  -  error = { code: err.code, message: err.message };
  +  error = { code: err.code, message: err.message, budget: err.kind };
   ...
   } else {
     status = 'FAILED';
  -  error = { code: MODEL_FAILURES.has(name) ? 'MODEL_UNAVAILABLE' : 'AGENT_ERROR', message };
  +  error = { code: failureCode(err), message, ...(budgetOf(err) ? { budget: budgetOf(err) } : {}) };
  ```
  `failureCode`:
  - a carried code (`PropagatedFailure.code`, one of `MODEL_UNAVAILABLE`, `MODEL_IDENTITY_UNCONFIRMED`, `BUDGET_EXCEEDED`) is kept;
  - StrictRouteError whose cause is `ModelIdentityError`, or IndependentQaUnavailableError with `identity: true`, gives `MODEL_IDENTITY_UNCONFIRMED`;
  - other `MODEL_FAILURES` names give `MODEL_UNAVAILABLE`;
  - anything else gives `AGENT_ERROR`.
- ★`common.ts`: `class PropagatedFailure extends Error { code; budget? }`.
- ★`research.ts` `failOnModelFailure`:
  - it propagates a child's `MODEL_UNAVAILABLE`, `MODEL_IDENTITY_UNCONFIRMED`, or `BUDGET_EXCEEDED` with `budget` `llmCalls` / `tokens`, keeping the child's code and budget;
  - a **tool** budget (`budget: 'toolCalls'`) no longer fails the parent as a model failure; it stays a limitation, as it is for unconfigured agents;
  - `waitWithRetry` also skips the retry for `MODEL_IDENTITY_UNCONFIRMED`;
  - the comment is corrected.

### L5: identity code and goal classification
- ★`modelRouter.ts`: `confirmIdentity` throws `ModelIdentityError` (name), still wrapped by StrictRouteError, so the message is unchanged.
- ★`toolLoop.ts` `checkServed`: a reply with no reported model gives `IndependentQaUnavailableError` with `identity: true`. "Answered by a model coding may use" stays `MODEL_UNAVAILABLE`.
- `goalExecutor.ts`:
  ```diff
   if (r.status !== 'COMPLETED') {
     const err = r.specialist?.error;
  -  return { ..., failure: { message: ..., ...(err?.code ? { code: err.code } : {}) } };
  +  const code = err?.code === 'BUDGET_EXCEEDED' && err.budget === 'toolCalls' ? 'TOOL_BUDGET_EXHAUSTED' : err?.code;
  +  return { ..., failure: { message: ..., ...(code ? { code } : {}) } };
   ...
     if (v?.verdict === 'issues') { …unchanged… }
  +  if (!v || v.verdict === 'inconclusive') {
  +    return { ok: false, result, usage, failure: { code: 'VERIFICATION_INCONCLUSIVE', message: `the Verification agent could not check everything: ${result.verification.note}` } };
  +  }
  ```
- `goalRecovery.ts`: `CODE_CLASS`:
  - `MODEL_UNAVAILABLE` → `dependency`
  - `MODEL_IDENTITY_UNCONFIRMED` → `configuration`
  - `TOOL_BUDGET_EXHAUSTED` → `budget`
  - `VERIFICATION_INCONCLUSIVE` → `inconclusive`

  It is checked after the approval and outcome-unknown checks and before the text patterns. `decide` gets these cases:
  - `configuration`: `blocked`, goal `block`, not counted as an attempt;
  - `inconclusive`: `needs_review`, goal `block` with `goalWaitingFor: 'review'`, not counted.

### L2: unverified results never become long-term memory
★`jarvisAgents.ts` `promoteToMemory(result, request, verification, verificationRequired = shouldVerify(result))`:
- a result that needed verification is stored only with verdict `verified`;
- `issues`, `inconclusive`, `unverified`, or a verification that did not finish are not stored, and the log line says why;
- a result that did not need verification is stored as today;
- the call site passes `check`.

### R1: Claude-primary target names
★`modelRouter.ts` `possibleTargets`:
- a failover provider's model is what `chain` really sends: `modelFor(name, asked)`, with the OpenAI-compatible provider's own model. The "named-only, so unmapped" shortcut applies only to a route that names a named-only provider (`callNamed`).
- Failed identity look-ups are cached for 60 s (R4), so a failing look-up is not repeated on every QA task.

### R2: aliases of one model
`modelCategories.ts`:
- **`identityKey(model)`** is what identities are compared by:
  - lower case;
  - `models/` and any `vendor/` gateway prefix removed;
  - a `:variant` suffix removed (e.g. `:free`);
  - a trailing date stamp removed (`-20261101`, `-2026-11-01`, `@20261101`);
  - a trailing `-NNN` version removed (e.g. `-001`).

  `sameModelPossible` and the reply check compare these keys, so two names that reduce to the same key are one model.
- **Floating aliases** (`…-latest`, `latest`), whose target the name does not disclose, are unresolved and so never independent.
- This only makes more pairs count as "same", never fewer (fail closed).

### R4: bounded identity look-ups, only when needed
- ★`modelRouter.ts`:
  - `qaIndependence(env, { resolve })`. Look-ups (`validateModel` / `modelIdentities`) run only with `resolve: true`.
  - Each look-up is raced against `JARVIS_QA_IDENTITY_LOOKUP_MS` (default 10 000, clamped 1 000–60 000). A time-out or failure gives `resolved: false`, so the pair is never independent.
  - Failures are cached for 60 s.
- ★`toolLoop.ts` `qaGate`:
  - required: `resolve: true`;
  - not required: `resolve: false`. The label is then "not_independent" / "unknown" from names only, never "independent", and no network look-up is made.

### L1: coding helpers' own settings
- `modelCategories.ts`: `HELPER_ROLES = { coding_agent: ['code_analysis_worker', 'test_runner_worker', 'repo_discovery_worker', 'repo_code_analysis_worker', 'project_deep_analysis_worker'], qa_agent: ['test_runner_worker', 'evidence_check_worker'] }`. A test checks this against the registry's allowed child roles, so the list cannot drift.
- ★`modelRouter.ts` `possibleTargets(role)`: when the role is **not** strict, it also adds the target of every helper role in `HELPER_ROLES[role]` that has its own `JARVIS_MODEL_AGENT_<HELPER>` setting. When the role is strict, helpers inherit its route, so nothing is added.

## 4. Tests (written first; shown failing on the current tree and on `c4ac909`)

| New test | Checks |
|---|---|
| `tests/errorClassificationTest.ts` (L5, R3) | • strict identity failure → task code `MODEL_IDENTITY_UNCONFIRMED`; goal class `configuration` → blocked<br>• strict model down → `MODEL_UNAVAILABLE` → `dependency` (retry later)<br>• tool budget → task `BUDGET_EXCEEDED` with `budget: 'toolCalls'`; goal code `TOOL_BUDGET_EXHAUSTED` → `budget`<br>• inconclusive verification of a goal task → `VERIFICATION_INCONCLUSIVE` → `needs_review`, goal waits for review<br>• strict research: a deep worker's **tool** budget does not fail the parent as a model failure; a **model** budget fails it with `BUDGET_EXCEEDED` / `llmCalls`<br>• the four codes give four different signatures |
| `tests/memoryTrustTest.ts` (L2) | • `promoteToMemory` stores nothing for `inconclusive`, `unverified`, `issues`, or verification required but missing<br>• stores for `verified`, and when verification was not required (a stand-in memory sink) |
| `tests/identityAliasTest.ts` (R1, R2, R4, L1) | • R2: `vendor/claude-opus-5-5` vs `claude-opus-5-5`, `gemini-2.5-flash-001` vs `gemini-2.5-flash`, `@date` and `-date` forms, `gemini-flash-latest` vs anything → not independent; two genuinely different names → independent; the reply check catches an alias of coding's model<br>• R1 (Claude primary, separate process section): coding's non-strict targets name the model really sent<br>• R4: a look-up that never answers ends within the limit as unresolved (not independent); no look-up when not required; a failed look-up is not repeated within 60 s<br>• L1: a helper's own setting on QA's model makes coding and QA not independent; the static `HELPER_ROLES` matches the registry |

Then:
- the 37 programme and related groups (`goalRecoveryTest`, `goalAgentIntegrationTest`, `goalRuntimeTest` and the other `goal*` tests among them), typecheck, voice-core and the full suite;
- a baseline comparison and the integrity checks;
- a fresh independent review of the final source, all High and Medium findings fixed, and a re-review if source changes after it.

## 5. Risks

| Risk | How it would show |
|---|---|
| VERIFICATION_INCONCLUSIVE now stops a goal for review (today the goal carries on) | Goals whose research cites an unreachable source pause for the owner. **Intended; your decision D-1** |
| MODEL_IDENTITY_UNCONFIRMED blocks a goal instead of retrying | A misconfigured strict model stops the goal until fixed. Intended (fail closed) |
| R2 key normalization counts more pairs as one model | Some genuinely different models with equal keys (e.g. two different `-001`/`-002` builds) count as one; QA may then be "unavailable". Fail closed |
| A tracked goal test may depend on today's "inconclusive is ok" path | It would fail. Then I stop and report rather than change the test |

## 6. Decisions needed

- **D-1:** should a goal task whose verification is inconclusive (or did not finish) **pause the goal for your review** (`needs_review`)? This plan says yes. The alternative is to record `VERIFICATION_INCONCLUSIVE` and let the goal continue; its `verified` criterion already waits for review.
- **D-2:** approve the protected-file edits in §1, limited to this plan.

## Approval (Gate 1)

2026-11-16, through the approval prompt: **"Approve plan"** (implement exactly this plan; tests first; full suite and a fresh independent review; no commit). D-1: **"Pause for review"**, so an inconclusive verification makes the goal task `needs_review` with `VERIFICATION_INCONCLUSIVE`. D-2: the protected-file edits in §1, limited to this plan.
