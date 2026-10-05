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
