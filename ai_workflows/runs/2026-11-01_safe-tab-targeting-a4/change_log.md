# Change Log — safe tab targeting (phase A4)

Gate 1: the owner approved P1–P8 on 2026-11-01 ("approved a4"), with the protected files `security/riskEngine.ts` and `core/deterministicRoutes.ts`. Owner decisions Q1–Q4 are in `patch_plan.md`. Base: `915584c`.

## Test first

`tests/tabTargetingA4Test.ts` on the code before the change: **15 passed, 37 failed** (`evidence/old_code_checks.txt`). The failures reproduce the PC and the audit:
- the YouTube tab listed first closed, not the one on screen;
- with two YouTube tabs and neither on screen, one closed with no question;
- a close that took Chrome 0.6 s was reported as "still open";
- closing the last tab took JARVIS's Chrome down;
- an empty name closed the first listed tab, even without full control;
- Ctrl+W and Ctrl+R were pressed into the browser window in front;
- `browser_tab close` of YouTube needed full control;
- a stale profile file and a Chrome on 9222 were used, and their tabs closed;
- "open youtube" added a tab;
- "close this tab" had no route.

The checks that must hold either way passed: a close that never happens is not "verified", the named-tab route from A3, and phrases that must not route.

## Changes

| # | File | Change |
|---|---|---|
| P2 | `perception/tabResolver.ts` (new) | `resolveTab(name, port)`, the one finder for every tab tool. A tab id → that tab. A name → the tabs whose title or address contains it: one → that tab; several → the one on screen if it is among them, else a question that names up to 3 of them (owner, Q1). No name → the tab on screen; none on screen → a question. An empty name never matches every tab. The question fits in 118 characters, so the fast route can say it. `TabQuestion` and `resolveTabOrAsk`. |
| P2 | `perception/browserState.ts` | `findTab` uses the finder (it served `browser_tab`, the read tools and the page tools; its "no name → first listed" is gone). |
| P2, P3, P4, P7 | `control/browserController.ts` | `findTab`, `focusTab`, `closeTab`, `closeActiveTab` and `refreshTab` use the finder and JARVIS's checked Chrome. The Ctrl+W and Ctrl+R fallbacks and `browserInFront` are removed: when that Chrome does not answer, the reason is given and nothing is pressed. `isTabOpen` keeps "any tab contains the name", but an empty name is no tab. `closeTab`'s own level: YouTube or `about:blank` 1, anything else (an empty name included) 2. The last tab gets a blank tab first. `axios` and `keyboardController` are no longer used here. |
| P2, P4, P7 | `control/browserAgent.ts` | `browser_tab switch` and `close` use JARVIS's checked Chrome and the finder. A close of the last tab opens a blank tab first. The 2-second wait for the tab to go reads that port. |
| P4, P6, P7 | `control/jarvisChrome.ts` | `checkedChromePort()`: the owner's `JARVIS_CDP_PORT` Chrome, or the Chrome whose browser id matches JARVIS's profile file; otherwise an error ("JARVIS's own Chrome is not running, so no tab was changed"). There is no stale file and no 9222. `closeTabKeepingChrome()` (owner, Q4). `showInJarvisChrome()`: an address that is a site's front page, with that site already open, brings that tab to the front instead of opening another (owner, Q3). A search or any other address still opens a new tab. |
| P1 | `core/verifiers.ts` | The `control_browser` close check waits up to 2 s for the closed tab's id to leave the list (N-PC4). |
| P5 | `security/riskEngine.ts` (**protected**; approved) | `control_browser close`: an empty target is no longer level 1 (it is the tab on screen, which can be any tab). `browser_tab close` of a YouTube or `about:blank` tab is level 1, the same rule (owner, Q2; N-PC6). Other tabs stay at level 2. |
| P8 | `core/deterministicRoutes.ts` (**protected**; approved) | "close tab", "close this tab", "close the tab", "close current tab", "close the current tab", "close my tab", "close (the) active tab" route to `close_current_tab`. "close that tab" does not. |
| — | `control/actionQueue.ts` | "Which tab, sir?", "No tab is on screen" and "JARVIS's own Chrome is not running, so no tab was changed" are final: the action queue no longer runs them a second time. Added during implementation, after the first green run showed a retry; covered by a check in the new test and by mutant M13. |

## Tests

| File | Change |
|---|---|
| `tests/tabTargetingA4Test.ts` (new) | The fake Chrome serves its HTTP endpoints, its browser socket and per-page sockets with visibility. Key presses and the window in front are recorded, not sent. Sections 1–7 are listed in the file's header. |
| `tests/browserControlTest.ts` | Check 4 required `closeTab()` with no Chrome to return text. It now fails with the reason, and the check asks for that reason ("not running", "no tab was changed"). The old text "Tab matching "youtube" is not open." was counted as a success by the kernel although Chrome was not reachable. |

