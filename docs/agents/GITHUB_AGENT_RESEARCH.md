# GitHub agent research (7A Phase 0)

The six repositories named in the request, cloned at depth 1 on 2026-10-09 and read at source. They are references, not dependencies: **no package was added**. An earlier, wider survey (14 projects, A2A v1.0 and the a2a-js SDK) is in [`RECURSIVE_AGENT_RESEARCH.md`](../../RECURSIVE_AGENT_RESEARCH.md); this file covers the six repositories and what changed because of them.

| Repository | Last commit seen | Licence | Language | Used as |
|---|---|---|---|---|
| langchain-ai/langgraphjs | 2026-10-08 | MIT | TypeScript | Design reference |
| microsoft/agent-framework | 2026-10-09 | MIT | Python, .NET, Go | Design reference |
| a2aproject/A2A | 2026-10-07 | Apache-2.0 | Protobuf spec | Wire format (already implemented natively) |
| OpenHands/software-agent-sdk | 2026-10-09 | MIT | Python (+ TS client) | Design reference |
| browser-use/browser-use | 2026-10-07 | MIT | Python | Design reference |
| mem0ai/mem0 | 2026-10-07 | Apache-2.0 | Python | Design reference |

No repository is claimed to "match" JARVIS by a percentage. Each row below names the exact file read and the decision.

## langgraphjs

- **Read:** `libs/langgraph-core/src/constants.ts` (`class Send`), `libs/langgraph-core/src/interrupt.ts`, `libs/langgraph-core/src/errors.ts` (`GraphRecursionError`), `libs/langgraph-supervisor/src/handoff.ts` (`createSupervisor`, handoff tools).
- **Patterns:** `Send` fans one node out to N parallel invocations with their own state (map-reduce); `interrupt()` pauses a graph for human input; a recursion limit (default 25 steps) stops runaway graphs; the supervisor hands work to sub-agents through tools.
- **JARVIS already has:** fan-out with dependency-aware fan-in (`taskManager.ts`), human approval through the gate (the equivalent of `interrupt`), depth/children/active limits plus step budgets (stricter than one recursion limit), and supervisor-style delegation through `delegate_task`.
- **Decision:** keep the existing implementation. Adopted: the supervisor runs a *validation stage* after workers finish. This became the verification pass (design §6).

## microsoft/agent-framework

- **Read:** `python/packages/orchestrations/agent_framework_orchestrations/_concurrent.py` (`ConcurrentBuilder`, `with_aggregator`), `_magentic.py` (`max_stall_count`, `max_reset_count`, `max_round_count`), `_sequential.py`, `_handoff.py`.
- **Patterns:** concurrent fan-out/fan-in with a pluggable aggregator callback over all participant results; a duplicate participant is rejected; Magentic's orchestrator keeps a progress ledger and stops after a set number of stalls.
- **JARVIS already has:** concurrency semaphores, duplicate-task reuse (`findReusableResult`), stall detection (`idleTimeoutMs`), aggregation per behaviour.
- **Decision:** adopt the *aggregator as a pure function over child results* for the Data agent's "combine independent analyses" step (`aggregateResults` in `behaviors/data.ts`). Keep everything else.

## a2aproject/A2A

- **Read:** `specification/a2a.proto`: task states `SUBMITTED, WORKING, COMPLETED, FAILED, CANCELED, INPUT_REQUIRED, REJECTED, AUTH_REQUIRED`.
- **JARVIS already has:** a native A2A v1.0 layer (`core/agents/a2a.ts`) mapping these states onto its lifecycle; in-process by default, optional HTTP with a token.
- **Decision:** keep it. Remote agents as separate services are not needed yet, and the native layer avoids a dependency (see the earlier research §3.3). The new message kinds (design §4) travel as `metadata.jarvis.kind` on A2A messages, which the spec allows.

## OpenHands/software-agent-sdk

- **Read:** `openhands-sdk/openhands/sdk/security/confirmation_policy.py` (`ConfirmRisky`: threshold HIGH, `confirm_unknown=True`), `security/risk.py`, `openhands-tools/openhands/tools/delegate/impl.py` (`DelegateExecutor(max_children=5)`), `openhands-workspace/` (docker, apptainer, remote workspaces).
- **Patterns:** confirmation is decided from the *action's* risk, and unknown risk is confirmed; delegation caps children per agent; code runs in a separate workspace.
- **JARVIS already has:** the risk engine plus approval gate (unknown tools are not low-risk), `maxChildrenPerAgent` default 5, and a workspace path policy. No container sandbox: JARVIS runs on the user's Windows PC.
- **Decision:** keep. Adopted: the verifier may *read* and *run checks* but holds no tool above risk 1 and no approval-answering path. A sandboxed workspace is documented as future work, not built.

## browser-use/browser-use

- **Read:** `browser_use/agent/service.py` (`max_failures=5`, `final_response_after_failure=True`, `use_judge=True`, `sensitive_data` refused unless `allowed_domains` is set), `browser_use/agent/judge.py`.
- **Patterns:** stop after N consecutive failures but still give a final answer; a separate "judge" model reviews the run's trace; secrets only on allow-listed domains.
- **JARVIS already has:** its own CDP browser bridge and browser policy (`security/browserPolicy.ts`), budgets, partial results on failure, untrusted wrapping of page text.
- **Decision:** do **not** add browser-use (Python, Playwright runtime) since it would be a second browser runtime. Adopted: the *judge* idea as the verification pass, run by the existing QA role (now the Verification agent) over the result's evidence, not by a new model loop.

## mem0ai/mem0

- **Read:** `mem0/memory/main.py` (`add(..., infer=True)`), `mem0/configs/prompts.py` (the update prompt returns `ADD`, `UPDATE`, `DELETE` or `NONE` per fact).
- **Pattern:** before storing, compare the new fact with similar stored ones and choose add/update/delete/no-op, so memory does not fill with duplicates.
- **JARVIS already has:** `memoryManager`, Neo4j relations, vectors; strong findings are written after a root task.
- **Decision:** no second memory store. Adopted: a *consistency check* in a new Memory Consistency Worker. It reads with `search_memory` and reports `ADD / UPDATE / NONE` proposals. Deletion stays a user action.

## What was not adopted, and why

- LangGraph or Agent Framework as runtime dependencies would mean a second orchestrator competing with `core/orchestrator.ts`.
- Docker workspaces (OpenHands): the target is a Windows desktop and Docker is not assumed.
- browser-use: a second browser runtime.
- mem0 storage: a second vector store.
