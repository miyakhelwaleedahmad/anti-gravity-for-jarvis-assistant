# Phase 1 — Tool registry: metadata and capability discovery

## Goal
Every tool JARVIS can call carries metadata — category, risk 0–4 (per action
where a tool has several), reversibility, external effect, expected effect and
output description — and JARVIS can say what it can do from that metadata.

## Current system context
- `core/toolRegistryV2.ts`: `AgentTool` has name, description, `riskLevel`
  (`low`/`medium`/`high`, used for sandbox, cache, queue), `requiredLevel`,
  `inputSchema` (with `enum` for actions), `fallbacks`, `cacheable`,
  `retryPolicy`, `rollback`, `execute`. `register()` warns about high-risk tools
  without `requiredLevel`.
- `core/skillLoader.ts`: builds tools from `skills/*/description.json`
  (`id`, `name`, `description`, `riskLevel`, `requiredLevel`, `cacheable`,
  `parameters` with `enum`, `fallbacks`).
- Built-in tools: `core/tools/index.ts` registers read_file, write_file,
  run_command, get_system_info, web_search, save_relation, search_memory.
- `core/orchestrator.ts`: `selectPlanningToolNames()` offers ≤ 8 tools by
  keyword; `matchDeterministicCommand()` answers "what can you do" / "who are
  you" with a fixed sentence (type `what_can_you_do`).
- 33 tools registered (list in [TOOL_REGISTRY.md](../TOOL_REGISTRY.md)).

## Required changes
1. Metadata types and an optional `meta` on `AgentTool`.
2. A catalogue with explicit metadata for all 33 tools; skills may declare
   `meta` in `description.json`; registration attaches it; a tool with no
   metadata gets derived defaults and one warning.
3. Registry discovery: `getMeta`, `riskOf(name, args)`, `describeCapabilities`,
   `capabilitySummary`.
4. `list_capabilities` tool (level 0).
5. The "what can you do" route answers from the registry (no LLM request);
   capability questions are offered `list_capabilities`.

## Implementation steps
1. In `core/toolRegistryV2.ts` add:
   - `type ToolCategory = 'OBSERVATION' | 'BROWSER' | 'COMPUTER' | 'FILESYSTEM' |
     'TERMINAL' | 'DEVELOPMENT' | 'NETWORK' | 'COMMUNICATION' | 'SCHEDULING' |
     'MEMORY' | 'SYSTEM'`
   - `type RiskTier = 0 | 1 | 2 | 3 | 4`,
     `type Reversibility = 'yes' | 'partial' | 'no'`,
     `type ExternalEffect = 'none' | 'query' | 'change'`
   - `interface ActionMeta { risk: RiskTier; reversible?: Reversibility; effect?: string }`
   - `interface ToolMeta { category; risk; reversible; external; effect;
     output: { format: 'text' | 'json'; description: string };
     actions?: Record<string, ActionMeta> }`
   - `AgentTool.meta?: ToolMeta`.
2. `core/toolCatalog.ts`: `TOOL_CATALOG: Record<string, ToolMeta>` with the
   values in TOOL_REGISTRY.md; `deriveMeta(tool)` for tools without an entry
   (category SYSTEM, risk from `riskLevel`: low 1, medium 2, high 3 — never 0,
   so an unknown tool is never treated as harmless).
3. `register()`: `tool.meta ??= TOOL_CATALOG[tool.name]`; if still missing →
   `deriveMeta` + one warning naming the tool. Record which tools were derived.
4. `core/skillLoader.ts`: pass `desc.meta` through when present.
5. Registry methods:
   - `getMeta(name)`;
   - `riskOf(name, args)`: `meta.actions[args.action].risk` when the tool has
     actions and the action is known; an unknown or missing action → the
     highest action risk; otherwise `meta.risk`;
   - `describeCapabilities({ category?, maxRisk? })` → array of
     `{ category, tools: [{ name, summary, risk: [min, max], approval,
     reversible, external }] }`, approval derived from max risk (0–1 `none`,
     2 `policy`, 3–4 `required`);
   - `capabilitySummary()` → one line per category: `CATEGORY: tool, tool, …`.
6. `core/tools/capabilityTool.ts`: `list_capabilities` (riskLevel low,
   `cacheable` false, input `category?: string`), output JSON of
   `describeCapabilities`. Register in `core/tools/index.ts`; catalogue entry
   (SYSTEM, 0).
7. `core/orchestrator.ts`:
   - deterministic `what_can_you_do` reply built from `describeCapabilities()`
     (categories in plain words, ≤ 3 sentences, details printed to console);
   - `selectPlanningToolNames`: offer `list_capabilities` when the request asks
     about capabilities (`what (tools|can you do)`, `which tools`, `your
     capabilities`, `list (your )?tools`).

## Files to inspect
`core/toolRegistryV2.ts`, `core/skillLoader.ts`, `core/tools/index.ts`,
`core/tools/memoryTool.ts`, `tools/*.ts`, `skills/*/description.json`,
`core/orchestrator.ts` (router, tool selection), `tests/dispatchAuthzTest.ts`,
`tests/toolDiscoverabilityAuditTest.ts`, `tests/toolRegistryOptimizationTest.ts`.

## Files that may be modified
`core/toolRegistryV2.ts`, `core/skillLoader.ts`, `core/toolCatalog.ts` (new),
`core/tools/capabilityTool.ts` (new), `core/tools/index.ts`,
`core/orchestrator.ts`, `tests/toolRegistryMetadataTest.ts` (new), docs.

## Dependencies
P0.

## Tests
`tests/toolRegistryMetadataTest.ts`:
- every registered tool has catalogue or declared metadata (none derived);
- every enum action of every multi-action tool has an action risk;
- `riskOf`: known action, unknown action (highest), no action;
- `describeCapabilities`: groups, filters by category and risk, approval derived;
- `capabilitySummary` lists each category present, under 600 characters;
- a tool registered without metadata gets derived risk ≥ 1 and a warning;
- `list_capabilities` through `toolRegistryV2.execute` returns the grouped JSON;
- orchestrator: "what can you do" → reply names real categories, 0 LLM requests;
  "which tools do you have for files" → `list_capabilities` offered;
  "open notepad" → not offered.
Run against the old code: the new test must fail there.

## Acceptance criteria (here)
- 33 of 33 existing tools (34 with `list_capabilities`) have explicit metadata.
- Capability answers come from the registry, not a fixed sentence.
- No tool's execution, schema or result changes; LLM tool definitions unchanged.
- Full suite: no new failures. CI green.

## Security requirements
- Derived defaults never yield risk 0.
- Metadata cannot lower any existing check: P1 only describes; enforcement is P2.
- `list_capabilities` output contains no paths, keys or environment values.

## Failure conditions
Any tool without explicit metadata; any existing test newly failing; a route
reply that is not built from the registry; an LLM request for "what can you do".

## Completion requirements
Gate in [JARVIS_PHASES.md](../JARVIS_PHASES.md); checklist P1 complete;
PHASE_STATUS updated; commit `phase-01-tool-registry`; branch pushed; CI green.
