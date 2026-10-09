# Recursive agent research

This document records the external research done before building the JARVIS multi-agent system (Phase 0b). It answers two questions:

1. How should JARVIS use the official A2A protocol?
2. Which existing hierarchical, recursive or multi-agent projects have ideas worth porting, and which should JARVIS ignore?

The current-state audit that this builds on is `JARVIS_MULTI_AGENT_ARCHITECTURE_AUDIT.md`.

## 1. Method

- **Date:** 2026-10-08.
- **Downloads:** every repository was read from a shallow, blob-less, sparse git clone of its default branch. Only the files named below were downloaded. Nothing was installed or run except the a2a-js package, which was unpacked from the npm registry so its type declarations could be read.
- **What was checked for each repository:**
  - the licence file itself, not a badge;
  - the date of the latest commit on the default branch;
  - the source files that implement delegation, recursion, limits, cancellation and events.
- **Stars and issue counts are not given.** The GitHub REST API is not reachable from this session, and figures quoted by third-party sites disagree with each other.
- **The A2A website was not readable.** a2a-protocol.org is blocked by this session's network proxy. The specification was read instead from `docs/specification.md` in the official repository (main branch), which names 1.0.0 as the latest released version.
- **No code was copied into JARVIS.** Where a project has a useful idea, JARVIS gets its own TypeScript implementation of that idea, so no licence obligations carry over. Licences are still recorded below in case code is copied later.

## 2. Summary

Verdicts:
- **Adopt:** use the thing itself.
- **Adapt:** port the idea into JARVIS's own code.
- **Reject:** don't use it.

