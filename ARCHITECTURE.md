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
                    │ AUTHORIZATION  (dispatch-layer gate)    │
                    │ schema validation                       │
                    │ result cache (low-risk tools only)      │
                    │ per-tool retry policy + fallback chain  │
                    │ health metrics, auto-degradation        │
                    └────────────────────────────────────────┘
                                             │
                     ┌───────────────────────┴──────────────────┐
                     ▼                                          ▼
              skills/  (26)                            control/  (10 controllers)
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
| Tool dispatch | `core/toolRegistryV2.ts` | Single point. Authz first, then schema validation, cache, retry, fallback |
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
| Document RAG | `rag/` + `skills/ingest_documents`, `skills/search_documents` | Ingest → parse → chunk → embed → cited retrieval |
| Goals | `core/goalManager.ts` | Live store `data/runtime/goals.json` (gitignored) |
| LLM routing | `bridge/modelRouter.ts`, `bridge/groqProvider.ts` | Primary is Gemini or Groq (`config/llmconfig.ts` picks from the keys), one OpenAI-compatible client for both; optional OpenAI-compatible fallback; a failed stream is answered once through `chat()` |
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
| Goals | `data/runtime/goals.json` | **yes** | 100-goal rolling window. Gitignored. |
| Document chunks | `data/rag/manifest.json` + `data/vector/` | **yes** | Chunk text and provenance; embeddings share the vector store. |

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
- OCR text enters the prompt as `user` content inside `<untrusted_context source="ocr">` tags, with `<`/`>` stripped so the wrapper cannot be forged, and a system-prompt rule that such content is never instruction. **Tool output is not wrapped this way** — it is never given `system` trust, but it is not delimited either. Retrieved memory facts are still sent as a `system` message.
- Agent file I/O is confined to the workspace root; Windows system paths are blocked on every host.
- Unknown shell commands default to HIGH_RISK.

## Document RAG

Retrieval over user-supplied documents, separate from conversational fact recall.

```
path ─► rag/ingest.ts ─► rag/parse.ts ─► rag/chunk.ts ─► memoryManager.embed()
        (workspace       (.txt .md .json   (~512 tokens,    (fact_id =
         containment)     .csv .log)        64 overlap)      doc:<hash>:<n>)
                                                                  │
query ─► rag/retrieve.ts ─► vector search ─► manifest join ─► cited passages
```

- Exposed as two tools: `ingest_documents` and `search_documents` (both `requiredLevel` 0).
- Ingest paths pass through the same workspace containment check as `read_file`.
- `.pdf` and Office formats are refused with a clear message; no parser is installed.
- Every returned passage names its source file and chunk. A hit with no manifest entry is dropped rather than returned uncited.
- Document chunks and conversational facts share one vector store, distinguished by the `doc:` id prefix.
- Retrieval depends on the sentence-transformers model. Without it the vector service answers `503`, `searchVector()` returns no hits, and `search_documents` says document search is unavailable (it asks `searchVector()` to rethrow; before, it reported "nothing matched"). Conversational fact recall still falls back to lexical search.

## What is NOT here

- **No Obsidian integration.** No code, no imports, no configuration.
- **No scheduler** wired into the running system.
- **`core/brain.ts` is not the brain.** It and the whole messageBus pipeline are unreachable and now live in `_legacy/`.
