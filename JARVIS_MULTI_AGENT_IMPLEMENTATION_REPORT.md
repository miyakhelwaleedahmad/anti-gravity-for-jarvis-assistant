# JARVIS multi-agent system: implementation report

This report is for the owner and for whoever works on JARVIS next. It covers:
- what existed;
- what was missing;
- what was built;
- how it was tested;
- what is still unverified.

The design reference is [docs/upgrade/MULTI_AGENT_SYSTEM.md](docs/upgrade/MULTI_AGENT_SYSTEM.md). The audit and research that came first are [JARVIS_MULTI_AGENT_ARCHITECTURE_AUDIT.md](JARVIS_MULTI_AGENT_ARCHITECTURE_AUDIT.md) and [RECURSIVE_AGENT_RESEARCH.md](RECURSIVE_AGENT_RESEARCH.md).

## 1. The existing architecture

JARVIS had one orchestrator and one global state machine (10 states). For each request, the orchestrator:
1. used fixed routes, or asked the planner to pick tool calls from at most 8 tools;
2. ran those calls as a task graph, at most 3 at a time;
3. reflected, repaired and synthesised one answer.

Every tool call went through `toolRegistryV2.execute`:
- permission floor;
- argument check;
- risk engine;
- rate limit;
- approval gate;
- sandbox;
- redaction;
- verification.

There was no agent hierarchy:
- `messageBus` had no subscribers that used agent events;
- `healthManager.registerAgent` was never called;
- `agents/researchAgent.py` was a one-line placeholder.

All of this was kept.

## 2. What was missing

The audit (section 2) classified the following as MISSING:
- specialists and workers;
- child creation with limits;
- lineage;
- a child lifecycle;
- dependencies with data hand-off;
- cancellation trees;
- per-child permissions;
- budgets;
- a shared workspace;
- conflict handling;
- agent events;
- A2A;
- observability of agents.

## 3. What was built

All new code is in `core/agents/` and `tools/githubTools.ts`. Existing files got small additions only.

| Part | File | What it does |
|---|---|---|
| Types | `core/agents/types.ts` | A2A v1.0 wire types, lifecycle states, requests, `ChildResult`, workspace items, events |
| Limits | `core/agents/config.ts` | 14 limits read from `.env`: depth, children, active, concurrent, model calls, task depth, lifetime, timeout, idle, retries, root tasks, three budgets |
| Permissions | `core/agents/permissions.ts` | Scopes (`tool` or `tool:action`, `maxRisk`, `canSpawn`); child = parent ∩ role ∩ request; escalation refused; tools never given to agents |
| Events | `core/agents/events.ts` | Agent events on the existing `messageBus` (topic `AGENT_EVENT`): per-root sequence numbers, filters, streams, replay |
| Workspace | `core/agents/workspace.ts` | Per root task: sources, findings, claims, conflicts, artifacts, results, decisions, messages, progress, final synthesis; merge instead of overwrite |
| Registry | `core/agents/registry.ts` | Roles and agents, discovery by capability, Agent Cards, "unknown role" with the valid ones |
| Task manager | `core/agents/taskManager.ts` | Lineage, statuses with allowed transitions, dependencies (cycle refused when added), deadlines, idle watchdog, cancellation tree |
| Agent Manager / Factory | `core/agents/agentManager.ts` | All checks before a child exists; lifecycle; work slots; model-call slots; budgets; results; orphan prevention; archive; status queries |
| Spawn policy | `core/agents/spawnPolicy.ts` | SPAWN, SELF, REUSE, SUBSCRIBE or ASK_PARENT, with recorded reasons |
| Agent scope | `core/agents/agentScope.ts` + `core/traceContext.ts` | An approval asked by an agent shows the agent and the root request |
| A2A | `core/agents/a2a.ts` | A2A v1.0 server and in-process client; optional localhost HTTP + SSE endpoint with token |
| Behaviours | `core/agents/behaviors/*.ts` | Research hierarchy; tool loop for the other specialists; rule fallbacks; `<untrusted_context>` for outside text |
| Roles | `core/agents/specialists.ts` | 7 specialists and 11 worker roles with tools and risk ceilings |
| JARVIS side | `core/agents/jarvisAgents.ts` | `delegate_task`, `agent_status`, `cancel_agent_task`; spoken result when idle; memory promotion; dashboard; console log; startup and shutdown |
| GitHub tools | `tools/githubTools.ts` | `github_search` and `github_repo`, read-only (`GITHUB_TOKEN` optional) |