| # | Project | Language | Licence (verified) | Last commit | Verdict |
|---|---|---|---|---|---|
| 1 | [a2aproject/A2A](https://github.com/a2aproject/A2A) (spec) | Protobuf / Markdown | Apache-2.0 | 2026-10-07 | **Adopt** the data model and JSON-RPC binding |
| 2 | [a2aproject/a2a-js](https://github.com/a2aproject/a2a-js) (`@a2a-js/sdk` 1.3.0) | TypeScript | Apache-2.0 | 2026-10-08 | **Adapt**: not a dependency now; used once to check interoperability |
| 3 | [Khaledayman9/A2A-Agent-Orchestration-System](https://github.com/Khaledayman9/A2A-Agent-Orchestration-System) (reference) | Python | Apache-2.0 | 2026-01-24 | **Adapt** the ready-set scheduler, fixed |
| 4 | [openclaw/openclaw](https://github.com/openclaw/openclaw) (sub-agents) | TypeScript | MIT | 2026-10-08 | **Adapt** the limits, leaf rule, deny list and cascade stop |
| 5 | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (`delegate_task`) | Python | MIT | 2026-10-08 | **Adapt** inherited tools, blocked child tools, stall detection and partial results |
| 6 | [zhudotexe/redel](https://github.com/zhudotexe/redel) | Python | MIT | 2025-09-11 | **Adapt** the "don't delegate your whole task" guard and the depth gate |
| 7 | [camel-ai/camel](https://github.com/camel-ai/camel) (Workforce) | Python | Apache-2.0 | 2026-10-05 | **Adapt** the recovery strategies and task-channel states |
| 8 | [microsoft/autogen](https://github.com/microsoft/autogen) (Magentic-One) | Python | MIT (code), CC-BY-4.0 (docs) | 2026-04-06 | **Adapt** the stall counter only (project is in maintenance mode) |
| 9 | [google/adk-python](https://github.com/google/adk-python) | Python | Apache-2.0 | 2026-10-08 | **Adapt** the single-parent tree and branch isolation |
| 10 | [google/adk-go](https://github.com/google/adk-go) | Go | Apache-2.0 | 2026-10-08 | Reference only (same model as adk-python) |
| 11 | [cloudwego/eino](https://github.com/cloudwego/eino) (ADK) | Go | Apache-2.0 | 2026-09-29 | **Adapt** agent-as-tool over context transfer, and addressed interrupts |
| 12 | [mastra-ai/mastra](https://github.com/mastra-ai/mastra) (supervisor) | TypeScript | Apache-2.0, except `ee/` directories | 2026-10-08 | **Adapt** the delegation hooks and message filter |
| 13 | [openai/openai-agents-js](https://github.com/openai/openai-agents-js) | TypeScript | MIT | 2026-10-07 | **Adapt** the per-delegation approval flag |
| 14 | [langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs) and [langgraph-supervisor-py](https://github.com/langchain-ai/langgraph-supervisor-py) | TypeScript / Python | MIT | 2026-10-07 / 2026-07-14 | **Reject** as a dependency; note the output-mode idea |
| 15 | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) (hierarchical process) | Python | MIT | 2026-10-08 | **Adapt** the "unknown co-worker" error |
| 16 | [The-Swarm-Corporation/swarms-rs](https://github.com/The-Swarm-Corporation/swarms-rs) | Rust | Apache-2.0 | 2026-10-03 | **Adapt** cycle rejection when an edge is added |
| 17 | [liquidos-ai/AutoAgents](https://github.com/liquidos-ai/AutoAgents) | Rust | MIT OR Apache-2.0 | 2026-08-26 | Reference only (typed topics; JARVIS already has them) |

No project was adopted as a framework. Each one either:
- replaces JARVIS's orchestrator, tool registry and approval gate with its own (LangGraph, Mastra, ADK, CrewAI, CAMEL, Eino);
- is a whole product rather than a library (OpenClaw, Hermes);
- is in another language and would need a second runtime (all the Python, Go and Rust projects);
- or has no recursion, cancellation or permissions (the reference repository).

The user's rule is to keep JARVIS's architecture and avoid dependency bloat, so the right move is to port specific ideas.

## 3. A2A protocol and the a2a-js SDK

### 3.1 What the specification defines (v1.0.0)

These points were read from `docs/specification.md`; section numbers refer to that file.

- **Core objects:** Task, TaskStatus, Message, Part, Artifact, AgentCard, AgentSkill, AgentCapabilities, plus the streaming events TaskStatusUpdateEvent and TaskArtifactUpdateEvent.
- **Task states** are ProtoJSON enum names (§4.1.3, §5.5):
  - `TASK_STATE_SUBMITTED`, `TASK_STATE_WORKING`;
  - interrupted: `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`;
  - terminal: `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, `TASK_STATE_CANCELED`, `TASK_STATE_REJECTED`.
- **Roles:** `ROLE_USER` and `ROLE_AGENT`.
- **Parts** carry exactly one of `text`, `raw` (base64), `url` or `data` (any JSON). Each part also has optional `mediaType`, `filename` and `metadata`. Field names are camelCase.
- **Operations and their JSON-RPC methods** (§5.3; PascalCase in v1.0, unlike v0.3's `message/send`):

  | Operation | JSON-RPC method |
  |---|---|
  | Send message | `SendMessage` |
  | Send message with streamed updates | `SendStreamingMessage` |
  | Get one task | `GetTask` |
  | List tasks | `ListTasks` |
  | Cancel a task | `CancelTask` |
  | Subscribe to an existing task | `SubscribeToTask` |
  | Get the extended Agent Card | `GetExtendedAgentCard` |
  | Push-notification configuration | four methods |

- **Error codes** (§5.4): `TaskNotFoundError` -32001, `TaskNotCancelableError` -32002, `UnsupportedOperationError` -32004, and others.
- **Streaming** (§3.1.2, §3.1.6):
  - The first event must be the Task.
  - Status and artifact updates follow.
  - The stream must end at a terminal state.
  - Subscribing to a task that is already terminal is an error.
- **Task IDs are server-generated** (§3.4.2). A client may not create a task with its own ID. `contextId` groups related tasks. `referenceTaskIds` on a Message points at related tasks.
- **Cancel** (§3.1.5): "the server will attempt to cancel the task, but success is not guaranteed". Cancelling a terminal task returns `TaskNotCancelableError`.
- **Agent Cards** are published at `/.well-known/agent-card.json`. Each card lists `supportedInterfaces` (URL, protocol binding, protocol version), `capabilities` (`streaming`, `pushNotifications`, `extensions`), and `skills`.
- **Extensions** are declared by URI in the Agent Card. They are the sanctioned place for data the core protocol does not define.

**What A2A does not define:**
- agent hierarchy, depth or child limits;
- permission inheritance;
- budgets;
- a shared workspace;
- dependency graphs between tasks.

These are JARVIS's own problem. They travel in `metadata`, under a JARVIS extension URI declared in each Agent Card.

### 3.2 What the a2a-js SDK provides (`@a2a-js/sdk` 1.3.0)

These facts were checked from the npm registry metadata and the published type declarations.

- **Package:**
  - licence Apache-2.0; `engines.node >= 20`;
  - one runtime dependency, `jose`;
  - optional peer dependencies: `express`, `@grpc/grpc-js`, `@bufbuild/protobuf`, `kysely`, `pg`, `mysql2`, `better-sqlite3`;
  - unpacked size about 4.5 MB.
- **Releases:** 1.0.0 on 2026-07-22, 1.3.0 on 2026-09-29. It implements specification v1.0 and has an opt-in v0.3 compatibility layer.
- **Server side:**
  - `AgentExecutor { execute(requestContext, eventBus), cancelTask(taskId, eventBus) }`.
  - `ExecutionEventBus` (`publish`, `on('event' | 'finished')`, `finished()`).
  - `DefaultRequestHandler(agentCard, taskStore, agentExecutor, ...)`, which implements `A2ARequestHandler`.
  - `InMemoryTaskStore`.
  - Transport adapters for Express (JSON-RPC and REST) and gRPC.
- **In-process use is possible.** `A2ARequestHandler` methods take `(params, ServerCallContext)` and can be called directly without HTTP. However, each handler is bound to one Agent Card and one executor, and brings its own task store and event-bus manager.
- **Parts are protobuf-ts style in memory.** In TypeScript a Part is `{ content: { $case: 'text', value } }` with `Buffer` for raw bytes, not the JSON wire shape, so JARVIS objects would need converting at every boundary.
- **Cancellation is cooperative.** The SDK sample keeps a `Set` of cancelled IDs and checks it before each step; the executor publishes the final `TASK_STATE_CANCELED` itself.

### 3.3 Decision: a native A2A v1.0 layer, not the SDK as a dependency (for now)

JARVIS will implement the A2A v1.0 data model and the JSON-RPC binding itself, in a small module (`core/agents/a2a.ts`). It will not add `@a2a-js/sdk` to `package.json` in this work.

**Reasons:**

1. **Installing a new dependency is a real risk on the owner's PC.** JARVIS is a pnpm project. The owner's Windows command prompt has no `pnpm`, and the owner has been told never to run `npm install` in this project. Adding a package would add an install step that has failed before.
2. **No duplicate communication systems.** The user asked for this explicitly. The SDK brings its own task store, event bus and event-bus manager. JARVIS already has `messageBus`, and the multi-agent work needs its own task manager anyway, because A2A has no lineage, limits or permissions. Running both would mean two task stores and two event buses describing the same work.
3. **Conversion at every boundary.** The SDK's in-memory types (`$case` unions, `Buffer`) differ from the JSON wire format. JARVIS agents run in one process, so the wire format can be used directly.
4. **The protocol surface JARVIS needs is small:**
   - Agent Cards;
   - `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`;
   - task states and the two update events.

   That is a few hundred lines with no new packages.

**How interoperability is still proven:**
- The optional localhost JSON-RPC endpoint is checked once against the official SDK client (1.3.0, unpacked in the session scratchpad, not shipped).
- The result is recorded in the final report.
- The in-repo tests check the same wire shapes without the SDK.

**When to switch to the SDK:** if JARVIS later needs remote agents on other machines, OAuth or signed Agent Cards, gRPC, REST, or push notifications. At that point the SDK is the right tool. The native layer keeps the spec's field names and method names, so the switch replaces only the transport module.

**Security for the optional HTTP endpoint:**
- off by default;
- bound to 127.0.0.1;
- requires a bearer token, the same rules as the existing bridge;
- never exposes tools directly: every request becomes a task that goes through the same permission and approval path as a voice command.

## 4. Project evaluations

Each entry uses the same fields. "Fit" means how well the idea fits JARVIS's existing architecture: one Node process, `toolRegistryV2` as the only path to tools, one approval at a time, the Gemini free tier, and a slow PC.

### 4.1 Khaledayman9/A2A-Agent-Orchestration-System (reference)

- **Language / licence / maintenance:** Python 3.10+, Apache-2.0. One commit series; latest 2026-01-24.
- **Architecture:** an Orchestrator Agent plus Math and Weather agents. Each is a separate A2A server: a2a-sdk 0.3.x for Python, FastAPI, LangGraph `create_react_agent`, and an MCP weather server.
- **How the orchestrator works:**
  - It reads each agent's card at start-up.
  - An LLM produces an `ExecutionPlan` of tasks, each with `order` and `dependencies`.
  - `execute_plan` loops: find the tasks whose dependencies are done, run them with `asyncio.gather`, and repeat.
  - Dependency results are prepended to the next task's input as text.
- **Recursion:** none. One orchestrator level, fixed agents.
- **Communication:** A2A `message/send` (v0.3) over HTTP with a 600 s client timeout. Text only.
- **Scheduling and concurrency:**
  - Wave-based: a wave waits for its slowest task before the next wave starts, even if other tasks became ready earlier.
  - No concurrency limit.
- **Failure handling:** an exception marks a task `error`. Later tasks still run, and the overall result is `partial_success`. If no task is ready, the run reports a circular dependency, but only after it has already executed some tasks.
- **Observability:** log lines only.
- **Security:** none (no permission model).
- **Strengths:** clear and small. Shows A2A Agent Cards used for discovery and for building the planner prompt.
- **Weaknesses:**
  - no recursion, cancellation (`cancel` raises `UnsupportedOperationError`), timeouts, limits, permissions or shared state;
  - wave scheduling wastes time;
  - cycle detection happens late.
- **Fit / verdict: Adapt.** JARVIS takes the ready-set loop and Agent-Card-driven planning, with three fixes:
  1. start each task as soon as its own dependencies finish (no waves);
  2. reject cycles before running anything;
  3. pass dependency results as structured data, not pasted text.

### 4.2 openclaw/openclaw — sub-agents

- **Language / licence / maintenance:** TypeScript, MIT. Very active (commit on 2026-10-08).
- **Architecture:** a gateway that runs agent sessions. `sessions_spawn` creates child sessions. Read from `docs/tools/subagents/nesting.md`, `tool-policy.md` and `operations.md`.
- **Recursion:**
  - `maxSpawnDepth` defaults to 5, configurable 1–5.
  - Agents below the cap are "orchestrators" and get the spawn and status tools.
  - Agents at the cap are "leaves" and lose them.
- **Limits:**
  - `maxChildrenPerAgent`: default 5, range 1–20, counts active children.
  - `maxConcurrent`: default 8, counts running child runs per spawning session. Each nested orchestrator has its own budget.
  - `runTimeoutSeconds`: per-spawn timeout; the docs' example sets 900, and 0 means no timeout.
- **Communication ("announce chain"):**
  - A child reports only to its direct parent.
  - The parent synthesises its children before announcing upward.
  - The docs tell orchestrators to wait for completion events rather than poll.
- **Tool policy:**
  - Children always lose system, messaging and scheduling tools (`gateway`, `cron`, `message`, `sessions_send`, and others), whatever the configuration.
  - "Deny wins."
  - An allow-list can only narrow the inherited set; it cannot add back a tool removed earlier.
- **Cancellation:** stopping an orchestrator cascades through all its descendants.
- **Restart:** after a restart, interrupted children are finalised as interrupted rather than relaunched. Their results tell the parent that side effects need checking.
- **Strengths:** limits, defaults and the leaf rule tested in production; a clear deny-wins policy.
- **Weaknesses:** the implementation is spread across a large gateway with persistence, channels and device pairing. Far too large to embed.
- **Fit / verdict: Adapt.** JARVIS takes:
  - the configurable depth cap (the user asked for an example of 4) and children-per-agent default 5;
  - per-parent concurrency;
  - the leaf rule (no spawn tool at max depth);
  - an always-denied tool list for children;
  - deny-wins narrowing;
  - results flowing up one level at a time;
  - cascade stop;
  - "interrupted, not relaunched" after a restart.

### 4.3 NousResearch/hermes-agent — `delegate_task`

- **Language / licence / maintenance:** Python, MIT. Very active (2026-10-08).
- **Architecture:** read from `website/docs/user-guide/features/delegation.md`. `delegate_task` runs child agents in a thread pool:
  - top-level delegations run in the background and post their result later;
  - an orchestrator child waits for its own workers.
- **Recursion:** flat by default; children cannot delegate. A child created with `role="orchestrator"` keeps `delegate_task`, bounded by `max_spawn_depth`.
- **Tool inheritance:**
  - There is deliberately no model-facing `toolsets` parameter. Children inherit the parent's tools, "so the model cannot grant a child capabilities that the parent does not have".
  - Children are always blocked from: asking the user (`clarify`), writing shared memory (`memory`), and sending messages (`send_message`).
- **Limits:**
  - Batch concurrency defaults to 10. A batch over the limit is a tool error, not silently truncated.
  - Per-child iteration budget. Running out returns `exit_reason: max_iterations, truncated: true`, so the parent can tell a budget stop from a finished task.
- **Timeouts:**
  - No wall-clock timeout by default. A heartbeat monitor interrupts a child with no progress for 450 s (1200 s while inside a tool).
  - The parent gets `status: "timeout"` with structured fields.
  - At about 80 % of the idle window, the child is warned to return what it has.
- **Cancellation:** stopping returns each child as `status: "interrupted"` with its partial output.
- **Failure visibility:** a failed child is never silent. It returns `status: "failed"` plus a one-line error.
- **Strengths:** the most careful treatment of "a child must not gain power" and of partial results.
- **Weaknesses:** Python, tied to its own agent loop.
- **Fit / verdict: Adapt.** JARVIS takes:
  - permissions inherited from the parent, never chosen by the model;
  - children cannot ask the user, write long-term memory or send messages;
  - batch-over-limit is an error;
  - budget stops are labelled as truncated;
  - progress-based stall detection alongside a hard lifetime cap;
  - cancelled and timed-out children return their partial findings.

### 4.4 zhudotexe/redel — recursive delegation

- **Language / licence / maintenance:** Python, MIT. Last commit 2025-09-11; quiet for about a year. A research toolkit.
- **Architecture:** each agent ("kani") may get a delegation tool. `DelegateWait` splits "start a helper" (`delegate`) from "wait for helpers" (`wait("next" | "all" | name)`), so models without parallel tool calls can still fan out.
- **Recursion:** `max_delegation_depth` (default 8). In `register_child_kani`, an agent created at the maximum depth gets no delegation tool.
- **Duplicate-work guard:** if the instructions given to a helper are more than 80 % similar to the agent's own task (fuzzy ratio), `delegate` refuses: "You shouldn't delegate the entire task to a helper." This stops agents passing the same task down the tree until the depth cap.
- **Events:** `kani_spawn`, `kani_delegated`, `kani_state_change`, `tokens_used`, `round_complete`. Used for a live tree view.
- **Failure handling:** a helper exception becomes its text result ("encountered an exception: …"). The parent keeps running.
- **Weaknesses:**
  - no child-count or concurrency limit;
  - no cancellation tree;
  - no permissions;
  - results are concatenated text.
- **Fit / verdict: Adapt.** JARVIS takes the "don't delegate your whole task" guard as part of `shouldSpawn` (similarity between child task and parent task) and the depth gate. The event names map onto the user's AGENT_CREATED / TASK_* list.

### 4.5 camel-ai/camel — Workforce

- **Language / licence / maintenance:** Python, Apache-2.0. Active (2026-10-05).
- **Architecture:** read from `camel/societies/workforce/` (about 12,500 lines).
  - A `Workforce` decomposes a task, assigns subtasks to workers, and collects results through a `TaskChannel`.
  - A Workforce can itself be a worker of another Workforce, which gives recursion.
- **Task channel:** packets move `SENT → PROCESSING → RETURNED → ARCHIVED`. Archived packets are read-only and are how finished tasks become dependencies for later ones.
- **Failure handling:** `FailureHandlingConfig` has:
  - `max_retries` (default 3);
  - `enabled_strategies`, a subset of `retry`, `replan`, `decompose`, `create_worker` and `reassign`;
  - `halt_on_max_retries`.
- **Events:** WorkerCreated/Deleted, TaskDecomposed, TaskCreated, TaskAssigned, TaskStarted, TaskUpdated, TaskCompleted, TaskFailed, AllTasksCompleted, QueueStatus. Very close to the user's event list.
- **Weaknesses:** large; tightly bound to CAMEL's agent classes; Python.
- **Fit / verdict: Adapt.**
  - The parent's options for a failed child become explicit strategies: retry, replace (new child), decompose, reassign, or continue without it, with a retry cap.
  - "Archived result is immutable and becomes a dependency input" matches the shared-workspace design.

### 4.6 microsoft/autogen — Magentic-One orchestrator

- **Language / licence / maintenance:** Python and .NET. MIT for code, CC-BY-4.0 for docs (two licence files).
- **Status:** the README says AutoGen "is now in maintenance mode" and points new users to Microsoft Agent Framework. Last commit 2026-04-06.
- **Idea:**
  - The orchestrator keeps a task ledger (facts and plan) and a progress ledger.
  - Each round asks `is_request_satisfied`, `is_progress_being_made` and `is_in_loop`.
  - No progress or a loop increments `n_stalls`; real progress decrements it.
  - At `max_stalls` the orchestrator replans.
- **Fit / verdict: Adapt the stall counter only.** It fits the Research Agent: when rounds stop adding new findings, stop or replan instead of spending more model calls. Rejected as a dependency because it is in maintenance mode and is Python.

### 4.7 google/adk-python and google/adk-go

- **Language / licence / maintenance:** Python and Go, both Apache-2.0. Both very active (2026-10-08).
- **Architecture:**
  - An agent tree: each agent has one `parent_agent`, and `sub_agents` are set on construction.
  - Delegation by LLM transfer, by `AgentTool` (call an agent like a tool and get its output), or by workflow agents (Sequential, Parallel, Loop).
  - `RemoteA2aAgent` wraps an A2A server as a sub-agent.
- **Branch isolation:** `ParallelAgent` gives each sub-agent its own branch. "Only conversation history is isolated between branches … Session state is shared by every branch, so branches writing the same key leave only the value written last." ParallelAgent is now deprecated in favour of `Workflow`.
- **Strengths:** clean tree model; A2A support from the same vendor that started A2A.
- **Weakness for JARVIS:** shared key-value state where the last write wins. That is exactly what a research workspace must avoid; findings must be appended and merged, not overwritten.
- **Fit / verdict: Adapt.** JARVIS takes:
  - one parent per agent;
  - isolated context per child;
  - a shared workspace that is append-only with explicit merge and conflict records, not last-write-wins.

  adk-go confirms the same model in Go and adds nothing extra for JARVIS.

### 4.8 cloudwego/eino — ADK for Go

- **Language / licence / maintenance:** Go, Apache-2.0. Active (2026-09-29).
- **Architecture:** sequential, parallel and loop agents; `Transfer` (hand off and exit) versus agent-as-tool (call and wait for the result); a `prebuilt/supervisor` package.
- **Notable finding:** the supervisor `Config` doc comment says "NOT RECOMMENDED: Supervisor is built on agent transfer with full context sharing, which has not proven to be more effective empirically. Consider using ChatModelAgent with AgentTool". This is evidence from a heavily used framework for the design JARVIS is choosing: children get a minimal task and return a structured result, rather than sharing the whole conversation.
- **Interrupts:** carry an address made of path segments (`AppendAddressSegment`), so a pause deep in the tree can be resumed at the right agent.
- **Fit / verdict: Adapt.**
  - Agent-as-tool with a structured result is the JARVIS default.
  - Addressed interrupts become the agent path recorded on an approval request, so the approval screen shows which agent asked.

### 4.9 mastra-ai/mastra — supervisor agents

- **Language / licence / maintenance:** TypeScript. Apache-2.0, except directories named `ee/`, which are under the separate licence in `ee/LICENSE` (not read). Very active (2026-10-08).
- **Architecture:** read from `docs/.../migrations/network-to-supervisor.mdx`. A supervisor lists sub-agents (each with a `description` that says when to use it) and has a `maxSteps` limit.
- **Delegation hooks:**
  - `onDelegationStart` can modify the prompt, lower the child's step limit, or reject the delegation.
  - `onDelegationComplete` can stop further delegations (`bail()`) or store feedback.
  - `messageFilter` controls which messages a child sees.
- **Approvals:** per Mastra's docs as returned by search, tool approvals inside a sub-agent propagate up to the supervisor. This was not verified in source.
- **Weakness for JARVIS:** adopting Mastra means adopting its agent, memory and workflow runtime, a second architecture.
- **Fit / verdict: Adapt.**
  - A validation hook before each child is created (the Agent Factory's checks) that can reject or shrink the request.
  - A completion hook where the parent decides what happens next.
  - Minimal context passed to children.

### 4.10 openai/openai-agents-js

- **Language / licence / maintenance:** TypeScript, MIT. Active (2026-10-07).
- **Architecture:** `agent.asTool({ needsApproval, isEnabled, ... })` turns an agent into a tool. Handoffs can be disabled per run with `isEnabled`.
- **Fit / verdict: Adapt the idea, not the package.**
  - A delegation can be marked as needing approval.
  - A child role can be disabled by the current context.
  - JARVIS already has the approval machinery, so this is a flag on the delegation request, not a new system.

### 4.11 langchain-ai/langgraphjs and langgraph-supervisor-py

- **Language / licence / maintenance:** TypeScript and Python, MIT. Active.
- **Architecture:** a supervisor graph with handoff tools. `output_mode` chooses whether the parent receives the child's full history or only its last message.
- **Notable:** the Python library's README now says "We now recommend using the supervisor pattern directly via tools rather than this library for most use cases." That points the same way as Eino.
- **Verdict: Reject** as a dependency (it would replace JARVIS's orchestrator with a graph runtime). The `output_mode` idea becomes the child result contract: the parent gets a structured summary, never the child's transcript.

### 4.12 crewAIInc/crewAI — hierarchical process

- **Language / licence / maintenance:** Python, MIT. Very active (2026-10-08).
- **Architecture:** in `Process.hierarchical`, a manager agent delegates with `Delegate work to coworker` and `Ask question to coworker` tools. If the named co-worker does not exist, the tool returns an error listing the valid co-workers.
- **Verdict: Adapt that one detail.** An unknown or unavailable child role returns an error naming the valid roles, so a planner can correct itself instead of failing.

### 4.13 The-Swarm-Corporation/swarms-rs

- **Language / licence / maintenance:** Rust, Apache-2.0. Active (2026-10-03).
- **Architecture:** sequential, concurrent and DAG workflows, with `SubAgentTool` and `HandoffTool` for delegation.
- **Cycle check:** `DAGWorkflow::connect_agents` adds an edge, checks `is_cyclic_directed`, and removes the edge again and returns `CycleDetected` if a cycle appears. `detect_potential_deadlocks` reports strongly connected components.
- **Verdict: Adapt.** The JARVIS task manager rejects a dependency that would create a cycle at the moment it is added, before anything runs.

### 4.14 liquidos-ai/AutoAgents

- **Language / licence / maintenance:** Rust, dual MIT OR Apache-2.0 (checked in `Cargo.toml`). Active (2026-08-26).
- **Architecture:** actor-based agents with typed pub/sub `Topic<M>`.
- **Verdict: Reference only.** JARVIS's `messageBus` already has a typed `EventMap`. This confirms the approach and adds nothing new.

## 5. What JARVIS takes, and where it went

Written before the implementation; the module column below was updated afterwards to the files that were actually written.

| Idea | Source | JARVIS module | Status |
|---|---|---|---|
| A2A Task, Message, Part, Artifact, Agent Card and states in wire format; JSON-RPC method names and error codes | A2A spec | `core/agents/a2a.ts`, `core/agents/types.ts` | done |
| Configurable depth cap; children-per-agent default 5; per-parent concurrency; global caps | OpenClaw, Hermes, the user's spec | `core/agents/config.ts`, `agentManager.ts` | done; concurrency is global (`JARVIS_AGENT_MAX_CONCURRENT`), not per parent |
| Leaf rule: no spawn ability at max depth | OpenClaw, ReDel | `core/agents/agentManager.ts`, `permissions.ts` | done |
| Child permissions inherited, never chosen by the model; deny wins; tools children never get | Hermes, OpenClaw | `core/agents/permissions.ts` | done |
| Refuse to delegate the whole task; reuse or follow duplicate work | ReDel, the user's spec | `spawnPolicy.ts`, `agentManager.ts` | done |
| Start tasks when their own dependencies finish; reject cycles when an edge is added | reference repo (fixed), swarms-rs | `core/agents/taskManager.ts` | done |
| Failed-child strategies | CAMEL | `agentContextApi.ts` (`retry`, `cancelChild`), behaviours | retry, replace (retry with changes), cancel and carry on are done; decompose and reassign are left to the behaviour, with no helper |
| Progress-based inactivity timeout plus a hard lifetime | Hermes | `taskManager.ts` | done |
| Stall counter (no new findings → replan) | Magentic-One | — | not done yet |
| Partial results on cancel or timeout; budget stops labelled `truncated` | Hermes | `agentManager.ts` (`ChildResult`) | done |
| Results go to the direct parent only; the parent synthesises before reporting up | OpenClaw | `agentManager.ts`, behaviours | done |
| Cascade cancel; interrupted (not relaunched) after a restart | OpenClaw, Hermes | `taskManager.ts`, `agentManager.ts` (archive) | done |
| Append-only shared workspace with merge and conflict records (not last-write-wins) | ADK's weakness, the user's spec | `core/agents/workspace.ts` | done |
| Checks before a child exists; minimal child context | Mastra | `agentManager.ts` (`spawnChild`), behaviours | done |
| Agent path recorded on approval requests | Eino interrupts | `agentScope.ts`, `traceContext.ts`, `approvalRequest.ts` | done |
| Unknown role → error listing valid roles | CrewAI | `core/agents/registry.ts` | done |

## 6. Recommendation

1. **A2A:** implement the A2A v1.0 data model and JSON-RPC binding natively, in-process first, with an optional localhost HTTP endpoint that is off by default. Prove interoperability once with the official `@a2a-js/sdk` client. Do not add the SDK as a dependency until JARVIS needs remote agents, OAuth, gRPC, REST or push notifications.
2. **Frameworks:** adopt none. JARVIS's orchestrator, `toolRegistryV2`, approval gate, `messageBus`, `modelRouter` and memory stay as they are. The multi-agent layer sits beside them and calls into them.
3. **Ideas:** port the ones in section 5. All are small and can be implemented in TypeScript without copying code.
4. **Defaults** for a slow PC on the Gemini free tier; all can be changed through environment variables:

   | Setting | Default |
   |---|---|
   | Maximum depth (JARVIS = 0) | 4 |
   | Children per agent | 5 |
   | Total active agents | 20 |
   | Concurrently running agents | 4 |
   | Concurrent model calls from agents | 2 |
   | Root task lifetime | 10 minutes |
   | Inactivity timeout | 2 minutes |

   Model and tool calls are also counted against a per-root budget.

## 7. Licence notes

- Every project in section 2 uses MIT, Apache-2.0, or both. All allow copying with attribution: Apache-2.0 also requires keeping NOTICE files and marking changes.
- Mastra's `ee/` directories are under a separate licence (`ee/LICENSE`) and must not be copied.
- AutoGen's documentation is CC-BY-4.0, which is separate from its MIT code.
- In this work no code was copied, so no attribution file is needed. If code is copied later, add the licence text and NOTICE to `THIRD_PARTY_NOTICES.md` in the same commit.
