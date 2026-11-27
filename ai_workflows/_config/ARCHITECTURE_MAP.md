# ARCHITECTURE_MAP.md — JARVIS Folder and File Responsibilities (Index)

> This is a reference map only. Do not use this file to make architectural changes.
> Do not delete or rename files based on this map alone.
> Paths checked against the repository on 2026-10-23 (`claude/jarvis-repair`).
> The source code wins over every map (`SOURCES_OF_TRUTH.md`); the pipeline
> overview, ownership table and memory tiers are in the root `ARCHITECTURE.md`.

Load only the topic file the task needs.

## Topic references

| Topic | File | Covers |
|---|---|---|
| Voice | `ARCH_VOICE.md` | Wake word, STT, TTS, NodeBridge, state machine, voice route, live log lines |
| Orchestrator, tools, agents | `ARCH_AGENTS.md` | Orchestrator, tool route, tool registry and catalog, skills, the seven specialists, LLM routing |
| Memory | `ARCH_MEMORY.md` | Memory manager, context builder, Redis, vector service, RAG, second brain, Obsidian |
| Self-healing and repair | `ARCH_SELF_HEALING.md` | `self_healing/`, `monitoring/`, issue store schema, repair run, code repair |
| Windows, browser, PC control | `ARCH_PC_CONTROL.md` | `control/`, `perception/`, `security/` policies, file, dev and git tools |
| Moved and removed files | `ARCH_LEGACY_PATHS.md` | Where the 2026-06 map's files went (mostly `_legacy/`), old audit flags |

## Runtime entry points

| File | Role |
|---|---|
| `jarvis.ts` | Main process entry (`pnpm run dev`, `pnpm start`): voice loop, CLI, NodeBridge, orchestrator, self-healing, second brain |
| `scripts/superviseJarvis.ts` | Runs JARVIS and restarts it after a crash (REL-02) |
| `backup.ts` | `pnpm backup`: copies `memory/` and `data/` to a folder outside the project |

`index.ts` is no longer an entry point (`_legacy/index.ts`, commit c39ca7b).

## Top-level folders

| Folder | Responsibility | Topic file |
|---|---|---|
| `core/` | Orchestrator, deterministic routes, task graph, state machine, tool registry and catalog, goals, issue store, repair, voice helpers | `ARCH_AGENTS.md`, `ARCH_SELF_HEALING.md`, `ARCH_VOICE.md` |
| `core/agents/` | Multi-agent system: JARVIS and seven specialists | `ARCH_AGENTS.md` |
| `core/tools/`, `tools/` | Built-in tools | `ARCH_AGENTS.md`, `ARCH_PC_CONTROL.md` |
| `skills/` | 26 loadable skill folders | `ARCH_AGENTS.md` |
| `bridge/` | NodeBridge; LLM providers and model routing | `ARCH_VOICE.md`, `ARCH_AGENTS.md` |
| `voice/` | Python wake word, STT and TTS services | `ARCH_VOICE.md` |
| `memory/`, `rag/` | Memory, vector service, second brain; document RAG | `ARCH_MEMORY.md` |
| `self_healing/`, `monitoring/` | Service supervision, health, logging | `ARCH_SELF_HEALING.md` |
| `control/`, `perception/`, `security/` | Acting on and reading the PC and browser; policies and approval | `ARCH_PC_CONTROL.md` |
| `system/` | Child processes, crash policy, shutdown, backup/restore, local Control Center | — |
| `config/` | `llmconfig.ts` (model and provider settings), `configValidator.ts`, `llmTiming.ts` | — |
| `scripts/` | `checkBrain.ts`, `verifyWindows.ts`, `trustSkills.ts`, `superviseJarvis.ts`, `benchMemoryLookup.ts` | — |
| `vision/` | `screen_capture.py` (screen capture and OCR) | — |
| `environment/` | `systemInfo.json` | — |
| `data/` | Runtime data; only `.gitkeep` placeholders and `goals.json` are tracked. Live data (`data/runtime/`, `data/repairs/`, `data/brain/`, `data/vector/`) is the owner's | `SOURCES_OF_TRUTH.md` |
| `tests/` | Test files run by `tests/runAll.ts` | `TEST_MATRIX.md` |
| `_legacy/` | Unreachable modules kept for reference | `ARCH_LEGACY_PATHS.md` |
| `docs/` | Design, audit, remediation and history documents | `SOURCES_OF_TRUTH.md` |

## Root files

Classification of other root-level files: `ROOT_FILE_AUDIT_GUIDE.md`
(dated 2026-06; many of the scripts it lists are now in `_legacy/`, so
re-check before relying on it).
