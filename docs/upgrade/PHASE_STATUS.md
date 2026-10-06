# Phase status

Updated after every phase. Checklist: [MASTER_PHASE_CHECKLIST.md](MASTER_PHASE_CHECKLIST.md).

## P0 — Discovery and architecture — COMPLETE

- **Implemented:** nothing in code (discovery phase). Documents in `docs/upgrade/`.
- **Tested:** baseline suite before any change: 92 files, 86 passed · 0 failed ·
  6 environment (Windows, Redis, Python venv, bridge token); CI mode 84 passed ·
  8 skipped. Commit `dc37503`.
- **Found:** see [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) §1.
  Facts that shape the plan:
  - Session level 1 ("safe control") is defined but never granted: the level is
    0 or 2, so focus, open-URL and other level-1 actions are refused by default.
  - Voice approval accepts "yes", "proceed" and "do it" as well as "confirm".
  - The browser layer uses only the DevTools HTTP endpoints (list, open, close,
    activate); it cannot read a page.
  - Since Chrome 136, `--remote-debugging-port` is ignored for the default
    profile; a separate `--user-data-dir` is required
    ([Chrome blog](https://developer.chrome.com/blog/remote-debugging-port)).
    JARVIS's existing instructions already use a separate profile.
  - `tools/browserTool.py` is a placeholder that returns fake text; it is not
    registered and nothing calls it.
  - The screen-capture service starts but nothing activates it.
  - Nothing redacts secrets from tool output.
- **Remaining:** P1–P15.
- **Next:** P1 — tool registry.

## P1 — Tool registry — COMPLETE

- **Implemented:**
  - Metadata on every tool (`core/toolRegistryV2.ts` types, `core/toolCatalog.ts`
    entries for all 34 tools): category, risk 0–4 with a risk per action for the
    nine multi-action tools, reversibility, external effect, expected effect,
    output. Skills may declare `meta` in `description.json`; a tool with neither
    gets derived defaults (never risk 0) and a warning.
  - Registry: `getMeta`, `riskOf` (unknown action → highest risk),
    `describeCapabilities` (grouped, filter by category or risk, approval need
    derived), `capabilitySummary`, `derivedMetaTools`.
  - `list_capabilities` tool (level 0).
  - "what can you do", "who are you", "list your tools" answered from the
    registry with no LLM request; capability questions are offered
    `list_capabilities`; each planning request carries a 196-character line
    naming the tool groups and their sizes.
- **Found and fixed:** "what can you do" never reached its fast route — "can
  you" is stripped as filler first, so it arrived as "what do" and went to the
  LLM, costing a request and answering with a fixed sentence.
- **Found, scheduled:** `explain_code` reads any absolute path (task T2.6, P2).
- **Tested:** `tests/toolRegistryMetadataTest.ts`, 36 checks, all pass; on the
  code before P1, 19 fail and 5 pass (the 5 are guards that held before).
  Full suite: 93 files, 87 passed · 0 failed · 6 environment.
- **Known limits:** metadata only describes; nothing is enforced from it until
  P2. Risk values are judgement calls recorded in the catalogue, reviewable in
  one file.
- **Next:** P2 — risk engine.
