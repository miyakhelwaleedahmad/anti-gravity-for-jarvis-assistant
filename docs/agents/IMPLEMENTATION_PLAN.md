# Implementation plan (7A)

Smallest changes that close the gaps in [EXISTING_AGENT_ARCHITECTURE.md](EXISTING_AGENT_ARCHITECTURE.md) §1 and §3. Each phase ends with `npx tsc --noEmit` and `npx tsx tests/runAll.ts --ci`; the next phase starts only when both are clean. Progress is ticked in [CHECKLIST.md](CHECKLIST.md).

| Phase | Change | Files | Gate |
|---|---|---|---|
| 0 | Audit, research, design, plan | `docs/agents/*.md` | Docs written; no code changed |
| 1 | Seven requested roles: `data_agent` added, `github_agent` merged into `coding_agent`, names updated, new worker roles; routing updated; restart does not duplicate roles | `core/agents/specialists.ts`, `jarvisAgents.ts`, `core/tools/dataTools.ts` (new), `core/tools/index.ts`, `behaviors/data.ts` (new), tests | `agentSpecialistsTest`, `jarvisAgentIntegrationTest`, `sevenAgentTest` (new) green |
| 2 | Message kinds and fields; duplicate and stale message guards; versioned artifacts; approval request carries agent and task ids | `types.ts`, `agentManager.ts`, `workspace.ts`, `security/approvalRequest.ts`, `core/toolRegistryV2.ts` | new tests in `sevenAgentTest`; `agentRuntimeTest`, `a2aProtocolTest` still green |
| 3 | Parallel and sequential execution, cancellation, timeouts, retries, cycles: already implemented and tested (`agentRuntimeTest`). Re-run and add the Data agent's parallel fan-out and aggregation | `behaviors/data.ts`, tests | as above |
| 4 | Specialist behaviours: Data (calculate/stats/compare/logs), Memory workers (retrieval, consistency), Desktop diagnostics worker, Verification evidence worker | `specialists.ts`, `behaviors/*.ts` | `sevenAgentTest` |
| 5 | Verification pass after root tasks (advisory, time-capped, can be turned off); result and dashboard show it | `jarvisAgents.ts`, `agentManager.ts` (`RootResult.verification`), `behaviors/verify.ts` (new) | tests for verified, issues, verifier failure |
| 6 | Full suite, typecheck, diff review, docs, commit, push to `claude/jarvis-repair`, CI | — | CI green |

## Configuration added

| Variable | Default | Meaning |
|---|---|---|
| `JARVIS_AGENT_VERIFY` | `1` | `0` turns the verification pass off |
| `JARVIS_AGENT_VERIFY_TIMEOUT_MS` | `20000` | Most time the pass may take before the result is presented as unverified |

All existing limits (`JARVIS_AGENT_MAX_DEPTH`, `_MAX_CHILDREN`, `_MAX_ACTIVE`, `_MAX_CONCURRENT`, `_LLM_CONCURRENCY`, `_MAX_TASK_DEPTH`, `_MAX_LIFETIME_MS`, `_TASK_TIMEOUT_MS`, `_IDLE_TIMEOUT_MS`, `_MAX_RETRIES`, `_MAX_ROOT_TASKS`, `_BUDGET_*`) stay as they are.

## Out of scope

- Running agents as separate processes or services (A2A over HTTP exists but stays opt-in).
- A container sandbox for code execution.
- Hardware checks (real Windows desktop, real Chrome) cannot run in CI. They are listed in the checklist as owner checks.
