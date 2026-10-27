# Diagnosis — JARVIS-owned Chrome and "close the browser" (phase A2)

## Root Cause (Primary Hypothesis)

RC1 in the audit: there is no browser-session model. Two paths reach two different browsers:

1. **Opening** goes to the default browser: `open_app` runs `cmd /c start "" <url>` (`skills/automation/skill.ts:30-33`), and `browserController.openUrl` falls back to `appController.openApp` when DevTools does not answer (`control/browserController.ts:184-188`). YouTube and site searches fall back to that path (`core/tools/youtubeTools.ts:33-46, 64-66, 124`).
2. **Seeing and controlling** goes only to whatever Chrome answers on `JARVIS_CDP_PORT` (default 9222) (`perception/cdpClient.ts:17-20`). JARVIS never starts that Chrome; it prints instructions instead.

Since Chrome 136 the everyday profile cannot be debugged at all, so path 2 can never see what path 1 opened in the everyday Chrome.

Closing: `control_browser` has list, focus, close (a tab), close_current, open_url and refresh (`skills/control_browser/skill.ts`); nothing closes a browser, and no route matches "close the browser" (TRA-17).

Instructions: three places build a Windows-only `chrome.exe …` command (`control/browserController.ts:41`, `perception/chromeState.ts:71`, `perception/cdpClient.ts:39`) (TRA-16).

## Supporting Evidence

`evidence/probe_before.txt` (run on `84b9c03`, Linux):
- (1) The CdpUnavailableError text on Linux names `chrome.exe`.
- (2) `control_browser close_browser` → `Unknown browser action`.
- (3) `open_app "youtube"` resolves to `https://www.youtube.com`, opened by the platform opener (default browser).
- (4) "close the browser", "close browser", "close chrome", "close google chrome" → no route; "open browser" → `open_app chrome` (the everyday Chrome).

Chrome facts the repair depends on, checked with a real Chromium 141 (same probe):
- (5) With `--remote-debugging-port=9333`, Chrome writes **no** `DevToolsActivePort` file.
- (6) With `--remote-debugging-port=0`, Chrome picks a free port and writes `<profile>/DevToolsActivePort`: line 1 the port, line 2 the browser's socket path. The path matches `/json/version`'s `webSocketDebuggerUrl`, which is unique per browser run.
- (7) CDP `Browser.close` closes that Chrome: the port stops answering and the process exits with code 0.

(5) agrees with Chromium's source: `chrome/browser/devtools/remote_debugging_server.cc` writes the file only when the requested port is 0. Not re-checked on Windows Chrome.

## Control Flow Trace

"Open YouTube" → `matchDeterministicCommand` → `open_app {target: youtube}` → `resolveTargetUrl` → `https://www.youtube.com` → `openTarget` → `cmd.exe /c start "" https://www.youtube.com` → the default browser. Then "close the YouTube tab" → planner → `control_browser close "youtube"` → `findTab` → `GET 127.0.0.1:9222/json/list` → unreachable, or a different Chrome → "not open".

## Alternative Hypotheses

- *Attach to the everyday Chrome instead*: impossible since Chrome 136 (vendor change), and rejected by D1.
- *Fixed port 9222 plus a "same profile" check*: with a fixed port Chrome writes nothing JARVIS can read to prove the profile (5), so a Chrome on 9222 could be any program's. Port 0 with the profile's own file (6) proves it.

## Files That Would Need to Change

See the patch plan.

## Evidence Labels

- TRA-16, TRA-17: CONFIRMED (code and probe).
- TRA-03: CONFIRMED in code; the owner-visible effect is LIKELY until checked on the PC.
- Chrome facts (5)–(7): CONFIRMED on Chromium 141 Linux headless; Windows Chrome LIKELY (same code path), checked on the PC.

## Proposed Reproduction (for Stage 02b)

The probe above (no runtime edit). The new tests are written first and run against the old code with only their seams added (as in phase A1), so each must fail there.

## Ready to Advance to Reproduction?

Yes.
