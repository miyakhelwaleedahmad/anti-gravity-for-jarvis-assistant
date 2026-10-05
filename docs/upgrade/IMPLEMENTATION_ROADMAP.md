# JARVIS upgrade — implementation roadmap

Goal: turn JARVIS into a PC-resident assistant that observes the real state of
the Windows PC and browser, knows which tools it has and what each may do, acts
on its own for safe tasks, and stops for approval before risky ones — built
into the existing architecture, not rewritten.

Branch: `claude/jarvis-repair` (never `main`). Baseline: commit `dc37503`,
suite 86 passed · 0 failed · 6 environment.

Documents in this folder:

| Document | What it holds |
|---|---|
| [JARVIS_PHASES.md](JARVIS_PHASES.md) | Every phase: objective, reason, dependencies, tasks, files, test plan, acceptance criteria, completion gate |
| [MASTER_PHASE_CHECKLIST.md](MASTER_PHASE_CHECKLIST.md) | Checklist per phase, `[ ]` `[~]` `[x]` `[!]` `[-]` |
| [PHASE_STATUS.md](PHASE_STATUS.md) | What each finished phase implemented and tested, results, limits, next |
| [MASTER_TASKS.md](MASTER_TASKS.md) | Every task: ID, priority, dependencies, files, steps, tests, acceptance, status |
| [TOOL_REGISTRY.md](TOOL_REGISTRY.md) | Tool metadata model and the current tool catalogue |
| [PERMISSION_MODEL.md](PERMISSION_MODEL.md) | Risk levels 0–4, policies, approval gate |
| [SECURITY_MODEL.md](SECURITY_MODEL.md) | Existing protections, what is added, redaction, audit |
| [SYSTEM_AWARENESS.md](SYSTEM_AWARENESS.md) | System and development observation, world state |
| [BROWSER_CONTROL.md](BROWSER_CONTROL.md) | Browser observation and control through the DevTools protocol |
| [PC_CONTROL.md](PC_CONTROL.md) | Windows computer control |
| [phases/](phases/) | One implementation prompt per phase |

## 1. Discovery (Phase 0)

Read before any change: orchestrator, state machine, task graph, reflection,
repair, synthesis, tool registry, skills, memory, voice, bridge, browser,
control layer, Windows perception, file and terminal tools, security, tests, CI.

### What JARVIS already has

| Area | What exists | Where |
|---|---|---|
| Request loop | Deterministic router → PLAN (LLM, ≤ 8 tools offered) → EXECUTE (task graph, parallel) → OBSERVE → REFLECT → REPAIR (retry, fallback tool, replan, abort) → SYNTHESIS; goals per request | `core/orchestrator.ts`, `core/taskGraphEngine.ts`, `core/reflectionEngine.ts`, `core/plannerIntelligence.ts`, `core/goalManager.ts` |
| State machine | IDLE, LISTENING, PROCESSING_STT, PLANNING, EXECUTING, OBSERVING, REFLECTING, REPAIRING, SPEAKING, INTERRUPTED; watchdogs | `core/agentStateMachine.ts` |
| Tool registry | 33 tools; name, description, risk low/medium/high, `requiredLevel`, input schema with enums, fallbacks, cacheable, retry policy, rollback hook; dispatch permission gate, validation, sandbox for medium/high, metrics, history | `core/toolRegistryV2.ts`, `core/skillLoader.ts`, `skills/*/description.json` |
| Session permission | Level 0 read-only (default), 2 full control (time-limited, persisted); 3 always needs confirmation, 4 always denied | `control/permissionSession.ts` |
| Command risk | Five command classes SAFE_READ_ONLY … CRITICAL_RISK; developer allowlist; dangerous-command blocklist | `security/permissionManager.ts`, `security/commandValidator.ts`, `tools/terminalTool.ts`, `control/adminController.ts` |
| Approval | Console YES/APPROVE/CONFIRM; voice "confirm" (also "yes", "do it"); 30 s / 10 s timeout, deny by default | `security/approvalGate.ts`, `bridge/nodeBridge.ts` |
| Observation | Active window, open apps (persistent PowerShell session), Chrome tabs (DevTools HTTP API), JARVIS services, CPU/RAM/uptime, background observer writing `data/runtime/system_state.json` | `perception/*`, `tools/terminalTool.ts` (get_system_info) |
| Computer control | Apps, windows (by handle), keyboard, mouse (coordinates), files in approved folders, processes, services, shell — through one kernel with an action queue, rollback and audit log | `control/*`, `control/win_automate.ps1` |
| Browser | List, focus, close, open URL, refresh tabs over the DevTools HTTP API (`127.0.0.1:9222`) | `control/browserController.ts`, `perception/chromeState.ts` |
| Files and terminal | read/write inside the project; control_file in project, temp, Desktop, Documents, Downloads; run_command on a developer allowlist | `tools/fileTool.ts`, `control/fileController.ts`, `tools/terminalTool.ts` |
| Memory | Long/short-term facts (JSON), episodes, vector search (Python), graph (optional), document RAG | `memory/*`, `rag/*` |
| Voice | Wake word → STT → `orchestrator.process(text, 'voice')` → TTS; barge-in, echo filter, follow-ups | `jarvis.ts`, `voice/*`, `bridge/nodeBridge.ts` |
| Safety | Localhost token bridge, file containment, OCR text as untrusted data, audit logs (security, tool, action, permission) | `bridge/`, `security/`, `core/workspaceRoot.ts` |
| Tests | 92 files, runner with CI mode, GitHub Actions | `tests/`, `.github/workflows/` |

