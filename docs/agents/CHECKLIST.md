# Seven-agent checklist

Each phase is ticked only after its tests pass. A phase does not start until the one before it is ticked.

Legend: `[x]` done and tested · `[~]` existed before 7A, re-verified · `[ ]` not done · `[owner]` needs the owner's Windows PC

## Phase 0: audit and research
- [x] Inspect orchestrator, state machine, tool registry, approval gate, agent runtime, memory, browser, desktop, dashboard
- [x] Baseline: suite 108 passed / 0 failed / 9 skipped; typecheck clean
- [x] Map existing roles onto the requested seven
- [x] Research the six repositories at source (licence, last commit, exact files)
- [x] `EXISTING_AGENT_ARCHITECTURE.md`, `GITHUB_AGENT_RESEARCH.md`, `SEVEN_AGENT_DESIGN.md`, `IMPLEMENTATION_PLAN.md` with Mermaid diagrams

## Phase 1: registry and task lifecycle
- [x] Exactly seven permanent roles with the requested names (`sevenAgentTest`, `agentSpecialistsTest`)
- [x] `github_agent` merged into Software Engineering; every GitHub tool kept (test checks each one)
- [x] `data_agent` added with a safe `data_tools` tool (own parser, no eval; refuses code, deep nesting, long input)
- [x] Registering twice / a fresh manager does not duplicate permanent roles
- [x] Specialist routing updated (data, engineering, verification); short spoken names kept
- [x] Data agent: exact answers without the model; small parts done itself, real analyses on parallel workers, combined in order
- [~] Lifecycle transitions enforced; ownership per task
- [x] Gate: typecheck clean; suite 109 passed / 0 failed / 9 skipped

## Phase 2: communication and bounded hierarchy
- [x] Message kinds: assignment, acceptance, delegation_request, failure, verification (`sevenAgentTest` §2)
- [x] Message fields: parentTaskId, correlationId, status, error; request → reply matched by correlationId
- [x] Duplicate message ids dropped; messages to ended agents refused
- [x] Versioned artifacts (version, previousArtifactId; older versions kept)
- [x] Approval request carries agentId, taskId, rootTaskId; written to the security audit log
- [x] Two agents asking at once: each request names its own agent and task; a denial reaches only that call
- [x] Messages cannot grant tools or raise risk (a message asking for run_command and risk 4 changed nothing)
- [x] A worker that may not spawn asks its parent with delegation_request; the parent decides
- [~] Parent/child/sibling-only messaging; nesting, child and active limits (`agentRuntimeTest`)
- [x] Gate: typecheck clean; suite 109 passed / 0 failed / 9 skipped

## Phase 3: parallel execution and aggregation
- [~] Independent tasks run concurrently (bounded): `agentRuntimeTest` §1–2
- [~] Dependent tasks wait; cycles refused: `agentRuntimeTest` §3
- [~] Cancellation cascade, retries, parent failure, timeouts, stalls, budgets: `agentRuntimeTest` §7–11
- [x] Data agent fans out independent analyses (two workers ran at once) and aggregates them in order
- [x] Gate: same run as Phase 2

## Phase 4: the seven specialists
- [x] Research: recursive flow unchanged (`recursiveResearchExampleTest` 32/0)
- [x] Software Engineering: code + GitHub tools; write, commit and push go through the approval gate
- [x] Browser: existing CDP tools only; no second browser runtime
- [x] Desktop: "why … not working" parts go to System Diagnostics Workers (read-only, risk 0)
- [x] Memory: Consistency Worker checks ADD / UPDATE / NONE before storing (mem0 pattern, no second store); Retrieval Workers for searches
- [x] Data: calculate, stats, compare, log summary
- [x] Verification: Evidence Check Worker re-reads a cited GitHub source; the agent cannot write, commit, push or approve
- [x] Every specialist can create its own workers; each worker's tools are a subset of its parent's
- [x] Gate: typecheck clean; suite 109 passed / 0 failed / 9 skipped

## Phase 5: verification and dashboard
- [x] Verification pass after research, data and engineering results (and any result with conflicts)
- [x] Checks: finished, answered, citations present, high-confidence research findings sourced, conflicts settled, confidence backed by evidence, confidence allows for failed tools, cited GitHub source re-read
- [x] Advisory and time-capped (`JARVIS_AGENT_VERIFY_TIMEOUT_MS`, default 20 s; `JARVIS_AGENT_VERIFY=0` turns it off); if the check cannot run, the answer is still reported as "not verified"
- [x] A result with issues is not stored in long-term memory, and the spoken reply says problems were found
- [x] Console report shows the verdict and each failed check; status questions stay on the user's task
- [x] Verification agents appear on the dashboard like other agents (existing health registration)
- [x] Gate: typecheck clean; suite 109 passed / 0 failed / 9 skipped

## Phase 6: regression and release
- [x] Full suite 109 passed / 0 failed / 9 skipped (skips need Windows, PowerShell 7, Redis, a live LLM API, the bridge token or the Python venv); typecheck clean
- [x] Diff reviewed against `d41caa4`: no tool, route, test or public interface removed; `github_agent` folded into `coding_agent` with every tool
- [x] Docs updated: `docs/agents/*`, `docs/upgrade/MULTI_AGENT_SYSTEM.md`
- [x] Committed and pushed to `claude/jarvis-repair`; CI run #32 green (110 passed / 0 failed / 8 skipped)
- [x] Final report: [FINAL_REPORT.md](FINAL_REPORT.md)
- [owner] `npm run dev`, then try the voice commands in the final report on the Windows PC
