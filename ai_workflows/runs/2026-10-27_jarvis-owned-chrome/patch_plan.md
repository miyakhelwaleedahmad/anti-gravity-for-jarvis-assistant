# Patch Plan — JARVIS-owned Chrome and "close the browser" (phase A2)

## Summary

JARVIS gets one Chrome of its own. It starts it on demand with its own profile and `--remote-debugging-port=0`, and finds its port again from the profile's `DevToolsActivePort` file. That file also proves the Chrome is JARVIS's. Web pages JARVIS opens go into that Chrome through DevTools, never into the default browser. "Close the browser" closes that Chrome after a confirmation. Start instructions are written for the platform JARVIS runs on.

## Proposed Changes

### Change 1 — `control/jarvisChrome.ts` (new)

- `profileDir()`: `JARVIS_CHROME_PROFILE`, else `%USERPROFILE%\jarvis-chrome-profile` on Windows (the folder the old instructions named, so an existing JARVIS profile and its sign-ins are kept), else `~/.jarvis-chrome-profile`.
- `findChrome()`: `JARVIS_CHROME_PATH`, else the standard install paths. Windows: Program Files, Program Files (x86), `%LOCALAPPDATA%`. macOS: `/Applications/Google Chrome.app`. Linux: `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` on the PATH.
- `ownPort()`: the port in `<profile>/DevToolsActivePort`, but only when `/json/version` on that port reports the same browser socket path as the file's second line. A stale file left by a closed Chrome therefore never counts.
- `ensureJarvisChrome()`:
  - When `JARVIS_CDP_PORT` is set and answers, use it (the owner's own debug Chrome, as today).
  - Else, when `ownPort()` answers, use that port.
  - Else start the browser found by `findChrome()` with `--remote-debugging-port=0 --user-data-dir=<profile> --no-first-run --no-default-browser-check`, detached, with the filtered environment (`childEnv`). Wait up to 20 s for a valid `DevToolsActivePort`.
  - Failure names the cause and the fix: Chrome not found (install it, or set `JARVIS_CHROME_PATH`); Chrome did not answer in time; the profile is already open in a Chrome started without JARVIS's port (close that window and ask again).
  - Concurrent calls share one start.
- `closeJarvisChrome()`: sends CDP `Browser.close` on JARVIS's port, then checks the port stops answering (within 5 s).
- `chromeStartHint(platform)` (TRA-16): one text per platform naming the binary, the profile and `JARVIS_CHROME_PATH`.
- Test seams (dependency injection): spawn, file reads, the binary lookup, `fetch` and the platform.

Chrome stays open when JARVIS exits. The next start finds it again through the profile file.

### Change 2 — `perception/cdpClient.ts`, `perception/chromeState.ts`, `control/browserController.ts`

- `cdpPort()`: `JARVIS_CDP_PORT` when set (unchanged; every browser test sets it), else JARVIS's Chrome's port from its profile file, else 9222 as today.
- The three Chrome instruction texts use `chromeStartHint()`.

### Change 3 — opening pages in JARVIS's Chrome

- `skills/automation/skill.ts` (**protected**): an allowed web target (`youtube`, `google`, `gmail`, `github`, `whatsapp`) goes through `ensureJarvisChrome()`, a new tab, and bringing that tab forward. Apps are unchanged. Dry run is unchanged (the DO_NOT_BREAK smoke test).
  - If Chrome cannot start, `success: false` with the cause and the fix. There is no fallback to the default browser (Q2, owner 2026-10-27).
- `control/browserController.ts` `openUrl`: same; the default-browser fallback is removed.
- `control/browserAgent.ts` `tab new` (YouTube search, site search, `browser_tab new`): calls `ensureJarvisChrome()` first.
- `core/tools/youtubeTools.ts` `openElsewhere`: reports that Chrome could not start, with the fix, instead of opening the default browser.
- `core/verifiers.ts` `verifyOpenApp`: a web target opened in JARVIS's Chrome is checked by looking for its tab. It is no longer "unverifiable".
- Q1 (owner, 2026-10-27): "open chrome" / "open browser" start JARVIS's Chrome (the `chrome` app target goes through `ensureJarvisChrome()` and brings it forward). "open edge" / "open firefox" are unchanged.

### Change 4 — "close the browser"

- `skills/control_browser/skill.ts`, `control/pcControlKernel.ts`, `control/browserController.ts`: new action `close_browser`.
  - When JARVIS's Chrome is not running: "JARVIS's Chrome is not open; your own Chrome is never closed." Nothing is closed.
  - Otherwise it asks one question every time, outside any earlier approval (`withoutApproval`, as in A1), naming the tab count and up to three titles: "Close JARVIS's Chrome (3 tabs: …)? Your own Chrome stays open."
  - On yes: `closeJarvisChrome()`, then a check that the port stopped answering. On no: nothing is closed.
  - It only acts on the Chrome `ownPort()` proves is JARVIS's, or on the owner's `JARVIS_CDP_PORT` Chrome. The everyday Chrome cannot be reached by either route.
- `core/toolCatalog.ts`: `close_browser` at risk 2, the same level as closing a tab, plus the confirmation.
- `security/riskEngine.ts` (**protected**): no change unless the catalog level is not enough (checked in tests).
- `core/deterministicRoutes.ts` and `core/orchestrator.ts` (**protected**): exact phrases "close the browser", "close browser", "close chrome", "close google chrome", "close the chrome" become a route `close_browser` that runs `control_browser close_browser`. More phrasings are phase A3.
- `core/planningToolSelection.ts`: a close request naming the browser or Chrome is offered `control_browser`, not `control_app` or `control_window`.
- `control/appMatch.ts`: A1's browser refusal now adds: "say 'close the browser' to close JARVIS's own Chrome."
- `core/verifiers.ts`: `control_browser close_browser` is verified by the port no longer answering.

### Change 5 — tests and docs

- `tests/jarvisChromeTest.ts` (new), with a fake DevTools server (HTTP plus a WebSocket for `Browser.close`) and a fake launcher:
  - start, reuse, stale file, not found, timeout and profile-in-use cases;
  - `cdpPort` order;
  - `open_app youtube` opens a tab in JARVIS's Chrome and runs no default-browser opener;
  - nothing falls back to the default browser;
  - `close_browser`: not running, declined, approved and verified, approved but still answering (failed);
  - routes, including the DO_NOT_BREAK open routes unchanged;
  - hint text per platform.
- A real-Chromium section (skipped when none is found): start headless through `ensureJarvisChrome`, open a page, close the browser with approval, Chrome gone.
- Tests are written first and must fail on the old code with only their seams added (the A1 method).
- `docs/upgrade/BROWSER_CONTROL.md`, `.env.example` (`JARVIS_CHROME_PATH`, `JARVIS_CHROME_PROFILE`), `docs/audit/TOOL_REPAIR_PHASES.md`.

## Files That Will Change

- New: `control/jarvisChrome.ts`, `tests/jarvisChromeTest.ts`.
- Protected (need Gate 1): `skills/automation/skill.ts`, `core/deterministicRoutes.ts`, `core/orchestrator.ts`, and `security/riskEngine.ts` only if needed.
- Others: `perception/cdpClient.ts`, `perception/chromeState.ts`, `control/browserController.ts`, `control/browserAgent.ts`, `control/pcControlKernel.ts`, `skills/control_browser/skill.ts`, `core/tools/youtubeTools.ts`, `core/verifiers.ts`, `core/toolCatalog.ts`, `core/planningToolSelection.ts`, `control/appMatch.ts`, existing tests that expect the default-browser fallback (updated, and listed in the change log), docs.

## Reproduction (from Stage 02b)

`reproduction.md`: REPRODUCED for TRA-16 and TRA-17; TRA-03 in code, PC to confirm.

## Tests to Run After Implementation

- `pnpm test -- --only=jarvisChromeTest`, then the browser and route tests (`browserControlAgentTest`, `browserObservationTest`, `desktopControlTest`, `deterministicCommandRouteTest`, `voiceRouteMockTest`, `openAppSmokeTest`, `closeByNameTest`, `riskEngineTest`).
- `pnpm typecheck`, then the full suite `pnpm test -- --ci`.
- Mutation check on the ownership check, the confirmation and the no-fallback rule.
- Independent agent review.

## Live Voice Verification Required?

Yes, on the owner's PC:
1. "open YouTube": JARVIS's Chrome opens with YouTube; the everyday Chrome is not touched.
2. "close the YouTube tab": that tab closes and the window stays.
3. "close the browser": JARVIS asks; on yes, JARVIS's Chrome closes and the everyday Chrome stays open.

## Risk Assessment

- **Behaviour change:** web pages no longer open in the owner's everyday Chrome (D1). If Chrome cannot start, opening fails with a message instead of falling back (Q2).
- **Profile in use:** if the owner has the JARVIS profile open in a Chrome started by hand without port 0, the start is refused with a message. JARVIS does not close that Chrome.
- **Windows:** the `DevToolsActivePort` behaviour is checked on Linux Chromium 141 and in Chromium's source, not yet on Windows Chrome. The PC check confirms it.
- **Security:** the debugging port binds to 127.0.0.1 only (Chrome's default; `localSocketUrl` already refuses others). Any local program can use it, as with the old 9222 Chrome.
- **Rollback:** revert the run's commits; nothing in the profile or the database changes.

## Approval

- Gate 1: **approved** by the owner on 2026-10-27 ("Approve (Recommended)").
- Q1: JARVIS's Chrome for "open chrome" / "open browser".
- Q2: when JARVIS's Chrome cannot start, fail and say why; no fallback to the default browser.