**Changes to existing files:**

| File | Change |
|---|---|
| `core/messageBus.ts` | The `AGENT_EVENT` topic |
| `core/traceContext.ts` | Agent-aware request text and source; `getAgentPath()` |
| `core/toolRegistryV2.ts` | Passes the agent path to approval requests |
| `security/approvalRequest.ts` | Optional `agent` field. The console shows ASKED BY AGENT; the voice says "the X needs your approval". Requests from JARVIS itself are unchanged. |
| `core/toolCatalog.ts`, `core/verifiers.ts`, `core/tools/index.ts` | The 5 new tools; JARVIS now has 65 tools (39 built-in, 26 skills) |
| `core/orchestrator.ts` | Fixed routes for agent questions, "stop this research" and research requests; the planner is offered the agent tools for matching wording |
| `jarvis.ts` | Starts the agent system after startup; cancels agents and closes the A2A endpoint at shutdown |

No package was added; `package.json` and `pnpm-lock.yaml` are unchanged.

## 4. Hierarchy and recursive spawning

```
JARVIS (depth 0)
└─ Research | Browser | PC | Coding | GitHub | QA | Memory Agent   (permanent, depth 1)
   └─ sub-agents and workers (temporary, depth 2…4; at depth 4 they cannot spawn)
```

**What each agent decides.** Every agent can run `ctx.decideSpawn`, which considers:
- whether the work is divisible;
- whether the parts are independent;
- whether parallelism helps;
- whether there is enough work;
- whether budget and depth remain;
- whether the capabilities are available;
- whether the work duplicates something already done or running.

It then either creates children through the Factory or does the work itself.

**What the Factory checks.** Every child request is checked against:
- parent alive;
- role known;
- role allowed;
- depth and task depth;
- children per agent;
- total active agents;
- capabilities and task type;
- permissions;
- whole-task delegation;
- retries;
- deadline;
- budget;
- dependencies.

A rejected request creates nothing; its reasons go out as a `SPAWN_REJECTED` event.

**The example, as it runs.** "Find the best GitHub projects for giving JARVIS browser awareness":
1. JARVIS sends the request to the Research Agent over A2A.
2. The Research Agent creates the GitHub, Web and Architecture Research Agents.
3. The GitHub Research Agent creates a Repository Discovery Worker and a Repository Code Analysis Worker. The Code Analysis Worker depends on the Discovery Worker.
4. Discovery finds projects A, B and C.
5. Code Analysis receives them and creates "Project browser-awareness Deep Analysis Worker" at depth 4.
6. Meanwhile the Architecture agent judges each candidate as it appears.
7. A licence disagreement (GPL-3.0 in the search index, MIT in the repository API) opens a conflict. A Fact Check Worker settles it.
8. Results go up level by level. The Research Agent synthesises the ranking.
9. JARVIS receives the answer, findings, sources, confidence, conflicts, limitations and next actions, and speaks a short version when idle.

## 5. Task graph, communication, workspace

**Task graph:**
- Each task records its task, parent task, root task, agent, parent agent, status, times, priority, dependencies, result, confidence, errors and cancellation state.
- Dependencies hand results to the dependent task. A cycle is refused when it is added.
- Independent tasks run at the same time, up to `JARVIS_AGENT_MAX_CONCURRENT`. An agent waiting for its children gives up its work slot, so waiting parents cannot deadlock the pool.

**Communication:**
- A2A between JARVIS and the specialists, and for explicit agent-to-agent messages.
- The parent ↔ child channel: spawn, wait, results and messages.
- Agent events on the existing message bus, delivered at once.
- The shared workspace.

Messages are allowed only to an agent's parent, children and siblings.

**Workspace:**
- Sources are de-duplicated by URL, and findings by statement; a second agent reporting the same finding corroborates it.
- Differing claims open conflict records, which are resolved by source quality, then by verification, or reported as unresolved.

## 6. A2A integration

- **Data model and methods.** The A2A v1.0 data model and JSON-RPC binding are implemented natively. Methods: `SendMessage` (blocking or `returnImmediately`), `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask` and `SubscribeToTask`; Agent Cards for JARVIS and for every agent; the specification's error codes.
- **Streams.** A stream starts with the Task, carries status updates (progress of the agents below) and artifact updates (findings as they appear), and ends at a terminal state.
- **Interoperability.** The official `@a2a-js/sdk` 1.3.0 client was run against the HTTP endpoint from a scratch folder: 10 of 10 checks passed (card, SendMessage, GetTask, streaming, `returnImmediately`, CancelTask, TaskNotFound mapping, ListTasks). The SDK is not a dependency; see research §3.3.

