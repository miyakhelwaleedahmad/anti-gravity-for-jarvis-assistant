# CONTEXT.md — Routing for AI Agents

> Load this file after `ai_workflows/CLAUDE.md`, then only the files named
> for your task. Routing only: no architecture or status lives here.

JARVIS is a local TypeScript + Python voice assistant on Windows: a
WebSocket bridge (NodeBridge) joins the Node orchestrator to the Python
wake-word, STT and TTS services. Overview: root `ARCHITECTURE.md`; folder
map: `_config/ARCHITECTURE_MAP.md`.

## Route by task

| Task | Start with | Then load, only as needed |
|---|---|---|
| Bug repair or any code change | `stages/01_intake/CONTEXT.md` | Each stage's `CONTEXT.md` in order (`CLAUDE.md`, Stage Order) |
| Read-only repository audit | `_config/DUPLICATE_FILE_AUDIT_GUIDE.md` | `_config/ROOT_FILE_AUDIT_GUIDE.md` (dated 2026-06: re-check), `_config/ARCH_LEGACY_PATHS.md` |
| Voice issue (wake word, STT, TTS, YouTube route) | `_config/ARCH_VOICE.md` | `_config/VOICE_ROUTE_CONTRACT.md`, `_config/YOUTUBE_OPENAPP_INVESTIGATION.md`, `_config/TEST_MATRIX.md` (live verification) |
| Windows, desktop or browser control | `_config/ARCH_PC_CONTROL.md` | `_config/TEST_MATRIX.md` (Windows note), `_config/SECURITY_RULES.md` |
| Agent, orchestrator or tool-registry issue | `_config/ARCH_AGENTS.md` | `_config/RUNTIME_PROTECTED_FILES.md`, `_config/SECURITY_RULES.md` |
| Memory, RAG or Obsidian issue | `_config/ARCH_MEMORY.md` | `_config/SOURCES_OF_TRUTH.md` (Obsidian rules) |
| Self-healing or a runtime issue (`iss-…`) | `_config/ARCH_SELF_HEALING.md` | `_config/SELF_HEALING_OWNERSHIP.md`, then Stage 01 |
| General maintenance or documentation | `CLAUDE.md` (Stage Order) | `_config/CONTEXT_LOADING_RULES.md` (Documentation / Workflow Tasks) |
| "What is the current status?" | `_config/JARVIS_CURRENT_STATUS.md` | The tracker it points to (`_config/SOURCES_OF_TRUTH.md`) |

Which files to read for a given bug type:
`_config/CONTEXT_LOADING_BY_BUG_TYPE.md`.

## Always apply

- `_config/CONTEXT_LOADING_RULES.md`: never load `_config/` as a folder,
  never open secret-named files, keep the FYP file out of JARVIS work.
- `_config/SOURCES_OF_TRUTH.md`: where each kind of fact lives.
- `_config/TEST_MATRIX.md`: tests run only through the runner
  (`pnpm test -- --only=<names>`); never `npx tsx tests/<name>.ts`.
- `_config/RUNTIME_PROTECTED_FILES.md` and `_config/DO_NOT_BREAK.md`
  before changing runtime files.
- Human approval points and the stage order: `CLAUDE.md`.

## Other references

| File | Purpose |
|---|---|
| `_config/CODING_RULES.md` | Diff size, runtime safety, TypeScript, imports, git |
| `_config/DEVELOPMENT_CHECKLIST.md` | Per-run checklist to copy into a run |
| `runs/README.md` | Run folder layout and the index of runs |
