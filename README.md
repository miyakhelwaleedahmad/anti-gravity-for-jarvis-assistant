# JARVIS — Antigravity

An autonomous desktop assistant for Windows. Voice in, plan, act on the machine,
speak back. Node.js/TypeScript at the core, with small Python sidecars for
speech, vision, and embeddings.

Despite the `requirements.txt`, this is **not** a Python application: 119 of the
live source files are TypeScript and 14 are Python.

---

## What it actually does

```
voice / CLI input
      ↓
jarvis.ts                    entry point, voice state machine, process supervision
      ↓
core/orchestrator.ts         THE BRAIN — plan → pre-check → execute → observe → reflect → repair
      ↓
core/taskGraphEngine.ts      runs the plan as a parallel DAG, with retries and rollback
      ↓
core/toolRegistryV2.ts       single dispatch point: schema validation, authz, retry, fallback, caching
      ↓
skills/*  and  control/*     33 tools; the control layer drives Windows
      ↓
memory/                      LowDB (source of truth) + Redis cache + vector search + optional graph
```

`core/orchestrator.ts` is the only brain. If you find a document or a comment
referring to `jarvisBrain` or `core/brain.ts`, it is describing a migration
leftover that no longer runs — see `_legacy/README.md`.

## Requirements

- **Node.js 22+** and **pnpm 10+**
- **Python 3.12** (for voice, vision, and the embedding service)
- **Windows** for the PC-control features. The rest runs anywhere.
- A **Groq API key** (or any OpenAI-compatible endpoint — see fallback below)
- *Optional:* Redis for caching, Neo4j for graph memory

## Setup

```bash
pnpm install
python -m venv .venv
.venv\Scripts\activate          # PowerShell / CMD on Windows
pip install -r requirements.txt

copy .env.example .env          # then fill it in
```

Two values in `.env` are required before anything will start:

| Variable | Why |
|---|---|
| `GROQ_API_KEY` | The reasoning model. Startup fails fast without it. |
| `JARVIS_BRIDGE_TOKEN` | Shared secret for the local voice bridge. Set a strong value, or set `JARVIS_BRIDGE_DEV_MODE=true` for insecure local development only. |

Everything else has a working default. `config/configValidator.ts` runs first at
startup and tells you exactly what is missing and how to fix it.

## Running

```bash
pnpm dev        # start JARVIS (tsx jarvis.ts)
pnpm build      # compile to dist/
pnpm start      # run the compiled build
```

The vector-memory service and the Python voice/vision processes are spawned and
supervised automatically by `self_healing/selfHealingManager.ts` — you do not
start them yourself.

## Testing

```bash
pnpm test                    # full census
pnpm test -- --ci            # skip what this machine lacks (Windows/Redis/venv/network);
                             # on Windows the Windows-only tests still run
pnpm test -- --filter=tool   # just the matching files
pnpm run typecheck           # tsc --noEmit
python tests/python/test_vector_persistence.py
```

Eight tests need Windows, Redis, a Python virtualenv, or a reachable LLM API.
The runner reports those separately from real failures, so a machine missing a
prerequisite does not look like a broken build.

## Permission model

Tools are gated by a session permission level, and the check happens twice — at
dispatch (`toolRegistryV2`) and inside the controller that does the work.

| Level | Meaning |
|---|---|
| 0 | Read-only. Observation, safe queries. **The default.** |
| 1 | Safe control — focus a window, open a safe app. |
| 2 | Full control — keyboard, mouse, file operations. Session-bounded and auto-revoking. |
| 3 | Always requires explicit confirmation. |
| 4 | Always denied. |

Full control is enabled per session, expires, and warns before it does. Ask
JARVIS to "enable full control" to elevate.

## Safety notes worth knowing

- **File containment.** All agent file I/O is confined to the project root
  (override with `JARVIS_WORKSPACE_ROOT`). Windows system directories are
  blocked, and the check works correctly on non-Windows hosts too.
- **Untrusted content.** Text read off the screen by OCR enters the prompt as
  data inside `<untrusted_context>` tags, never as system-level instruction.
- **Command validation.** Unknown shell commands are classified HIGH_RISK and
  fail closed.
- **Your data.** Live state is written only to gitignored locations:
  goals to `data/runtime/goals.json`, facts to `memory/jarvis_memory.json`,
  vectors to `data/vector/`, episodes to `data/episodes.jsonl`. Git never
  tracks, overwrites or deletes them, so pulling and merging leave them alone.
  `data/goals.json` is tracked but no longer written: on first start it is
  copied once into `data/runtime/goals.json` (never overwriting an existing
  file). Back up `memory/` and `data/` before upgrading anyway.

## Optional configuration

| Variable | Effect |
|---|---|
| `JARVIS_FALLBACK_BASE_URL` / `_API_KEY` / `_MODEL` | A second OpenAI-compatible provider, tried when the primary fails. Without it, a Groq outage stops all reasoning. |
| `JARVIS_VECTOR_PERSIST` | Vector store durability. On by default. |
| `JARVIS_NEO4J_ENABLED` + `NEO4J_PASSWORD` | Graph memory. Off by default; refuses to connect without a password. |
| `JARVIS_MIN_TOOL_GAP_MS` | Minimum spacing between repeat calls to the same tool (default 250). |

See `.env.example` for the full list.

## Repository layout

| Path | Contents |
|---|---|
| `jarvis.ts` | Entry point and voice state machine |
| `core/` | Orchestrator, task graph, tool registry, reflection, goals |
| `control/` | Windows control: apps, windows, keyboard, mouse, files, processes |
| `skills/` | 26 dynamically-loaded skills, each a `description.json` + `skill.ts` |
| `memory/` | LowDB source of truth, Redis cache, vector service, graph memory |
| `security/` | Permission manager, approval gate, command validator, path policy |
| `self_healing/` | Process supervision, failure detection, recovery |
| `bridge/` | WebSocket bridge, LLM providers, model router |
| `voice/`, `vision/` | Python sidecars |
| `tests/` | Test suite and the runner |
| `_legacy/` | Quarantined unreachable code — see its README |
| `docs/` | Baseline and engineering notes |

## Further reading

- `IMPLEMENTATION_PLAN.md` — what was repaired, verified, and what remains
- `docs/BASELINE.md` — measured state before the repair work
- `_legacy/README.md` — what was quarantined and why
