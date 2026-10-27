# Reproduction — JARVIS-owned Chrome and "close the browser" (phase A2)

## Failure Being Reproduced

TRA-03 (pages open where JARVIS cannot see them), TRA-16 (Windows-only instructions), TRA-17 (no close-the-browser).

## Method

A read-only probe against the current code (`evidence/probe_before.mts`), with `JARVIS_CDP_PORT=9` so that nothing answers. It opens no page in any browser; it starts one throwaway headless Chromium per Chrome check and closes it.

## Commands and Output

```
npx tsx ai_workflows/runs/2026-10-27_jarvis-owned-chrome/evidence/probe_before.mts
```

Output: `evidence/probe_before.txt`, in full:

```
1. CdpUnavailableError on linux → Chrome is not reachable for JARVIS on 127.0.0.1:9. Start it with chrome.exe --remote-debugging-port=9 --user-data-dir=<a separate profile folder> (Chrome 136 and later ignore the port for the everyday profile).
2. control_browser close_browser → Unknown browser action: "close_browser"
3. open_app "youtube" resolves to https://www.youtube.com (skills/automation/skill.ts opens it with cmd /c start | open | xdg-open: the default browser)
4. route "close the browser" → none (planner)
4. route "close browser" → none (planner)
4. route "close chrome" → none (planner)
4. route "close google chrome" → none (planner)
4. route "open browser" → open_app chrome
   Chromium: /opt/pw-browsers/chromium
5. --remote-debugging-port=9333: DevToolsActivePort not written
6. --remote-debugging-port=0: DevToolsActivePort ["41035","/devtools/browser/a215a9c0-b57e-4fc0-8a22-57ef705b449c"] | /json/version socket ws://127.0.0.1:41035/devtools/browser/a215a9c0-b57e-4fc0-8a22-57ef705b449c
   the file names this browser: true
7. after CDP Browser.close: port answers false | process exit code 0
```

Point 3 is from code, not an executed open: the probe does not open a page in a real browser.

## Result Label (choose one)

REPRODUCED for TRA-16 and TRA-17. For TRA-03, REPRODUCED in code; what the owner sees is confirmed only on the PC.

## Exception (any label other than REPRODUCED / REPRODUCED-MANUAL)

TRA-03 on the PC: "open YouTube", then "close the YouTube tab", checked live with the owner after the change.

## Ready for Patch Plan?

Yes.
