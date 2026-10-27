# Change Log — JARVIS-owned Chrome and "close the browser" (phase A2)

Gate 1 approved by the owner on 2026-10-27 (patch plan, Q1 = JARVIS's Chrome for "open chrome", Q2 = fail and say why). Base: `84b9c03`.

## Test first

`tests/jarvisChromeTest.ts` was written before any runtime change and run on the old code through the runner (`evidence/old_code_run.txt`): **14 passed, 44 failed**. Modules this change adds could not load there; their checks failed with "cannot load". The child-process guard recorded every default-browser launch (`xdg-open https://www.youtube.com`, `xdg-open chrome.exe`) and ran none. One check that passed on the old code for the wrong reason was tightened afterwards: the close check's "failed" now requires "still answers".

## Changes

| File | Change |
|---|---|
| `perception/chromeProfile.ts` (new) | Profile folder (`JARVIS_CHROME_PROFILE`, else `%USERPROFILE%\jarvis-chrome-profile` / `~/.jarvis-chrome-profile`); `readActivePort` (port and browser path from `DevToolsActivePort`); `chromeStartHint(platform)` (TRA-16). |
| `control/jarvisChrome.ts` (new) | `findChrome` (`JARVIS_CHROME_PATH`, install folders); `JarvisChrome.runningPort` (the profile's port only when that port answers with the same browser path; or the owner's `JARVIS_CDP_PORT` Chrome); `ensure` (attach-only with `JARVIS_CDP_PORT`; else reuse, else start once with `--remote-debugging-port=0`, wait ≤20 s; refuses with `JARVIS_CHROME_AUTOSTART=off`; the cause and fix in each failure); `close` (CDP `Browser.close`, then the port must stop answering ≤5 s); `showInJarvisChrome`. |
| `perception/cdpClient.ts` | `cdpPort()`: `JARVIS_CDP_PORT`, then the profile file, then 9222. "Not reachable": with `JARVIS_CDP_PORT` set, how to start that Chrome; otherwise JARVIS's Chrome is not running, plus `chromeStartHint`. |
| `perception/chromeState.ts` | Error text uses `chromeStartHint`. |
| `skills/automation/skill.ts` (protected) | Web targets and `chrome` → `showInJarvisChrome` (`method: jarvis-chrome`, `port`, `tabId`); a failure returns `success: false` with the reason; nothing opens elsewhere. Dry run unchanged. |
| `control/browserController.ts` | Dependency injection (`chrome`, `approve`). `getInstruction` uses `chromeStartHint`. `openUrl`: JARVIS's Chrome, brought forward; the default-browser fallback removed. New `closeBrowser`: level 2; "not open" refusal; one question every time, outside any earlier approval, naming the tab count and up to three titles; then the close and its check. |
| `control/browserAgent.ts` | `tab new` calls `jarvisChrome.ensure()` first. |
| `core/tools/youtubeTools.ts` | `openElsewhere` (the default-browser fallback) removed; YouTube and site search report the reason. |
| `control/pcControlKernel.ts` (protected, see deviations), `skills/control_browser/skill.ts`, `skills/control_browser/description.json`, `skills/trusted-skills.json` | Action `close_browser`, given the tool's own abort signal (not the queue's 10 s timeout: review R3, R2-1); the description re-trusted with `scripts/trustSkills.ts control_browser`. |
| `control/appController.ts` (review R1, R2-4) | `openApp`: a web address, or Chrome (also by its full path), opens in JARVIS's Chrome via `showInJarvisChrome`, never the platform opener. |
| `core/toolCatalog.ts` | `control_browser.close_browser`: risk 2. |
| `control/actionQueue.ts` | Not retried: "JARVIS's Chrome is not/still open", "Chrome was not found", "…its debugging port", "JARVIS_CHROME_AUTOSTART is off", "JARVIS_CDP_PORT is set". |
| `core/verifiers.ts` | `close_browser`: verified when the named port no longer answers. `open_app` with `method: jarvis-chrome`: verified when the tab is in that Chrome (any platform). |
| `core/deterministicRoutes.ts` (protected) | Exact phrases "close the browser", "close browser", "close chrome", "close the chrome", "close google chrome" → `close_browser` (the plan's five; a sixth was removed in review, R5). |
| `core/orchestrator.ts` (protected) | Route `close_browser` → `control_browser close_browser`. `open_app` route: a JARVIS-Chrome failure is spoken as its first sentence (Q2); the rest is in the console. |
| `core/planningToolSelection.ts` | A close/kill/exit/quit request naming the browser or Chrome is offered `control_browser`, not `control_app`/`control_window`. |
| `control/appMatch.ts` | A1's browser refusal adds: say "close the browser" to close JARVIS's own Chrome. |
| `tests/runAll.ts` | Every test runs with `JARVIS_CHROME_AUTOSTART=off` and a throwaway `JARVIS_CHROME_PROFILE`. |
| `.env.example`, `docs/upgrade/BROWSER_CONTROL.md` | The new settings and behaviour. |

## Changes made in review (rounds 1 and 2)

See `review.md`. In short: `JarvisChrome.running()` (port and browser path) and `close(running)` re-checks the browser (R8); one serialized check-and-start (R10); `ChromeNotAvailableError.spoken` (R6) and separate could-not-run / exit-code messages (R17); the blank start tab is closed (R9); the close check's regex is anchored (R7); `closeBrowser(signal)` refuses an answer that came after the tool's own signal aborted (R3, R2-1); `control_app open` uses JARVIS's Chrome (R1, R2-4); `tests/childEnvCoverageTest.ts` opens `notepad` instead of a web address to check the opener's environment (a web address no longer reaches the opener); `tests/taskFailureHonestyTest.ts` §1b drives the routes through the real orchestrator (R4).

## Deviations from the plan (for the owner to approve)

- **Protected file `core/orchestrator.ts`, beyond the plan's `close_browser` route:** the `open_app` route speaks the short reason and fix when JARVIS's Chrome cannot be used (`spoken`, else the first sentence). Without it a long reason was replaced by "encountered an issue", which does not meet Q2 ("fail and say why"). Review R5.
- **Protected file `control/pcControlKernel.ts`:** listed under "Others" in the plan, but `RUNTIME_PROTECTED_FILES.md` lists it under PC Control. Changes: the `closeBrowser` method (in the plan, Change 4) and passing the tool's abort signal to it (review R3, R2-1). Review R2-2.
- **`control/appController.ts`**, not in the plan's file list: needed so that `control_app open` follows D1, Q1 and Q2 (review R1).

- `security/riskEngine.ts` not changed: the catalog level (risk 2) is what the registry applies (tests).
- Added during implementation: `JARVIS_CHROME_AUTOSTART` (owner opt-out; the runner sets it off), and the level-2 check inside `closeBrowser` (the other close actions check inside the controller too).
- `JARVIS_CDP_PORT` set means attach-only, so tests and an owner who starts Chrome by hand are never given a second Chrome.
- The reproduction probe was renamed `probe_before.ts` → `probe_before.mts` after it ran (content unchanged): `childEnvCoverageTest` scans `.ts` files for unfiltered `spawn` calls, and the probe's throwaway Chromium is not a runtime call site.

## Not changed (recorded for later phases)

- `closeActiveTab` / `refreshTab` still press Ctrl+W / Ctrl+R in a browser window in front when DevTools does not answer (TRA-03 note). That window can be the everyday Chrome. This belongs to phase A4/A5 (target resolution and honest capability).
- `closeTab` returns "Permission level … required" as text, not as an error (TRA-10, phase A5).
