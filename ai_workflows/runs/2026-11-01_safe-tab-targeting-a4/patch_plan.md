# Patch Plan — safe tab targeting (phase A4)

Tests first, run on the current code; then the change; related tests, typecheck, full suite, mutation check (MB, MD, ME included), independent review. Commit and push only with the owner's approval.

| # | Change | Files | Protected? |
|---|---|---|---|
| P1 (D1) | The close check waits up to 2 s for the closed tab's id to leave the list (as `browser_tab` does), then reports. | `core/verifiers.ts` | no |
| P2 (D2–D5) | **One tab finder** for both tab tools: a tab id; else tabs whose title or address contains the name. One match → that tab. Several → the one on screen if it is among them, else a question that lists them (owner, Q1). No name → the tab on screen; none on screen → a question, never "the first listed". An empty name never matches every tab. | new `perception/tabResolver.ts`; `control/browserController.ts`; `control/browserAgent.ts`; `perception/browserState.ts` | no |
| P3 (D6) | No Ctrl+W / Ctrl+R fallback: when JARVIS's Chrome does not answer, JARVIS says so and presses nothing. | `control/browserController.ts` | no |
| P4 (D7) | The tab and read tools use only JARVIS's checked Chrome (`jarvisChrome.running()`), or the owner's `JARVIS_CDP_PORT`; no stale profile file, no 9222 guess. | `perception/cdpClient.ts`, callers | no |
| P5 (D8) | One permission rule for closing a tab, whichever tool does it (owner, Q2). | `security/riskEngine.ts` | **yes** |
| P6 (D9) | "open youtube" when YouTube is already open in JARVIS's Chrome brings that tab to the front instead of adding one (owner, Q3). A search or a full address still opens a new tab. | `control/jarvisChrome.ts` | no |
| P7 (D10) | Closing the last tab leaves JARVIS's Chrome open on a blank tab (owner, Q4). | `control/browserController.ts`, `control/browserAgent.ts` | no |
| P8 (D11) | "close this tab", "close the tab", "close the current tab", "close current tab" route to closing the tab on screen in JARVIS's Chrome (after P2, P3). | `core/deterministicRoutes.ts` | **yes** |
| T | Fake-CDP tests: two YouTube tabs (one on screen), none on screen, empty name, the last tab, a slow close, Chrome not answering (no key press), a stale port file; the permission rule for both tools; the routes; "open youtube" twice. Mutations MB, MD, ME must be caught. DO_NOT_BREAK tests stay green. | tests | — |

## Owner decisions (Gate 1)

- **Q1** Several tabs match the name, and none of them is on screen: ask which (recommended), or close the most recently used?
- **Q2** One rule for closing a tab: YouTube and blank tabs at the normal level and other tabs need full control, for both tools (recommended: keeps today's rule for the fast route, and gives the planner the same); or every tab close needs full control?
- **Q3** "open youtube" when it is already open: bring that tab to the front (recommended), or always open a new tab?
- **Q4** Closing the last tab: keep JARVIS's Chrome open on a blank tab (recommended), or let it close and say so?

Not in this plan: the echo and noise items (Voice phase).

Owner's answers, 2026-11-01: **Q1** ask which tab; **Q2** YouTube and blank tabs at the normal level, other tabs need full control, for both tools; **Q3** bring the open tab to the front; **Q4** keep JARVIS's Chrome open on a blank tab. Gate 1: **approved** by the owner on 2026-11-01 ("approved a4"), protected files included.
