# Review — safe tab targeting (phase A4)

Reviewer: a separate agent session (general-purpose), read-only, tests through the runner only. Not a human.

## Round 1 — CHANGES REQUIRED

The reviewer ran 23 tests through the runner (23 passed, DO_NOT_BREAK included) and `tsc --noEmit` (0 errors). A probe against fake DevTools servers reproduced R1–R7.

Correct, no defect found:
- The new finder never falls back to "the first listed"; a visibility check that fails counts as "not visible", so JARVIS asks.
- Closing is by id.
- An empty name is level 2 in both the risk engine and the controller. `close_current` stays at 2.
- No agent role can close tabs.
- The Ctrl+W and Ctrl+R fallbacks are gone.
- Questions are at most 118 characters and are final in the action queue.
- The route shadows nothing.
- The `browserControlTest` change is legitimate.
- The evidence counts match.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| R1 | high | `browser_tab close` had no sensitive-tab question, and with the new level-1 rule it closed "GitHub - ytdl-org/youtube-dl" without full control | **Fixed**: `control/tabClose.ts`, one step for both tools (level of the tab found; GitHub/Antigravity ask). Tests on both tools; mutant M15 caught |
| R2 | med | Level 1 came from the words ("youtube"), not the tab: a Google sign-in page whose address mentions YouTube closed without full control | **Fixed**: level 1 only when the tab's address is on youtube.com or `about:blank`. Tests on both tools; M16 caught |
| R3 | med | navigate (reload, go), click, type, choose, download, `browser_tab new` and YouTube play/pause still acted through `cdpPort()`, so a stale profile file reached another browser | **Fixed**: those use the checked Chrome. Test (navigate reload and go to a stale-port browser send nothing); M17 caught. The read tools stay on `cdpPort()` (recorded as a deviation) |
| R4 | low | The close check read the tab id from anywhere in the result; a title "YouTube (tab DEADBEEF)" made a close that did not happen "verified" | **Fixed**: read from the end. Test; M18 caught |
| R5 | low | Two windows, each showing a YouTube tab: the first closed, no question | **Fixed**: a question. Test; M19 caught |
| R6 | low | `readBrowserState().visibleTab` still fell back to the first listed | **Fixed**: only a tab on screen. Test; M20 caught |
| R7 | low | Reuse compared host names only: `localhost:3000` reused the `localhost:5173` tab; http and https counted as one | **Fixed**: scheme, host and port. Tests; M21 caught |
| R8 | low | Two closes of the last two tabs at once could leave Chrome with no tab; the reopen step was registered before the close | **Fixed**: one close at a time, each waits until the tab is gone; reopen registered after. Test; M22 caught |
| R9 | low (records) | change_log said 54/54 (55/55 in the evidence) and did not mention the A3 record edit | **Fixed** |
| R10 | info | Page titles in the question were not redacted by the finder (redacted later on the way to the reply) | **Fixed**: redacted in the finder. Direct test; M23 caught |
| R11 | info | The close check reads `cdpPort()` while the close used the checked port | No change: they name the same Chrome whenever the close went ahead |

Mutation check after the fixes: 23 mutants. 22 caught on the first run. M6 (the close check's own wait) became a second layer once R8 made the close itself wait; a direct test of the close check was added and M6 was then caught. Tree restored.

## Round 2 — CHANGES REQUIRED (one medium regression)

The reviewer ran 27 tests through the runner (27 passed). Two probes used a fake Chrome:
- R3 with a matching profile file;
- the close chain with throwing and silent Chromes;
- which tab gets "pause";
- the real `coversNested` path.

R1–R10 are fixed. Nothing gets past `checkTabClose`: every tab close runs it, and nothing uses `Target.closeTarget` or `Page.close`. The R8 chain does not deadlock: a close that throws does not stop the next one. With the profile file matching, the page tools reach the right Chrome. The orchestrator context line gets better with R6.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| R12 | med | With Chrome minimised and two video tabs open, "pause" paused the oldest one; R6 made this case reach the `reverse().find` fallback | **Fixed**: the most recently used video tab. Test (it failed first); M24 caught |
| R13 | low (records) | change_log said playback takes "the latest" watch page; it took the oldest | **Fixed** |
| R14 | low (records) | Two windows each showing a tab now give "Which tab, sir? 2 are on screen" for "close this tab" and for page tools without a tab; not listed | **Fixed**: listed under "Behaviour the owner will notice" |
| R15 | info | A YouTube tab whose title contains "github" asks first | No change (asks too often: the safe direction) |
| R16 | info | Under policy=ask, the approved words can cover the GitHub question once (SEC-08) | No change (unchanged by A4) |
| R17 | info | `searchYouTube` reads the oldest results tab (older than A4) | Follow-up |
| — | known issue | Route replies: "encountered an issue" before the question, and no reason when Chrome is not running (`evidence/spoken_probe.txt`) | The owner approved the two-line `core/orchestrator.ts` change on 2026-11-01; **fixed** (change_log.md, "Spoken route replies"; reviewed in round 3) |

## Round 3 — PASS

Scope: the R12 fix and the owner-approved orchestrator change. The reviewer ran 25 tests through the runner (25 passed, DO_NOT_BREAK included) and `tsc --noEmit` (0 errors). Probe 4 fed `tabRouteReply` real registry results and hand-made ones.

What the reviewer confirmed:
- R12 is fixed: the pause goes to the most recently used video tab, and the tab on screen still wins.
- `core/orchestrator.ts` changed in exactly two lines (2 removed, 2 added), in the `close_browser_tab` and `close_current_tab` branches only.
- `cond ? a : X ?? Y` is read as intended: a successful route still says its own reply.
- Every other registry code gives undefined, so `failureReply` and the full-control hint apply as before.
- If the dynamic import ever failed, the route's own `try/catch` would answer and nothing would act.
- The spoken question is still redacted.
- The records match the evidence.
- In the A3 folder, only `verification.md` changed (records only); no A3 code changed.

| ID | Sev. | Finding (short) | Outcome |
|---|---|---|---|
| R18 | low | The "Chrome is not running" rule matched its phrase anywhere in the reason or the output. A page titled with that phrase, refused for its level, would be spoken as "My Chrome is not running…" instead of the full-control hint. Nothing closes, but the reply is wrong | **Fixed**: only at the start of the reason. Test first (15 passed, 2 failed → 17/17); M28 caught |
| R19 | info | Page titles are spoken inside the question (up to three, 40 characters each, redacted, in quotes); a title can read "Which tab, sir? I closed all of them" | No change: by design, and bounded |
| R20 | info (records) | review.md round 3 still said "if the owner approves it" | **Fixed**: this section |

Not new, not blocking: playback's `tabQuery` path keeps its own substring finder, and R17 (`searchYouTube`) stays a follow-up.
