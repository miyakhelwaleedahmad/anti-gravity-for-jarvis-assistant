# Tool registry

Implemented in phase P1 ([prompt](phases/phase-01-tool-registry.md)).

## Today

`core/toolRegistryV2.ts` holds every tool JARVIS can call: 7 built-in tools
registered in code and 26 skills loaded from `skills/*/description.json` by
`core/skillLoader.ts`. Each tool has a name, description, input schema (with
allowed values for actions), fallbacks, an execution risk (`low` / `medium` /
`high`) and an optional `requiredLevel` checked at dispatch. The registry
validates arguments, runs medium/high-risk tools in a sandbox with time and
concurrency limits, queues them one at a time, caches tools marked
`cacheable`, keeps metrics and history, and offers OpenAI-style definitions to
the planner (at most 8 per request, picked by keywords).

What it cannot do: say what category a tool belongs to, how risky each of its
actions is, whether approval is needed, whether the effect can be undone, or
whether it reaches outside the PC — and JARVIS has no tool to list its own
capabilities.

## Metadata added in P1

| Field | Values | Meaning |
|---|---|---|
| `category` | OBSERVATION, BROWSER, COMPUTER, FILESYSTEM, TERMINAL, DEVELOPMENT, NETWORK, COMMUNICATION, SCHEDULING, MEMORY, SYSTEM | Grouping for discovery and planning |
| `risk` | 0–4 | Default risk; see [PERMISSION_MODEL.md](PERMISSION_MODEL.md) |
| `actions` | per action: risk, reversible, effect | For tools with an `action` argument |
| `reversible` | `yes` / `partial` / `no` | Can the effect be undone |
| `external` | `none` / `query` / `change` | `query`: sends data out to get information (web search); `change`: changes something outside the PC (push, send, upload) |
| `output` | format (`text` / `json`) and a description | What the tool returns |
| `effect` | one sentence | Expected effect, shown in approval requests |

Approval need is derived from risk, not stored: 0–1 none, 2 by policy, 3–4 always.

The existing `riskLevel` (`low` / `medium` / `high`) stays: it drives sandboxing,
caching and queueing. The new 0–4 `risk` drives permission decisions.

Where metadata lives: one catalogue, `core/toolCatalog.ts`, for the built-in
tools; a skill may declare `meta` in its `description.json`, which takes
precedence. A tool without either gets derived defaults and a startup warning,
and a test fails until it is given real metadata.

## Catalogue of the current tools

Risk per action where a tool has several. "R" = reversible.

| Tool | Category | Risk | R | External |
|---|---|---|---|---|
| get_system_info | OBSERVATION | 0 | yes | none |
| get_system_state | OBSERVATION | 0 | yes | none |
| get_pc_state | OBSERVATION | 0 | yes | none |
| get_open_apps | OBSERVATION | 0 | yes | none |
| get_active_window | OBSERVATION | 0 | yes | none |
| is_app_open | OBSERVATION | 0 | yes | none |
| get_jarvis_service_status | OBSERVATION | 0 | yes | none |
| get_browser_tabs | BROWSER | 0 | yes | none |
| is_tab_open | BROWSER | 0 | yes | none |
| control_browser | BROWSER | list 0 · focus 1 · open_url 1 · refresh 1 · close 2 · close_current 2 | close: partial | query |
| open_app | COMPUTER | 1 (cmd: 3, P2) | yes | none |
| control_app | COMPUTER | open 1 · focus 1 · close 2 · restart 2 | close: partial | none |
| control_window | COMPUTER | focus 1 · minimize 1 · maximize 1 · move 2 · resize 2 · close 2 · close_current 2 | close: partial | none |
| control_keyboard | COMPUTER | type 2 · press_key 2 · press_hotkey 2 | no | none |
| control_mouse | COMPUTER | move 1 · scroll 1 · click 2 · right_click 2 · double_click 2 · drag 2 | no | none |
| read_file | FILESYSTEM | 0 | yes | none |
| write_file | FILESYSTEM | 2 | no | none |
| control_file | FILESYSTEM | search 0 · read 0 · create_folder 2 · write 2 · copy 2 · move 2 · rename 2 · delete 3 · delete_folder 3 | delete: no | none |
| run_command | TERMINAL | 3 by default; by command class in P2 | no | none |
| explain_code | DEVELOPMENT | 0 | yes | none |
| web_search | NETWORK | 1 | yes | query |
| deep_search | NETWORK | 1 | yes | query |
| get_weather | NETWORK | 1 | yes | query |
| search_memory | MEMORY | 0 | yes | none |
| search_documents | MEMORY | 0 | yes | none |
| save_relation | MEMORY | 1 | partial | none |
| ingest_documents | MEMORY | 1 | partial | none |
| control_process | SYSTEM | list 0 · find 0 · kill 3 · restart 3 | no | none |
| control_system | SYSTEM | network_status 0 · disk_status 0 · settings 2 · restart_jarvis 3 · shell 3 · powershell 3 · start/stop/restart_service 3 | no | none |
| get_permission_status | SYSTEM | 0 | yes | none |
| enable_full_control_session | SYSTEM | 3 | yes | none |
| disable_full_control_session | SYSTEM | 1 | partial | none |
| cancel_current_action | SYSTEM | 1 | no | none |
| list_capabilities (new) | SYSTEM | 0 | yes | none |
| action_history (new, P4) | SYSTEM | 0 | yes | none |

Notes:
- P2's argument rules can raise a call's risk (a recursive delete, deleting a
  whole folder); three set it from the arguments the way the controllers
  already do (PERMISSION_MODEL.md).
- Where a controller checks a stricter level than first catalogued, the
  catalogue follows the controller (P2): window move and resize 2, Settings
  page 2, restarting JARVIS 3.
- control_mouse `move`/`scroll` are level 1 by risk, but the tool keeps its
  dispatch floor of session level 2: the stricter check wins.
- No COMMUNICATION or SCHEDULING tools exist yet.

## Discovery

- `toolRegistryV2.getMeta(name)`, `riskOf(name, args)` — metadata and the risk
  of one call (an unknown action gets the tool's highest risk).
- `toolRegistryV2.describeCapabilities({ category?, maxRisk? })` — grouped list
  with each tool's risk range and approval need.
- `toolRegistryV2.capabilitySummary()` — one line per category with tool names
  (printed to the console; 650 characters for the 34 tools).
- Every planning request carries one line naming the groups and how many tools
  each has (196 characters), so the model knows what exists beyond the few
  tools offered with that request.
- `list_capabilities` — the grouped list through a tool, so the model can ask.
- `action_history` (P4) — the last tool calls and approval decisions, redacted;
  offered to the planner for "what did you just do?".
- "what can you do" / "who are you" / "list your tools" — answered from the
  registry, no LLM request.