### What is missing

- Tool metadata the planner and a risk engine can use: category, output
  description, risk 0–4 per action, approval need, reversibility, external effect.
  JARVIS cannot list what it can do.
- One risk engine. Three separate notions exist (tool risk, session level,
  command class) and none sees the arguments of a call except commands.
- A structured approval request (action, why, target, effect, risk,
  reversibility) tied to one pending action and recorded with the task.
- Secret redaction: tool output reaches the LLM, memory and logs unfiltered.
- Verification after an action: success means "the tool did not report an error".
- Observation of GPU, displays, audio devices, cameras, installed apps,
  services, listening ports, development servers, git repositories.
- A world-state model: observations are scattered and partly stale.
- Browser page content, structure, navigation inside a page, clicks, typing,
  downloads, screenshots. The HTTP API only lists, opens, closes, activates tabs.
- Windows control through UI Automation (structured), screenshots, clipboard,
  dialogs. Mouse and keyboard work by coordinates and key codes only.
- Structured git, test, build and dev-server tools; file list, compare, diff.
- Repair plans are not checked against permissions before they run.

### What is reused

The orchestrator loop, task graph, reflection and repair; the registry and
skill loader (extended, not replaced); `permissionSession` (session level),
`permissionManager` (command classes), `approvalGate` (extended), the control
kernel and its action queue, rollback and audit; the PowerShell session; the
DevTools connection on port 9222; file containment; the audit loggers; the
voice pipeline unchanged.

### What must be improved

`requiredLevel` alone cannot express "close is riskier than focus"; approvals
accept a bare "yes" by voice; the browser layer cannot read a page; nothing
checks that an action did what it claimed.

### What is not touched

The deterministic router's aliases and its injection guards; the voice
pipeline and NodeBridge singleton; the state machine's transition table (new
behaviour runs inside existing states); the open_app allow-list; the blocklist,
containment and bridge authentication (only added to, never loosened). See
`ai_workflows/_config/DO_NOT_BREAK.md`. Files on its protected list
(`core/orchestrator.ts`, `core/toolRegistryV2.ts`, …) are changed only where a
phase prompt names the change, with a test proving the old behaviour holds.

## 2. Design rules for every phase

1. Observation on demand, never continuous: a tool reads what the current
   request needs. Nothing new polls in the background (the 2010 iMac is slow,
   and this is not a monitoring system).
2. Few LLM requests: the Gemini free tier allows about 20 requests a day per
   model. Common questions ("what is open in my browser?") get deterministic
   routes; the planner sees tool categories, not every schema.
3. No new heavy dependencies: the DevTools protocol over the existing `ws`
   package instead of Playwright; PowerShell and .NET UI Automation on Windows.
4. Structured APIs before coordinates: DevTools DOM queries, UI Automation
   elements, window handles; mouse coordinates only as a last resort.
5. Never weaker: every existing check stays. New checks run in addition.
6. Secrets stay out: redaction before anything reaches the LLM, memory or logs.

## 3. Phase order

```
P0 Discovery ─► P1 Tool registry ─► P2 Risk engine ─► P3 Approval gate ─► P4 Redaction
                                                                             │
      ┌──────────────────────────────────────────────────────────────────────┘
      ▼
P5 Observe→Act→Verify ─► P6 System & dev observation ─► P7 World state ─► P8 Browser observation
                                                                             │
      ┌──────────────────────────────────────────────────────────────────────┘
      ▼
P9 Browser control ─► P10 Files & development ─► P11 Error recovery ─► P12 Voice
      ─► P13 Integration & scenarios ─► P14 Windows observation & control ─► P15 Final verification
```

Why this order and not the example's:

- The risk engine and approval gate come before any new action tool, so no
  new action ever exists without them.
- Redaction comes before the phases that read pages, files and the clipboard.
- The verification framework comes before the new action tools, so each ships
  with its check.
- Windows-only work is gathered in P14. Everything before it can be verified
  for real in this Linux container (real Chromium for the browser, real git,
  real files, real ports). P14 can only be verified on the owner's Windows PC.

## 4. Verification policy

Each phase lists its acceptance criteria in two groups:

- **Here** — verified in this container with real components (files, git,
  ports, a real Chromium over the DevTools protocol, the real orchestrator with
  a scripted model where an LLM would be needed).
- **Windows** — behaviour that only exists on Windows (PowerShell, UI
  Automation, window handles, the owner's Chrome).

A phase is `[x] COMPLETE` only when both groups pass. A phase whose Windows
group cannot run here is marked `[!] BLOCKED`, with a verification script the
owner runs on Windows (`pnpm verify:windows`, added in P14). Phases P1–P13 are
designed to have no Windows group, so they can be completed here. Work stops at
P14 until the Windows verification has been run.
