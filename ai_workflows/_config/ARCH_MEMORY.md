# ARCH_MEMORY.md — Memory, RAG and Second Brain Reference

> Topic reference for memory, retrieval and Obsidian bugs. Paths checked
> against the repository on 2026-10-23 (`claude/jarvis-repair`). The code
> wins; memory tiers and the second brain are described in full in the root
> `ARCHITECTURE.md` ("Memory tiers", "Document RAG", "Second brain").

## Files

| File | Role |
|---|---|
| `memory/memoryManager.ts` | Short-term (conversation) and long-term (fact) memory; LowDB `memory/jarvis_memory.json` is the authority for facts; circuit breaker around the vector service |
| `memory/unifiedContextBuilder.ts` | Builds the token-budgeted context for LLM planning (short-term, facts, graph, system, vault notes) |
| `memory/agentMemory.ts` | Working and episodic memory of the agent loop (`data/episodes.jsonl`) |
| `memory/redisCache.ts` | Redis cache layer: cache only, never truth |
| `memory/vectorMemory.py` | FastAPI vector service (sentence-transformers, default `all-MiniLM-L6-v2`, `EMBEDDING_MODEL`), persisted under `data/vector/` |
| `memory/vectorMemorySupervisor.ts` | Starts and watches `vectorMemory.py` |
| `memory/vectorAuth.ts` | Shared token for the local vector service (SEC-18) |
| `memory/graphMemory.ts` | Neo4j graph memory, off by default (`JARVIS_NEO4J_ENABLED`) |
| `rag/*.ts` | Document RAG: ingest → parse → chunk → embed → cited retrieval (`ingest_documents`, `search_documents`) |
| `memory/secondBrain.ts` | The second brain in the owner's Obsidian vault: spaces, filing, retrieval, verified lessons, error notes |
| `memory/vault.ts` | Safe vault access: only under `<vault>/JARVIS/`, only notes marked `jarvis_managed` are changed |
| `core/obsidianMirror.ts` | Mirrors issue-store issues into `JARVIS/01 Active Errors` and `02 Resolved Errors` |
| `memory/brainCheck.ts`, `scripts/checkBrain.ts` | "Is my second brain connected?" (`pnpm check:brain`) |
| `core/tools/memoryTool.ts`, `core/tools/secondBrainTool.ts` | Memory tools and the `memory_brain` tool |

`memory/contextBuilder.ts` and `memory/cacheManager.ts` are in `_legacy/`
(commit c39ca7b); see `ARCH_LEGACY_PATHS.md`.

## Memory route

```
orchestrator.process()
  → agentMemory.addConversationMessage()
  → unifiedContextBuilder.buildContext() → Redis cache → vector search → graph
  → memoryManager short-term and fact search
  → injected into the LLM planning prompt (retrieved vault notes wrapped as untrusted data)
```

## Redis role

- Caches context packets and recent messages to avoid repeated vector searches.
- Optional: JARVIS falls back when Redis is unavailable.
- Does not block the deterministic voice route.

## Vector memory role

- Serves semantic search over long-term facts and document chunks.
- A derived index joined back to LowDB by fact id; rebuilt from LowDB when
  the persisted form is missing or refused.
- Non-fatal if unavailable (circuit breaker in `memoryManager.ts`); fact
  recall falls back to lexical search.
- Does not block the deterministic voice route.

## Second brain and Obsidian boundaries

- Off unless `JARVIS_OBSIDIAN_VAULT` names a folder holding `.obsidian`.
- Decisions in `data/brain/registry.json`, operations in
  `data/brain/operations.jsonl`, offline writes in `data/brain/outbox.jsonl`.
  These are the owner's runtime data: never stage or commit them.
- Lessons are written only for verified issue resolutions
  (`issueStore.onResolved` → `secondBrain.noteResolvedIssue`).
- Error notes mirror the issue store; the issue store stays the authority
  (`SOURCES_OF_TRUTH.md`). Never write these notes by hand.

## Tests and docs

`secondBrainTest`, `secondBrainIntegrationTest`, `vectorRebuildStoreTest`,
`failedTaskMemoryTest` and others, through the runner (`TEST_MATRIX.md`).
Context loading for memory bugs: `CONTEXT_LOADING_RULES.md`.