## 7. Permission inheritance and security

- **Scopes only narrow.** A child's scope is its parent's scope ∩ its role's maximum ∩ the request. A request for more is refused as `PERMISSION_ESCALATION`.
- **Risk ceilings:**

  | Specialists | Ceiling |
  |---|---|
  | Research, Browser, QA, Memory | 1 |
  | PC, Coding | 2 |
  | GitHub | 3 (git push still asks for approval) |

  No agent is ever given risk 4.
- **Tools never given to any agent:**
  - full-control on/off and cancel-current-action;
  - `control_system:restart_jarvis`;
  - JARVIS's own agent tools;
  - communication and scheduling tools.
- **Every call goes through the same checks.** A call first passes the agent's scope check, then the whole registry pipeline. Approvals name the agent and the user's original request.
- **Outside text is untrusted.** READMEs, web results and tool output reach the model only inside `<untrusted_context>`. The test checks that a README with an injected instruction is wrapped.

## 8. Cancellation flow

1. "Stop this research" goes to `cancel_agent_task`, which cancels the root task.
2. Linked AbortControllers abort every task below it.
3. Running work is cut at its next await, and each task ends CANCELLED.
4. Unfinished children of any task that ends are cancelled, so there are no orphans.
5. Partial findings are kept.
6. JARVIS says "Stopped … and all its agents", and later reports findings only if there were any.

A restart marks running root tasks INTERRUPTED in their archive; they are not run again.

## 9. Resource limits

The default limits are:

| Limit | Default |
|---|---|
| Depth | 4 |
| Children per agent | 5 |
| Active agents | 20 |
| Agents at work at once | 4 |
| Model calls at once | 2 |
| Root lifetime | 10 min |
| Child timeout | 5 min |
| Idle stop | 2 min |
| Retries | 1 |
| Root tasks at once | 3 |
| Model calls per root | 40 |
| Tool calls per root | 120 |
| Tokens per root | 400,000 |

All can be changed in `.env`; the variable names are listed in MULTI_AGENT_SYSTEM.md. Budgets are charged up the tree.

## 10. Repositories investigated, adopted, and ideas translated

17 repositories were read: licences checked, code read, nothing copied.

- **Adopted:** the A2A specification (data model and JSON-RPC binding).
- **Ideas translated into TypeScript:**

  | Source | Idea |
  |---|---|
  | OpenClaw | depth and child limits, leaf rule, deny list, cascade stop, "interrupted, not relaunched" |
  | Hermes Agent | permissions never chosen by the model, blocked child tools, stall detection, partial results |
  | ReDel | "don't delegate your whole task", depth gate |
  | CAMEL | recovery strategies |
  | AutoGen Magentic-One | stall counter (not used yet; noted for later) |
  | ADK | single parent, isolated child context; append-only workspace instead of last-write-wins |
  | Eino | agent-as-tool with structured results; agent path on approvals |
  | Mastra | pre-spawn checks, minimal context |
  | CrewAI | "unknown role" error with the list of valid roles |
  | swarms-rs | cycle refusal when an edge is added |
  | Khaledayman9 reference | ready-set scheduling, with waves removed |

- **Rejected as dependencies:** all frameworks. They would replace JARVIS's orchestrator or add a second runtime. Details are in RECURSIVE_AGENT_RESEARCH.md.

## 11. Tests

| Test | Checks | Result here |
|---|---|---|
| `tests/agentRuntimeTest.ts` | 102 | 102 passed (every run after the fixes) |
| `tests/a2aProtocolTest.ts` | 56 | 56 passed |
| `tests/agentSpecialistsTest.ts` | 27 | 27 passed |
| `tests/recursiveResearchExampleTest.ts` | 32 | 32 passed |
| `tests/jarvisAgentIntegrationTest.ts` | 42 | 42 passed |
| SDK interop (scratch, not in the repo) | 10 | 10 passed |
| Full suite `npm test` | 117 files | 111 passed · 0 failed · 6 environment |

The 20 checks the request asked for, with where each is tested:

