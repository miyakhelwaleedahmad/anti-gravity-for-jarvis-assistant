# Patch Plan — routing (phase A3)

Tests first, run on the current code; then the change; related tests, typecheck, full suite, mutation check, independent review. Commit and push only with the owner's approval.

| # | Change | Files | Protected? |
|---|---|---|---|
| P1 (D1) | Route "close [the] <name> tab", "close <name> tab for me": `close_browser_tab` with that name (1–3 words, letters/digits only, not all/other/every/this/that/current). Same tool and safety checks as "close youtube" today (JARVIS's own Chrome; the risk engine decides the level). | `core/deterministicRoutes.ts` | **yes** |
| P2 (D2) | Route near-misses of "enable full control mode" (one typo per word: "controll", "fool", "contol"; "turn on / activate / switch on"; "mode" optional) to the same route. Nothing changes about turning it on: the owner's approval question is still asked every time (risk 3). | `core/deterministicRoutes.ts` | **yes** |
| P3 (D2) | The planner is offered the full-control tools for the same near-misses. | `core/planningToolSelection.ts` | no |
| P4 (D3) | Say why enabling failed (not approved, rate-limited, …) with the existing `failureReply`, instead of "Failed to enable full control, sir." | `core/orchestrator.ts` (one line) | **yes** |
| P5 (D4) | A close request naming the browser **and** something else ("close notepad and chrome") is offered both the browser tools and `control_app` (app and window tools still refuse browsers, phase A1). | `core/planningToolSelection.ts` | no |
| P6 (D5) | The voice normaliser keeps a dot between letters or digits ("github.com", "www.google.com"); the routes still match on text without dots, so every existing route is unchanged. | `core/voiceInput.ts` | no |
| T | New `tests/routingA3Test.ts`: every phrase above, the planner's tools, the normaliser, and security-boundary checks (shell characters, long targets, "close all tabs", "launch cmd /c del *" still no route). `routeGoldenTest` / `deterministicCommandRouteTest` / `voiceNormalizerTest` stay green (DO_NOT_BREAK). | tests | — |

Not in this plan: "close this tab" / "close the current tab" (wait for phase A4, which removes the Ctrl+W fallback); echo (voice phase).
