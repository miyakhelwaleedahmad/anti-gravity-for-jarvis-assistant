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

## P2 — Risk engine — COMPLETE

- **Implemented:**
  - `security/riskEngine.ts`: `assessRisk` gives one call a level 0–4, the
    reasons, and a refusal where a rule forbids it; `decide` turns that into
    run, ask or refuse from the session level, `JARVIS_LEVEL2_POLICY` and the
    tool's floor (table in [PERMISSION_MODEL.md](PERMISSION_MODEL.md)).
  - Registry: runs it after the floor and argument checks. A refusal returns
    `RISK_REFUSED` (a rule) or `PERMISSION_DENIED` (needs full control mode);
    a risk check that throws refuses the call.
  - `security/approvalScope.ts`: an approved call carries the approval to the
    controller it reaches, which no longer asks a second time. A call running
    at the same time, or queued behind it, does not see it.
  - Default session level 1; `JARVIS_DEFAULT_PERMISSION_LEVEL=0` restores the
    previous default. `JARVIS_LEVEL2_POLICY=ask` asks to approve each action
    instead of requiring full control mode. Both in `.env.example`.
  - Replies: a declined approval is "Cancelled, sir. You did not approve it,
    so nothing was done."; a refusal gives its reason.
  - Catalogue aligned with the controllers' own checks: window move and
    resize 2, Settings page 2, restarting JARVIS 3.
- **Found and fixed:**
  - `explain_code` read any file on the PC and sent it to the LLM (found in
    P1): now the JARVIS folder only, `.env` refused.
  - Command Prompt injection: with level 1 granted, `control_app open
    "notepad&calc"` would also have started calc, and so would a URL with `&`
    in control_browser's fallback. Such targets are refused.
  - The action queue retried an action the user had refused, so the question
    was asked twice. Refusals and cancellations are no longer retried.
  - The developer allow-list ("read-only git") accepted `git branch -D`,
    `git branch -m` and `git diff --output=<file>`.
  - The command classes rated `rd /s /q C:\`, `Clear-Disk`, `bcdedit` and
    deleting restore points HIGH_RISK, like `echo`. They are level 4 now, and
    deleting a drive, a user profile or a Windows system folder is refused.
  - An open_app dry run asked for approval although it opens nothing.
- **Behaviour changes (intended):**
  - Focus, minimise, maximise and control_app open/focus run without full
    control mode.
  - `write_file` needs full control mode (level 2, "modify project files");
    before, it ran at level 0 with no level check.
  - Restarting JARVIS through control_system needs full control mode and an
    approval; before, the approval alone.
- **Tested:**
  - `tests/riskEngineTest.ts`: 127 checks, all pass — levels of 35 calls, 35
    shell commands, decisions for 20 calls at session 0/1/2 under both
    policies, the real registry and orchestrator, real file writes, approval
    isolation. On the code before P2: 18 of 26 runnable checks fail (the
    engine sections need the new module).
  - `tests/actionQueueRecoveryTest.ts`: new section, 5 checks; 4 fail on the
    old queue.
  - Changed tests: `permissionSessionTest` and `dispatchAuthzTest` (default
    level 1); `registryRepairHonestyTest` and `taskFailureHonestyTest` — their
    helper that takes permissions out of a check now sets the tool's risk as
    well as its floor; two checks they skipped at the new default level run
    again.
  - Security tests unchanged and passing: runCommandSafety 11,
    securityGateUnit 36, dangerousCommandMatch 23, openAppSecurity 15,
    fileControlSafety 10, adminControl 30.
  - Full suite: 94 files, 88 passed · 0 failed · 6 environment; CI mode
    86 passed · 8 skipped.
- **Not verified here:** approval prompts on a real console and by voice
  (P3 replaces the presentation); the Windows controllers (P14).
- **Known limits:**
  - Level 4 is asked with the same YES as level 3 until P3 adds the typed code.
  - The critical-command patterns are a list, not a proof: a destructive
    command missing from it stays level 3 (full control mode and an approval
    every time).
  - control_browser refresh presses Ctrl+R, which needs level 2, so it fails
    at level 1 (P9 replaces it).
  - URLs with `&` or `%` open through Chrome's DevTools endpoint only; the
    `cmd /c start` fallback refuses them.
  - `git show HEAD:<file>` prints any tracked file; secrets in tool output are
    P4's subject.
- **Next:** P3 — approval gate.