After:
- `tabTargetingA4Test`: **55/55**, including the two queue-retry checks added during implementation and the controller-level check added after the mutation check (`evidence/new_code_checks.txt`).
- Related tests: 34 run; 33 passed on the first run, and `browserControlTest` passed after the change above (`evidence/related_tests.txt`, `evidence/related_tests_after.txt`). These include the six DO_NOT_BREAK tests, `browserControlAgentTest` (a real headless Chromium), `jarvisChromeTest`, `routeGoldenTest`, `routingA3Test` and `riskEngineTest`.

## Behaviour the owner will notice

- With full control off, "close this tab" (any wording) is refused with the full-control hint. JARVIS cannot know beforehand that the tab on screen is YouTube (owner, Q2). "close youtube tab" still works without full control.
- With two Chrome windows, each showing a tab, "close this tab" asks "Which tab, sir? 2 are on screen: …". So do navigate, scroll and screenshot when no tab is named (review R5, R14).
- When it is not clear which tab: "Which tab, sir? 2 match "youtube": "…", "…"." With no tab on screen: "No tab is on screen (is Chrome minimised?). Which tab, sir: …". When JARVIS's Chrome is not running: "My Chrome is not running, sir, so I did not change any tab." (fast routes; see "Spoken route replies" below).

## Changes made in review (round 1; `review.md`)

Tests first: the new checks on the code before these fixes gave **58 passed, 11 failed** (`evidence/review_r1_old_code_checks.txt`). R10 already passed, because the reply path redacts later. One R1 check passed only because an unanswered approval question timed out (15 s).