| # | Check | Where |
|---|---|---|
| 1 | Delegate to a specialist | runtime §1, research example, integration |
| 2 | Specialist creates workers | runtime §1 |
| 3 | Concurrent workers | runtime §1–2 |
| 4 | Workers communicate | runtime §14, A2A |
| 5 | Real-time sharing | runtime §14, research example |
| 6 | Parent receives results | runtime §1 |
| 7 | Parent synthesises | research example |
| 8 | JARVIS receives the final result | runtime §1, research example, integration |
| 9 | Dependencies | runtime §3 |
| 10 | Cancellation propagates | runtime §7, research example, integration |
| 11 | A failed worker does not crash its parent | runtime §8 |
| 12 | Worker timeout | runtime §10 |
| 13 | Depth limit | runtime §4, research example |
| 14 | Concurrency limit | runtime §2, §5 |
| 15 | Permission inheritance | runtime §6, specialists |
| 16 | A child cannot exceed its parent | runtime §6 |
| 17 | Duplicate work avoided | runtime §12 |
| 18 | Conflicts detected | runtime §13, research example |
| 19 | A2A works | A2A test, SDK interop |
| 20 | Existing JARVIS still works | full suite |

The second prompt's list is covered by the same sections: child and grandchild, parent and child failure, retry, discovery, cleanup and orphan prevention are in runtime §§4, 8, 9, 15 and 1.

## 12. Test results

| Check | Result |
|---|---|
| Typecheck (`npx tsc --noEmit`) | Clean |
| Full suite (`npm test`, this Linux container, 117 files) | 111 passed · 0 failed · 6 environment |
| Five new agent tests (259 checks) | All passed |
| SDK interop (10 checks) | All passed |

The 6 environment entries are the same as before this work: they need Windows, Redis, the Python virtualenv or the bridge token.

The full suite's numbers before this work were 106 passed · 0 failed · 6 environment (commit `d77d0d9`). The 5 added test files account for the difference.

One full-suite run made while the orchestrator was being edited failed three voice tests with `ReferenceError: matchAgentRoute is not defined`, from a half-written file. The same tests pass on the finished code, both alone and in the final run.

## 13. Limitations

- **The owner's PC is the first live run.** Tests here run offline with a scripted model. Live GitHub, Serper and Gemini were not exercised, and the agents were not tried on Windows.
- **Without `SERPER_API_KEY` there is no web research.** The answer then rests on GitHub data, and says so.
- **GitHub without a token:** about 10 searches a minute and 60 other requests an hour.
- **Model calls:** a research task makes 4 (plan, queries, one deep analysis, final answer). The free Gemini tier allows few per minute.
- **Approvals queue:** they are shown one at a time, so a background agent's approval waits behind others.
- **Nothing prunes `data/agents/`.**
- **The A2A endpoint is local only:** no push notifications, OAuth or gRPC.
- **The stall counter is not used yet:** the Research Agent does not replan when rounds stop adding findings.

## 14. How to run it (Windows CMD)

Each step is one command, typed in **CMD** in your JARVIS folder.

1. Get the branch: `git fetch origin` then `git checkout claude/jarvis-repair` then `git pull origin claude/jarvis-repair`. You should see the new files listed, with no errors.
2. There is nothing to install: no package was added. Do not run `npm install`.
3. Optional, in `.env`:
   - `GITHUB_TOKEN=<a GitHub token with no scopes>` for higher GitHub limits;
   - `SERPER_API_KEY=…` for web research;
   - limits such as `JARVIS_AGENT_MAX_DEPTH=4`.
4. Start JARVIS: `npm run dev`. A few seconds after startup there are no agent lines yet; they appear when you delegate something.
5. Optional check without the microphone: `npx tsx tests\recursiveResearchExampleTest.ts`. The last line should be `=== Results: 32 passed, 0 failed ===`.

## 15. Things to say to JARVIS

- "Jarvis, find the best GitHub projects for giving JARVIS browser awareness." It answers "On it, sir. The Research Agent is working on it…" and later "Sir, the Research Agent has finished. …"
- "Jarvis, research TypeScript libraries for the Chrome DevTools Protocol."
- "What are your agents doing?" / "How many agents are running?"
- "Show the task tree." The tree is printed in the console.
- "What subagents did the research agent create and why?"
- "What has each worker discovered?" / "Which agents failed?" / "How much work remains?"
- "Stop this research." / "Stop all agents."
- "Compare Playwright and Puppeteer in the background." The planner may hand this to the Research Agent.
