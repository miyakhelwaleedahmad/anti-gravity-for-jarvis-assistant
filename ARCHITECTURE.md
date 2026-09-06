# JARVIS — Architecture

Reconstructed from the code, not from intent. Every claim here was checked
against the implementation; where a component is disabled or unreachable, it
says so.

## The one authoritative pipeline

```
        voice (wake → STT)                CLI
                 │                         │
                 └───────────┬─────────────┘
                             ▼
                      jarvis.ts
        voice state machine · mic arbitration · echo filter
        barge-in · watchdogs · process supervision
                             │
                             ▼
              core/orchestrator.ts   ◄── THE BRAIN
     ┌───────────────────────────────────────────────┐
     │  deterministic fast-path router (no LLM)      │
     │  PLAN → PRE-CHECK → EXECUTE → OBSERVE         │
     │       → REFLECT → REPAIR → respond            │
     └───────────────────────────────────────────────┘
              │                            │
              ▼                            ▼
  memory/unifiedContextBuilder      core/taskGraphEngine.ts
  token-budgeted context            parallel DAG, retries,
                                    rollback, interrupts
                                             │
                                             ▼
                                 core/toolRegistryV2.ts
                    ┌────────────────────────────────────────┐
                    │ schema validation                       │
                    │ AUTHORIZATION  (dispatch-layer gate)    │
                    │ result cache (low-risk tools only)      │
                    │ per-tool retry policy + fallback chain  │
                    │ health metrics, auto-degradation        │
                    └────────────────────────────────────────┘
                                             │
                     ┌───────────────────────┴──────────────────┐
                     ▼                                          ▼
              skills/  (24)                            control/  (10 controllers)
         dynamically loaded                     AUTHORIZATION (controller-layer)
                                                            │
                                                            ▼
                                                    Windows shell / OS
```

Everything the agent does passes through `toolRegistryV2`. There is no second
dispatch path.

## Subsystem ownership

| Responsibility | Owner | Notes |
|---|---|---|
| Orchestration | `core/orchestrator.ts` | The only brain. Single authoritative loop. |
| Plan execution | `core/taskGraphEngine.ts` | Parallel DAG, max concurrency 3, bounded retries |
| Tool dispatch | `core/toolRegistryV2.ts` | Single point. Validation, authz, retry, fallback, cache |
| Authorization | `control/permissionSession.ts` | Enforced at **both** dispatch and controller layers |
| Approval for dangerous acts | `security/approvalGate.ts` | 14 call sites |
| Command risk | `security/commandValidator.ts` | Fails closed: unknown ⇒ HIGH_RISK |
| File containment | `core/workspaceRoot.ts` + `security/workspacePathPolicy.ts` | Portable, host-independent |
| Source of truth (facts) | `memory/memoryManager.ts` (LowDB) | Authoritative |
| Cache | `memory/redisCache.ts` | Cache only, never truth |
| Semantic search | `memory/vectorMemory.py` | FastAPI + sentence-transformers, **persisted** |
| Episodic memory | `memory/agentMemory.ts` | Append-only JSONL |
| Graph memory | `memory/graphMemory.ts` | **Off by default** (`JARVIS_NEO4J_ENABLED`) |
| Context assembly | `memory/unifiedContextBuilder.ts` | Token-budgeted, cached |
| LLM routing | `bridge/modelRouter.ts` | Groq primary, OpenAI-compatible fallback |
| Process supervision | `self_healing/selfHealingManager.ts` | Spawn, crash-detect, backoff, circuit-break at 3 |
| Tracing | `monitoring/structuredLogger.ts` + `monitoring/traceWiring.ts` | One correlation id per request |
| State | `core/agentStateMachine.ts` | `core/stateShim.ts` is a compat proxy over it |

## Memory tiers

| Tier | Store | Durable? | Role |
|---|---|---|---|
| Short-term | in-process | no | Current turn |
| Working | `agentMemory` | no | Active task context |
| Episodic | `data/episodes.jsonl` | **yes** | What happened, including failures |
| Long-term facts | LowDB `memory/jarvis_memory.json` | **yes — SSOT** | Authoritative |
| Semantic index | `data/vector/` | **yes** | Derived index over the facts. Never truth. |
| Cache | Redis | no | Embeddings, context. Optional. |
| Graph | Neo4j | optional | Entities/relations. Off by default. |

Write authority for facts is LowDB alone. The vector store is a derived index
joined back to LowDB by stable fact id, and is rebuilt from LowDB if its
persisted form is missing or refused.

## Request lifecycle

1. **Deterministic router** — known commands ("open YouTube") execute with no LLM call.
2. **Plan** — one LLM call with tool definitions, built into a DAG.
3. **Pre-check** — structural validation, then confidence scoring. A low-confidence plan triggers a real replan, bounded by a guard.
4. **Execute** — DAG runs with bounded parallelism; per-tool spacing; per-node retries.
5. **Observe** — results collected; failures classified (timeout/abort/permission/transient/fatal).
6. **Reflect** — chooses a repair strategy: `retry_same`, `retry_with_delay`, `fallback_tool` (switches tool), `replan`, or abort.
7. **Repair** — bounded by `maxRepairCycles`; every loop in the system is bounded.
8. **Respond** — usually assembled without a second LLM call.

## Trust boundaries

- The WebSocket bridge **refuses to bind to a non-localhost host** and requires a shared token unless dev mode is explicit. It is not, and cannot be, a distributed bus.
- OCR text and tool output are untrusted: they enter the prompt as `user` content inside `<untrusted_context>` tags, with a system-prompt rule that such content is never instruction.
- Agent file I/O is confined to the workspace root; Windows system paths are blocked on every host.
- Unknown shell commands default to HIGH_RISK.

## What is NOT here

- **No Obsidian integration.** No code, no imports, no configuration.
- **No document RAG.** Semantic *fact* recall exists; ingestion, parsing and chunking do not.
- **No scheduler** wired into the running system.
- **`core/brain.ts` is not the brain.** It and the whole messageBus pipeline are unreachable and now live in `_legacy/`.