| ID | File | Change |
|---|---|---|
| R1, R2 | `control/tabClose.ts` (new); `control/browserController.ts`; `control/browserAgent.ts` | One step for both tools, run on the tab that was found: level 1 only when its address is on youtube.com (any subdomain) or it is `about:blank`; any other tab needs level 2. A GitHub or Antigravity tab asks first. Before, `browser_tab close` had no sensitive-tab question, and both tools gave level 1 to any tab whose title or address contained "youtube" (a Google sign-in page, a GitHub repository). The risk engine still sees only the words, so its level-1 for "youtube" is a first check and the tab decides again. `closeTab`'s early refusal now fails instead of returning text. The reopen step is registered after the close, not before. |
| R3 | `control/browserAgent.ts`; `control/youtubeControl.ts` | The tools that act on a page use JARVIS's checked Chrome: navigate (go, back, forward, reload), click, type, choose, scroll and screenshot (through `chooseTab`); download (`elementTab`, and the browser session). `browser_tab new` uses the port `ensure()` returns. YouTube play and pause use the checked port. |
| R4 | `core/verifiers.ts` | The tab id is read from the end of the result, so a page title holding "(tab …)" cannot stand in for it. |
| R5 | `perception/tabResolver.ts` | Two or more matching tabs on screen (two windows): a question, not the first. |
| R6 | `perception/browserState.ts` | `visibleTab` is only a tab that is on screen; with Chrome minimised it is empty (it was the first listed). This feeds `browser_state`, the context line in `core/orchestrator.ts` (which then uses the active window's title) and YouTube playback (which then takes the most recently used watch page, since review round 2, R12). |
| R7 | `control/jarvisChrome.ts` | A tab is reused only for the same scheme, host and port ("www." aside): `localhost:3000` is not `localhost:5173`, and `https` is not `http`. |
| R8 | `control/jarvisChrome.ts` | Tab closes run one at a time, and each waits until Chrome no longer lists the tab: two closes of the last two tabs at once no longer leave Chrome with no tab. |
| R9 | records | The count is 55/55, and this log mentions the A3 record edit below. |
| R10 | `perception/tabResolver.ts` | Titles in the question are redacted and lose angle brackets. |
| tests | `tests/tabTargetingA4Test.ts` | Section 8: one check each for R1 to R10 (two tools where it applies), plus a direct check that the close check waits. 71 checks in total. |

After: `tabTargetingA4Test` **71/71** (`evidence/review_r1_new_code_checks.txt`). All 34 related tests pass (`evidence/review_related_tests.txt`). Typecheck: 0 errors. Mutation check: **23 mutants**, 22 caught on the first run (`evidence/a4_mut_run_review.txt`). M6 (the close check's own wait) became a second layer once R8 made the close itself wait. A direct check of the close check was added, and M6 was then caught (`evidence/a4_mut_run_m6.txt`).

Not changed (R11, info): the close check reads `cdpPort()`. It names the same Chrome as the checked port whenever the close went ahead.

## Changes made in review (round 2)

| ID | File | Change |
|---|---|---|
| R12 | `control/youtubeControl.ts` | With Chrome minimised, play and pause go to the most recently used video tab (listed first), not the oldest. The R6 fix had made this case take the oldest, so "pause" left the playing video running. Test first: **71 passed, 1 failed** before the fix (`evidence/review_r2_old_code_checks.txt`), **72/72** after (`evidence/review_r2_new_code_checks.txt`). Mutant M24 caught (`evidence/a4_mut_run_m24.txt`). |
| R13, R14 | records | The R6 row is corrected, and the line on two windows is added. |

Not changed, recorded:
- R15 (info): a YouTube tab whose title contains "github" asks first. This asks too often, which is the safe direction.
- R16 (info): under `JARVIS_LEVEL2_POLICY=ask`, an approved close covers the GitHub question once when the approved words are part of the tab's title. That is SEC-08, unchanged.
- R17 (info, older than A4): `searchYouTube` reads the oldest results tab for a query. Follow-up.

After: 14 related tests pass, including YouTube play, the real Chromium and DO_NOT_BREAK (`evidence/review_r2_related_tests.txt`). Typecheck: 0 errors (`evidence/typecheck_review2.txt`).

## Spoken route replies (owner's approval of 2026-11-01 for `core/orchestrator.ts`)

Before, the fast tab routes said "I tried to close the tab "youtube" but encountered an issue, sir." and then the question. When JARVIS's Chrome was not running they said only "…encountered an issue, sir.", because that reason is longer than the 120 characters the route keeps (`evidence/spoken_probe.txt`, cases 3, 5 and 8).

Test first: `tests/tabRouteReplyA4Test.ts` (new) on the code before the change gave **6 passed, 7 failed** (`evidence/route_reply_old_code_checks.txt`).

| File | Change |
|---|---|
| `control/tabClose.ts` | `tabRouteReply(result)`: a "Which tab, sir?" or "No tab is on screen" reason is returned as it is (at most 160 characters; the finder keeps it within 118). "JARVIS's own Chrome is not running, so no tab was changed" becomes "My Chrome is not running, sir, so I did not change any tab." Anything else: undefined. |
| `core/orchestrator.ts` (**protected**; owner-approved two lines) | The `close_browser_tab` and `close_current_tab` routes say `tabRouteReply(result)` when it has a reply, else `failureReply` as before. The helper is loaded with `await import(...)` inside those two lines, so no import line was added. |
| `tests/tabRouteReplyA4Test.ts` (new) | It hears what JARVIS says (the real `orchestrator.speak()`, with `tts.py` replaced by `tests/fakeTts.ts`) for: the question; no tab on screen; Chrome not running on both routes; and four unchanged cases (success, the full-control hint, "close this tab" with full control on, no tab matches). |
| `tests/boundary-doubles.json` | Entry for the new test (`installFakeTts`), with the standard reason. |

After: **13/13** (`evidence/route_reply_new_code_checks.txt`). The probe again (`evidence/spoken_probe_after.txt`): case 3 "Which tab, sir? 2 match "youtube": "YouTube", "lofi beats YouTube"."; case 5 "My Chrome is not running, sir, so I did not change any tab."; case 8 "No tab is on screen (is Chrome minimised?). Which tab, sir: "Inbox Gmail", "YouTube"."; the other six unchanged. Mutants M25, M26 and M27 cover these lines.

## Changes made in review (round 3)

| ID | File | Change |
|---|---|---|
| R18 | `control/tabClose.ts` | `tabRouteReply` takes "Chrome is not running" only from the start of the reason, not from anywhere in the reason or the output: a refusal quotes the page's title, and a page chooses its title. Test first: `tabRouteReplyA4Test` 15 passed, 2 failed (`evidence/review_r3_old_code_checks.txt`) → **17/17** (`evidence/review_r3_new_code_checks.txt`); mutants M27, M28 caught (`evidence/a4_mut_run_m28.txt`). |

## Other records

- `ai_workflows/runs/2026-10-31_routing-a3/verification.md` (uncommitted): the owner's PC results for A3 on `915584c` (2026-11-01). The "not verified" line about "close the tab" now notes that it has its own route since A4. Left out of the A4 commit by the owner's instruction ("Leave A3 untouched"); it stays uncommitted in the working tree.

## Deviations

- Files not in the plan's table: `control/actionQueue.ts` (one pattern; see above), `control/tabClose.ts` and `control/youtubeControl.ts` (review R1–R3, R12).
- One existing test changed: `tests/browserControlTest.ts` check 4 (see above).
- The read tools (`browser_state`, `browser_read_page`, `browser_page_structure`) still read the port with `cdpPort()`, so they can read another Chrome; they change nothing. Since review R3 the page tools that act use the checked Chrome. Follow-up for A5 (honest capability); the plan named the read tools under P4.
- `core/orchestrator.ts`: only the two approved lines (above). No change to `skills/automation/skill.ts`, `control/pcControlKernel.ts`, `.env`, subagents (`core/agents/**`), or the A3 routes.
