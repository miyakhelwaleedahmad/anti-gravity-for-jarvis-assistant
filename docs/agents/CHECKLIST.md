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
- [ ] Message kinds: assignment, acceptance, delegation_request, failure, verification
- [ ] Message fields: parentTaskId, correlationId, status, error
- [ ] Duplicate message ids dropped; messages to ended agents refused
- [ ] Versioned artifacts
- [ ] Approval request carries agentId, taskId, rootTaskId
- [ ] Messages cannot grant tools or answer approvals (test)
- [~] Parent/child/sibling-only messaging; nesting, child and active limits
- [ ] Gate: typecheck + full suite green

## Phase 3: parallel execution and aggregation
- [~] Independent tasks run concurrently (bounded)
- [~] Dependent tasks wait; cycles refused
- [~] Timeouts, stalls, retries, cancellation cascade, budgets
- [ ] Data agent fans out independent analyses and aggregates them
- [ ] Gate: typecheck + full suite green

## Phase 4: the seven specialists
- [ ] Research: unchanged recursive flow
- [ ] Software Engineering: code + GitHub tools; push approval-gated
- [ ] Browser: existing CDP tools only
- [ ] Desktop: diagnostics worker added
- [ ] Memory: retrieval and consistency workers
- [ ] Data: calculate, stats, compare, log summary
- [ ] Verification: evidence worker; no tool above risk 1
- [ ] Gate: typecheck + full suite green

## Phase 5: verification and dashboard
- [ ] Verification pass after research/data/engineering results
- [ ] Advisory and time-capped; verifier failure never blocks the answer
- [ ] Result report and status show the verdict
- [ ] Gate: typecheck + full suite green

## Phase 6: regression and release
- [ ] Full suite and typecheck
- [ ] Diff reviewed; no feature removed
- [ ] Docs updated
- [ ] Committed and pushed to `claude/jarvis-repair`; CI green
- [owner] `npm run dev`, then try the voice commands in the final report on the Windows PC
