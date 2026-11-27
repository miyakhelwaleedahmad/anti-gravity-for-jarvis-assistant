# ARCH_AGENTS.md — Orchestrator, Tools and Agents Reference

> Topic reference for orchestrator, tool-registry, skill and agent bugs.
> Paths checked against the repository on 2026-10-23
> (`claude/jarvis-repair`). The code wins; the pipeline overview is in the
> root `ARCHITECTURE.md`.

## Orchestration

| File | Role |
|---|---|
| `core/orchestrator.ts` | The one brain: deterministic fast path, then PLAN → PRE-CHECK → EXECUTE → OBSERVE → REFLECT → REPAIR → respond |
| `core/deterministicRoutes.ts` | Deterministic pre-router (moved out of `orchestrator.ts`) |
| `core/taskGraphEngine.ts` | Parallel DAG execution, bounded retries, rollback, interrupts |
| `core/agentStateMachine.ts` | Agent states; illegal transitions are rejected |
| `core/reflectionEngine.ts`, `core/stepRecovery.ts` | Repair strategy within a request; recovery of one failed step |
| `core/planningToolSelection.ts`, `core/plannerIntelligence.ts`, `core/clarification.ts` | Which tools the planner sees; plan checks; clarifying questions |
| `core/goal*.ts` | Goal runtime: lifecycle, scheduling, recovery, learning (`docs/GOAL_RUNTIME.md`) |
| `core/worldState.ts`, `core/verifiers.ts` | World-state summary for planning; checks that an action had its effect |
| `bridge/modelRouter.ts` | LLM routing and failover; `bridge/modelCategories.ts` picks a model per kind of work |
| `bridge/groqProvider.ts` | The OpenAI-compatible client for Gemini or Groq (not Groq-specific) |
| `bridge/anthropicProvider.ts` | Claude through the official SDK (optional, `JARVIS_LLM_PROVIDER=anthropic`) |

## Tool route

```
orchestrator.runAgentLoop()
  → matchDeterministicCommand()       fast path (no LLM)
  → OR planPhase()                    LLM call via bridge/modelRouter.ts
  → taskGraphEngine.execute()
  → toolRegistryV2.execute(toolName, args)
       authorization → schema validation → cache (low-risk only) → retry/fallback
  → skill or built-in tool runs
  → result collected → synthesis → reply (spoken through TTS for voice)
```

Everything the agent does passes through `core/toolRegistryV2.ts`; there is
no second dispatch path.

## Tools and skills

| File / folder | Role |
|---|---|
| `core/toolRegistryV2.ts` | The tool registry (V1 is `_legacy/core/toolRegistry.ts`) |
| `core/toolCatalog.ts` | Tool metadata: kind, risk level 0–4 per action, reversibility |
| `core/toolExecutionSandbox.ts` | Concurrency caps and budgets around risky calls |
| `core/toolNameLists.ts` | Shared tool-name lists |
| `core/tools/index.ts` | Registers the built-in tools (`core/tools/*.ts`, `tools/*.ts`) |
| `core/skillLoader.ts`, `core/skillTrust.ts` | Loads `skills/<name>/skill.ts`; only trusted skill folders (`skills/trusted-skills.json`, `scripts/trustSkills.ts`) |
| `skills/` | 26 skill folders (`automation` = `open_app`, `control_*`, `get_*`, `search`, `weather`, …) |
| `security/riskEngine.ts`, `security/approvalGate.ts`, `security/approvalRequest.ts` | Run / ask / refuse per call; the human approval gate |

## Multi-agent system (`core/agents/`)

JARVIS (the orchestrator) supervises **seven permanent specialists**
(`core/agents/specialists.ts`, `docs/agents/SEVEN_AGENT_DESIGN.md`):

| Role id | Specialist | Risk ceiling |
|---|---|---|
| `research_agent` | Research & Intelligence | 1 |
| `coding_agent` | Software Engineering & Code Execution (includes GitHub) | 3 (write, commit, push ask for approval) |
| `browser_agent` | Browser & Web Operations | 1 |
| `pc_agent` | Desktop & System Operations | 2 |
| `memory_agent` | Memory & Personalization | 1 |
| `data_agent` | Data & Problem-Solving | 0 |
| `qa_agent` | Verification, Security & Reliability | 1 |

Other agents are temporary workers for one task. A role's tools are the
most it may use; a child gets the intersection with its parent's scope
(`permissions.ts`), and every call still passes the risk engine and the
approval gate. Session-control and messaging tools are never given to agents.

| File | Role |
|---|---|
| `agentManager.ts` | The only place agents are created |
| `registry.ts`, `specialists.ts`, `behaviors/*.ts` | Role definitions and what each role does |
| `permissions.ts`, `spawnPolicy.ts`, `config.ts`, `semaphore.ts` | Tool scopes, whether to spawn children, limits (from `.env`), concurrency |
| `taskManager.ts`, `workspace.ts`, `a2a.ts`, `events.ts` | Task lineage, shared workspace, agent-to-agent messages, events |
| `jarvisAgents.ts`, `agentContextApi.ts`, `agentScope.ts` | How JARVIS uses the system; the agent's only door to tools and the model |

Docs: `docs/agents/`, `docs/upgrade/MULTI_AGENT_SYSTEM.md`,
`docs/upgrade/TOOL_REGISTRY.md`, `docs/upgrade/PERMISSION_MODEL.md`.

## Rules

- Agent roles, permissions, spawn limits, risk levels and approval gates
  are protected (`RUNTIME_PROTECTED_FILES.md`); changing one is a patch
  plan with approval, and Stage 05b checks it.
